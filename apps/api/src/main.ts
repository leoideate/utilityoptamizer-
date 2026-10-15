import "./load-env";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule } from "@nestjs/swagger";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { apiDocsEnabled, buildOpenApi, configureApp } from "./bootstrap";
import { startWorkers } from "./jobs/workers";
import { StagesService } from "./opportunities/stages.service";
import { OBJECT_STORAGE, S3Storage } from "./storage/storage";

async function main() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  const env = configureApp(app);

  // Interactive API docs at /api/docs (JSON at /api/docs-json).
  if (apiDocsEnabled(env)) SwaggerModule.setup("api/docs", app, buildOpenApi(app), { jsonDocumentUrl: "api/docs-json" });

  // Idempotent: makes sure the 18 pipeline stages exist.
  await app.get(StagesService).sync();
  const storage = app.get(OBJECT_STORAGE);
  if (env.NODE_ENV !== "production" && storage instanceof S3Storage) await storage.ensureBucket();

  if (env.RUN_WORKERS_IN_API) await startWorkers(app);
  await app.listen(env.PORT);
  app.get(Logger).log(`API listening on :${env.PORT}`);
}

main().catch((err) => {
  // Configuration errors are printed plainly so they're easy to act on.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
