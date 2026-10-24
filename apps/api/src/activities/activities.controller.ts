import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { activitySchema } from "@uo/shared";
import { z } from "zod";
import type { Actor } from "../common/actor";
import { CurrentUser } from "../common/decorators";
import { ZodPipe } from "../common/zod.pipe";
import { NotificationsService } from "../notifications/notifications.service";
import { ActivitiesService } from "./activities.service";

const Id = new ParseUUIDPipe({ version: "4" });
// Zod 4 fills in defaults for absent fields even after .partial(), so updates drop the priority default.
const activityUpdateSchema = activitySchema.extend({ priority: activitySchema.shape.priority.unwrap() }).partial();
const listQuery = z.object({
  scope: z.enum(["mine", "team"]).default("mine"),
  status: z.enum(["open", "done", "cancelled"]).optional(),
  due: z.enum(["overdue", "today", "week"]).optional(),
  opportunityId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

@ApiTags("activities")
@Controller()
export class ActivitiesController {
  constructor(
    private readonly activities: ActivitiesService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get("activities")
  list(@CurrentUser() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.activities.list(a, q);
  }

  @Post("activities")
  create(@CurrentUser() a: Actor, @Body(new ZodPipe(activitySchema)) body: z.infer<typeof activitySchema>) {
    return this.activities.create(a, body);
  }

  @Patch("activities/:id")
  update(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(activityUpdateSchema)) body: Partial<z.infer<typeof activitySchema>>) {
    return this.activities.update(a, id, body);
  }

  @Post("activities/:id/complete")
  complete(@CurrentUser() a: Actor, @Param("id", Id) id: string, @Body(new ZodPipe(z.object({ note: z.string().max(2000).optional() }))) body: { note?: string }) {
    return this.activities.complete(a, id, body.note);
  }

  @Post("activities/:id/cancel")
  cancel(@CurrentUser() a: Actor, @Param("id", Id) id: string) {
    return this.activities.cancel(a, id);
  }

  // --- Notifications ----------------------------------------------------------

  @Get("notifications")
  notificationsList(@CurrentUser() a: Actor, @Query("unread") unread?: string) {
    return this.notifications.list(a.id, unread === "true");
  }

  @Get("notifications/unread-count")
  async unread(@CurrentUser() a: Actor) {
    return { count: await this.notifications.unreadCount(a.id) };
  }

  @Post("notifications/read")
  async markRead(@CurrentUser() a: Actor, @Body(new ZodPipe(z.object({ ids: z.union([z.array(z.string().uuid()), z.literal("all")]) }))) body: { ids: string[] | "all" }) {
    await this.notifications.markRead(a.id, body.ids);
    return { ok: true };
  }
}
