/**
 * Regenerates docs/security-matrix.md from the permission table in packages/shared.
 * Run after changing permissions:  npm run build -w @uo/shared && node scripts/gen-security-matrix.js
 */
const fs = require("node:fs");
const path = require("node:path");
const s = require("../packages/shared/dist");

const desc = {
  "opportunity.read_all": "See every opportunity (All Opportunities). Salespeople see their own and unassigned leads.",
  "opportunity.create": "Create opportunities",
  "opportunity.write_all": "Edit any opportunity (salespeople edit their own and unassigned)",
  "opportunity.assign": "Assign / reassign salespeople",
  "opportunity.approve": "Grant or refuse internal approval",
  "opportunity.reopen_completed": "Reopen a Live / Won opportunity",
  "opportunity.submit": "Move to Submitted and later stages; send submission packs; record Worldpay approval",
  "opportunity.activate": "Record activation (moves to Live / Won)",
  "customer.read": "View customers",
  "customer.write": "Create and edit customers and contacts",
  "customer.merge": "Merge duplicate customers",
  "principal.read_sensitive": "View principal date of birth, nationality and address history (every view is logged)",
  "principal.write": "Enter or replace principal details",
  "risk.read": "View Worldpay underwriting answers (the owning salesperson can too)",
  "risk.review": "Record the compliance decision; read/write restricted compliance notes",
  "bank.read": "Reveal full bank details (every view is logged)",
  "bank.write": "Add bank details",
  "document.read_sensitive": "Open identity documents, bank statements and other restricted files (every view is logged)",
  "document.review": "Approve or reject documents",
  "document.request": "Request documents from the customer",
  "commission.read": "View commission figures and export the commissions CSV",
  "commission.write": "Record and update commissions",
  "chat.manage_channels": "Create, archive and add people to team channels (anyone can DM and join public channels)",
  "chat.moderate": "Remove other people's chat messages and view edit/delete history (audit-logged)",
  "report.read": "Business-wide dashboard (others see their own figures)",
  "admin.users": "Manage users, roles, passwords and 2FA resets",
  "admin.pipeline": "Rename pipeline stages, run the stage check, manage suppliers",
  "admin.integrations": "Integration settings, outbound job queue and retries, signature templates",
  "admin.audit": "Read the audit log",
  "admin.retention": "Configure and run data retention",
};

const roles = s.ROLES;
let out = `# Security matrix

Generated from \`packages/shared/src/permissions.ts\`, the single source of truth (\`node scripts/gen-security-matrix.js\`). The API enforces every row on every request (guards plus row-level checks in services). The web app uses the same table only to hide buttons.

| Capability | What it allows | ${roles.map((r) => s.ROLE_LABELS[r]).join(" | ")} |
|---|---|${roles.map(() => ":-:").join("|")}|
`;
for (const [k, v] of Object.entries(s.CAPABILITIES)) {
  out += `| \`${k}\` | ${desc[k] ?? ""} | ${roles.map((r) => (v.includes(r) ? "✓" : "")).join(" | ")} |\n`;
}
out += `
## Row-level rules

- **Opportunities**: salespeople read and edit the opportunities they own plus unassigned leads (so they can claim them). Anything else returns *404 Not found*, so other people's deals aren't revealed. Roles with \`opportunity.read_all\` see everything.
- **Won deals** keep their salesperson: unassigning a won opportunity is refused.
- **Activities** can only be edited by their owner, or by roles with \`opportunity.write_all\`.
- **Business-card scans** are visible to the uploader and to roles that read all opportunities.

## Restricted data

| Data | How it's stored | Who can read it |
|---|---|---|
| Principal date of birth, nationality | AES-256-GCM encrypted columns; presence flags in clear for validation | \`principal.read_sensitive\` |
| Principal residential address history | Encrypted JSON per address; dates in clear for the 3-year check | \`principal.read_sensitive\` |
| Restricted compliance notes | Encrypted; never copied to the timeline | \`risk.review\` |
| Bank details (account name, IBAN, BIC) | Encrypted; last four IBAN digits in clear | \`bank.read\` |
| Identity / bank documents | Private bucket, server-side encryption, short-lived signed links | \`document.read_sensitive\` |
| Worldpay underwriting answers | Plain columns | \`risk.read\` or the owning salesperson |
| MFA secrets | Encrypted | nobody (server only) |
| Passwords | scrypt hash (N=32768) | nobody |
| Session tokens | SHA-256 hash only | nobody |

Every view of restricted data writes a \`sensitive.read\` audit entry. Request logs redact cookies, CSRF tokens, passwords and restricted fields (\`apps/api/src/common/redact.ts\`).

## Authentication controls

- Email and password, or Microsoft / Google single sign-on (OpenID Connect with PKCE; existing active users only, matched by verified email, optional domain allow-list). HTTP-only, SameSite=Lax session cookie (Secure in production); sessions expire after \`SESSION_TTL_HOURS\`.
- CSRF: double-submit token (\`uo_csrf\` cookie echoed in \`X-CSRF-Token\`) plus an Origin check on every state-changing request.
- Rate limits: 300 requests/minute per IP; login 10/minute per IP; account locked for 15 minutes after 8 wrong passwords.
- Optional TOTP two-factor authentication per user (Account → Security); administrators can reset it.
- Changing a user's roles, deactivating them or resetting their password ends all their sessions.
`;
fs.writeFileSync(path.join(__dirname, "..", "docs", "security-matrix.md"), out);
console.log("Wrote docs/security-matrix.md");
