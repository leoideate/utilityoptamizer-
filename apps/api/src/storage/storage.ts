import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Env } from "../config/env";
import type { CryptoService } from "../common/crypto.service";

/** Private object storage. Files are never public; downloads use short-lived signed links. */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** A link valid for `ttlSeconds` that downloads the file with the given name. */
  signedUrl(key: string, filename: string, ttlSeconds: number): Promise<string>;
  ping(): Promise<void>;
}

export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");

export class S3Storage implements ObjectStorage {
  private readonly s3: S3Client;
  constructor(private readonly env: Env) {
    this.s3 = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
    });
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: this.env.S3_SERVER_SIDE_ENCRYPTION === "none" ? undefined : this.env.S3_SERVER_SIDE_ENCRYPTION }));
  }

  async get(key: string) {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }));
  }

  signedUrl(key: string, filename: string, ttlSeconds: number) {
    const safe = filename.replace(/["\r\n]/g, "");
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key, ResponseContentDisposition: `inline; filename="${safe}"` }),
      { expiresIn: ttlSeconds },
    );
  }

  async ping() {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.env.S3_BUCKET }));
  }

  /** Development convenience: create the private bucket if the local S3 server doesn't have it. */
  async ensureBucket() {
    try {
      await this.ping();
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.env.S3_BUCKET }));
    }
  }
}

/**
 * Local-disk storage for single-server installs and tests. Signed links point at
 * GET /api/files/local, which checks an HMAC and expiry before streaming the file.
 */
export class LocalStorage implements ObjectStorage {
  private readonly root: string;
  constructor(
    env: Env,
    private readonly crypto: CryptoService,
    private readonly publicApiBase: string,
  ) {
    this.root = path.resolve(env.LOCAL_STORAGE_DIR);
  }

  private file(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("Invalid storage key");
    return p;
  }

  async put(key: string, body: Buffer) {
    const p = this.file(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body, { mode: 0o600 });
  }

  get(key: string) {
    return readFile(this.file(key));
  }

  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }

  async signedUrl(key: string, filename: string, ttlSeconds: number) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = this.crypto.sign(`${key}|${filename}|${exp}`);
    const q = new URLSearchParams({ key, name: filename, exp: String(exp), sig });
    return `${this.publicApiBase}/files/local?${q.toString()}`;
  }

  verifyLink(key: string, filename: string, exp: number, sig: string): boolean {
    return exp >= Math.floor(Date.now() / 1000) && this.crypto.verify(`${key}|${filename}|${exp}`, sig);
  }

  async ping() {
    await mkdir(this.root, { recursive: true });
  }
}
