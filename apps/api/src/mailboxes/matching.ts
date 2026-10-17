import type { Db } from "../common/prisma.service";

export interface EmailLink {
  customerId: string | null;
  opportunityId: string | null;
}

const OPEN = { outcome: "open", active: true } as const;

/**
 * Which customer and deal an email belongs to:
 *  1. a message in a thread the CRM already linked keeps that link;
 *  2. otherwise the other party's addresses are matched (case-insensitively) to customers and
 *     their contacts, and to leads' email on deals without a customer yet;
 *  3. one open deal → that deal; several → the one the mailbox owner owns, if exactly one;
 *     otherwise the customer only (when there's exactly one).
 * Mail between staff, or from unknown addresses, isn't linked and stays private to its owner.
 */
export async function matchEmail(db: Db, input: { mailboxId: string; ownerId: string; threadId: string | null; counterparts: string[] }): Promise<EmailLink> {
  if (input.threadId) {
    const earlier = await db.emailMessage.findFirst({
      where: { mailboxId: input.mailboxId, threadId: input.threadId, OR: [{ opportunityId: { not: null } }, { customerId: { not: null } }] },
      orderBy: { sentAt: "desc" },
      select: { customerId: true, opportunityId: true },
    });
    if (earlier) return earlier;
  }

  const staff = new Set((await db.user.findMany({ where: { email: { in: input.counterparts, mode: "insensitive" } }, select: { email: true } })).map((u) => u.email.toLowerCase()));
  const addresses = [...new Set(input.counterparts.map((a) => a.toLowerCase()))].filter((a) => a && !staff.has(a));
  if (!addresses.length) return { customerId: null, opportunityId: null };

  const customers = await db.customer.findMany({
    where: { mergedIntoId: null, OR: [{ email: { in: addresses, mode: "insensitive" } }, { contacts: { some: { email: { in: addresses, mode: "insensitive" } } } }] },
    select: { id: true },
    take: 20,
  });
  const customerIds = customers.map((c) => c.id);
  const deals = await db.opportunity.findMany({
    where: { ...OPEN, OR: [...(customerIds.length ? [{ customerId: { in: customerIds } }] : []), { customerId: null, email: { in: addresses, mode: "insensitive" as const } }] },
    select: { id: true, customerId: true, ownerId: true },
    take: 50,
  });

  let deal = deals.length === 1 ? deals[0] : undefined;
  if (!deal && deals.length > 1) {
    const owned = deals.filter((d) => d.ownerId === input.ownerId);
    if (owned.length === 1) deal = owned[0];
  }
  if (deal) return { opportunityId: deal.id, customerId: deal.customerId };
  return { opportunityId: null, customerId: customerIds.length === 1 ? customerIds[0] : null };
}
