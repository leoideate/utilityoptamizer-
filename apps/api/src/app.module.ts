import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "node:crypto";
import { AuthModule } from "./auth/auth.module";
import { CapabilityGuard, CsrfGuard, SessionGuard } from "./auth/guards";
import { CommonModule } from "./common/common.module";
import { HttpErrorFilter } from "./common/http-error.filter";
import { REDACT_PATHS } from "./common/redact";
import { ConfigModule } from "./config/config.module";
import { JobsModule } from "./jobs/jobs.module";
import { FEATURE_MODULES } from "./modules";
import { RealtimeModule } from "./realtime/realtime";
import { StorageModule } from "./storage/storage.module";

const logLevel = process.env.LOG_LEVEL ?? "info";

/** Human-readable logs in development, if pino-pretty is installed (it isn't in production images). */
function prettyTransport() {
  if (process.env.NODE_ENV !== "development") return undefined;
  try {
    require.resolve("pino-pretty");
    return { target: "pino-pretty", options: { singleLine: true } };
  } catch {
    return undefined;
  }
}

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: logLevel,
        redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
        genReqId: (req, res) => {
          const id = (req.headers["x-request-id"] as string) || randomUUID();
          res.setHeader("x-request-id", id);
          return id;
        },
        customProps: (req) => ({ userId: (req as { user?: { id: string } }).user?.id }),
        autoLogging: { ignore: (req) => req.url === "/api/health" },
        transport: prettyTransport(),
      },
    }),
    // Default: 300 requests/minute per IP. Login has its own stricter limit.
    ThrottlerModule.forRoot({ throttlers: [{ name: "default", ttl: 60_000, limit: 300 }], skipIf: () => process.env.NODE_ENV === "test" }),
    CommonModule,
    StorageModule,
    JobsModule,
    AuthModule,
    RealtimeModule,
    ...FEATURE_MODULES,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    // Order matters: rate limit → session → CSRF → capability.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
  ],
})
export class AppModule {}
