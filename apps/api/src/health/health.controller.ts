import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Response } from "express";
import { Public } from "../common/decorators";
import { PrismaService } from "../common/prisma.service";
import { BullJobQueue, JOB_QUEUE, type JobQueue, QUEUES } from "../jobs/queue";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";

/** Liveness/readiness for load balancers and monitoring. Returns 503 if a dependency is down. */
@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const run = async (fn: () => Promise<unknown>) => {
      try {
        await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))]);
        return "ok";
      } catch {
        return "down";
      }
    };
    const checks = {
      database: await run(() => this.prisma.$queryRaw`SELECT 1`),
      redis:
        this.queue instanceof BullJobQueue
          ? await run(async () => {
              const client = (await (this.queue as BullJobQueue).queue(QUEUES.automations).client) as unknown as { ping(): Promise<string> };
              await client.ping();
            })
          : "not_used",
      storage: await run(() => this.storage.ping()),
    };
    const ok = Object.values(checks).every((v) => v !== "down");
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "degraded", checks, time: new Date().toISOString() };
  }
}
