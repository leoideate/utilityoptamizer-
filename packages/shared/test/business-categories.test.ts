import { parseBusinessCategory, inferBusinessCategory, createOpportunitySchema, updateOpportunitySchema, opportunityListQuerySchema } from "../src";

describe("Business Category", () => {
  it.each([
    ["Café", "cafe"], [" CAFÉS ", "cafe"], ["Mobile Shops", "mobile_shop"],
    ["mobile_shop", "mobile_shop"], ["Beauty salon", "salon"], ["Take-away", "takeaway"],
    ["Restaurants", "restaurant"], ["Other", "other"], ["Hospitality", null],
    ["Harbour Café Ltd", null], ["__proto__", null], ["", null],
  ])("maps only a recognized category: %s", (input, expected) => expect(parseBusinessCategory(input)).toBe(expected));
  it("uses known categories but leaves conflicts unset", () => {
    expect(inferBusinessCategory("Hospitality", "Café")).toBe("cafe");
    expect(inferBusinessCategory("Restaurants", "Cafe")).toBeNull();
    expect(inferBusinessCategory("Restaurant", "Restaurants")).toBe("restaurant");
  });
  it("supports optional categories and clearing, and refuses invalid input", () => {
    expect(createOpportunitySchema.parse({ name: "New cafe", serviceType: "electricity", businessCategory: "cafe" }).businessCategory).toBe("cafe");
    expect(updateOpportunitySchema.parse({ businessCategory: null }).businessCategory).toBeNull();
    expect(updateOpportunitySchema.safeParse({ businessCategory: "hospitality" }).success).toBe(false);
    expect(createOpportunitySchema.safeParse({ name: "New", serviceType: "gas" }).success).toBe(true);
    expect(opportunityListQuerySchema.parse({ businessCategory: "uncategorized" }).businessCategory).toBe("uncategorized");
    expect(opportunityListQuerySchema.safeParse({ businessCategory: "made_up" }).success).toBe(false);
  });
});
