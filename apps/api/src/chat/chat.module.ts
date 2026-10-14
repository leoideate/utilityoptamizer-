import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { chatChannelSchema, chatMessageSchema } from "@uo/shared";
import { memoryStorage } from "multer";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { ChatService } from "./chat.service";

const Id = new ParseUUIDPipe({ version: "4" });

/** Multipart messages send `body` and `mentions` (JSON array) as fields; plain JSON is also accepted. */
const multipartMessage = z.preprocess(
  (v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return { body: o.body ?? "", mentions: typeof o.mentions === "string" ? (o.mentions ? JSON.parse(o.mentions) : []) : (o.mentions ?? []) };
  },
  chatMessageSchema,
);

@ApiTags("chat")
@Controller("chat")
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get("channels")
  list(@CurrentUser() a: Actor) {
    return this.chat.list(a);
  }

  @Post("channels")
  create(@CurrentUser() a: Actor, @Body(new ZodPipe(chatChannelSchema)) body: z.infer<typeof chatChannelSchema>) {
    return this.chat.createChannel(a, body);
  }

  @Post("direct/:userId")
  direct(@CurrentUser() a: Actor, @Param("userId", Id) userId: string) {
    return this.chat.openDirect(a, userId);
  }

  @Get("opportunities/:id")
  deal(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.chat.dealChannel(a, id);
  }

  @Get("channels/:id/messages")
  messages(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Query("before") before?: string) {
    return this.chat.messages(a, id, before && !Number.isNaN(Date.parse(before)) ? before : undefined);
  }

  @Get("channels/:id/mentionable")
  mentionable(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.chat.mentionable(a, id);
  }

  @Post("channels/:id/messages")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiConsumes("multipart/form-data", "application/json")
  @UseInterceptors(FilesInterceptor("files", 5, { storage: memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }))
  post(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(multipartMessage)) body: z.infer<typeof chatMessageSchema>, @UploadedFiles() files?: Express.Multer.File[]) {
    return this.chat.post(a, id, body, files ?? []);
  }

  @Post("channels/:id/read")
  @HttpCode(204)
  read(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.chat.markRead(a, id);
  }

  @Post("channels/:id/join")
  @HttpCode(204)
  join(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.chat.join(a, id);
  }

  @Post("channels/:id/leave")
  @HttpCode(204)
  leave(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.chat.leave(a, id);
  }

  @Post("channels/:id/members")
  @HttpCode(204)
  addMembers(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ userIds: z.array(z.string().uuid()).min(1).max(200) }))) body: { userIds: string[] }) {
    return this.chat.addMembers(a, id, body.userIds);
  }

  @Post("channels/:id/mute")
  @HttpCode(204)
  mute(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ muted: z.boolean() }))) body: { muted: boolean }) {
    return this.chat.setMuted(a, id, body.muted);
  }

  @Post("channels/:id/archive")
  @HttpCode(204)
  archive(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ archived: z.boolean() }))) body: { archived: boolean }) {
    return this.chat.archive(a, id, body.archived);
  }

  @Patch("messages/:id")
  @HttpCode(204)
  edit(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ body: z.string().max(4000) }))) body: { body: string }) {
    return this.chat.edit(a, id, body.body);
  }

  @Delete("messages/:id")
  @HttpCode(204)
  remove(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.chat.remove(a, id);
  }

  @Get("messages/:id/revisions")
  revisions(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.chat.revisions(a, id);
  }

  @Get("attachments/:id/url")
  attachment(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.chat.attachmentUrl(a, id);
  }
}

@Module({ controllers: [ChatController], providers: [ChatService], exports: [ChatService] })
export class ChatModule {}
