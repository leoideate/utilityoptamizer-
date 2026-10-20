import { isHandedOver } from "../src";

describe("handover", () => {
  it("a deal is handed to the back office from Supplier selected, but not a scheduled renewal", () => {
    expect(isHandedOver("client_reviewing")).toBe(false);
    expect(isHandedOver("supplier_selected")).toBe(true);
    expect(isHandedOver("awaiting_confirmation")).toBe(true);
    expect(isHandedOver("renewal_scheduled")).toBe(false);
    expect(isHandedOver(null)).toBe(false);
  });
});
