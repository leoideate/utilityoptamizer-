import "reflect-metadata";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Role } from "@prisma/client";
import request from "supertest";

/**
 * Integration-test harness: the real AppModule against the test database (TEST_DATABASE_URL),
 * with local-disk storage and a recording job queue instead of Redis.
 */
const envFile = path.resolve(__dirname, "../../.env");
// Jest gives each test file its own process.env, so assign explicitly (process.loadEnvFile writes to the real one).
if (existsSync(envFile)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) if (process.env[k] === undefined) process.env[k] = v;
}
if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL (see apps/api/.env.example).");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "uo-test-"));
process.env.RUN_WORKERS_IN_API = "false";
process.env.LOG_LEVEL = "error";
process.env.SIGNATURE_WEBHOOK_SECRET = process.env.SIGNATURE_WEBHOOK_SECRET || "test-webhook-secret-test-webhook-secret";
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64");
process.env.APP_SECRET = process.env.APP_SECRET || "test-app-secret-test-app-secret-test-app-secret";
process.env.SMTP_URL = "";
process.env.LEAD_WEBHOOK_SECRET = "test-lead-secret-test-lead-secret";
// Chat is off by default; the suites exercise it switched on (chat.test.ts also checks it switched off).
process.env.CHAT_ENABLED = process.env.CHAT_ENABLED || "true";

// Imported after the environment is prepared.
/* eslint-disable @typescript-eslint/no-require-imports */
const { AppModule } = require("../../src/app.module") as typeof import("../../src/app.module");
const { configureApp } = require("../../src/bootstrap") as typeof import("../../src/bootstrap");
const { JOB_QUEUE, RecordingJobQueue } = require("../../src/jobs/queue") as typeof import("../../src/jobs/queue");
const { REALTIME_BUS, LocalRealtimeBus } = require("../../src/realtime/realtime") as typeof import("../../src/realtime/realtime");
const { PrismaService } = require("../../src/common/prisma.service") as typeof import("../../src/common/prisma.service");
const { StagesService } = require("../../src/opportunities/stages.service") as typeof import("../../src/opportunities/stages.service");
const { hashPassword } = require("../../src/auth/passwords") as typeof import("../../src/auth/passwords");
/* eslint-enable @typescript-eslint/no-require-imports */

jest.setTimeout(120_000);

export const PASSWORD = "Integration-Test-Pass-1";
export const ORIGIN = "http://localhost:3000";

export interface TestApp {
  app: INestApplication;
  prisma: InstanceType<typeof PrismaService>;
  queue: InstanceType<typeof RecordingJobQueue>;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const queue = new RecordingJobQueue();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JOB_QUEUE).useValue(queue).overrideProvider(REALTIME_BUS).useValue(new LocalRealtimeBus()).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: process.env.TEST_LOG_ERRORS ? ["error"] : false });
  configureApp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  await resetDatabase(prisma);
  await app.get(StagesService).sync();
  return { app, prisma, queue, close: () => app.close() };
}

/** Empties every table. TRUNCATE bypasses the append-only row triggers, which is what a test reset needs. */
export async function resetDatabase(prisma: InstanceType<typeof PrismaService>) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

let counter = 0;
export async function createUser(t: TestApp, roles: Role[], name?: string) {
  counter++;
  const email = `user${counter}-${roles.join("-")}@test.local`;
  const user = await t.prisma.user.create({ data: { name: name ?? `${roles.join("/")} ${counter}`, email, passwordHash: await hashPassword(PASSWORD), roles: { create: roles.map((role) => ({ role })) } } });
  return { ...user, roles };
}

/** A logged-in HTTP client that sends the session cookie, CSRF token and Origin header. */
export async function login(t: TestApp, email: string) {
  const agent = request.agent(t.app.getHttpServer());
  const res = await agent.post("/api/auth/login").set("Origin", ORIGIN).send({ email, password: PASSWORD });
  if (res.status !== 200 || !res.body.csrfToken) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrfToken as string;
  const withHeaders = (r: request.Test) => r.set("Origin", ORIGIN).set("X-CSRF-Token", csrf);
  return {
    agent,
    csrf,
    get: (url: string) => agent.get(`/api${url}`),
    post: (url: string, body: object = {}) => withHeaders(agent.post(`/api${url}`)).send(body),
    patch: (url: string, body: object = {}) => withHeaders(agent.patch(`/api${url}`)).send(body),
    put: (url: string, body: object = {}) => withHeaders(agent.put(`/api${url}`)).send(body),
    del: (url: string) => withHeaders(agent.delete(`/api${url}`)),
    upload: (url: string, file: Buffer, filename: string, mime: string) => withHeaders(agent.post(`/api${url}`)).attach("file", file, { filename, contentType: mime }),
  };
}
export type Client = Awaited<ReturnType<typeof login>>;

export async function userAndClient(t: TestApp, roles: Role[], name?: string) {
  const user = await createUser(t, roles, name);
  return { user, client: await login(t, user.email) };
}

/** Smallest valid PDF-looking payload accepted by the content sniffing. */
export const pdf = (label = "x") => Buffer.from(`%PDF-1.4\n% ${label} ${Math.random()}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);

export function expectStatus(res: request.Response, status: number) {
  if (res.status !== status) throw new Error(`Expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}
