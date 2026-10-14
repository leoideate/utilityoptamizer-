import { Injectable } from "@nestjs/common";
import type { Opportunity, Prisma, Stage } from "@prisma/client";
import { type StageKey, can, canReadOpportunity, canWriteOpportunity } from "@uo/shared";
import type { Actor } from "../common/actor";
import { Forbidden, NotFound } from "../common/errors";
import type { Db } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";

export type OppWithStage = Opportunity & { stage: Stage; stageKey: StageKey | null };

/** Row-level access to opportunities. Every service that touches an opportunity goes through here. */
@Injectable()
export class OpportunityAccess {
  constructor(private readonly prisma: PrismaService) {}

  async load(id: string, db: Db = this.prisma): Promise<OppWithStage> {
    const opp = await db.opportunity.findUnique({ where: { id }, include: { stage: true } });
    if (!opp) throw new NotFound("Opportunity");
    return { ...opp, stageKey: opp.stage.key as StageKey | null };
  }

  async readable(actor: Actor, id: string, db: Db = this.prisma) {
    const opp = await this.load(id, db);
    if (!canReadOpportunity(actor, { ownerId: opp.ownerId })) throw new NotFound("Opportunity");
    return opp;
  }

  async writable(actor: Actor, id: string, db: Db = this.prisma) {
    const opp = await this.load(id, db);
    if (!canReadOpportunity(actor, { ownerId: opp.ownerId })) throw new NotFound("Opportunity");
    if (!canWriteOpportunity(actor, { ownerId: opp.ownerId })) throw new Forbidden("You can view this opportunity but not change it.");
    return opp;
  }

  /** Prisma filter restricting a list to what the actor may see. */
  visibleWhere(actor: Actor): Prisma.OpportunityWhereInput {
    if (can(actor, "opportunity.read_all")) return {};
    if (actor.roles.includes("salesperson")) return { OR: [{ ownerId: actor.id }, { ownerId: null }] };
    return { id: { in: [] } };
  }
}
