import { formFieldSchema, sourceMatches } from "../src";

describe("supplier form fields", () => {
  it("matches values case-insensitively, and yes/no as true/false", () => {
    expect(sourceMatches("Sole_Trader", "sole_trader")).toBe(true);
    expect(sourceMatches(" 24 ", "24")).toBe(true);
    expect(sourceMatches("12", "24")).toBe(false);
    expect(sourceMatches(false, "false")).toBe(true);
    expect(sourceMatches(false, "no")).toBe(true);
    expect(sourceMatches(true, "YES")).toBe(true);
    expect(sourceMatches(true, "false")).toBe(false);
    expect(sourceMatches(null, "false")).toBe(false);
    expect(sourceMatches(undefined, "")).toBe(false);
  });

  const base = { id: "f", label: "Limited Co.", page: 0, x: 10, y: 10, w: 10, h: 10 };

  it("needs a value to tick on when a tick box follows something other than yes/no", () => {
    expect(formFieldSchema.safeParse({ ...base, kind: "check", source: "customer.legalEntity" }).success).toBe(false);
    expect(formFieldSchema.safeParse({ ...base, kind: "check", source: "customer.legalEntity", match: "limited_company" }).success).toBe(true);
    expect(formFieldSchema.safeParse({ ...base, kind: "check", source: "is.renewal" }).success).toBe(true);
    expect(formFieldSchema.safeParse({ ...base, kind: "check", source: "marketing.email", match: "false" }).success).toBe(true);
  });

  it("accepts fill conditions, masks and block capitals, and rejects unknown sources", () => {
    expect(formFieldSchema.safeParse({ ...base, kind: "text", source: "contract.rateDayCent", onlyIf: { source: "contract.priceType", equals: "fixed" }, mask: true, upper: true }).success).toBe(true);
    expect(formFieldSchema.safeParse({ ...base, kind: "text", source: null, mask: true }).success).toBe(true);
    expect(formFieldSchema.safeParse({ ...base, kind: "text", source: "contract.rateDayCent", onlyIf: { source: "nope", equals: "fixed" } }).success).toBe(false);
  });
});
