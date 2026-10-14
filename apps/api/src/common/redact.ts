/** Paths removed from request logs. Pino replaces them with "[REDACTED]". */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.totp",
  "*.iban",
  "*.bic",
  "*.accountName",
  "*.dateOfBirth",
  "*.nationality",
  "*.addressHistory",
  "*.restrictedNotes",
  "*.token",
  "*.apiKey",
];

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordHash",
  "iban",
  "bic",
  "accountName",
  "dateOfBirth",
  "nationality",
  "addressHistory",
  "restrictedNotes",
  "token",
  "totp",
]);

/** Removes restricted values from objects before they are written to the audit log. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEYS.has(k) ? "[REDACTED]" : redact(v)]),
    ) as T;
  }
  return value;
}
