"use client";

import { BUSINESS_CATEGORIES, BUSINESS_CATEGORY_LABELS } from "@uo/shared";

/** Select inspects its option children, so return the options directly, without a wrapper component. */
export function businessCategoryOptions(filter = false) {
  return [
    <option key="all" value="">{filter ? "All Business Categories" : "Uncategorized"}</option>,
    ...BUSINESS_CATEGORIES.map((key) => <option key={key} value={key}>{BUSINESS_CATEGORY_LABELS[key]}</option>),
    ...(filter ? [<option key="uncategorized" value="uncategorized">Uncategorized</option>] : []),
  ];
}
