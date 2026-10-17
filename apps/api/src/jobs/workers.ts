import type { INestApplicationContext } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { type Job, Queue, Worker } from "bullmq";
import { ENV, type Env } from "../config/env";
import { RetentionService } from "../admin/retention.service";
import { AutomationsService } from "../automations/automations.service";
import { CallsService } from "../calls/calls.service";
import { ChatService } from "../chat/chat.service";
import { DocumentsService } from "../documents/documents.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { MailboxesService } from "../mailboxes/mailboxes.service";
import { redisConnection } from "./jobs.module";
import { DEFAULT_ATTEMPTS, QUEUES } from "./queue";

const TZ = "Europe/Dublin";

/** Recurring schedules (idempotent upserts, safe to call on every start). */
export async function registerSchedules(env: Env) {
  const q = new Queue(QUEUES.automations, { connection: redisConnection(env.REDIS_URL) });
  // Daily automations at 07:00 Irish time, before the team starts.
  await q.upsertJobScheduler("daily-automations", { pattern: "0 7 * * *", tz: TZ }, { name: "daily", data: {} });
  // Lead assignment and first-contact checks every 15 minutes during the day.
  await q.upsertJobScheduler("lead-assignment", { pattern: "*/15 7-20 * * *", tz: TZ }, { name: "leads", data: {} });
  await q.upsertJobScheduler("hourly", { pattern: "5 * * * *", tz: TZ }, { name: "hourly", data: {} });
  await q.upsertJobScheduler("retention", { pattern: "30 2 * * 0", tz: TZ }, { name: "retention", data: {} });
  // Connected mailboxes are polled every two minutes (one deduplicated job per mailbox).
  await q.upsertJobScheduler("mailbox-sync", { pattern: "*/2 * * * *", tz: TZ }, { name: "mail-sync", data: {} });
  // Calls from the RingCentral call log (inbound, missed, desk phones and the app) every five minutes.
  if (env.TELEPHONY_PROVIDER === "ringcentral") await q.upsertJobScheduler("call-log-sync", { pattern: "*/5 * * * *", tz: TZ }, { name: "call-log", data: {} });
  await q.close();
}

/** Starts BullMQ workers. Returns a function that stops them. */
export async function startWorkers(app: INestApplicationContext): Promise<() => Promise<void>> {
  const log = new Logger("Workers");
  const env = app.get<Env>(ENV);
  const connection = redisConnection(env.REDIS_URL);
  const automations = app.get(AutomationsService);
  const documents = app.get(DocumentsService);
  const integrations = app.get(IntegrationsService);
  const retention = app.get(RetentionService);
  const calls = app.get(CallsService);
  const chat = app.get(ChatService);
  const mailboxes = app.get(MailboxesService);

  await registerSchedules(env);

  const workers = [
    new Worker(
      QUEUES.automations,
      async (job: Job) => {
        switch (job.name) {
          case "daily":
            return automations.runAll();
          case "leads":
            return { assigned: await automations.assignNewLeads(), firstContact: await automations.firstContactReminders(new Date()), unanswered: await automations.unansweredMessages(new Date()) };
          case "hourly":
            return automations.hourly();
          case "retention":
            return retention.run();
          case "mail-sync":
            return mailboxes.enqueueSyncAll();
          case "call-log":
            return calls.syncCallLog();
          default:
            throw new Error(`Unknown automation job ${job.name}`);
        }
      },
      { connection, concurrency: 1 },
    ),
    new Worker(
      QUEUES.documents,
      async (job: Job<{ versionId?: string; attachmentId?: string }>) => (job.name === "chat-scan" ? chat.scanAttachment(job.data.attachmentId!) : documents.scan(job.data.versionId!)),
      { connection, concurrency: 2 },
    ),
    new Worker(
      QUEUES.integrations,
      async (job: Job<{ integrationJobId?: string; callId?: string; attempt?: number }>) =>
        job.name === "call.poll"
          ? calls.poll(job.data.callId!, job.data.attempt ?? 0)
          : integrations.execute(job.data.integrationJobId!, job.attemptsMade + 1, job.opts.attempts ?? DEFAULT_ATTEMPTS),
      { connection, concurrency: 4 },
    ),
    new Worker(
      QUEUES.mail,
      async (job: Job<{ mailboxId?: string; emailMessageId?: string }>) =>
        job.name === "mailbox.markRead" ? mailboxes.markReadAtProvider(job.data.emailMessageId!) : mailboxes.sync(job.data.mailboxId!),
      { connection, concurrency: 4 },
    ),
  ];
  for (const w of workers) {
    w.on("failed", (job, err) => log.warn({ queue: w.name, job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }, "Job failed"));
    w.on("error", (err) => log.error({ queue: w.name, err: err.message }, "Worker error"));
  }
  log.log("Workers started");
  return async () => {
    await Promise.all(workers.map((w) => w.close()));
  };
}
