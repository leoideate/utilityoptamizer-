import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { documentItemSchema, documentReviewSchema, removeWithReasonSchema } from "@uo/shared";
import { memoryStorage } from "multer";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { RuleViolation } from "../common/errors";
import { ZodPipe } from "../common/zod.pipe";
import { DocumentsService } from "./documents.service";

const Id = new ParseUUIDPipe({ version: "4" });
/** Uploads are buffered in memory, so the configured size limit is enforced while receiving, not after. */
export const uploadLimitBytes = () => (Number(process.env.MAX_UPLOAD_MB) || 20) * 1024 * 1024;
export const uploadInterceptor = () => FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: uploadLimitBytes(), files: 1, fields: 20, parts: 30 } });

@ApiTags("documents")
@Controller()
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get("opportunities/:id/documents")
  list(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.docs.checklist(a, id);
  }

  @Post("opportunities/:id/documents")
  add(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(documentItemSchema)) body: z.infer<typeof documentItemSchema>) {
    return this.docs.addItem(a, id, body);
  }

  @Post("opportunities/:id/documents/standard")
  standard(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.docs.addStandard(a, id);
  }

  @Post("opportunities/:id/documents/request")
  @HttpCode(204)
  request(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ itemIds: z.array(z.string().uuid()).min(1) }))) body: { itemIds: string[] }) {
    return this.docs.request(a, id, body.itemIds);
  }

  @Patch("documents/:id")
  @HttpCode(204)
  setRequired(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ required: z.boolean() }))) body: { required: boolean }) {
    return this.docs.setRequired(a, id, body.required);
  }

  @Post("documents/:id/versions")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(uploadInterceptor())
  upload(@CurrentUser() a: Actor, @Param("id", Id) id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new RuleViolation(["Choose a file to upload."]);
    return this.docs.upload(a, id, file);
  }

  /** Returns a short-lived signed link (S3 or local). Sensitive files are restricted and logged. */
  @Get("document-versions/:id/url")
  url(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.docs.downloadUrl(a, id);
  }

  /** Removes a wrong upload; the file stays in the document's history with the reason. */
  @Post("document-versions/:id/remove")
  @HttpCode(204)
  removeVersion(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(removeWithReasonSchema)) body: z.infer<typeof removeWithReasonSchema>) {
    return this.docs.removeVersion(a, id, body.reason);
  }

  /** Deletes a checklist row nothing was ever uploaded to. */
  @Delete("documents/:id")
  @HttpCode(204)
  deleteItem(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.docs.deleteItem(a, id);
  }

  @Post("documents/:id/review")
  @HttpCode(204)
  review(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(documentReviewSchema)) body: z.infer<typeof documentReviewSchema>) {
    return this.docs.review(a, id, body);
  }
}
