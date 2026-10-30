/** Sales classification belongs to a lead, independently of its linked customer. */
export const BUSINESS_CATEGORIES = ["restaurant", "cafe", "salon", "mobile_shop", "takeaway", "other"] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];
export const BUSINESS_CATEGORY_LABELS: Record<BusinessCategory, string> = {
  restaurant: "Restaurants", cafe: "Cafés", salon: "Salons", mobile_shop: "Mobile Shops", takeaway: "Takeaways", other: "Other",
};

/** Exact aliases only: never guess a category from a business name or turn unknown text into Other. */
export function parseBusinessCategory(value: string | null | undefined): BusinessCategory | null {
  const key = value?.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const aliases: Record<string, BusinessCategory> = {
    restaurant: "restaurant", restaurants: "restaurant", cafe: "cafe", cafes: "cafe",
    salon: "salon", salons: "salon", "hair salon": "salon", "hair salons": "salon", "beauty salon": "salon", "beauty salons": "salon",
    "mobile shop": "mobile_shop", "mobile shops": "mobile_shop", "mobile phone shop": "mobile_shop", "mobile phone shops": "mobile_shop",
    takeaway: "takeaway", takeaways: "takeaway", "take away": "takeaway", "take aways": "takeaway", other: "other",
  };
  return key && Object.hasOwn(aliases, key) ? aliases[key] : null;
}

/** Use known values only; conflicting known categories stay unset. */
export function inferBusinessCategory(...values: (string | null | undefined)[]): BusinessCategory | null {
  const matches = new Set(values.map(parseBusinessCategory).filter((v): v is BusinessCategory => v !== null));
  return matches.size === 1 ? [...matches][0] : null;
}
