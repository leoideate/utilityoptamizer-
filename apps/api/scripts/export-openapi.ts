/** Writes the OpenAPI document to docs/openapi.json without starting the server. */
import "reflect-metadata";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { buildOpenApi } from "../src/bootstrap";

async function main() {
  // preview: wires up modules and routes without instantiating providers (no DB/Redis needed).
  const app = await NestFactory.create(AppModule, { preview: true, logger: false, abortOnError: false });
  app.setGlobalPrefix("api");
  const doc = buildOpenApi(app);
  const out = path.resolve(__dirname, "../../../docs/openapi.json");
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`Wrote ${Object.keys(doc.paths).length} paths to ${out}`);
  await app.close().catch(() => undefined);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
