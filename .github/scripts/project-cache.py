#!/usr/bin/env python3
"""Input-keyed seed caches with content-addressed payloads and replaceable manifests."""
import argparse
import hashlib
import gzip
import io
import json
import os
import platform
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
from urllib.parse import urlparse

MAX_ARCHIVE = 256 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024
# Handy's measured clean mobile dependency tree has 62,585 entries.
# Keep a finite allowance with headroom; byte and safe-extraction limits still apply.
MAX_FILES = 100000
FORBIDDEN = {'.git', '.env', '.npmrc', '.netrc', '.ssh', '.aws', '.hermes', 'credentials', 'opencode.db'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def relative(value, code_directories=False, directory=False):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        raise ValueError('invalid path')
    parts = value.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('forbidden cache path')
    for index, part in enumerate(parts):
        # EAS CLI publishes code in credentials/ directories. This archive-only
        # exception does not admit a credential file, .aws tree or config root.
        if (code_directories and part.lower() == 'credentials'
                and (directory or index < len(parts) - 1)):
            continue
        if part.lower() in FORBIDDEN or part.lower().startswith('.env.'):
            raise ValueError('forbidden cache path')
    return value


def within(root, name):
    destination = root / relative(name)
    if not destination.resolve().is_relative_to(root.resolve()):
        raise ValueError('path escapes declared root')
    return destination


class Missing(Exception):
    pass


class Unavailable(Exception):
    def __init__(self, message='S3 unavailable', code='unavailable', operation=None, client_exit=None):
        super().__init__(message)
        self.code = code
        self.operation = operation
        self.client_exit = client_exit


class S3:
    """Small object adapter; ordinary single PUTs, no exclusive-publisher promise."""
    def __init__(self, env=os.environ):
        required = ('URL', 'REGION', 'BUCKET', 'PREFIX', 'PATH_STYLE', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY')
        if any(not env.get('S3_CACHE_' + name) for name in required):
            raise Unavailable('explicit S3_CACHE configuration not complete')
        self.bucket = env['S3_CACHE_BUCKET']
        self.prefix = env['S3_CACHE_PREFIX'].strip('/')
        # Validate a safe bucket segment, not AWS-specific naming/length policy.
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,253}', self.bucket):
            raise ValueError('invalid cache bucket')
        relative(self.prefix)
        self.region = env['S3_CACHE_REGION']
        if not re.fullmatch(r'[a-z0-9-]+', self.region):
            raise ValueError('invalid S3 region')
        self.endpoint = env['S3_CACHE_URL']
        url = urlparse(self.endpoint)
        if url.username or url.password or url.query or url.fragment or url.path not in ('', '/') or not url.hostname:
            raise ValueError('invalid S3 endpoint')
        if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost', '::1')):
            raise ValueError('S3 endpoint requires TLS')
        self.env = {k: v for k, v in env.items() if not k.startswith('AWS_')}
        for suffix in ('ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SESSION_TOKEN'):
            if env.get('S3_CACHE_' + suffix):
                self.env['AWS_' + suffix] = env['S3_CACHE_' + suffix]
        # Optional AWS-specific streaming checksum trailers are not universal S3.
        # The cache protocol verifies its own SHA256 after every download.
        self.env.update(AWS_EC2_METADATA_DISABLED='true', AWS_MAX_ATTEMPTS='2', AWS_PAGER='',
                        AWS_REQUEST_CHECKSUM_CALCULATION='when_required', AWS_RESPONSE_CHECKSUM_VALIDATION='when_required')
        style = env['S3_CACHE_PATH_STYLE']
        if style not in ('true', 'false'):
            raise ValueError('path style must be true or false')
        self.path_style = style == 'true'

    def command(self, operation, key, extra=()):
        relative(key)
        with tempfile.TemporaryDirectory(prefix='agentic-s3-') as temporary:
            config = Path(temporary) / 'config'
            config.write_text('[default]\nregion = ' + self.region + '\ns3 =\n    addressing_style = ' + ('path' if self.path_style else 'virtual') + '\n')
            env = dict(self.env, AWS_CONFIG_FILE=str(config), AWS_SHARED_CREDENTIALS_FILE=os.devnull)
            command = ['aws', '--no-cli-pager', '--region', self.region, '--cli-connect-timeout', '10', '--cli-read-timeout', '30']
            command += ['--endpoint-url', self.endpoint]
            try:
                result = subprocess.run(command + ['s3api', operation, '--bucket', self.bucket, '--key', f'{self.prefix}/{key}'] + list(extra), env=env, capture_output=True, timeout=90)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise Unavailable('S3 client unavailable') from error
            if result.returncode:
                # Never emit endpoint, signed headers, provider error bodies or CLI stderr.
                error = result.stderr.decode(errors='replace')
                if '(NoSuchKey)' in error or '(404)' in error:
                    raise Missing()
                # Report only known protocol codes, never arbitrary provider text.
                codes = ('AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AuthorizationHeaderMalformed',
                         'InvalidRequest', 'InvalidArgument', 'NotImplemented', 'UnsupportedHeader', 'MissingContentLength',
                         'NoSuchBucket', 'RequestTimeout', 'SlowDown', 'ServiceUnavailable', 'InternalError',
                         'XAmzContentSHA256Mismatch', 'InvalidBucketName', 'InvalidToken', 'ExpiredToken', 'InvalidRange')
                code = next((code for code in codes if f'({code})' in error), 'operation_failed')
                status = re.search(r'An error occurred \(([45][0-9]{2})\)', error)
                if status:
                    code = 'http_' + status[1]
                for text, category in (('SSL validation failed', 'tls_validation'), ('Could not connect to the endpoint URL', 'endpoint_connection'),
                                       ('Unknown options:', 'cli_options'), ('Parameter validation failed', 'cli_parameters'),
                                       ('Connection was closed', 'connection_closed'), ('Invalid header value', 'invalid_header'),
                                       ('Read timeout', 'read_timeout'), ('Connect timeout', 'connect_timeout'),
                                       ('Error parsing parameter', 'cli_parameter_file'), ('Failed to connect to proxy', 'proxy_connection'),
                                       ('Could not connect to proxy', 'proxy_connection'), ('Invalid endpoint', 'invalid_endpoint')):
                    if text.lower() in error.lower():
                        code = category
                raise Unavailable('S3 operation failed', code=code, operation=operation, client_exit=result.returncode)
            return json.loads(result.stdout or b'{}')

    def get(self, key, limit):
        metadata = self.command('head-object', key)
        size = metadata['ContentLength']
        if not isinstance(size, int) or size < 0 or size > limit:
            raise ValueError('object size limit')
        if size == 0:
            return b''
        with tempfile.TemporaryDirectory(prefix='agentic-read-') as temporary:
            target = Path(temporary) / 'object'
            self.command('get-object', key, ['--range', f'bytes=0-{size - 1}', str(target)])
            data = target.read_bytes()
            if len(data) > limit:
                raise ValueError('object size limit')
            return data

    def put(self, key, data):
        with tempfile.TemporaryDirectory(prefix='agentic-put-') as temporary:
            target = Path(temporary) / 'object'
            target.write_bytes(data)
            self.command('put-object', key, ['--body', str(target)])
            return True


class DirectoryStore:
    """Deterministic test double, never selected by the production CLI."""
    def __init__(self, root):
        self.root = Path(root)

    def get(self, key, limit):
        target = within(self.root, key)
        if not target.exists():
            raise Missing()
        if target.stat().st_size > limit:
            raise ValueError('object size limit')
        return target.read_bytes()

    def put(self, key, data):
        target = within(self.root, key)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
            candidate = Path(temporary) / 'candidate'
            with candidate.open('wb') as stream:
                stream.write(data)
            os.replace(candidate, target)
            return True


def resolve_spec(spec, members, cache_root):
    if spec.get('schema') != 1 or spec.get('class') not in ('tool-downloads', 'package-downloads', 'installed-seed'):
        raise ValueError('unsupported cache schema/class')
    for field in ('installation', 'project', 'recipe', 'environment', 'generation'):
        if not isinstance(spec.get(field), str) or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,100}', spec[field]):
            raise ValueError('invalid cache identity')
    if not isinstance(spec.get('runtime'), dict) or not spec['runtime']:
        raise ValueError('explicit runtime/OS/architecture contract required')
    roots = {key: Path(value['directory']).resolve() for key, value in members.items()}
    roots['cache'] = Path(cache_root).resolve()
    inputs = []
    for item in spec['inputs']:
        root = roots[item['member']]
        file = within(root, item['path'])
        if not file.is_file() or file.is_symlink() or file.stat().st_size > 16 * 1024 * 1024:
            raise ValueError('missing/invalid required input')
        inputs.append({'member': item['member'], 'repository': members[item['member']]['repository'], 'path': item['path'], 'sha256': digest(file.read_bytes())})
    if not inputs or not spec.get('outputs') or len(spec['outputs']) > 20:
        raise ValueError('explicit inputs and outputs required')
    outputs = []
    for item in spec['outputs']:
        root = roots[item['member']]
        target = within(root, item['path'])
        if item['member'] != 'cache':
            tracked = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--', item['path']])
            if tracked:
                raise ValueError('cache may not overwrite tracked source')
        if target.is_symlink():
            raise ValueError('output root may not be a symlink')
        outputs.append(target)
    for i, output in enumerate(outputs):
        if any(output == other or output.is_relative_to(other) or other.is_relative_to(output) for other in outputs[:i]):
            raise ValueError('overlapping outputs')
    binding = {key: value for key, value in spec.items() if key not in ('config_sha', 'config_ref', 'config_path', 'source_vector')}
    binding['inputs'] = inputs
    actual_os = platform.system().lower()
    actual_arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine(), platform.machine())
    if spec['runtime'].get('os', actual_os) != actual_os or spec['runtime'].get('arch', actual_arch) != actual_arch:
        raise ValueError('runtime platform does not match this worker')
    actual_runtime = {'os': actual_os, 'arch': actual_arch}
    for tool in ('node', 'pnpm'):
        if tool in spec['runtime']:
            version = subprocess.check_output([tool, '--version'], timeout=15).decode().strip().lstrip('v')
            expected = str(spec['runtime'][tool]).lstrip('v')
            if not (version == expected or version.startswith(expected + '.')):
                raise ValueError('runtime tool version does not match recipe')
            actual_runtime[tool] = version
    binding['actual_runtime'] = actual_runtime
    # The resolver supplies effective setup bytes, not the whole configuration ref.
    if not re.fullmatch(r'[a-f0-9]{64}', spec.get('recipe_digest', '')):
        raise ValueError('effective recipe digest required')
    key = digest(canonical(binding))
    return key, outputs


