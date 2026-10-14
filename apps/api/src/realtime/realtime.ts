import { EventEmitter } from "node:events";
import { Controller, Get, Global, Inject, Injectable, Logger, Module, type OnModuleDestroy, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Response } from "express";
import Redis from "ioredis";
import { ENV, type Env } from "../config/env";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import type { AuthedRequest } from "../auth/guards";

/**
 * Real-time updates for signed-in users (new chat messages, call status, notifications), sent as
 * Server-Sent Events over the normal session cookie. Events are addressed to user ids and fanned
 * out through Redis so every API instance can deliver them. Events carry ids and display data only;
 * clients re-fetch anything they need through the normal, permission-checked API.
 */
export interface RealtimeEvent {
  type: "chat.message" | "chat.message.updated" | "chat.read" | "call.updated" | "notification";
  data: Record<string, unknown>;
}

interface Envelope {
  userIds: string[];
  event: RealtimeEvent;
}

export interface RealtimeBus {
  publish(userIds: string[], event: RealtimeEvent): Promise<void>;
  subscribe(handler: (e: Envelope) => void): void;
  close(): Promise<void>;
}

export const REALTIME_BUS = Symbol("REALTIME_BUS");

/** Single-process bus (tests, or a single API instance without Redis). */
export class LocalRealtimeBus implements RealtimeBus {
  private readonly emitter = new EventEmitter();
  readonly published: Envelope[] = [];
  async publish(userIds: string[], event: RealtimeEvent) {
    const e = { userIds: [...new Set(userIds)], event };
    this.published.push(e);
    this.emitter.emit("event", e);
  }
  subscribe(handler: (e: Envelope) => void) {
    this.emitter.on("event", handler);
  }
  async close() {
    this.emitter.removeAllListeners();
  }
}

const CHANNEL = "uo:realtime";

export class RedisRealtimeBus implements RealtimeBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly log = new Logger("RealtimeBus");
  constructor(url: string) {
    this.pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.sub = new Redis(url, { lazyConnect: false });
    this.pub.on("error", (e) => this.log.warn(`Redis publish connection: ${e.message}`));
    this.sub.on("error", (e) => this.log.warn(`Redis subscribe connection: ${e.message}`));
  }
  async publish(userIds: string[], event: RealtimeEvent) {
    if (!userIds.length) return;
    await this.pub.publish(CHANNEL, JSON.stringify({ userIds: [...new Set(userIds)], event }));
  }
  subscribe(handler: (e: Envelope) => void) {
    void this.sub.subscribe(CHANNEL);
    this.sub.on("message", (_ch, raw) => {
      try {
        handler(JSON.parse(raw) as Envelope);
      } catch {
        /* ignore malformed */
      }
    });
  }
  async close() {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

/** Keeps each user's open event streams and writes events to them. */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly streams = new Map<string, Set<Response>>();

  constructor(@Inject(REALTIME_BUS) private readonly bus: RealtimeBus) {
    this.bus.subscribe(({ userIds, event }) => {
      const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
      for (const id of userIds) for (const res of this.streams.get(id) ?? []) res.write(payload);
    });
  }

  publish(userIds: (string | null | undefined)[], event: RealtimeEvent) {
    const ids = userIds.filter((x): x is string => !!x);
    return this.bus.publish(ids, event).catch(() => undefined);
  }

  attach(userId: string, res: Response) {
    const set = this.streams.get(userId) ?? new Set<Response>();
    set.add(res);
    this.streams.set(userId, set);
    return () => {
      set.delete(res);
      if (!set.size) this.streams.delete(userId);
    };
  }

  connectedUsers() {
    return [...this.streams.keys()];
  }

  async onModuleDestroy() {
    for (const set of this.streams.values()) for (const res of set) res.end();
    await this.bus.close();
  }
}

@ApiTags("realtime")
@Controller("realtime")
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  /** Server-Sent Events stream for the signed-in user. Reconnects automatically in the browser. */
  @SkipThrottle()
  @Get("stream")
  stream(@CurrentUser() actor: Actor, @Req() req: AuthedRequest, @Res() res: Response) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(`retry: 5000\nevent: ready\ndata: {}\n\n`);
    const detach = this.realtime.attach(actor.id, res);
    // Comment lines keep proxies from closing an idle connection.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      detach();
    });
  }
}

@Global()
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeService, { provide: REALTIME_BUS, inject: [ENV], useFactory: (env: Env): RealtimeBus => new RedisRealtimeBus(env.REDIS_URL) }],
  exports: [RealtimeService],
})
export class RealtimeModule {}
