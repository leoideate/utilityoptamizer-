import { Controller, Get, Inject, NotFoundException, Query, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
import { Public } from "../common/decorators";
import { Forbidden } from "../common/errors";
import { LocalStorage, OBJECT_STORAGE, type ObjectStorage } from "./storage";

/** Serves signed, expiring links when STORAGE_DRIVER=local. With S3 the links go to S3 directly. */
@ApiExcludeController()
@Controller("files")
export class FilesController {
  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  @Public()
  @Get("local")
  async local(@Query("key") key: string, @Query("name") name: string, @Query("exp") exp: string, @Query("sig") sig: string, @Res() res: Response) {
    if (!(this.storage instanceof LocalStorage)) throw new NotFoundException();
    if (!key || !name || !sig || !this.storage.verifyLink(key, name, Number(exp), sig)) throw new Forbidden("This download link has expired.");
    const body = await this.storage.get(key);
    res.setHeader("Content-Disposition", `inline; filename="${name.replace(/["\r\n]/g, "")}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(body);
  }
}
