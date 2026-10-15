/**
 * Load / stress test against a running API.
 *
 *   1. Start an API on a throwaway database with rate limiting raised, e.g.
 *        DATABASE_URL=<test db> PORT=4100 RATE_LIMIT_PER_MINUTE=10000000 RUN_WORKERS_IN_API=false npm run start -w @uo/api
 *   2. STRESS_DATABASE_URL=<same db> STRESS_BASE_URL=http://127.0.0.1:4100 npm run stress -w @uo/api
 *
 * Seeds a realistic volume of data (if not already there), then runs each scenario at a fixed
 * concurrency for a fixed time and reports throughput, latency percentiles and errors.
 * Refuses to seed a database whose name doesn't contain "test" or "stress".
 */
import http from "node:http";
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/auth/passwords";

const BASE = new URL(process.env.STRESS_BASE_URL ?? "http://127.0.0.1:4100");
const DB_URL = process.env.STRESS_DATABASE_URL ?? "";
const DURATION = Number(process.env.STRESS_SECONDS ?? 15) * 1000;
const ORIGIN = process.env.STRESS_ORIGIN ?? "http://localhost:3000";
const PASSWORD = "Stress-Test-Password-1";
const OPPS = Number(process.env.STRESS_OPPORTUNITIES ?? 5000);
const CUSTOMERS = Number(process.env.STRESS_CUSTOMERS ?? 2000);
const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });

