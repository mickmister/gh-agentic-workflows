"""Small pilot transport: private S3 objects, verified blobs and conditional heads.

This is deployment IO, not a new nugs catalog. The pilot namespace is deliberately
separate from existing production workspaces until typed nugs thread APIs ship.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def secret(name):
    return (Path(os.environ.get('SECRETS_DIR', '/run/secrets')) / name).read_text().strip()


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', value):
        raise ValueError('Invalid scoped identifier')
    return value


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


class Store:
    def __init__(self):
        self.bucket = os.environ.get('S3_BUCKET', 'agentic-private')
        self.s3 = boto3.client('s3', endpoint_url=os.environ['S3_ENDPOINT'], region_name='us-east-1',
                               aws_access_key_id=os.environ.get('S3_ACCESS_KEY_ID') or secret('minio_user'),
                               aws_secret_access_key=os.environ.get('S3_SECRET_ACCESS_KEY') or secret('minio_password'),
                               config=Config(s3={'addressing_style': 'path'}, retries={'max_attempts': 3}))

    def get(self, key):
        try:
            response = self.s3.get_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if error.response['Error']['Code'] in ('NoSuchKey', '404'):
                return None, None
            raise
        return response['Body'].read(), response['ETag']

    def read(self, key):
        data, etag = self.get(key)
        return (json.loads(data) if data is not None else None), etag

    def put(self, key, value, expected=None):
        data = encoded(value)
        args = {'IfMatch': expected} if expected else {'IfNoneMatch': '*'}
        result = self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType='application/json', **args)
        # A writer may already advance a mutable head after our successful CAS.
        # The PUT acknowledgement/ETag, not a racy reread, is its revision.
        return result['ETag']

    def mutate(self, key, update):
        for _ in range(20):
            value, etag = self.read(key)
            result = update(value)
            try:
                self.put(key, value, etag)
                return result
            except ClientError as error:
                if error.response['Error']['Code'] not in ('PreconditionFailed', 'ConditionalRequestConflict', '412', '409'):
                    raise
        raise RuntimeError('State is busy; retry the same request ID')

    def blob(self, data):
        digest = hashlib.sha256(data).hexdigest()
        key = 'pilot/blobs/' + digest
        try:
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, IfNoneMatch='*')
        except ClientError as error:
            if error.response['Error']['Code'] not in ('PreconditionFailed', '412'):
                raise
        actual, _ = self.get(key)
        if actual != data:
            raise RuntimeError('Blob readback mismatch')
        return {'key': key, 'sha256': digest, 'bytes': len(data)}

    def restore(self, ref):
        data, _ = self.get(ref['key'])
        if data is None or len(data) != ref['bytes'] or hashlib.sha256(data).hexdigest() != ref['sha256']:
            raise RuntimeError('Checkpoint missing or corrupt; refusing fresh-session fallback')
        return data


def thread_key(workspace, thread):
    return f'pilot/workspaces/{identifier(workspace)}/threads/{identifier(thread)}.json'
