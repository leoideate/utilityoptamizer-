import { Injectable } from "@nestjs/common";
import type { Db } from "../common/prisma.service";
import { PrismaService } from "../common/prisma.service";

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async notify(userId: string | null | undefined, n: { title: string; body?: string; link?: string }, db: Db = this.prisma) {
    if (!userId) return;
    await db.notification.create({ data: { userId, title: n.title, body: n.body ?? null, link: n.link ?? null } });
  }

  list(userId: string, unreadOnly = false) {
    return this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, ids: string[] | "all") {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) },
      data: { readAt: new Date() },
    });
  }
}
