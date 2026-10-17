/**
 * Loads the supplier forms we've set up from a folder of PDFs:
 *
 *   npm run forms:presets -w @uo/api -- <folder>
 *
 * Every PDF whose SHA-256 matches a preset becomes a template with its fields placed (skipped when an
 * active template already has that PDF). Other PDFs are listed and left alone. Uses apps/api/.env.
 */
import "reflect-metadata";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { SYSTEM } from "../src/common/actor";
import { CryptoService } from "../src/common/crypto.service";
import { PrismaService } from "../src/common/prisma.service";
import { FormsService } from "../src/forms/forms.service";
import { presetFor } from "../src/forms/presets";

async function main() {
  const folder = process.argv[2];
  if (!folder) throw new Error("Usage: npm run forms:presets -w @uo/api -- <folder with the supplier PDFs>");
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
  const forms = app.get(FormsService);
  const prisma = app.get(PrismaService);
  for (const name of readdirSync(folder).filter((n) => n.toLowerCase().endsWith(".pdf"))) {
    const buffer = readFileSync(path.join(folder, name));
    const sha256 = CryptoService.sha256(buffer);
    const preset = presetFor(sha256);
    if (!preset) {
      console.log(`  skipped   ${name} (not a form we've set up)`);
      continue;
    }
    if (await prisma.formTemplate.findFirst({ where: { sha256, active: true }, select: { id: true } })) {
      console.log(`  exists    ${name} → ${preset.name}`);
      continue;
    }
    const r = await forms.createTemplate(SYSTEM, { name: preset.name, documentType: preset.documentType }, { buffer, size: buffer.length, mimetype: "application/pdf", originalname: name });
    console.log(`  added     ${name} → ${preset.name} (${r.fieldsFound} fields)`);
  }
  await app.close();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