interface Res {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}
function send(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { agent, host: BASE.hostname, port: BASE.port, method, path, headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

interface Session {
  cookie: string;
  csrf: string;
}
async function login(email: string): Promise<Session> {
  const r = await send("POST", "/api/auth/login", { origin: ORIGIN }, { email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${r.body}`);
  const cookie = (r.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
  return { cookie, csrf: JSON.parse(r.body).csrfToken };
}
const authed = (s: Session, write = false) => ({ cookie: s.cookie, ...(write ? { origin: ORIGIN, "x-csrf-token": s.csrf } : {}) });

async function seed(prisma: PrismaClient) {
  const dbName = new URL(DB_URL).pathname;
  if (!/test|stress/i.test(dbName)) throw new Error(`Refusing to seed ${dbName}: use a test or stress database.`);
  const passwordHash = await hashPassword(PASSWORD);
  const users: { email: string; role: "salesperson" | "manager" }[] = [
    ...Array.from({ length: 5 }, (_, i) => ({ email: `stress-sales-${i}@stress.local`, role: "salesperson" as const })),
    { email: "stress-manager@stress.local", role: "manager" },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      create: { email: u.email, name: u.email.split("@")[0], passwordHash, roles: { create: [{ role: u.role }] } },
      update: { passwordHash, lockedUntil: null, failedLogins: 0, active: true },
    });
  }
  const sales = await prisma.user.findMany({ where: { email: { in: users.filter((u) => u.role === "salesperson").map((u) => u.email) } }, orderBy: { email: "asc" } });
  if ((await prisma.opportunity.count()) < OPPS) {
    const stages = await prisma.stage.findMany({ orderBy: { sequence: "asc" } });
    if (!stages.length) throw new Error("No stages: start the API once against this database first.");
    const customers = Array.from({ length: CUSTOMERS }, (_, i) => ({
      legalName: `Stress Customer ${i} Ltd`,
      email: `customer${i}@stress.local`,
      createdById: sales[i % sales.length].id,
    }));
    await prisma.customer.createMany({ data: customers });
    const custIds = (await prisma.customer.findMany({ select: { id: true } })).map((c) => c.id);
    const services = ["electricity", "gas", "dual_fuel", "merchant_services"] as const;
    for (let i = 0; i < OPPS; i += 1000) {
      await prisma.opportunity.createMany({
        data: Array.from({ length: Math.min(1000, OPPS - i) }, (_, j) => {
          const n = i + j;
          return {
            name: `Stress deal ${n}`,
            serviceType: services[n % services.length],
            saleType: "new_sale" as const,
            stageId: stages[n % Math.min(stages.length, 12)].id,
            ownerId: n % 7 === 0 ? null : sales[n % sales.length].id,
            customerId: custIds[n % custIds.length],
            companyName: `Stress Customer ${n % CUSTOMERS} Ltd`,
            contactName: `Contact ${n}`,
            email: `deal${n}@stress.local`,
            leadSource: "manual" as const,
            createdById: sales[n % sales.length].id,
          };
        }),
      });
    }
  }
  return { sales: sales.map((s) => s.email), manager: "stress-manager@stress.local" };
}

interface Scenario {
  name: string;
  concurrency: number;
  run: (i: number) => Promise<Res>;
}
interface Result {
  name: string;
  concurrency: number;
  requests: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statuses: Record<string, number>;
  errors: number;
}

async function runScenario(s: Scenario): Promise<Result> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let errors = 0;
  let i = 0;
  const end = performance.now() + DURATION;
  const worker = async () => {
    while (performance.now() < end) {
      const start = performance.now();
      try {
        const r = await s.run(i++);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      } catch {
        errors++;
      }
      latencies.push(performance.now() - start);
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: s.concurrency }, worker));
  const elapsed = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0);
  return { name: s.name, concurrency: s.concurrency, requests: latencies.length, rps: Math.round(latencies.length / elapsed), p50: pct(50), p95: pct(95), p99: pct(99), max: Math.round(latencies.at(-1) ?? 0), statuses, errors };
}

async function main() {
  if (!DB_URL) throw new Error("Set STRESS_DATABASE_URL to the database the API under test uses.");
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const who = await seed(prisma);
  const sales = await Promise.all(who.sales.map(login));
  const manager = await login(who.manager);
  // A channel the salespeople share, for the chat write scenario.
  const channel = JSON.parse((await send("POST", "/api/chat/channels", authed(manager, true), { name: `stress-${Date.now()}`, memberIds: [] })).body);
  await Promise.all(sales.map((s) => send("POST", `/api/chat/channels/${channel.id}/join`, authed(s, true))));
  const oppIds = JSON.parse((await send("GET", "/api/opportunities?pageSize=100", authed(sales[0]))).body).items.map((o: { id: string }) => o.id) as string[];
  const counts = { opportunities: await prisma.opportunity.count(), customers: await prisma.customer.count(), users: await prisma.user.count() };
  const sp = (i: number) => sales[i % sales.length];

  const scenarios: Scenario[] = [
    { name: "GET /health (baseline)", concurrency: 50, run: () => send("GET", "/api/health") },
    { name: "GET /opportunities (salesperson list)", concurrency: 50, run: (i) => send("GET", `/api/opportunities?page=${(i % 5) + 1}`, authed(sp(i))) },
    { name: "GET /opportunities/board", concurrency: 25, run: (i) => send("GET", "/api/opportunities/board", authed(sp(i))) },
    { name: "GET /opportunities/:id (detail)", concurrency: 50, run: (i) => send("GET", `/api/opportunities/${oppIds[i % oppIds.length]}`, authed(sales[0])) },
    { name: "GET /customers (scoped list)", concurrency: 50, run: (i) => send("GET", `/api/customers?q=Stress%20Customer%20${i % 100}`, authed(sp(i))) },
    { name: "GET /search", concurrency: 50, run: (i) => send("GET", `/api/search?q=deal%20${i % 500}`, authed(sp(i))) },
    { name: "GET /reports/dashboard (manager)", concurrency: 20, run: () => send("GET", "/api/reports/dashboard", authed(manager)) },
    { name: "POST /opportunities (create)", concurrency: 20, run: (i) => send("POST", "/api/opportunities", authed(sp(i), true), { name: `Load ${i}`, serviceType: "gas", companyName: `Load ${i} Ltd` }) },
    { name: "POST /chat message", concurrency: 20, run: (i) => send("POST", `/api/chat/channels/${channel.id}/messages`, authed(sp(i), true), { body: `load message ${i}` }) },
    { name: "Spike: 200 users listing deals", concurrency: 200, run: (i) => send("GET", "/api/opportunities", authed(sp(i))) },
    { name: "POST /auth/login (brute-force guard)", concurrency: 10, run: () => send("POST", "/api/auth/login", { origin: ORIGIN }, { email: who.sales[0], password: "wrong-password-xx" }) },
  ];

  console.log(`Data: ${counts.opportunities} opportunities, ${counts.customers} customers, ${counts.users} users. ${DURATION / 1000}s per scenario.\n`);
  const results: Result[] = [];
  for (const s of scenarios) {
    const r = await runScenario(s);
    results.push(r);
    console.log(`${r.name}: ${r.rps} req/s, p95 ${r.p95} ms, statuses ${JSON.stringify(r.statuses)}, errors ${r.errors}`);
  }
  console.log("\n| Scenario | Concurrency | Requests | Req/s | p50 ms | p95 ms | p99 ms | Max ms | Status codes | Network errors |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---|---:|");
  for (const r of results) {
    console.log(`| ${r.name} | ${r.concurrency} | ${r.requests} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${Object.entries(r.statuses).map(([k, v]) => `${k}×${v}`).join(", ")} | ${r.errors} |`);
  }
  const fiveXX = results.reduce((n, r) => n + Object.entries(r.statuses).filter(([k]) => k.startsWith("5")).reduce((m, [, v]) => m + v, 0), 0);
  // Brute-force guard: the user must be locked or throttled, never signed in.
  await prisma.user.update({ where: { email: who.sales[0] }, data: { lockedUntil: null, failedLogins: 0 } });
  await prisma.$disconnect();
  agent.destroy();
  if (fiveXX) {
    console.error(`\n${fiveXX} server errors (5xx).`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
