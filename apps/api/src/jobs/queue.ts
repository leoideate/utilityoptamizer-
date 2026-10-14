import { Queue, type ConnectionOptions } from "bullmq";

export const QUEUES = {
  /** Scheduled CRM automations (reminders, activation, renewals). */
  automations: "automations",
  /** Outbound integrations with retries and dead-lettering. */
  integrations: "integrations",
  /** Document processing (virus scanning). */
  documents: "documents",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface EnqueueOptions {
  /** Deduplicates: a job with the same id isn't added twice. */
  jobId?: string;
  delayMs?: number;
  attempts?: number;
}

/** Abstraction over BullMQ so domain services don't depend on Redis directly. */
export interface JobQueue {
  add(queue: QueueName, name: string, data: Record<string, unknown>, opts?: EnqueueOptions): Promise<void>;
}

export const JOB_QUEUE = Symbol("JOB_QUEUE");

/** Exponential backoff: 30 s, 1 min, 2 min, 4 min... */
export const DEFAULT_ATTEMPTS = 6;
export const BACKOFF = { type: "exponential" as const, delay: 30_000 };

export class BullJobQueue implements JobQueue {
  private readonly queues = new Map<QueueName, Queue>();
  constructor(private readonly connection: ConnectionOptions) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async add(queue: QueueName, name: string, data: Record<string, unknown>, opts: EnqueueOptions = {}) {
    await this.queue(queue).add(name, data, {
      jobId: opts.jobId,
      delay: opts.delayMs,
      attempts: opts.attempts ?? DEFAULT_ATTEMPTS,
      backoff: BACKOFF,
      removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
      // Failed jobs are kept for inspection; IntegrationJob rows carry the dead-letter state.
      removeOnFail: false,
    });
  }

  async close() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/** Records jobs instead of sending them to Redis. Used by the integration tests. */
export class RecordingJobQueue implements JobQueue {
  readonly jobs: { queue: QueueName; name: string; data: Record<string, unknown>; opts?: EnqueueOptions }[] = [];
  async add(queue: QueueName, name: string, data: Record<string, unknown>, opts?: EnqueueOptions) {
    if (opts?.jobId && this.jobs.some((j) => j.opts?.jobId === opts.jobId)) return;
    this.jobs.push({ queue, name, data, opts });
  }
}
