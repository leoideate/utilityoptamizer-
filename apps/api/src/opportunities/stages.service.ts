import { Injectable } from "@nestjs/common";
import { STAGES, type StageKey, normalizeStageName, stageDef } from "@uo/shared";
import { NotFound } from "../common/errors";
import type { Db } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";

export interface StageSyncReport {
  created: StageKey[];
  matchedByKey: StageKey[];
  matchedByName: string[];
  /** Existing stages outside the canonical pipeline (e.g. a legacy "Lost" column). Left untouched. */
  unmanaged: string[];
}

@Injectable()
export class StagesService {
  private cache = new Map<StageKey, string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent stage migration: matches by key, then by normalised name or alias, and inserts
   * only what's missing. Running it again changes nothing. Admin-chosen names are kept.
   */
  async sync(db: Db = this.prisma): Promise<StageSyncReport> {
    const report: StageSyncReport = { created: [], matchedByKey: [], matchedByName: [], unmanaged: [] };
    const existing = await db.stage.findMany({ orderBy: { sequence: "asc" } });
    const claimed = new Set<string>();

    for (const [i, def] of STAGES.entries()) {
      const sequence = (i + 1) * 10;
      let row = existing.find((s) => s.key === def.key);
      if (row) report.matchedByKey.push(def.key);
      else {
        const names = [def.name, ...(def.aliases ?? [])].map(normalizeStageName);
        row = existing.find((s) => !s.key && !claimed.has(s.id) && names.includes(normalizeStageName(s.name)));
        if (row) report.matchedByName.push(`${row.name} → ${def.key}`);
      }
      if (row) {
        claimed.add(row.id);
        if (row.key !== def.key || row.sequence !== sequence || row.probability !== def.probability || !row.active) {
          await db.stage.update({ where: { id: row.id }, data: { key: def.key, sequence, probability: def.probability, active: true } });
        }
      } else {
        await db.stage.create({ data: { key: def.key, name: def.name, sequence, probability: def.probability } });
        report.created.push(def.key);
      }
    }
    report.unmanaged = existing.filter((s) => !claimed.has(s.id)).map((s) => s.name);
    this.cache.clear();
    return report;
  }

  async idFor(key: StageKey, db: Db = this.prisma): Promise<string> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const row = await db.stage.findUnique({ where: { key } });
    if (!row) throw new NotFound(`Pipeline stage "${stageDef(key).name}" (run the database migration and seed)`);
    this.cache.set(key, row.id);
    return row.id;
  }

  list() {
    return this.prisma.stage.findMany({ where: { active: true }, orderBy: { sequence: "asc" } });
  }

  /** Admin: rename a stage (keys and order stay fixed because rules depend on them). */
  rename(id: string, name: string) {
    return this.prisma.stage.update({ where: { id }, data: { name } });
  }
}
