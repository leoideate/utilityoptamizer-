/**
 * Seed data: pipeline stages, suppliers, a signature template and (outside production)
 * demo users and opportunities.
 *
 *   npm run db:seed                 stages + suppliers + demo data (development)
 *   SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... npm run db:seed    first administrator (production)
 *
 * Idempotent: running it again doesn't create duplicates.
 */
import { PrismaClient, type Role } from "@prisma/client";
import { STAGES, addDays, addMonths, today } from "@uo/shared";
import { hashPassword } from "../src/auth/passwords";

const prisma = new PrismaClient();
const isProd = process.env.NODE_ENV === "production";

const ENERGY_SUPPLIERS = ["Electric Ireland", "SSE Airtricity", "Bord Gáis Energy", "Energia", "Flogas", "Pinergy", "Yuno Energy", "Community Power"];

async function stages() {
  const existing = await prisma.stage.findMany();
  for (const [i, s] of STAGES.entries()) {
    const row = existing.find((e) => e.key === s.key);
    if (row) await prisma.stage.update({ where: { id: row.id }, data: { sequence: (i + 1) * 10, probability: s.probability } });
    else await prisma.stage.create({ data: { key: s.key, name: s.name, sequence: (i + 1) * 10, probability: s.probability } });
  }
}

async function suppliers() {
  for (const name of ENERGY_SUPPLIERS) {
    await prisma.supplier.upsert({ where: { name_kind: { name, kind: "energy" } }, create: { name, kind: "energy" }, update: {} });
  }
  await prisma.supplier.upsert({ where: { name_kind: { name: "Worldpay", kind: "merchant" } }, create: { name: "Worldpay", kind: "merchant" }, update: {} });
  for (const [name, serviceType] of [
    ["Supplier application & letter of authority", null],
    ["Worldpay merchant application", "merchant_services"],
  ] as const) {
    const exists = await prisma.signatureTemplate.findFirst({ where: { name } });
    if (!exists) await prisma.signatureTemplate.create({ data: { name, provider: "manual", serviceType } });
  }
}

async function user(name: string, email: string, password: string, roles: Role[]) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({ data: { name, email, passwordHash: await hashPassword(password), roles: { create: roles.map((role) => ({ role })) } } });
}

