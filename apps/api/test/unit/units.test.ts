import { CryptoService } from "../../src/common/crypto.service";
import { redact } from "../../src/common/redact";
import { phoneKey } from "../../src/common/values";
import { loadEnv } from "../../src/config/env";
import { sniffMatches } from "../../src/documents/documents.service";
import { bullJobId } from "../../src/jobs/queue";
import { parseCardText } from "../../src/ocr/card-parser";
import { addressYears } from "../../src/opportunities/facts";
import { signWebhook, verifyWebhook } from "../../src/signatures/provider";
import { base32Decode, base32Encode, generateSecret, totpAt, verifyTotp } from "../../src/auth/totp";
import { hashPassword, verifyPassword } from "../../src/auth/passwords";
import type { Env } from "../../src/config/env";

jest.setTimeout(30_000);

const key = Buffer.alloc(32, 1).toString("base64");
const env = { FIELD_ENCRYPTION_KEY: key, APP_SECRET: "x".repeat(40) } as Env;

describe("field encryption", () => {
  const crypto = new CryptoService(env);
  it("round-trips and never stores plaintext", () => {
    const c = crypto.encrypt("1980-05-17");
    expect(c).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(c).not.toContain("1980");
    expect(crypto.decrypt(c)).toBe("1980-05-17");
    expect(crypto.encrypt("1980-05-17")).not.toBe(c); // random IV
  });
  it("detects tampering", () => {
    const c = crypto.encrypt("secret")!;
    const parts = c.split(":");
    parts[4] = Buffer.from("tampered").toString("base64");
    expect(() => crypto.decrypt(parts.join(":"))).toThrow();
  });
  it("still decrypts with the previous key during rotation", () => {
    const old = crypto.encrypt("rotate me")!;
    const rotated = new CryptoService({ ...env, FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"), FIELD_ENCRYPTION_KEY_PREVIOUS: key });
    expect(rotated.decrypt(old)).toBe("rotate me");
  });
  it("signs and verifies links", () => {
    const sig = crypto.sign("a|b|1");
    expect(crypto.verify("a|b|1", sig)).toBe(true);
    expect(crypto.verify("a|b|2", sig)).toBe(false);
  });
});

describe("passwords and TOTP", () => {
  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("matches the RFC 6238 test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpAt(secret, 59_000)).toBe("287082");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
  });
  it("accepts one step of clock drift only", () => {
    const s = generateSecret();
    const now = 1_700_000_000_000;
    expect(verifyTotp(s, totpAt(s, now - 30_000), now)).toBe(true);
    expect(verifyTotp(s, totpAt(s, now - 90_000), now)).toBe(false);
  });
});

describe("webhook signatures", () => {
  it("verifies HMAC and rejects replays", () => {
    const body = '{"eventId":"1"}';
    const header = signWebhook("secret", body, 1000);
    expect(verifyWebhook("secret", body, header, 1100)).toBe(true);
    expect(verifyWebhook("secret", body + " ", header, 1100)).toBe(false);
    expect(verifyWebhook("other", body, header, 1100)).toBe(false);
    expect(verifyWebhook("secret", body, header, 2000)).toBe(false);
    expect(verifyWebhook("secret", body, undefined)).toBe(false);
  });
});

describe("business-card parsing", () => {
  it("extracts the usual fields from OCR text", () => {
    const f = parseCardText(["Mary O'Brien", "Operations Director", "Quayside Foods Ltd", "Unit 4, Docklands Business Park, Dublin 1, D01 X2Y3", "T: +353 1 555 1234", "M: 087 123 4567", "mary@quaysidefoods.ie", "www.quaysidefoods.ie"].join("\n"));
    expect(f).toMatchObject({
      firstName: "Mary",
      lastName: "O'Brien",
      jobTitle: "Operations Director",
      company: "Quayside Foods Ltd",
      email: "mary@quaysidefoods.ie",
      website: "www.quaysidefoods.ie",
      mobile: "087 123 4567",
      phone: "+353 1 555 1234",
    });
    expect(f.address).toContain("Docklands Business Park");
  });
  it("falls back to the email domain for the company", () => {
    expect(parseCardText("John Smith\njohn@acmebakery.ie").company).toBe("Acmebakery");
    expect(parseCardText("John Smith\njohn@gmail.com").company).toBeNull();
  });
});

describe("helpers", () => {
  it("normalises Irish and UK phone numbers for duplicate matching", () => {
    expect(phoneKey("+353 87 123 4567")).toBe("871234567");
    expect(phoneKey("087 123 4567")).toBe("871234567");
    expect(phoneKey("00353 1 234 5678")).toBe(phoneKey("(01) 234 5678"));
    expect(phoneKey("+44 7700 900123")).toBe(phoneKey("07700 900123"));
    expect(phoneKey("123")).toBeNull();
  });
  it("counts address-history coverage without double-counting overlaps", () => {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    const years = addressYears([{ fromDate: d("2020-01-01"), toDate: d("2022-01-01") }, { fromDate: d("2021-01-01"), toDate: d("2023-01-01") }], d("2030-01-01"));
    expect(years).toBeCloseTo(3, 1);
    expect(addressYears([{ fromDate: d("2025-01-01"), toDate: null }], d("2026-01-01"))).toBeCloseTo(1, 1);
  });
  it("redacts restricted keys at any depth", () => {
    expect(redact({ a: 1, password: "x", nested: [{ iban: "IE..", ok: true }] })).toEqual({ a: 1, password: "[REDACTED]", nested: [{ iban: "[REDACTED]", ok: true }] });
  });
  it("checks upload content against its declared type", () => {
    expect(sniffMatches("application/pdf", Buffer.from("%PDF-1.7 ..."))).toBe(true);
    expect(sniffMatches("application/pdf", Buffer.from("MZ\x90\x00"))).toBe(false);
    expect(sniffMatches("image/png", Buffer.from("89504e470d0a1a0a0000", "hex"))).toBe(true);
    expect(sniffMatches("image/jpeg", Buffer.from("ffd8ffe000", "hex"))).toBe(true);
  });
});

describe("configuration", () => {
  const base = { DATABASE_URL: "postgresql://u:p@h/db", FIELD_ENCRYPTION_KEY: key, APP_SECRET: "y".repeat(40), STORAGE_DRIVER: "local" };
  it("accepts a minimal valid environment and treats blank values as unset", () => {
    expect(loadEnv({ ...base, OCR_HTTP_ENDPOINT: "" }).PORT).toBe(4000);
  });
  it("refuses to start with clear messages", () => {
    expect(() => loadEnv({ ...base, FIELD_ENCRYPTION_KEY: "short" })).toThrow(/FIELD_ENCRYPTION_KEY must be 32 bytes/);
    expect(() => loadEnv({ ...base, STORAGE_DRIVER: "s3" })).toThrow(/S3 credentials are required/);
    expect(() => loadEnv({ ...base, NODE_ENV: "production" })).toThrow(/COOKIE_SECURE must be true/);
    expect(() => loadEnv({ ...base, OCR_PROVIDER: "http" })).toThrow(/OCR_HTTP_ENDPOINT is required/);
  });
});

describe("CSV lead import parsing", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseCsv } = require("../../src/opportunities/lead-intake") as typeof import("../../src/opportunities/lead-intake");
  it("handles quotes, escaped quotes, commas and CRLF", () => {
    const rows = parseCsv('Name,Service,Notes\r\n"Murphy, Bar",Gas,"Said ""call Tuesday"""\r\n\r\nShop,Electricity,\n');
    expect(rows).toEqual([
      ["Name", "Service", "Notes"],
      ["Murphy, Bar", "Gas", 'Said "call Tuesday"'],
      ["Shop", "Electricity", ""],
    ]);
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseIrishAddress, splitContact } = require("../../src/opportunities/lead-intake") as typeof import("../../src/opportunities/lead-intake");
  it("splits one-line Irish addresses into address fields", () => {
    expect(parseIrishAddress("157 Drimnagh Road Dublin 12 D12 cx84, Co. Dublin")).toEqual({ kind: "trading", line1: "157 Drimnagh Road", line2: undefined, city: "Dublin 12", county: "Co. Dublin", postcode: "D12 CX84", country: "IE" });
    expect(parseIrishAddress("183 Kimmage Road Lower Kimmage Dublin 6W D6W NW81, Co. Dublin")).toMatchObject({ line1: "183 Kimmage Road Lower Kimmage", city: "Dublin 6W", postcode: "D6W NW81" });
    expect(parseIrishAddress("Dundrum Town Centre, Sandyford Rd, Dundrum, Co. Dublin", "Dublin 14")).toMatchObject({ line1: "Dundrum Town Centre", line2: "Sandyford Rd, Dundrum", city: "Dublin 14", postcode: undefined });
    // The file's Area wins over a mistyped district in the address.
    expect(parseIrishAddress("55 Decies Road Ballyfermot Dublin 1, Co. Dublin", "Dublin 10")).toMatchObject({ line1: "55 Decies Road Ballyfermot", city: "Dublin 10" });
    expect(parseIrishAddress("Unit 7 Tower Shopping Centre Clondalkin Co. Dublin D22 Wv81")).toMatchObject({ line1: "Unit 7 Tower Shopping Centre Clondalkin", county: "Co. Dublin", postcode: "D22 WV81" });
    expect(parseIrishAddress("Dublin 12, Co. Dublin", "Dublin 12")).toMatchObject({ line1: "Dublin 12", city: undefined });
    expect(parseIrishAddress("  ")).toBeNull();
  });

  it("separates a contact's role in brackets", () => {
    expect(splitContact("Paul McDonald (Owner)")).toEqual({ name: "Paul McDonald", role: "Owner" });
    expect(splitContact("Geoff Lenehan / Maisha Lenehan (Co-owners)")).toEqual({ name: "Geoff Lenehan / Maisha Lenehan", role: "Co-owners" });
    expect(splitContact("Mary Byrne")).toEqual({ name: "Mary Byrne" });
  });
});

describe("BullMQ job ids", () => {
  it("never contain a colon, which BullMQ rejects", () => {
    expect(bullJobId("scan:1b2c")).toBe("scan-1b2c");
    expect(bullJobId("call.poll:abc:2")).toBe("call.poll-abc-2");
    expect(bullJobId(undefined)).toBeUndefined();
  });
});
