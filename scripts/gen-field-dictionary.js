/**
 * Regenerates docs/field-dictionary.md from apps/api/prisma/schema.prisma (models, columns,
 * types and /// comments). Run after schema changes:  node scripts/gen-field-dictionary.js
 */
const fs = require("node:fs");
const path = require("node:path");

const schema = fs.readFileSync(path.join(__dirname, "../apps/api/prisma/schema.prisma"), "utf8");
const NOTES = {
  Opportunity: "One sale (new or renewal). Permanent: can't be deleted or archived (database trigger).",
  Customer: "Permanent customer record. Merged duplicates are kept with merged_into_id set.",
  Principal: "Restricted. Personal values are encrypted; has_* flags let validation run without decrypting.",
  AuditLog: "Append-only (trigger). Never contains restricted values.",
  TimelineEntry: "Append-only (trigger). Corrections are new entries with corrects_id.",
  EnergyContract: "Live/ended contracts are read-only history; renewals create new rows.",
  DocumentVersion: "Every upload is a new version; nothing is overwritten.",
};
let out = "# Field dictionary\n\nGenerated from `apps/api/prisma/schema.prisma` (`node scripts/gen-field-dictionary.js`). Table and column names are the database (snake_case) names. Columns ending in `_enc` hold AES-256-GCM ciphertext.\n\n";
const enums = {};
for (const m of schema.matchAll(/^enum (\w+) \{([^}]*)\}/gm)) enums[m[1]] = m[2].trim().split(/\s+/);

for (const m of schema.matchAll(/((?:^\/\/\/.*\n)*)^model (\w+) \{([^}]*)\}/gm)) {
  const [, docs, name, body] = m;
  const table = body.match(/@@map\("(\w+)"\)/)?.[1] ?? name;
  out += `## ${table}\n\n`;
  const note = [docs.replace(/\/\/\/ ?/g, "").trim(), NOTES[name]].filter(Boolean).join(" ");
  if (note) out += `${note}\n\n`;
  out += "| Column | Type | Required | Notes |\n|---|---|:-:|---|\n";
  let pending = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("///")) {
      pending.push(line.slice(3).trim());
      continue;
    }
    if (!line || line.startsWith("@@") || line.startsWith("//")) continue;
    const [field, type] = line.split(/\s+/);
    const base = type.replace(/[?[\]]/g, "");
    const isRelation = /^[A-Z]/.test(base) && !enums[base] && !["String", "Int", "Boolean", "DateTime", "Decimal", "Json"].includes(base);
    if (isRelation) {
      pending = [];
      continue;
    }
    const column = line.match(/@map\("(\w+)"\)/)?.[1] ?? field;
    let t = base;
    if (line.includes("@db.Date")) t = "Date";
    else if (line.includes("@db.Uuid")) t = "UUID";
    else if (base === "Decimal") t = `Decimal(${line.match(/@db\.Decimal\(([^)]+)\)/)?.[1] ?? ""})`;
    else if (enums[base]) t = `Enum: ${enums[base].join(", ")}`;
    const notes = pending.map((p) => p.replace(/.$/, ""));
    if (line.includes("@id")) notes.push("Primary key");
    if (line.includes("@unique")) notes.push("Unique");
    const def = line.match(/@default\(([^)]*\)?)\)/)?.[1];
    if (def) notes.push(`Default ${def}`);
    out += `| ${column} | ${t} | ${type.endsWith("?") ? "" : "✓"} | ${notes.join(". ")} |\n`;
    pending = [];
  }
  out += "\n";
}
fs.writeFileSync(path.join(__dirname, "../docs/field-dictionary.md"), out);
console.log("Wrote docs/field-dictionary.md");
