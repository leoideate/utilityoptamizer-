import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { ocrConfirmSchema } from "@uo/shared";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { RuleViolation } from "../common/errors";
import { ZodPipe } from "../common/zod.pipe";
import { uploadInterceptor } from "../documents/documents.controller";
import { OcrService } from "./ocr.service";

const Id = new ParseUUIDPipe({ version: "4" });
const fieldsSchema = z.object({
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  mobile: z.string().nullable().optional(),
});

@ApiTags("business-cards")
@Controller("business-cards")
export class OcrController {
  constructor(private readonly ocr: OcrService) {}

  @Post()
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(uploadInterceptor())
  upload(@CurrentUser() a: Actor, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new RuleViolation(["Choose a photo of the card."]);
    return this.ocr.upload(a, file);
  }

  @Get(":id")
  get(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.ocr.get(a, id);
  }

  @Post(":id/retry")
  retry(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.ocr.process(a, id);
  }

  /** Re-check duplicates after the user corrects the fields. */
  @Post(":id/duplicates")
  @HttpCode(200)
  duplicates(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(fieldsSchema)) body: z.infer<typeof fieldsSchema>) {
    return this.ocr.duplicates(a, id, body);
  }

  @Post(":id/confirm")
  confirm(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(ocrConfirmSchema)) body: z.infer<typeof ocrConfirmSchema>) {
    return this.ocr.confirm(a, id, body);
  }

  @Post(":id/discard")
  @HttpCode(204)
  discard(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.ocr.discard(a, id);
  }
}
