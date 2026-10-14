import {
  addMonths,
  can,
  canReadOpportunity,
  merchantPricingSchema,
  meterPointErrors,
  normalizeIdentifier,
  normalizeStageName,
  riskSchema,
  principalSchema,
  STAGES,
} from "../src";

describe("meter identifiers", () => {
  it("accepts valid MPRN and GPRN, normalising spaces", () => {
    expect(normalizeIdentifier(" 100 1234 5678 ")).toBe("10012345678");
    expect(meterPointErrors({ fuel: "electricity", mprn: "10012345678", gprn: null })).toEqual([]);
    expect(meterPointErrors({ fuel: "gas", mprn: null, gprn: "1234567" })).toEqual([]);
  });

  it("rejects malformed identifiers unless an exception reason is recorded", () => {
    expect(meterPointErrors({ fuel: "electricity", mprn: "12345", gprn: null })[0]).toMatch(/11 digits/);
    expect(meterPointErrors({ fuel: "electricity", mprn: "20012345678", gprn: null })[0]).toMatch(/start with 10/);
    expect(meterPointErrors({ fuel: "electricity", mprn: "UK-MPAN-1", gprn: null, formatExceptionReason: "Northern Ireland site" })).toEqual([]);
  });

  it("never allows the wrong identifier for the fuel", () => {
    expect(meterPointErrors({ fuel: "gas", mprn: "10012345678", gprn: "1234567", formatExceptionReason: "x" })).toEqual(["A gas meter point can't have an MPRN."]);
  });
});

describe("percentage validation", () => {
  it("rejects values outside 0-100", () => {
    expect(riskSchema.safeParse({ depositTxnPct: 101 }).success).toBe(false);
    expect(riskSchema.safeParse({ fullPrepaymentPct: -1 }).success).toBe(false);
    expect(merchantPricingSchema.safeParse({ product: "Terminal", debitRate: 150 }).success).toBe(false);
    expect(principalSchema.safeParse({ role: "director", firstName: "A", lastName: "B", ownershipPct: 100.5 }).success).toBe(false);
    expect(riskSchema.safeParse({ depositTxnPct: 0, depositValuePct: 100 }).success).toBe(true);
  });

  it("gives a readable message", () => {
    const r = riskSchema.safeParse({ depositValuePct: 120 });
    expect(r.success ? "" : r.error.issues[0].message).toBe("Deposit value percentage must be between 0 and 100.");
  });
});

describe("permissions", () => {
  const sales = { id: "u1", roles: ["salesperson"] as const };
  const manager = { id: "m1", roles: ["manager"] as const };
  it("salespeople see their own and unassigned opportunities only", () => {
    expect(canReadOpportunity(sales, { ownerId: "u1" })).toBe(true);
    expect(canReadOpportunity(sales, { ownerId: null })).toBe(true);
    expect(canReadOpportunity(sales, { ownerId: "u2" })).toBe(false);
  });
  it("managers see everything", () => {
    expect(canReadOpportunity(manager, { ownerId: "u2" })).toBe(true);
  });
  it("restricted data is limited to the right roles", () => {
    expect(can(sales, "principal.read_sensitive")).toBe(false);
    expect(can(manager, "principal.read_sensitive")).toBe(false);
    expect(can({ roles: ["compliance"] }, "principal.read_sensitive")).toBe(true);
    expect(can({ roles: ["finance"] }, "bank.read")).toBe(true);
    expect(can(sales, "bank.read")).toBe(false);
    expect(can(sales, "admin.audit")).toBe(false);
  });
});

describe("pipeline", () => {
  it("has the 18 stages in order, without Lost", () => {
    expect(STAGES).toHaveLength(18);
    expect(STAGES[0].name).toBe("New Lead");
    expect(STAGES[16].name).toBe("Live / Won");
    expect(STAGES.some((s) => /lost/i.test(s.name))).toBe(false);
  });
  it("normalises legacy names", () => {
    expect(normalizeStageName("Comparison/Pricing Prepared")).toBe(normalizeStageName("Comparison or Pricing Prepared"));
  });
});

describe("dates", () => {
  it("adds months clamping to month end", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-15", 24)).toBe("2028-03-15");
  });
});

describe("phone numbers", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { toE164 } = require("../src") as typeof import("../src");
  it("normalises Irish and international formats to E.164", () => {
    expect(toE164("087 123 4567")).toBe("+353871234567");
    expect(toE164("(01) 234-5678")).toBe("+35312345678");
    expect(toE164("+353 (0)87 123 4567")).toBe("+353871234567");
    expect(toE164("0044 7700 900123")).toBe("+447700900123");
    expect(toE164("+44 (0)7700 900123")).toBe("+447700900123");
    expect(toE164("12")).toBeNull();
    expect(toE164("call me")).toBeNull();
  });
});
