import { readFileSync } from "node:fs";
import path from "node:path";
import { Controller, Get, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

/** The team's CRM guide (a self-contained page with its screenshots embedded), for signed-in users only. */
const GUIDE_FILE = path.resolve(__dirname, "../../assets/crm-guide.html");
let guideHtml: Buffer | null = null;

@ApiTags("help")
@Controller("help")
export class HelpController {
  /** Shown inside the web app's Help & guide page (an iframe on the same origin), so it may be framed by it alone. */
  @Get("guide")
  guide(@Res() res: Response) {
    guideHtml ??= readFileSync(GUIDE_FILE);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    // Its own CSS, its small enlarge-a-screenshot script and the embedded images; nothing it loads from elsewhere.
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    res.send(guideHtml);
  }
}
