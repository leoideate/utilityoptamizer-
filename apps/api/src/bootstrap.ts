import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Prisma } from "@prisma/client";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { map } from "rxjs";
import { ENV, type Env } from "./config/env";

/** Converts Prisma Decimals to plain numbers in every JSON response. */
function plain(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toNumber();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** Shared HTTP setup for main.ts and the integration tests. */
export function configureApp(app: INestApplication) {
  const env = app.get<Env>(ENV);
  app.setGlobalPrefix("api");
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(cookieParser());
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
  app.useGlobalInterceptors({ intercept: (_ctx, next) => next.handle().pipe(map(plain)) });
  app.enableShutdownHooks();
  return env;
}

export function buildOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle("Utility Optimizer CRM API")
    .setDescription(
      "REST API for the Utility Optimizer CRM. Authenticate with POST /api/auth/login (session cookie). " +
        "State-changing requests must send the X-CSRF-Token header with the token returned by login or /api/auth/me. " +
        "Errors use { statusCode, message, issues? }; 422 means a business rule was not met.",
    )
    .setVersion("0.1.0")
    .addCookieAuth("uo_session")
    .addApiKey({ type: "apiKey", in: "header", name: "X-CSRF-Token" }, "csrf")
    .build();
  return SwaggerModule.createDocument(app, config);
}
