import { Inject, Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ENV, type Env } from "../config/env";

/**
 * Field-level encryption for restricted columns (AES-256-GCM).
 * Format: "v1:<keyId>:<iv>:<tag>:<ciphertext>" (base64 parts). The key id lets the
 * previous key keep decrypting during a rotation (FIELD_ENCRYPTION_KEY_PREVIOUS).
 */
@Injectable()
export class CryptoService {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentId: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    const current = Buffer.from(env.FIELD_ENCRYPTION_KEY, "base64");
    this.currentId = CryptoService.keyId(current);
    this.keys.set(this.currentId, current);
    if (env.FIELD_ENCRYPTION_KEY_PREVIOUS) {
      const prev = Buffer.from(env.FIELD_ENCRYPTION_KEY_PREVIOUS, "base64");
      this.keys.set(CryptoService.keyId(prev), prev);
    }
  }

  private static keyId(key: Buffer) {
    return createHash("sha256").update(key).digest("hex").slice(0, 8);
  }

  encrypt(plain: string): string;
  encrypt(plain: string | null | undefined): string | null;
  encrypt(plain: string | null | undefined): string | null {
    if (plain == null || plain === "") return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.currentId)!, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", this.currentId, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }

  decrypt(value: string | null | undefined): string | null {
    if (!value) return null;
    const [version, keyId, iv, tag, ct] = value.split(":");
    const key = this.keys.get(keyId);
    if (version !== "v1" || !key) throw new Error("Cannot decrypt field: unknown key or format.");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
  }

  encryptJson(v: unknown): string {
    return this.encrypt(JSON.stringify(v));
  }

  decryptJson<T>(v: string | null | undefined): T | null {
    const s = this.decrypt(v);
    return s == null ? null : (JSON.parse(s) as T);
  }

  /** HMAC-SHA256 with APP_SECRET, hex. Used for signed download links. */
  sign(data: string): string {
    return createHmac("sha256", this.env.APP_SECRET).update(data).digest("hex");
  }

  verify(data: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(data), "hex");
    const given = Buffer.from(signature, "hex");
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  static sha256(data: string | Buffer): string {
    return createHash("sha256").update(data).digest("hex");
  }

  static token(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
  }
}
