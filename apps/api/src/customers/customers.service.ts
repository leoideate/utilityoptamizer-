import { Injectable } from "@nestjs/common";
import type { Customer, Prisma } from "@prisma/client";
import { type ContactInput, type CustomerInput, can, vatIssues } from "@uo/shared";
import type { z } from "zod";
import type { bankDetailsSchema, duplicateCheckSchema } from "@uo/shared";
import { AuditService } from "../audit/audit.service";
import { type Actor, actorRef } from "../common/actor";
import { CryptoService } from "../common/crypto.service";
import { Conflict, Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { type Page, dateOnly, defined, pageArgs, phoneKey } from "../common/values";
import { OpportunityAccess } from "../opportunities/access.service";

export interface DuplicateMatch {
  customer: Pick<Customer, "id" | "legalName" | "tradingName" | "email" | "phone" | "companyRegNumber" | "vatNumber">;
  reasons: string[];
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const normCode = (s: string | null | undefined) => (s ?? "").replace(/[\s-]/g, "").toUpperCase();

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly access: OpportunityAccess,
  ) {}

  /**
   * Possible duplicates by email, phone/mobile, company registration number, VAT number,
   * or legal name + postcode. Contacts' emails and phones count too. Never merges anything.
   */
  /** Customers the actor may see (ISO 27001 A.8.3); see OpportunityAccess.customerWhere. */
  visibleWhere(actor: Actor): Prisma.CustomerWhereInput {
    return this.access.customerWhere(actor);
  }

  /** A customer the actor may link a new opportunity or contact to. */
  linkable(actor: Actor, id: string) {
    return this.access.linkableCustomer(actor, id);
  }

  /** Loads a customer the actor may see (404 otherwise, so existence isn't revealed). */
  async visible(actor: Actor, id: string) {
    const c = await this.prisma.customer.findFirst({ where: { AND: [{ id }, this.visibleWhere(actor)] } });
    if (!c) throw new NotFound("Customer");
    return c;
  }

  /**
   * Duplicate check. Matches are reported for every customer (to prevent duplicates), but people
   * who can't see a matching customer get only its name and why it matched, never its contact details.
   */
  async findDuplicates(c: z.infer<typeof duplicateCheckSchema>, excludeId?: string, actor?: Actor): Promise<DuplicateMatch[]> {
    const or: Prisma.CustomerWhereInput[] = [];
    const email = norm(c.email);
    const pk = phoneKey(c.phone);
    const reg = normCode(c.companyRegNumber);
    const vat = normCode(c.vatNumber);
    if (email) or.push({ email: { equals: email, mode: "insensitive" } }, { contacts: { some: { email: { equals: email, mode: "insensitive" } } } });
    if (pk) or.push({ phoneKey: pk }, { contacts: { some: { OR: [{ phoneKey: pk }, { mobileKey: pk }] } } });
    if (reg) or.push({ companyRegNumber: { equals: reg, mode: "insensitive" } });
    if (vat) or.push({ vatNumber: { equals: vat, mode: "insensitive" } });
    if (c.legalName && c.postcode) {
      or.push({ legalName: { equals: c.legalName.trim(), mode: "insensitive" }, addresses: { some: { postcode: { equals: c.postcode.trim(), mode: "insensitive" } } } });
    }
    if (!or.length) return [];
    const rows = await this.prisma.customer.findMany({
      where: { OR: or, mergedIntoId: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
      include: { contacts: true, addresses: true },
      take: 20,
    });
    const matches = rows.map((r) => {
      const reasons: string[] = [];
      if (email && (norm(r.email) === email || r.contacts.some((x) => norm(x.email) === email))) reasons.push("Same email");
      if (pk && (r.phoneKey === pk || r.contacts.some((x) => x.phoneKey === pk || x.mobileKey === pk))) reasons.push("Same phone number");
      if (reg && normCode(r.companyRegNumber) === reg) reasons.push("Same company registration number");
      if (vat && normCode(r.vatNumber) === vat) reasons.push("Same VAT number");
      if (c.legalName && c.postcode && norm(r.legalName) === norm(c.legalName) && r.addresses.some((a) => norm(a.postcode) === norm(c.postcode))) {
        reasons.push("Same name and postcode");
      }
      const { id, legalName, tradingName, email: e, phone, companyRegNumber, vatNumber } = r;
      return { customer: { id, legalName, tradingName, email: e, phone, companyRegNumber, vatNumber }, reasons };
    });
    if (!actor || can(actor, "opportunity.read_all")) return matches;
    const visibleIds = new Set((await this.prisma.customer.findMany({ where: { AND: [{ id: { in: matches.map((m) => m.customer.id) } }, this.visibleWhere(actor)] }, select: { id: true } })).map((x) => x.id));
    return matches.map((m) => (visibleIds.has(m.customer.id) ? m : { ...m, customer: { id: m.customer.id, legalName: m.customer.legalName, tradingName: m.customer.tradingName, email: null, phone: null, companyRegNumber: null, vatNumber: null } }));
  }

  /**
   * Creates a customer. If possible duplicates exist and `confirmNew` is false, nothing is
   * created and the matches are returned so the user can link, merge or confirm.
   */
  async create(actor: Actor, input: CustomerInput, confirmNew = false): Promise<{ id?: string; duplicates?: DuplicateMatch[] }> {
    if (!can(actor, "customer.write")) throw new Forbidden();
    // A missing VAT number is allowed at capture; it's enforced at Documents Prepared.
    if (!confirmNew) {
      const duplicates = await this.findDuplicates({
        email: input.email,
        phone: input.phone,
        companyRegNumber: input.companyRegNumber,
        vatNumber: input.vatNumber,
        legalName: input.legalName,
        postcode: input.addresses?.[0]?.postcode,
      }, undefined, actor);
      if (duplicates.length) return { duplicates };
    }
    const customer = await this.prisma.$transaction(async (tx) => {
      const c = await tx.customer.create({
        data: {
          ...this.columns(input),
          legalName: input.legalName,
          createdById: actorRef(actor),
          addresses: input.addresses?.length ? { create: input.addresses } : undefined,
        },
      });
      await this.audit.record(
        actor,
        { action: "customer.create", entityType: "customer", entityId: c.id, summary: `Created customer ${c.legalName}`, data: { confirmedDespiteDuplicates: confirmNew } },
        { customerId: c.id, kind: "system", body: "Customer created." },
        tx,
      );
      return c;
    });
    return { id: customer.id };
  }

  private columns(input: Partial<CustomerInput>) {
    return defined({
      legalName: input.legalName,
      tradingName: input.tradingName,
      businessType: input.businessType,
      industry: input.industry,
      companyRegNumber: input.companyRegNumber === undefined ? undefined : input.companyRegNumber ? normCode(input.companyRegNumber) : null,
      vatRegistered: input.vatRegistered,
      vatNumber: input.vatNumber === undefined ? undefined : input.vatNumber ? normCode(input.vatNumber) : null,
      incorporationDate: dateOnly(input.incorporationDate),
      countryOfIncorporation: input.countryOfIncorporation,
      website: input.website,
      phone: input.phone,
      phoneKey: input.phone === undefined ? undefined : phoneKey(input.phone),
      email: input.email,
      advertisingMethod: input.advertisingMethod,
      legalEntity: input.legalEntity,
      employees: input.employees,
      vatExempt: input.vatExempt,
      vatExemptNumber: input.vatExemptNumber,
      carbonTaxExempt: input.carbonTaxExempt,
      charityNumber: input.charityNumber,
      priorityCustomer: input.priorityCustomer,
      marketingEmail: input.marketingEmail,
      marketingPost: input.marketingPost,
      marketingPhone: input.marketingPhone,
      marketingSms: input.marketingSms,
      paperlessBilling: input.paperlessBilling,
    });
  }

  async update(actor: Actor, id: string, patch: Partial<CustomerInput>) {
    if (!can(actor, "customer.write")) throw new Forbidden();
    const c = await this.visible(actor, id);
    const after = { vatRegistered: patch.vatRegistered ?? c.vatRegistered, vatNumber: patch.vatNumber === undefined ? c.vatNumber : patch.vatNumber };
    // Explicitly saying "VAT registered: yes" on the profile requires the number.
    if (patch.vatRegistered === "yes" && vatIssues(after).length) throw new RuleViolation(vatIssues(after));
    const data = this.columns(patch);
    await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id }, data });
      if (patch.addresses) {
        await tx.customerAddress.deleteMany({ where: { customerId: id } });
        if (patch.addresses.length) await tx.customerAddress.createMany({ data: patch.addresses.map((a) => ({ ...a, customerId: id })) });
      }
      await this.audit.log(actor, { action: "customer.update", entityType: "customer", entityId: id, summary: `Updated ${Object.keys(patch).join(", ")}` }, tx);
    });
  }

  async get(id: string) {
    const c = await this.prisma.customer.findUnique({ where: { id } });
    if (!c) throw new NotFound("Customer");
    return c;
  }

  async profile(actor: Actor, id: string) {
    if (!can(actor, "customer.read")) throw new Forbidden();
    await this.visible(actor, id);
    const c = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        addresses: true,
        contacts: { orderBy: [{ isPrimary: "desc" }, { firstName: "asc" }] },
        sites: { include: { meterPoints: true } },
        bankAccounts: { select: { id: true, ibanLast4: true, createdAt: true } },
        // Supply points this customer has occupied, including ones since taken over by someone else.
        occupancies: { orderBy: { recordedAt: "desc" }, include: { site: { select: { id: true, label: true, line1: true, city: true, customerId: true, meterPoints: { select: { fuel: true, mprn: true, gprn: true } } } } } },
      },
    });
    if (!c) throw new NotFound("Customer");
    const opportunities = await this.prisma.opportunity.findMany({
      where: { AND: [{ customerId: id }, this.access.visibleWhere(actor)] },
      orderBy: { createdAt: "desc" },
      include: { stage: { select: { key: true, name: true } }, owner: { select: { id: true, name: true } } },
    });
    const mergedInto = c.mergedIntoId ? await this.prisma.customer.findUnique({ where: { id: c.mergedIntoId }, select: { id: true, legalName: true } }) : null;
    return { ...c, opportunities, mergedInto, canReadBank: can(actor, "bank.read") };
  }

  async list(actor: Actor, q: { q?: string; page: number; pageSize: number }): Promise<Page<unknown>> {
    if (!can(actor, "customer.read")) throw new Forbidden();
    const term = q.q?.trim();
    const where: Prisma.CustomerWhereInput = {
      mergedIntoId: null,
      AND: [this.visibleWhere(actor)],
      ...(term
        ? {
            OR: [
              { legalName: { contains: term, mode: "insensitive" } },
              { tradingName: { contains: term, mode: "insensitive" } },
              { email: { contains: term, mode: "insensitive" } },
              { companyRegNumber: { contains: term, mode: "insensitive" } },
              { vatNumber: { contains: term, mode: "insensitive" } },
              { contacts: { some: { OR: [{ firstName: { contains: term, mode: "insensitive" } }, { lastName: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }] } } },
              ...(phoneKey(term) ? [{ phoneKey: phoneKey(term) }] : []),
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({ where, orderBy: { legalName: "asc" }, ...pageArgs(q.page, q.pageSize), include: { _count: { select: { opps: true } } } }),
      this.prisma.customer.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /**
   * Merges `sourceId` into `targetId` (authorised users only, never automatic). Everything
   * linked to the source moves to the target; the source is kept, marked merged and inactive.
   */
  async merge(actor: Actor, targetId: string, sourceId: string) {
    if (!can(actor, "customer.merge")) throw new Forbidden("Only a manager can merge customers.");
    if (targetId === sourceId) throw new RuleViolation(["Choose two different customers."]);
    const [target, source] = await Promise.all([this.get(targetId), this.get(sourceId)]);
    if (source.mergedIntoId || target.mergedIntoId) throw new Conflict("One of these customers has already been merged.");
    await this.prisma.$transaction(async (tx) => {
      const moved = {
        opportunities: (await tx.opportunity.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } })).count,
        contacts: (await tx.customerContact.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId, isPrimary: false } })).count,
        addresses: (await tx.customerAddress.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } })).count,
        sites: (await tx.supplySite.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } })).count,
        bankAccounts: (await tx.bankAccount.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } })).count,
      };
      await tx.energyContract.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
      await tx.merchantApplication.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
      await tx.documentItem.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
      await tx.activity.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
      // Fill gaps on the target from the source; never overwrite target values.
      const fill = Object.fromEntries(
        (["tradingName", "businessType", "industry", "companyRegNumber", "vatRegistered", "vatNumber", "incorporationDate", "countryOfIncorporation", "website", "phone", "phoneKey", "email", "advertisingMethod"] as const)
          .filter((k) => target[k] == null && source[k] != null)
          .map((k) => [k, source[k]]),
      );
      if (Object.keys(fill).length) await tx.customer.update({ where: { id: targetId }, data: fill });
      await tx.customer.update({ where: { id: sourceId }, data: { mergedIntoId: targetId, active: false } });
      await this.audit.log(actor, { action: "customer.merge", entityType: "customer", entityId: targetId, summary: `Merged ${source.legalName} into ${target.legalName}`, data: { sourceId, moved } }, tx);
      await this.audit.timeline(actor, { customerId: targetId, kind: "system", body: `Merged duplicate customer ${source.legalName} into this record.` }, tx);
    });
  }

  // --- Contacts ---------------------------------------------------------------

  async addContact(actor: Actor, customerId: string, input: ContactInput) {
    if (!can(actor, "customer.write")) throw new Forbidden();
    await this.visible(actor, customerId);
    return this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) await tx.customerContact.updateMany({ where: { customerId }, data: { isPrimary: false } });
      const c = await tx.customerContact.create({ data: { ...input, customerId, phoneKey: phoneKey(input.phone), mobileKey: phoneKey(input.mobile), isPrimary: input.isPrimary ?? false } });
      await this.audit.log(actor, { action: "contact.create", entityType: "customer", entityId: customerId, summary: `Added contact ${input.firstName} ${input.lastName ?? ""}`.trim() }, tx);
      return c;
    });
  }

  async updateContact(actor: Actor, contactId: string, input: Partial<ContactInput>) {
    if (!can(actor, "customer.write")) throw new Forbidden();
    const c = await this.prisma.customerContact.findUnique({ where: { id: contactId } });
    if (!c) throw new NotFound("Contact");
    await this.visible(actor, c.customerId);
    return this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) await tx.customerContact.updateMany({ where: { customerId: c.customerId }, data: { isPrimary: false } });
      const updated = await tx.customerContact.update({
        where: { id: contactId },
        data: { ...input, phoneKey: input.phone === undefined ? undefined : phoneKey(input.phone), mobileKey: input.mobile === undefined ? undefined : phoneKey(input.mobile) },
      });
      await this.audit.log(actor, { action: "contact.update", entityType: "customer", entityId: c.customerId, summary: "Updated contact" }, tx);
      return updated;
    });
  }

  // --- Bank details (restricted) ------------------------------------------------

  async addBankAccount(actor: Actor, customerId: string, input: z.infer<typeof bankDetailsSchema>) {
    if (!can(actor, "bank.write")) throw new Forbidden();
    await this.visible(actor, customerId);
    const b = await this.prisma.bankAccount.create({
      data: {
        customerId,
        accountNameEnc: this.crypto.encrypt(input.accountName),
        ibanEnc: this.crypto.encrypt(input.iban),
        ibanLast4: input.iban.slice(-4),
        bicEnc: this.crypto.encrypt(input.bic ?? null),
        createdById: actorRef(actor),
      },
    });
    await this.audit.log(actor, { action: "bank.create", entityType: "customer", entityId: customerId, summary: `Added bank account ending ${b.ibanLast4}` });
    return { id: b.id, ibanLast4: b.ibanLast4 };
  }

  /** Full bank details: Finance/Compliance/Admin only; every view is logged. */
  async revealBankAccount(actor: Actor, bankAccountId: string) {
    if (!can(actor, "bank.read")) throw new Forbidden("Bank details are restricted.");
    const b = await this.prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
    if (!b) throw new NotFound("Bank account");
    await this.audit.sensitiveAccess(actor, "customer", b.customerId, `bank account ending ${b.ibanLast4}`);
    return { id: b.id, accountName: this.crypto.decrypt(b.accountNameEnc), iban: this.crypto.decrypt(b.ibanEnc), bic: this.crypto.decrypt(b.bicEnc) };
  }
}
