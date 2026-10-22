/**
 * What every supplier application shares (Flogas electricity, Bord Gáis electricity): its kinds,
 * when one applies to a deal, where it stands, and the address shape its forms print.
 */
import type { ProductInterest, ServiceType } from "./enums";
import type { FormSignerRole, FormStatus, SigningLinkStatus } from "./forms";

const labels = <T extends string>(m: Record<T, string>) => m;

export const SUPPLIER_APPLICATION_KINDS = ["flogas_electricity", "bord_gais_electricity"] as const;
export type SupplierApplicationKind = (typeof SUPPLIER_APPLICATION_KINDS)[number];
export const SUPPLIER_APPLICATION_LABELS = labels<SupplierApplicationKind>({ flogas_electricity: "Flogas electricity", bord_gais_electricity: "Bord Gáis electricity" });

/** Letters only, accents removed and lower-cased: "Bord Gáis Energy" → "bordgaisenergy". */
export const supplierKey = (name: string | null | undefined) =>
  (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

// --- Status ---------------------------------------------------------------------------

export const APPLICATION_STATUSES = ["draft", "ready", "sent", "viewed", "signed", "declined", "expired", "completed", "rejected"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const APPLICATION_STATUS_LABELS = labels<ApplicationStatus>({
  draft: "Draft",
  ready: "Ready for signature",
  sent: "Sent",
  viewed: "Viewed",
  signed: "Signed, awaiting review",
  declined: "Declined",
  expired: "Expired",
  completed: "Completed",
  rejected: "Rejected at review",
});

/**
 * Where an application stands, from its current version and that version's signing links.
 * A version is current until a newer one supersedes it; `stale` means the CRM changed since.
 * `links` are newest first.
 */
export function applicationStatus(v: { form: { status: FormStatus } | null; stale: boolean; links: { role: FormSignerRole; status: SigningLinkStatus }[] }): ApplicationStatus {
  if (!v.form || v.form.status === "superseded") return "draft";
  if (v.form.status === "approved") return "completed";
  if (v.form.status === "rejected") return "rejected";
  if (v.form.status === "awaiting_review") return "signed";
  // The newest link per signer counts; cancelled links don't.
  const latest = new Map<FormSignerRole, SigningLinkStatus>();
  for (const l of v.links) if (l.status !== "revoked" && !latest.has(l.role)) latest.set(l.role, l.status);
  const states = [...latest.values()];
  if (!states.length) return v.stale ? "draft" : "ready";
  if (states.includes("declined")) return "declined";
  if (states.includes("opened")) return "viewed";
  if (states.includes("sent")) return "sent";
  if (states.includes("expired")) return "expired";
  return states.every((s) => s === "signed") ? "signed" : "sent";
}

// --- Addresses --------------------------------------------------------------------------

export interface ApplicationAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
}
export const EMPTY_ADDRESS: ApplicationAddress = { line1: null, line2: null, city: null, county: null, postcode: null };
export const addressText = (a: ApplicationAddress | null | undefined) => (a ? [a.line1, a.line2, a.city, a.county, a.postcode].filter((x) => x && x.trim()).join(", ") : "");
export const sameAddress = (a: ApplicationAddress, b: ApplicationAddress) => addressText(a).toLowerCase() === addressText(b).toLowerCase();

/** Whether a supplier application applies to a deal right now (its tab shows and it can be generated or sent). */
export type ApplicationDeal = { productInterest: readonly ProductInterest[]; serviceType: ServiceType; supplierName: string | null | undefined };
