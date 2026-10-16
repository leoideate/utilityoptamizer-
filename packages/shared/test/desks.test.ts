import { desksFor, isHandedOver } from "../src";

describe("desks", () => {
  it("salespeople and field agents work at the sales desk, operations at the back office, managers at both", () => {
    expect(desksFor(["salesperson"])).toEqual(["sales"]);
    expect(desksFor(["operations"])).toEqual(["back_office"]);
    expect(desksFor(["compliance"])).toEqual(["back_office"]);
    expect(desksFor(["manager"])).toEqual(["sales", "back_office"]);
    expect(desksFor(["salesperson", "operations"])).toEqual(["sales", "back_office"]);
  });

  it("a deal is handed to the back office from Supplier selected, but not a scheduled renewal", () => {
    expect(isHandedOver("client_reviewing")).toBe(false);
    expect(isHandedOver("supplier_selected")).toBe(true);
    expect(isHandedOver("awaiting_confirmation")).toBe(true);
    expect(isHandedOver("renewal_scheduled")).toBe(false);
    expect(isHandedOver(null)).toBe(false);
  });
});
