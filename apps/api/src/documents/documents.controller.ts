import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { documentItemSchema, documentReviewSchema } from "@uo/shared";
import { memoryStorage } from "multer";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { RuleViolation } from "../common/errors";
import { ZodPipe } from "../common/zod.pipe";
import { DocumentsService } from "./documents.service";

const Id = new ParseUUIDPipe({ version: "4" });
/** Hard cap at the HTTP layer; the configured MAX_UPLOAD_MB is checked in the service. */
export const uploadInterceptor = () => FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });

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

  @Post("documents/:id/review")
  @HttpCode(204)
  review(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(documentReviewSchema)) body: z.infer<typeof documentReviewSchema>) {
    return this.docs.review(a, id, body);
  }
}
