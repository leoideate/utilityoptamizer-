import type { ServiceType } from "@prisma/client";
import { type Client, type TestApp, expectStatus, pdf } from "./app";

export interface Team {
  sales: Client;
  salesId: string;
  ops: Client;
  manager: Client;
  compliance: Client;
}

export async function supplier(t: TestApp, name = "Energia", kind: "energy" | "merchant" = "energy") {
  return t.prisma.supplier.upsert({ where: { name_kind: { name, kind } }, create: { name, kind, submissionEmail: "submissions@supplier.test" }, update: {} });
}

export async function createOpportunity(c: Client, serviceType: ServiceType, extra: object = {}) {
  const res = expectStatus(await c.post("/opportunities", { name: `Test ${serviceType}`, serviceType, companyName: "Test Trading Ltd", contactName: "Mary Murphy", email: "mary@testtrading.ie", phone: "087 123 4567", ...extra }), 201);
  return res.body.id as string;
}

/** Uploads, and has Operations approve, every required checklist document. */
export async function completeDocuments(team: Team, oppId: string) {
  expectStatus(await team.sales.post(`/opportunities/${oppId}/documents/standard`), 201);
  const items = expectStatus(await team.ops.get(`/opportunities/${oppId}/documents`), 200).body as { id: string; required: boolean }[];
  for (const item of items.filter((i) => i.required)) {
    expectStatus(await team.sales.upload(`/documents/${item.id}/versions`, pdf(item.id), "doc.pdf", "application/pdf"), 201);
    expectStatus(await team.ops.post(`/documents/${item.id}/review`, { approval: "approved" }), 204);
  }
}

export async function completeSignature(team: Team, oppId: string) {
  const sig = expectStatus(
    await team.sales.post(`/opportunities/${oppId}/signatures`, {
      title: "Supplier application",
      signers: [{ role: "customer", name: "Mary Murphy", email: "mary@testtrading.ie" }],
    }),
    201,
  ).body.id as string;
  const list = expectStatus(await team.sales.get(`/opportunities/${oppId}/signatures`), 200).body as { id: string; signers: { id: string }[] }[];
  const signerId = list.find((s) => s.id === sig)!.signers[0].id;
  expectStatus(await team.sales.upload(`/signatures/${sig}/signers/${signerId}/signed`, pdf("signed"), "signed.pdf", "application/pdf"), 204);
}

/** An energy opportunity that satisfies every gate up to Submitted (not yet moved). */
export async function readyEnergy(t: TestApp, team: Team, serviceType: "electricity" | "gas" | "dual_fuel" = "electricity") {
  const s = await supplier(t);
  const oppId = await createOpportunity(team.sales, serviceType);
  expectStatus(await team.sales.post(`/opportunities/${oppId}/customer/create`), 201);
  const site = expectStatus(
    await team.sales.post(`/opportunities/${oppId}/sites`, { label: "Shop", serviceType, occupancyType: "owner_occupied", address: { line1: "1 Main Street", city: "Naas", postcode: "W91 AB12" } }),
    201,
  ).body.id as string;
  if (serviceType !== "gas") expectStatus(await team.sales.post(`/sites/${site}/meters`, { fuel: "electricity", mprn: "10012345678" }), 201);
  if (serviceType !== "electricity") expectStatus(await team.sales.post(`/sites/${site}/meters`, { fuel: "gas", gprn: "7654321" }), 201);
  const fuels = serviceType === "dual_fuel" ? (["electricity", "gas"] as const) : ([serviceType] as const);
  for (const fuel of fuels) {
    expectStatus(await team.sales.post(`/opportunities/${oppId}/contracts`, { fuel, siteId: site, existingSupplierName: "Electric Ireland", currentContractEndDate: "2026-12-31", termMonths: 24 }), 201);
  }
  expectStatus(await team.sales.patch(`/opportunities/${oppId}`, { selectedSupplierId: s.id }), 204);
  // Sign first: the signed copy is stored as a new document version, which then needs review.
  await completeSignature(team, oppId);
  await completeDocuments(team, oppId);
  expectStatus(await team.manager.post(`/opportunities/${oppId}/approval`, { decision: "approved" }), 204);
  return { oppId, siteId: site, supplierId: s.id };
}

/** A Worldpay opportunity that satisfies every gate up to Submitted. */
export async function readyMerchant(t: TestApp, team: Team) {
  const oppId = await createOpportunity(team.sales, "merchant_services");
  expectStatus(await team.sales.post(`/opportunities/${oppId}/customer/create`), 201);
  const appId = expectStatus(
    await team.sales.post(`/opportunities/${oppId}/merchant-applications`, {
      legalEntity: "limited_company",
      natureOfBusiness: "Café",
      estimatedAnnualTurnover: 250000,
      cardTurnoverPct: 70,
      averageTransactionValue: 18.5,
      website: "https://testtrading.ie",
      termMonths: 18,
    }),
    201,
  ).body.id as string;
  expectStatus(await team.sales.post(`/merchant-applications/${appId}/pricing`, { product: "Countertop terminal", debitRate: 0.35, creditRate: 0.85, productMonthlyFee: 15 }), 201);
  expectStatus(
    await team.sales.post(`/merchant-applications/${appId}/principals`, {
      role: "director",
      firstName: "Mary",
      lastName: "Murphy",
      dateOfBirth: "1980-05-17",
      nationality: "Irish",
      ownershipPct: 100,
      addressHistory: [{ line1: "4 Oak Park", city: "Naas", postcode: "W91 XY34", fromDate: "2015-01-01" }],
    }),
    201,
  );
  expectStatus(await team.sales.put(`/merchant-applications/${appId}/risk`, { depositsAccepted: false, fullPrepaymentAccepted: false }), 204);
  expectStatus(await team.compliance.post(`/merchant-applications/${appId}/compliance-review`, { status: "approved", restrictedNotes: "PEP check clear; ID verified." }), 204);
  // Sign first: the signed copy is stored as a new document version, which then needs review.
  await completeSignature(team, oppId);
  await completeDocuments(team, oppId);
  expectStatus(await team.manager.post(`/opportunities/${oppId}/approval`, { decision: "approved" }), 204);
  return { oppId, appId };
}

/** Records that every current file was sent to the supplier and that the supplier accepted it (needed before activation). */
export async function sendAndAccept(team: Team, oppId: string, reference = "SUP-ACCEPT-1") {
  const kase = expectStatus(await team.ops.get(`/opportunities/${oppId}/case`), 200).body as { files: { versionId: string }[] };
  const sub = expectStatus(
    await team.ops.post(`/opportunities/${oppId}/submissions`, {
      recipient: "submissions@supplier.test",
      channel: "email",
      documentVersionIds: kase.files.map((f) => f.versionId),
      deliveryEvidence: "Sent from ops@utilityoptimizer.ie",
    }),
    201,
  ).body.id as string;
  expectStatus(await team.ops.post(`/submissions/${sub}/responses`, { outcome: "accepted", receivedVia: "email", externalReference: reference }), 201);
  return sub;
}
