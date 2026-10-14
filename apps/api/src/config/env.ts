import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

/**
 * All configuration comes from the environment and is validated at start-up.
 * The process refuses to start with a missing or malformed value.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(4000),
    /** Public URL of the web app (used for CORS/Origin checks and links in emails). */
    WEB_ORIGIN: z.string().url().default("http://localhost:3000"),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),

    /** 32 bytes, base64. Encrypts restricted columns. Generate: openssl rand -base64 32 */
    FIELD_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, "FIELD_ENCRYPTION_KEY must be 32 bytes, base64-encoded."),
    /** Optional previous key, accepted for decryption during key rotation. */
    FIELD_ENCRYPTION_KEY_PREVIOUS: z
      .string()
      .optional()
      .refine((v) => !v || Buffer.from(v, "base64").length === 32, "FIELD_ENCRYPTION_KEY_PREVIOUS must be 32 bytes, base64-encoded."),
    /** Signs local-storage download links and webhook-free internal tokens. */
    APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters."),

    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
    COOKIE_SECURE: bool,

    STORAGE_DRIVER: z.enum(["s3", "local"]).default("s3"),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default("eu-west-1"),
    S3_BUCKET: z.string().default("uo-documents"),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool,
    LOCAL_STORAGE_DIR: z.string().default("./storage"),
    DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(20),

    /** Virus scanning: "none" marks files as skipped; "clamav" uses clamd over TCP. */
    VIRUS_SCAN_DRIVER: z.enum(["none", "clamav"]).default("none"),
    CLAMAV_HOST: z.string().default("127.0.0.1"),
    CLAMAV_PORT: z.coerce.number().int().default(3310),

    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default("Utility Optimizer CRM <crm@utilityoptimizer.com>"),

    OCR_PROVIDER: z.enum(["manual", "http"]).default("manual"),
    OCR_HTTP_ENDPOINT: z.string().url().optional(),
    OCR_HTTP_API_KEY: z.string().optional(),

    SIGNATURE_PROVIDER: z.enum(["manual", "webhook"]).default("manual"),
    SIGNATURE_WEBHOOK_SECRET: z.string().optional(),

    /**
     * Single sign-on (OpenID Connect, authorization code + PKCE). A provider is enabled when its
     * client id and secret are set. Users must already exist in the CRM; SSO never creates accounts.
     * Redirect URI to register with the provider: {WEB_ORIGIN}/api/auth/sso/{microsoft|google}/callback
     */
    SSO_MICROSOFT_TENANT_ID: z.string().optional(),
    SSO_MICROSOFT_CLIENT_ID: z.string().optional(),
    SSO_MICROSOFT_CLIENT_SECRET: z.string().optional(),
    /** Override only for sovereign clouds or tests. Default: https://login.microsoftonline.com/{tenant}/v2.0 */
    SSO_MICROSOFT_ISSUER: z.string().url().optional(),
    SSO_GOOGLE_CLIENT_ID: z.string().optional(),
    SSO_GOOGLE_CLIENT_SECRET: z.string().optional(),
    SSO_GOOGLE_ISSUER: z.string().url().default("https://accounts.google.com"),
    /** Comma-separated email domains allowed to sign in with SSO (e.g. utilityoptimizer.com). Empty = any domain of an existing user. */
    SSO_ALLOWED_DOMAINS: z.string().optional(),

    /** HMAC secret for POST /api/public/leads (website and API lead intake). Endpoint is disabled when unset. */
    LEAD_WEBHOOK_SECRET: z.string().min(16).optional(),

    WHATSAPP_PROVIDER: z.enum(["disabled", "meta_cloud"]).default("disabled"),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),

    /** Run BullMQ workers inside the API process (dev convenience). Production runs `npm run worker`. */
    RUN_WORKERS_IN_API: bool,
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  })
  .superRefine((e, ctx) => {
    if (e.STORAGE_DRIVER === "s3" && (!e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({ code: "custom", path: ["S3_ACCESS_KEY_ID"], message: "S3 credentials are required when STORAGE_DRIVER=s3." });
    }
    if (e.OCR_PROVIDER === "http" && !e.OCR_HTTP_ENDPOINT) {
      ctx.addIssue({ code: "custom", path: ["OCR_HTTP_ENDPOINT"], message: "OCR_HTTP_ENDPOINT is required when OCR_PROVIDER=http." });
    }
    if (e.SIGNATURE_PROVIDER === "webhook" && !e.SIGNATURE_WEBHOOK_SECRET) {
      ctx.addIssue({ code: "custom", path: ["SIGNATURE_WEBHOOK_SECRET"], message: "SIGNATURE_WEBHOOK_SECRET is required when SIGNATURE_PROVIDER=webhook." });
    }
    if (e.WHATSAPP_PROVIDER === "meta_cloud" && (!e.WHATSAPP_ACCESS_TOKEN || !e.WHATSAPP_PHONE_NUMBER_ID)) {
      ctx.addIssue({ code: "custom", path: ["WHATSAPP_ACCESS_TOKEN"], message: "WhatsApp credentials are required when WHATSAPP_PROVIDER=meta_cloud." });
    }
    if (e.SSO_MICROSOFT_CLIENT_ID && (!e.SSO_MICROSOFT_CLIENT_SECRET || (!e.SSO_MICROSOFT_TENANT_ID && !e.SSO_MICROSOFT_ISSUER))) {
      ctx.addIssue({ code: "custom", path: ["SSO_MICROSOFT_TENANT_ID"], message: "Microsoft SSO needs SSO_MICROSOFT_CLIENT_SECRET and your Entra tenant id (SSO_MICROSOFT_TENANT_ID)." });
    }
    if (e.SSO_GOOGLE_CLIENT_ID && !e.SSO_GOOGLE_CLIENT_SECRET) {
      ctx.addIssue({ code: "custom", path: ["SSO_GOOGLE_CLIENT_SECRET"], message: "Google SSO needs SSO_GOOGLE_CLIENT_SECRET." });
    }
    if (e.NODE_ENV === "production" && !e.COOKIE_SECURE) {
      ctx.addIssue({ code: "custom", path: ["COOKIE_SECURE"], message: "COOKIE_SECURE must be true in production." });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Blank lines in .env (KEY=) mean "not set".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  return parsed.data;
}

export const ENV = Symbol("ENV");
