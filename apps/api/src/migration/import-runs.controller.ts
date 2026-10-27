import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser, RequireCapability } from "../common/decorators";
import { RuleViolation } from "../common/errors";
import { ZodPipe } from "../common/zod.pipe";
import { uploadInterceptor } from "../documents/documents.controller";
import { ImportRunsService } from "./import-runs.service";

const Id = new ParseUUIDPipe({ version: "4" });
const flag = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).default(false);
const optionsSchema = z.object({
  allowFormatExceptions: flag,
  createSuppliers: flag,
  /** Sheet name → user id, or null for unassigned. Sent as JSON text with the upload. */
  agents: z
    .union([z.record(z.string().max(200), z.string().uuid().nullable()), z.string().transform((s, ctx) => {
      try {
        return z.record(z.string().max(200), z.string().uuid().nullable()).parse(s ? JSON.parse(s) : {});
      } catch {
        ctx.addIssue({ code: "custom", message: "The salesperson choices couldn't be read." });
        return z.NEVER;
      }
    })])
    .default({}),
  /** Sheet name → email: salespeople to add as users when importing, so their deals are assigned to them. */
  newAgents: z
    .union([z.record(z.string().max(200), z.string().trim().toLowerCase().email()), z.string().transform((s, ctx) => {
      try {
        return z.record(z.string().max(200), z.string().trim().toLowerCase().email()).parse(s ? JSON.parse(s) : {});
      } catch {
        ctx.addIssue({ code: "custom", message: "Enter a valid email for each new salesperson." });
        return z.NEVER;
      }
    })])
    .default({}),
});

/** Administration → Import customers: dry run a master sheet, then import it. Administrators only. */
@ApiTags("admin")
@Controller("admin/imports")
export class ImportRunsController {
  constructor(private readonly runs: ImportRunsService) {}

  @Get()
  @RequireCapability("admin.import")
  list() {
    return this.runs.list();
  }

  @Post()
  @RequireCapability("admin.import")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(uploadInterceptor())
  dryRun(@CurrentUser() a: Actor, @Body(new ZodPipe(optionsSchema)) body: z.infer<typeof optionsSchema>, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new RuleViolation(["Choose the master sheet (.xlsx) to upload."]);
    return this.runs.dryRun(a, file, body);
  }

  @Get(":id")
  @RequireCapability("admin.import")
  get(@Param("id", Id) id: string) {
    return this.runs.get(id);
  }

  /** Imports for real from a finished dry run. */
  @Post(":id/import")
  @RequireCapability("admin.import")
  commit(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(optionsSchema)) body: z.infer<typeof optionsSchema>) {
    return this.runs.commit(a, id, body);
  }
}
