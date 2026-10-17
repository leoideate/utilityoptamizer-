import { Controller, Delete, Get, HttpCode, Inject, Module, Param, ParseUUIDPipe, Post, Query, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { CookieOptions, Response } from "express";
import { z } from "zod";
import { ENV, type Env } from "../config/env";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import type { AuthedRequest } from "../auth/guards";
import { MAIL_OAUTH, MAIL_PROVIDERS, MailboxConnectError, MailboxesService, type MailProviders } from "./mailboxes.service";
import { MailOAuth } from "./oauth";
import { GmailMailProvider, GraphMailProvider } from "./providers";

const Id = new ParseUUIDPipe({ version: "4" });
const MAILBOX_FLOW_COOKIE = "uo_mailbox";
const MAILBOX_PATH = "/api/mailboxes";
const listQuery = z.object({
  folder: z.enum(["inbox", "sent"]).default("inbox"),
  unread: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

@ApiTags("email")
@Controller()
export class MailboxesController {
  constructor(
    private readonly mailboxes: MailboxesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private cookie(): CookieOptions {
    return { secure: this.env.COOKIE_SECURE, sameSite: "lax", httpOnly: true, path: MAILBOX_PATH };
  }

  /** The caller's connected mailboxes, and which providers can be connected. */
  @Get("mailboxes")
  async mine(@CurrentUser() a: Actor) {
    return { available: this.mailboxes.available(), mailboxes: await this.mailboxes.mine(a) };
  }

  /** Starts connecting the caller's own Outlook or Gmail mailbox (a browser navigation, not an API call). */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("mailboxes/:provider/connect")
  async connect(@CurrentUser() a: Actor, @Param("provider") provider: string, @Res() res: Response) {
    try {
      const { url, cookie, maxAgeMs } = await this.mailboxes.startConnect(a, provider);
      res.cookie(MAILBOX_FLOW_COOKIE, cookie, { ...this.cookie(), maxAge: maxAgeMs });
      res.redirect(302, url);
    } catch (e) {
      res.redirect(302, `/account?mailbox=${e instanceof MailboxConnectError ? e.code : "mailbox_failed"}`);
    }
  }

  /** The provider redirects here after consent; returns to the Account page with the outcome. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("mailboxes/:provider/callback")
  async callback(@CurrentUser() a: Actor, @Param("provider") provider: string, @Query() q: { code?: string; state?: string; error?: string }, @Req() req: AuthedRequest, @Res() res: Response) {
    res.clearCookie(MAILBOX_FLOW_COOKIE, this.cookie());
    try {
      await this.mailboxes.completeConnect(a, provider, q, req.cookies?.[MAILBOX_FLOW_COOKIE]);
      res.redirect(302, "/account?mailbox=connected");
    } catch (e) {
      res.redirect(302, `/account?mailbox=${e instanceof MailboxConnectError ? e.code : "mailbox_failed"}`);
    }
  }

  @Delete("mailboxes/:id")
  @HttpCode(204)
  disconnect(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.mailboxes.disconnect(a, id);
  }

  @Post("mailboxes/:id/sync")
  @HttpCode(202)
  sync(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.mailboxes.requestSync(a, id);
  }

  @Get("mailbox/messages")
  list(@CurrentUser() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.mailboxes.list(a, q);
  }

  @Get("mailbox/unread-count")
  async unread(@CurrentUser() a: Actor) {
    return { count: await this.mailboxes.unreadCount(a) };
  }

  @Get("emails/:id")
  get(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.mailboxes.get(a, id);
  }
}

@Module({
  controllers: [MailboxesController],
  providers: [
    MailboxesService,
    { provide: MAIL_OAUTH, inject: [ENV], useFactory: (env: Env) => new MailOAuth(env) },
    {
      provide: MAIL_PROVIDERS,
      inject: [ENV],
      useFactory: (env: Env): MailProviders => ({ microsoft: new GraphMailProvider(env.MAIL_GRAPH_URL), google: new GmailMailProvider(env.MAIL_GMAIL_URL, env.MAIL_BACKFILL_DAYS) }),
    },
  ],
  exports: [MailboxesService],
})
export class MailboxesModule {}