async function demo() {
  const password = process.env.SEED_DEMO_PASSWORD ?? "ChangeMe-Demo-2026!";
  const admin = await user("Aisling Admin", "admin@demo.utilityoptimizer.ie", password, ["administrator"]);
  const manager = await user("Michael Manager", "manager@demo.utilityoptimizer.ie", password, ["manager"]);
  const sales1 = await user("Sarah Sales", "sarah@demo.utilityoptimizer.ie", password, ["salesperson"]);
  const sales2 = await user("Sean Sales", "sean@demo.utilityoptimizer.ie", password, ["salesperson"]);
  await user("Orla Operations", "ops@demo.utilityoptimizer.ie", password, ["operations"]);
  await user("Colm Compliance", "compliance@demo.utilityoptimizer.ie", password, ["compliance"]);
  await user("Fiona Finance", "finance@demo.utilityoptimizer.ie", password, ["finance"]);
  void admin;
  void manager;

  if (await prisma.opportunity.count()) return;
  const stage = async (key: string) => (await prisma.stage.findUniqueOrThrow({ where: { key } })).id;
  const energia = await prisma.supplier.findFirstOrThrow({ where: { name: "Energia" } });

  const cafe = await prisma.customer.create({
    data: {
      legalName: "Harbour Café Limited",
      tradingName: "Harbour Café",
      businessType: "Limited company",
      industry: "Hospitality",
      companyRegNumber: "654321",
      vatRegistered: "yes",
      vatNumber: "IE6543210T",
      phone: "+353 1 555 0101",
      phoneKey: "15550101",
      email: "hello@harbourcafe.example",
      website: "https://harbourcafe.example",
      addresses: { create: [{ kind: "trading", line1: "12 Harbour Road", city: "Howth", county: "Dublin", postcode: "D13 X1Y2" }] },
      contacts: { create: [{ firstName: "Niamh", lastName: "Kelly", jobTitle: "Director", email: "niamh@harbourcafe.example", mobile: "+353 87 555 0102", mobileKey: "875550102", isPrimary: true }] },
    },
  });

  // Lead just captured.
  await prisma.opportunity.create({
    data: { name: "Doyle Pharmacy – electricity", serviceType: "electricity", leadSource: "social_media", companyName: "Doyle Pharmacy", contactName: "Pat Doyle", phone: "087 555 0199", ownerId: sales1.id, stageId: await stage("new_lead"), probability: 5, expectedRevenue: 1200 },
  });
  // Dual fuel in progress with a site and meters.
  const dual = await prisma.opportunity.create({
    data: { name: "Harbour Café – dual fuel", serviceType: "dual_fuel", leadSource: "referral", customerId: cafe.id, ownerId: sales1.id, stageId: await stage("comparison_prepared"), probability: 40, expectedRevenue: 2400, selectedSupplierId: energia.id },
  });
  await prisma.supplySite.create({
    data: {
      opportunityId: dual.id,
      customerId: cafe.id,
      label: "Café",
      line1: "12 Harbour Road",
      city: "Howth",
      postcode: "D13 X1Y2",
      serviceType: "dual_fuel",
      occupancyType: "rented",
      landlordName: "Howth Properties Ltd",
      customerSector: "Hospitality",
      annualConsumptionKwh: 48000,
      meterPoints: { create: [{ fuel: "electricity", mprn: "10012345678", meterType: "24hr" }, { fuel: "gas", gprn: "1234567", meterType: "Standard" }] },
    },
  });
  // Worldpay lead.
  await prisma.opportunity.create({
    data: { name: "Harbour Café – card payments", serviceType: "merchant_services", leadSource: "existing_customer", customerId: cafe.id, ownerId: sales2.id, stageId: await stage("details_requested"), probability: 25, expectedRevenue: 900 },
  });
  // A live energy deal with a contract ending in ~100 days (the renewal job will pick it up).
  const live = await prisma.opportunity.create({
    data: {
      name: "Quayside Bakery – electricity",
      serviceType: "electricity",
      leadSource: "website",
      companyName: "Quayside Bakery",
      ownerId: sales2.id,
      stageId: await stage("live_won"),
      outcome: "won",
      probability: 100,
      wonAt: new Date(),
      activationDate: new Date(`${addMonths(today(), -21)}T00:00:00Z`),
      renewalDate: new Date(`${addDays(today(), 100)}T00:00:00Z`),
      selectedSupplierId: energia.id,
      expectedRevenue: 1500,
    },
  });
  await prisma.energyContract.create({
    data: {
      opportunityId: live.id,
      fuel: "electricity",
      selectedSupplierId: energia.id,
      status: "live",
      termMonths: 24,
      activationDate: new Date(`${addMonths(today(), -21)}T00:00:00Z`),
      contractEndDate: new Date(`${addDays(today(), 100)}T00:00:00Z`),
      dayRate: 0.2412,
      nightRate: 0.1398,
      standingCharge: 0.7123,
      supplierReference: "EN-778812",
    },
  });
  console.log(`Demo data created. Demo users share the password from SEED_DEMO_PASSWORD (default: ${password}).`);
}

async function main() {
  await stages();
  await suppliers();
  if (process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD) {
    if (process.env.SEED_ADMIN_PASSWORD.length < 12) throw new Error("SEED_ADMIN_PASSWORD must be at least 12 characters.");
    await user(process.env.SEED_ADMIN_NAME ?? "Administrator", process.env.SEED_ADMIN_EMAIL.toLowerCase(), process.env.SEED_ADMIN_PASSWORD, ["administrator"]);
    console.log(`Administrator ${process.env.SEED_ADMIN_EMAIL} is ready.`);
  }
  if (!isProd) await demo();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
