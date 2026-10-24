import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { billCheckSchema, formReviewSchema, formSignatureSchema, formTemplateMetaSchema, formTemplateUpdateSchema, generateFormSchema } from "@uo/shared";
import { memoryStorage } from "multer";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { RuleViolation } from "../common/errors";
import { ZodPipe } from "../common/zod.pipe";
import { uploadInterceptor } from "../documents/documents.controller";
import { FormsService } from "./forms.service";

const Id = new ParseUUIDPipe({ version: "4" });
const OptId = new ZodPipe(z.string().uuid().optional());
const signatureInterceptor = () => FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 10, parts: 20 } });

/** Multipart text fields arrive as strings; "true" becomes a boolean before validation. */
const multipartBools = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body ?? {}).map(([k, v]) => [k, v === "true" ? true : v === "false" ? false : v === "" ? null : v]));

@ApiTags("forms")
@Controller()
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  /** Active templates, optionally for one supplier (plus templates for any supplier). */
  @Get("form-templates")
  templates(@Query("supplierId", OptId) supplierId?: string) {
    return this.forms.templates(supplierId);
  }

  /** Every template, including retired ones (template managers). */
  @Get("form-templates/all")
  all(@CurrentUser() a: Actor) {
    return this.forms.allTemplates(a);
  }

  @Get("form-templates/:id")
  async template(@Param("id", Id) id: string) {
    const { storageKey: _key, ...t } = await this.forms.template(id);
    return t;
  }

  @Get("form-templates/:id/file")
  async file(@Param("id", Id) id: string) {
    return new StreamableFile(await this.forms.templateFile(id), { type: "application/pdf", disposition: "inline" });
  }

  @Post("form-templates")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(uploadInterceptor())
  create(@CurrentUser() a: Actor, @Body() body: Record<string, unknown>, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new RuleViolation(["Choose the supplier's PDF."]);
    return this.forms.createTemplate(a, new ZodPipe(formTemplateMetaSchema).transform(multipartBools(body)), file);
  }

  @Patch("form-templates/:id")
  @HttpCode(204)
  update(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(formTemplateUpdateSchema)) body: z.infer<typeof formTemplateUpdateSchema>) {
    return this.forms.updateTemplate(a, id, body);
  }

  @Get("opportunities/:id/forms")
  list(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.forms.list(a, id);
  }

  @Get("opportunities/:id/forms/prefill")
  prefill(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Query("templateId", Id) templateId: string) {
    return this.forms.prefill(a, id, templateId);
  }

  @Post("opportunities/:id/forms")
  generate(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(generateFormSchema)) body: z.infer<typeof generateFormSchema>) {
    return this.forms.generate(a, id, body);
  }

  /** Uploads one signer's signature (PNG) with how they authorised it for this form. */
  @Post("forms/:id/signatures")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(signatureInterceptor())
  sign(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body() body: Record<string, unknown>, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new RuleViolation(["Choose the signature image."]);
    return this.forms.addSignature(a, id, new ZodPipe(formSignatureSchema).transform(multipartBools(body)), file);
  }

  /** Uploads the form as the customer signed it on paper (a scanned PDF), for review by someone else. */
  @Post("forms/:id/signed-copy")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(uploadInterceptor())
  signedCopy(@CurrentUser() a: Actor, @Param("id", Id) id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new RuleViolation(["Choose the signed PDF."]);
    return this.forms.uploadSignedCopy(a, id, file);
  }

  @Post("forms/:id/review")
  @HttpCode(204)
  review(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(formReviewSchema)) body: z.infer<typeof formReviewSchema>) {
    return this.forms.review(a, id, body);
  }

  /** Makes the black and white copy of a form, for external parties that need one. */
  @Post("forms/:id/mono")
  mono(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.forms.monoCopy(a, id);
  }

  @Get("opportunities/:id/bill-checks")
  billChecks(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.forms.billChecks(a, id);
  }

  @Post("opportunities/:id/bill-checks")
  checkBill(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(billCheckSchema)) body: z.infer<typeof billCheckSchema>) {
    return this.forms.checkBill(a, id, body);
  }

  @Get("opportunities/:id/switch-conflicts")
  conflicts(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.forms.switchConflicts(a, id);
  }
}
