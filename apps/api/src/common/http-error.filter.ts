import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import type { Response } from "express";
import { ZodError } from "zod";
import { Conflict, Forbidden, NotFound, RuleViolation } from "./errors";

/**
 * One error shape for every response: { statusCode, message, issues? }.
 * Unexpected errors are logged with a reference and never leak internals to the client.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly log = new Logger("HttpError");

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (statusCode: number, message: string, issues?: string[]) =>
      res.status(statusCode).json(issues ? { statusCode, message, issues } : { statusCode, message });

    if (err instanceof RuleViolation) return send(422, err.issues.length === 1 ? err.issues[0] : "Please fix the following.", err.issues);
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
      return send(400, "Some details are missing or invalid.", issues);
    }
    if (err instanceof Forbidden) return send(403, err.message);
    if (err instanceof NotFound) return send(404, err.message);
    if (err instanceof Conflict) return send(409, err.message);
    if (err instanceof ThrottlerException) return send(429, "Too many attempts. Please wait a minute and try again.");
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const message = typeof body === "string" ? body : ((body as { message?: string | string[] }).message ?? err.message);
      return send(err.getStatus(), Array.isArray(message) ? message.join(" ") : message);
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") return send(409, "That record already exists.");
      if (err.code === "P2025") return send(404, "Record not found.");
    }
    const ref = randomBytes(4).toString("hex");
    this.log.error({ err, ref }, "Unhandled error");
    return send(500, `Something went wrong. Reference: ${ref}`);
  }
}