def archive(outputs):
    buffer = io.BytesIO()
    expanded = count = 0
    with gzip.GzipFile(fileobj=buffer, mode='wb', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as tar:
        for index, root in enumerate(outputs):
            if not root.is_dir():
                raise ValueError('output directory missing')
            files = [root]
            for file in root.rglob('*'):
                if len(files) >= MAX_FILES:
                    raise ValueError('archive file count limit')
                files.append(file)
            for file in sorted(files):
                name = str(index) + (('/' + file.relative_to(root).as_posix()) if file != root else '')
                tar.inodes.clear()  # Store package-manager hardlinks as ordinary files.
                info = tar.gettarinfo(str(file), arcname=name)
                relative(name, code_directories=True, directory=info.isdir())
                count += 1
                expanded += info.size
                if count > MAX_FILES or expanded > MAX_EXPANDED:
                    raise ValueError('expanded seed limit')
                if info.issym():
                    if not (file.parent / os.readlink(file)).resolve().is_relative_to(root.resolve()):
                        raise ValueError('escaping archive link')
                elif not (info.isfile() or info.isdir()):
                    raise ValueError('unsupported archive entry')
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                info.mode &= 0o777
                if info.isfile():
                    with file.open('rb') as stream:
                        tar.addfile(info, stream)
                else:
                    tar.addfile(info)
    data = buffer.getvalue()
    if len(data) > MAX_ARCHIVE:
        raise ValueError('compressed seed limit')
    return data


def extract(data, outputs):
    """Validate complete archive before creating outputs; reject link traversal."""
    with tempfile.TemporaryDirectory(prefix='agentic-extract-') as temporary:
        stage = Path(temporary)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
            entries = []
            seen = set()
            expanded = 0
            for item in tar:
                relative(item.name, code_directories=True, directory=item.isdir())
                parts = PurePosixPath(item.name).parts
                if not parts[0].isdigit() or int(parts[0]) >= len(outputs) or parts[0] != str(int(parts[0])):
                    raise ValueError('unexpected output slot')
                if item.name in seen or len(seen) >= MAX_FILES or item.size < 0:
                    raise ValueError('duplicate/oversized archive')
                seen.add(item.name)
                expanded += item.size
                if expanded > MAX_EXPANDED or not (item.isfile() or item.isdir() or item.issym()):
                    raise ValueError('unsupported/oversized archive')
                if item.issym():
                    if os.path.isabs(item.linkname) or not ((stage / item.name).parent / item.linkname).resolve().is_relative_to(stage / parts[0]):
                        raise ValueError('escaping archive link')
                entries.append(item)
            links = {item.name for item in entries if item.issym()}
            if any(any(parent.as_posix() in links for parent in PurePosixPath(item.name).parents) for item in entries):
                raise ValueError('archive writes through symlink')
            for index, output in enumerate(outputs):
                if output.exists() or output.is_symlink() or not any(item.name == str(index) and item.isdir() for item in entries):
                    raise ValueError('output already exists or slot missing')
            # No arbitrary tar extraction or hard links. Data comes only from verified members.
            for item in entries:
                target = stage / item.name
                target.parent.mkdir(parents=True, exist_ok=True)
                if item.isdir():
                    target.mkdir(exist_ok=True)
                elif item.issym():
                    target.symlink_to(item.linkname)
                else:
                    with tar.extractfile(item) as source, target.open('xb') as destination:
                        shutil.copyfileobj(source, destination)
                if not item.issym():
                    target.chmod(item.mode & 0o777)
        moved = []
        try:
            for index, output in enumerate(outputs):
                output.parent.mkdir(parents=True, exist_ok=True)
                moved.append(output)
                shutil.move(str(stage / str(index)), str(output))
        except Exception:
            for output in moved:
                shutil.rmtree(output)
            raise


def read_entry(store, key):
    """Read one manifest snapshot and verify its complete payload before use."""
    manifest = json.loads(store.get(f'manifests/{key}.json', 16384))
    if (manifest['schema'] != 1 or manifest['key'] != key
            or manifest['producer_stage'] != 'clean-init'
            or not isinstance(manifest['blob'], str) or not re.fullmatch(r'[a-f0-9]{64}', manifest['blob'])
            or type(manifest['bytes']) is not int or not 0 < manifest['bytes'] <= MAX_ARCHIVE):
        raise ValueError('invalid manifest')
    data = store.get(f'blobs/{manifest["blob"]}', MAX_ARCHIVE)
    if digest(data) != manifest['blob'] or len(data) != manifest['bytes']:
        raise ValueError('corrupt blob')
    return manifest, data


def restore(spec, members, cache_root, store, mode='normal'):
    started = time.monotonic()
    key, outputs = resolve_spec(spec, members, cache_root)
    result = {'schema': 1, 'key': key, 'mode': mode, 'status': 'miss', 'ready_seed': False, 'bytes': 0}
    if mode not in ('normal', 'rebuild', 'disabled'):
        raise ValueError('invalid cache mode')
    if mode != 'normal':
        result['status'] = 'disabled' if mode == 'disabled' else 'rebuild'
    else:
        try:
            manifest, data = read_entry(store, key)
            extract(data, outputs)
            result.update(status='exact', ready_seed=spec['class'] == 'installed-seed', bytes=len(data), blob=manifest['blob'])
        except Missing:
            pass
        except Unavailable:
            result['status'] = 'unavailable'
        except (ValueError, KeyError, TypeError, OSError, EOFError, tarfile.TarError):
            result['status'] = 'rejected'
    result['restore_ms'] = round((time.monotonic() - started) * 1000)
    return result


def save(spec, members, cache_root, store, receipt, producer_stage):
    started = time.monotonic()
    key, outputs = resolve_spec(spec, members, cache_root)
    if receipt['key'] != key or producer_stage != 'clean-init':
        raise ValueError('seed inputs changed or producer is not clean-init')
    if receipt['mode'] == 'disabled':
        return {'status': 'disabled', 'key': key}
    data = archive(outputs)
    if resolve_spec(spec, members, cache_root)[0] != key:
        raise ValueError('seed inputs changed during capture')
    blob = digest(data)
    manifest = {'schema': 1, 'key': key, 'blob': blob, 'bytes': len(data), 'producer_stage': producer_stage}
    try:
        # An exact usable entry avoids repeat writes/versions, not concurrent writers.
        if receipt['mode'] == 'normal':
            try:
                existing, _ = read_entry(store, key)
                return {'status': 'existing', 'key': key, 'blob': existing['blob'], 'bytes': existing['bytes'],
                        'save_ms': round((time.monotonic() - started) * 1000)}
            except Missing:
                pass
        blob_key = f'blobs/{blob}'
        try:
            if store.get(blob_key, MAX_ARCHIVE) != data:
                raise ValueError('content-addressed blob corruption')
        except Missing:
            store.put(blob_key, data)
        # Manifest publication is the only point where an entry becomes discoverable.
        # Another compatible producer may replace this complete manifest immediately.
        store.put(f'manifests/{key}.json', canonical(manifest))
        status = 'saved'
    except (Unavailable, Missing):
        status = 'unavailable'
    except (ValueError, KeyError, TypeError):
        status = 'rejected'
    return {'status': status, 'key': key, 'blob': blob, 'bytes': len(data), 'save_ms': round((time.monotonic() - started) * 1000)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['restore', 'save'])
    parser.add_argument('--spec', required=True)
    parser.add_argument('--members', required=True)
    parser.add_argument('--cache-root', required=True)
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--mode', default='normal', choices=['normal', 'rebuild', 'disabled'])
    parser.add_argument('--producer-stage', default='clean-init', choices=['clean-init'])
    args = parser.parse_args()
    spec = json.loads(Path(args.spec).read_text())
    members = json.loads(Path(args.members).read_text())
    class Offline:
        def get(self, *_args):
            raise Unavailable()
        def put(self, *_args):
            raise Unavailable()
    try:
        store = S3()
    except Unavailable:
        store = Offline()
    if args.operation == 'restore':
        result = restore(spec, members, args.cache_root, store, args.mode)
        Path(args.receipt).parent.mkdir(parents=True, exist_ok=True)
        Path(args.receipt).write_text(json.dumps(result))
    else:
        result = save(spec, members, args.cache_root, store, json.loads(Path(args.receipt).read_text()), args.producer_stage)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            for key in ('status', 'ready_seed', 'key', 'bytes', 'restore_ms', 'save_ms'):
                if key in result:
                    output.write(f'{key}={str(result[key]).lower()}\n')
            output.write(f'receipt={Path(args.receipt).resolve()}\n')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not print raw CLI/provider/config/source content.
        raise SystemExit('Cache specification/publication failed validation; no cache success claimed.')
