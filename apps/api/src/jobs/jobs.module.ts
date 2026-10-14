import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ENV, type Env } from "../config/env";
import { BullJobQueue, JOB_QUEUE, type JobQueue } from "./queue";

export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

@Global()
@Module({
  providers: [{ provide: JOB_QUEUE, inject: [ENV], useFactory: (env: Env): JobQueue => new BullJobQueue(redisConnection(env.REDIS_URL)) }],
  exports: [JOB_QUEUE],
})
export class JobsModule implements OnApplicationShutdown {
  private readonly log = new Logger(JobsModule.name);
  constructor(@Inject(JOB_QUEUE) private readonly queue: JobQueue) {}
  async onApplicationShutdown() {
    if (this.queue instanceof BullJobQueue) {
      await this.queue.close();
      this.log.log("Job queues closed");
    }
  }
}
