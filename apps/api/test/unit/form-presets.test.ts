import { FORM_SOURCES, formFieldSchema } from "@uo/shared";
import { FORM_PRESETS } from "../../src/forms/presets";

/** Page sizes of the supplier PDFs the presets were drawn for (points). */
const PAGES: Record<string, { pages: number; width: number; height: number }> = {
  "flogas-gas-sme-agreement": { pages: 2, width: 654.3, height: 900.9 },
  "flogas-electricity-commercial-agreement": { pages: 2, width: 654.3, height: 900.9 },
  "bord-gais-electricity-caf": { pages: 1, width: 595.3, height: 841.9 },
  "bord-gais-gas-caf": { pages: 1, width: 512, height: 722.3 },
  "energia-customer-registration": { pages: 3, width: 648, height: 895 },
};

describe("supplier form presets", () => {
  it("has five distinct presets keyed by PDF hash", () => {
    expect(FORM_PRESETS).toHaveLength(5);
    expect(new Set(FORM_PRESETS.map((p) => p.key)).size).toBe(5);
    expect(new Set(FORM_PRESETS.map((p) => p.sha256)).size).toBe(5);
    for (const p of FORM_PRESETS) expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(FORM_PRESETS.map((p) => [p.key, p] as const))("%s: every field is valid, uniquely named and on the page", (key, p) => {
    const page = PAGES[key];
    expect(page).toBeDefined();
    const ids = new Set<string>();
    const sources = new Set<string>(Object.keys(FORM_SOURCES));
    for (const f of p.fields) {
      const parsed = formFieldSchema.safeParse(f);
      expect({ label: f.label, ok: parsed.success, issues: parsed.success ? [] : parsed.error.issues.map((i) => i.message) }).toEqual({ label: f.label, ok: true, issues: [] });
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      if (f.source) expect(sources).toContain(f.source);
      if (f.onlyIf) expect(sources).toContain(f.onlyIf.source);
      expect(f.page).toBeLessThan(page.pages);
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(page.width + 0.5);
      expect(f.y + f.h).toBeLessThanOrEqual(page.height + 0.5);
    }
    // Each form leaves the customer somewhere to sign.
    expect(p.fields.some((f) => f.kind === "signature" && f.signer === "customer")).toBe(true);
  });
});
