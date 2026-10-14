/** Saved views for the opportunity list (keys match the API's `view` parameter). */
export const VIEWS = [
  { key: "my_open", label: "My open opportunities" },
  { key: "all", label: "All opportunities" },
  { key: "all_won", label: "All won" },
  { key: "energy", label: "Energy" },
  { key: "worldpay", label: "Worldpay" },
  { key: "renewals_due", label: "Renewals due" },
  { key: "awaiting_customer", label: "Awaiting customer" },
  { key: "awaiting_supplier", label: "Awaiting supplier" },
  { key: "awaiting_worldpay", label: "Awaiting Worldpay" },
  { key: "compliance_queries", label: "Compliance queries" },
  { key: "missing_documents", label: "Missing documents" },
  { key: "unsigned", label: "Unsigned applications" },
  { key: "unassigned", label: "Unassigned leads" },
  { key: "lost", label: "Lost" },
] as const;
