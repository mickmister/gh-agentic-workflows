import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { assert } from "./core.ts";
import { missingObject } from "./diagnostics.ts";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class PrivateStore {
  client: S3Client;
  bucket: string;
  prefix: string;
  constructor(env = process.env) {
    this.bucket = env.S3_CACHE_BUCKET!;
    this.prefix =
      (env.S3_CACHE_PREFIX ?? "qrspi").replace(/^\/+|\/+$/g, "") +
      "/qrspi-hosted/";
    assert(
      this.bucket &&
        env.S3_CACHE_URL &&
        env.S3_CACHE_ACCESS_KEY_ID &&
        env.S3_CACHE_SECRET_ACCESS_KEY,
      "Missing private S3 configuration",
    );
    this.client = new S3Client({
      endpoint: env.S3_CACHE_URL,
      region: env.S3_CACHE_REGION ?? "us-east-1",
      forcePathStyle: env.S3_CACHE_PATH_STYLE === "true",
      // Match project-cache provider compatibility: omit optional streaming
      // checksums, without weakening conditional writes or exact readback.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: env.S3_CACHE_ACCESS_KEY_ID,
        secretAccessKey: env.S3_CACHE_SECRET_ACCESS_KEY,
      },
    });
  }
  async read(key: string) {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }),
      );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of r.Body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        assert(size <= 32_000_000, "Bound exceeded: private S3 object");
        chunks.push(Buffer.from(chunk));
      }
      return {
        value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        etag: r.ETag!,
      };
    } catch (e: any) {
      if (missingObject(e)) return undefined;
      throw e;
    }
  }
  async put(
    key: string,
    value: unknown,
    condition?: { etag: string } | { create: true },
  ) {
    const body = JSON.stringify(value);
    assert(Buffer.byteLength(body) <= 32_000_000, "Bound exceeded: private S3 publication");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + key,
        Body: body,
        ContentType: "application/json",
        ...(condition && "etag" in condition
          ? { IfMatch: condition.etag }
          : condition
            ? { IfNoneMatch: "*" }
            : {}),
      }),
    );
    const actual = await this.read(key);
    assert(
      actual && digest(actual.value) === digest(value),
      "Private S3 readback failed",
    );
    return actual;
  }
  async admit(key: string, value: unknown) {
    // Any prior record (even unsettled/unknown) forbids another prompt. No time-based lease stealing.
    try {
      await this.put(key, value, { create: true });
      return true;
    } catch (e: any) {
      if ([409, 412].includes(e.$metadata?.httpStatusCode)) {
        assert(
          await this.read(key),
          "Admission conflict without durable evidence",
        );
        return false;
      }
      throw e;
    }
  }
}
