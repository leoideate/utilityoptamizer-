import { Injectable } from "@nestjs/common";
import { Prisma, type TimelineKind } from "@prisma/client";
import type { Actor } from "../common/actor";
import { actorRef } from "../common/actor";
import type { Db } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";
import { redact } from "../common/redact";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  data?: Record<string, unknown>;
}

export interface TimelineInput {
  opportunityId?: string | null;
  customerId?: string | null;
  kind: TimelineKind;
  body: string;
  direction?: "inbound" | "outbound" | null;
  data?: Record<string, unknown>;
  occurredAt?: Date;
  correctsId?: string | null;
}

/**
 * Writes the append-only audit log and the opportunity/customer timeline.
 * Both tables are protected by database triggers: rows can be added, never changed.
 * Callers pass `db` so entries commit atomically with the change they describe.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(actor: Actor, input: AuditInput, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorId: actorRef(actor),
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: input.summary,
        data: input.data ? (redact(input.data) as Prisma.InputJsonValue) : undefined,
        ip: actor.ip ?? null,
      },
    });
  }

  /** Records that restricted data was viewed (DOB, bank details, sensitive documents...). */
  async sensitiveAccess(actor: Actor, entityType: string, entityId: string, what: string, db: Db = this.prisma) {
    await this.log(actor, { action: "sensitive.read", entityType, entityId, summary: `Viewed ${what}` }, db);
  }

  /** Timeline entries must describe what happened without including restricted values. */
  async timeline(actor: Actor, input: TimelineInput, db: Db = this.prisma) {
    return db.timelineEntry.create({
      data: {
        opportunityId: input.opportunityId ?? null,
        customerId: input.customerId ?? null,
        kind: input.kind,
        body: input.body,
        direction: input.direction ?? null,
        data: input.data ? (redact(input.data) as Prisma.InputJsonValue) : undefined,
        actorId: actorRef(actor),
        occurredAt: input.occurredAt ?? new Date(),
        correctsId: input.correctsId ?? null,
      },
    });
  }

  /** Both at once: the common case for opportunity changes. */
  async record(actor: Actor, a: AuditInput, t: TimelineInput, db: Db = this.prisma) {
    await this.log(actor, a, db);
    await this.timeline(actor, t, db);
  }
}
