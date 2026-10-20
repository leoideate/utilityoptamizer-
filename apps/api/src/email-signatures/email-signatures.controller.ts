import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { type CompanySignature, type EmailSignature, companySignatureSchema, emailSignatureSchema } from "@uo/shared";
import type { Response } from "express";
import { memoryStorage } from "multer";
import type { Actor } from "../common/actor";
import { CurrentUser, Public, RequireCapability } from "../common/decorators";
import { RuleViolation } from "../common/errors";
import { ZodPipe } from "../common/zod.pipe";
import { EmailSignaturesService } from "./email-signatures.service";

const imageInterceptor = () => FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1, fields: 5, parts: 10 } });

@ApiTags("email signatures")
@Controller()
export class EmailSignaturesController {
  constructor(private readonly signatures: EmailSignaturesService) {}

  @Get("account/email-signature")
  mine(@CurrentUser() a: Actor) {
    return this.signatures.mine(a);
  }

  @Put("account/email-signature")
  save(@CurrentUser() a: Actor, @Body(new ZodPipe(emailSignatureSchema)) body: EmailSignature) {
    return this.signatures.saveMine(a, body);
  }

  /** The person's own picture for their signature (PNG or JPEG, up to 1 MB). */
  @Post("account/email-signature/image")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(imageInterceptor())
  image(@CurrentUser() a: Actor, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new RuleViolation(["Choose a picture."]);
    return this.signatures.setMyImage(a, file);
  }

  @Get("admin/settings/email-signature")
  @RequireCapability("admin.integrations")
  async company() {
    const { logoImageId: _id, ...company } = await this.signatures.company();
    return company;
  }

  @Put("admin/settings/email-signature")
  @RequireCapability("admin.integrations")
  @HttpCode(204)
  saveCompany(@CurrentUser() a: Actor, @Body(new ZodPipe(companySignatureSchema)) body: CompanySignature) {
    return this.signatures.saveCompany(a, body);
  }

  @Post("admin/settings/email-signature/logo")
  @RequireCapability("admin.integrations")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(imageInterceptor())
  logo(@CurrentUser() a: Actor, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new RuleViolation(["Choose the logo."]);
    return this.signatures.setCompanyLogo(a, file);
  }

  /** Goes back to the letterhead logo. */
  @Delete("admin/settings/email-signature/logo")
  @RequireCapability("admin.integrations")
  resetLogo(@CurrentUser() a: Actor) {
    return this.signatures.setCompanyLogo(a, null);
  }

  /**
   * Signature pictures for recipients' mail apps. Public by design: they're logos and pictures
   * people chose to put in their email, addressed by an unguessable id, and never documents.
   */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get("public/email-images/:id")
  async publicImage(@Param("id") id: string, @Res() res: Response) {
    const img = await this.signatures.image(id);
    res.setHeader("Content-Type", img.mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(img.bytes);
  }
}
