import type { Role } from "./enums";

/**
 * Capability → roles. This table IS the security matrix: the API enforces it on every
 * request (the web app only uses it to hide buttons). See docs/security-matrix.md.
 */
export const CAPABILITIES = {
  // Opportunities
  "opportunity.read_all": ["administrator", "manager", "operations", "compliance", "finance"],
  "opportunity.create": ["administrator", "manager", "salesperson", "operations"],
  "opportunity.write_all": ["administrator", "manager", "operations"],
  "opportunity.assign": ["administrator", "manager"],
  "opportunity.approve": ["administrator", "manager"],
  "opportunity.reopen_completed": ["administrator", "manager"],
  "opportunity.submit": ["administrator", "manager", "operations"],
  "opportunity.activate": ["administrator", "manager", "operations"],
  /** Mark a whole CSV import batch (or one service from it) lost in one go. */
  "opportunity.close_batch": ["administrator", "manager"],
  /** Permanently delete leads still at New Lead that nobody has worked on (no forms, documents, calls or emails). */
  "opportunity.purge": ["administrator"],

  // Customers
  "customer.read": ["administrator", "manager", "salesperson", "operations", "compliance", "finance"],
  "customer.write": ["administrator", "manager", "salesperson", "operations", "compliance"],
  "customer.merge": ["administrator", "manager"],

  // Restricted data
  /** Unmasked principal details: date of birth, nationality, residential address history. */
  "principal.read_sensitive": ["administrator", "compliance"],
  "principal.write": ["administrator", "manager", "salesperson", "operations", "compliance"],
  /** Worldpay risk answers and restricted compliance notes. */
  "risk.read": ["administrator", "manager", "operations", "compliance"],
  "risk.review": ["administrator", "compliance"],
  /** Bank details (IBAN etc.). */
  "bank.read": ["administrator", "finance", "compliance"],
  "bank.write": ["administrator", "manager", "salesperson", "operations", "finance"],
  /** Identity documents, bank statements and other sensitive files. */
  "document.read_sensitive": ["administrator", "compliance", "finance"],
  "document.review": ["administrator", "manager", "operations", "compliance"],
  "form.template_manage": ["administrator", "manager", "operations"],
  "document.request": ["administrator", "manager", "salesperson", "operations", "compliance"],

  // Finance
  "commission.read": ["administrator", "manager", "finance"],
  "commission.write": ["administrator", "finance"],

  // Reporting
  "report.read": ["administrator", "manager", "operations", "compliance", "finance"],

  // Internal chat
  /** Create, rename and archive team channels (anyone can send direct messages and join public channels). */
  "chat.manage_channels": ["administrator", "manager"],
  /** Remove other people's chat messages and read message history (moderation). */
  "chat.moderate": ["administrator"],

  // AI assistant
  /** Ask the CRM assistant (read-only: it answers with the asker's own access). */
  "assistant.use": ["administrator", "manager", "salesperson", "operations", "compliance", "finance"],
  /** Read the answers people marked unhelpful, to improve the assistant's instructions. */
  "assistant.review": ["administrator", "manager"],

  // Administration
  "admin.users": ["administrator"],
  "admin.pipeline": ["administrator"],
  "admin.integrations": ["administrator"],
  "admin.audit": ["administrator"],
  "admin.retention": ["administrator"],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export interface Principal {
  id: string;
  roles: readonly Role[];
}

export function can(user: Pick<Principal, "roles">, cap: Capability): boolean {
  const allowed: readonly Role[] = CAPABILITIES[cap];
  return user.roles.some((r) => allowed.includes(r));
}

interface Owned {
  ownerId: string | null;
}

/** Salespeople see their own opportunities plus unassigned leads (so they can pick them up). */
export function canReadOpportunity(user: Principal, opp: Owned): boolean {
  return can(user, "opportunity.read_all") || (user.roles.includes("salesperson") && (opp.ownerId === user.id || opp.ownerId === null));
}

/** Compliance may update compliance-related parts through dedicated endpoints, not the opportunity itself. */
export function canWriteOpportunity(user: Principal, opp: Owned): boolean {
  return can(user, "opportunity.write_all") || (user.roles.includes("salesperson") && (opp.ownerId === user.id || opp.ownerId === null));
}

/** Roles that can see every capability's holders, for the security matrix document and admin screen. */
export function capabilityMatrix(): Record<Capability, readonly Role[]> {
  return CAPABILITIES;
}
