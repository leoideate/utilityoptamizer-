import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ImportRun, Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import type { Actor } from "../common/actor";
import { Conflict, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { OBJECT_STORAGE, type ObjectStorage } from "../storage/storage";
import { type CustomersImport, MigrationService } from "./migration.service";
import { readMasterSheet } from "./sheet";

const SHEET_TYPES = ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"];

export interface ImportRunOptions {
  allowFormatExceptions: boolean;
  createSuppliers: boolean;
  /** Sheet sales agent name → user id, or null to leave those deals unassigned. */
  agents: Record<string, string | null>;
}

/**
 * Customer imports run from Administration → Import customers. A run (dry run or real import)
 * starts in the background and is polled, because a sheet of a thousand rows takes longer than a
 * web request may: the page shows the report when it's done. An import is always confirmed from a
 * finished dry run of the same sheet, and re-running never duplicates (rows are keyed by importKey).
 */
@Injectable()
export class ImportRunsService {
  private readonly log = new Logger(ImportRunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly migration: MigrationService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** Uploads the sheet and starts a dry run. */
  async dryRun(actor: Actor, file: { originalname: string; mimetype: string; buffer: Buffer }, options: ImportRunOptions) {
    if (!/\.xlsx$/i.test(file.originalname) || !SHEET_TYPES.includes(file.mimetype)) throw new RuleViolation(["Upload the master sheet as an Excel .xlsx file."]);
    // Read it once now, so a file that isn't a sheet fails here rather than in the background.
    const tabs = await readMasterSheet(file.buffer).catch(() => null);
    if (!tabs?.some((t) => t.rows.length)) throw new RuleViolation(["No customer rows were found. Check the sheet has a header row with Business name, MPRN/GPRN and Contract status."]);
    const storageKey = `imports/${randomUUID()}.xlsx`;
    await this.storage.put(storageKey, file.buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const run = await this.prisma.importRun.create({
      data: {
        mode: "dry_run",
        filename: file.originalname.slice(0, 200),
        storageKey,
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
        options: options as unknown as Prisma.InputJsonValue,
        createdById: actor.id,
      },
    });
    await this.audit.log(actor, { action: "import.dry_run", entityType: "import_run", entityId: run.id, summary: `Dry run of ${run.filename}` });
    this.start(run, false);
    return this.view(run);
  }

  /** Imports for real from a finished dry run, with the agent choices made after seeing its report. */
  async commit(actor: Actor, dryRunId: string, options: ImportRunOptions) {
    const dry = await this.prisma.importRun.findUnique({ where: { id: dryRunId } });
    if (!dry || dry.mode !== "dry_run") throw new NotFound("Dry run");
    if (dry.status !== "done") throw new RuleViolation(["Wait for the dry run to finish, then import."]);
    const running = await this.prisma.importRun.findFirst({ where: { mode: "import", status: "running" } });
    if (running) throw new Conflict("An import is already running. Wait for it to finish.");
    const run = await this.prisma.importRun.create({
      data: { mode: "import", filename: dry.filename, storageKey: dry.storageKey, sha256: dry.sha256, options: options as unknown as Prisma.InputJsonValue, fromRunId: dry.id, createdById: actor.id },
    });
    await this.audit.log(actor, { action: "import.customers", entityType: "import_run", entityId: run.id, summary: `Importing customers from ${run.filename}` });
    this.start(run, true);
    return this.view(run);
  }

  async get(id: string) {
    const run = await this.prisma.importRun.findUnique({ where: { id } });
    if (!run) throw new NotFound("Import");
    return this.view(run, true);
  }

  async list() {
    const runs = await this.prisma.importRun.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
    return runs.map((r) => this.view(r));
  }

  private view(r: ImportRun, withLines = false) {
    const { storageKey: _key, lines, ...rest } = r;
    return { ...rest, ...(withLines ? { lines } : {}) };
  }

  /** Runs in the background; the row records the outcome. A restart mid-run leaves it "running", and running it again is safe. */
  private start(run: ImportRun, commit: boolean) {
    void (async () => {
      try {
        const tabs = await readMasterSheet(await this.storage.get(run.storageKey));
        const o = run.options as unknown as ImportRunOptions;
        const r: CustomersImport = await this.migration.importCustomers(tabs, { commit, allowFormatExceptions: o.allowFormatExceptions, createSuppliers: o.createSuppliers, agents: o.agents });
        const { lines, ...summary } = r;
        const counts = { created: 0, exists: 0, skipped: 0 };
        for (const l of lines) counts[l.action]++;
        await this.prisma.importRun.update({
          where: { id: run.id },
          data: { status: "done", finishedAt: new Date(), summary: { ...summary, ...counts, rows: lines.length } as unknown as Prisma.InputJsonValue, lines: lines as unknown as Prisma.InputJsonValue },
        });
      } catch (e) {
        this.log.error({ runId: run.id, err: (e as Error).message }, "Customer import failed");
        await this.prisma.importRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: new Date(), error: "The import stopped with an error. Rows already imported are kept; run it again to continue." } });
      }
    })();
  }
}
