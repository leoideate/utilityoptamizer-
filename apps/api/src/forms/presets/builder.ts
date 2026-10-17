import type { FormDocumentType, FormField, FormSource } from "@uo/shared";

/** A supplier form that comes set up: recognised by the PDF's SHA-256 when it's uploaded. */
export interface FormPreset {
  /** Stable key, e.g. "flogas-gas-sme-agreement". */
  key: string;
  name: string;
  /** Supplier name as seeded (matched case-insensitively). */
  supplier: string;
  documentType: FormDocumentType;
  /** SHA-256 of the supplier's PDF this preset was drawn for. */
  sha256: string;
  fields: FormField[];
}

type Extra = Partial<Pick<FormField, "match" | "onlyIf" | "mask" | "upper" | "fontSize" | "comb" | "required">>;

/**
 * Small helpers to write field lists. Coordinates are PDF points from the page's bottom-left corner,
 * measured from the supplier's PDF (text positions and drawn boxes extracted with pdf.js).
 */
export function preset(prefix: string) {
  let n = 0;
  const id = () => `${prefix}${++n}`;
  return {
    /** A text value. */
    text: (label: string, page: number, x: number, y: number, w: number, h: number, source: FormSource | null, extra: Extra = {}): FormField => ({ id: id(), label, kind: "text", page, x, y, w, h, source, ...extra }),
    /** A tick box (drawn as an X): ticked when `source` is yes, or equals `match`. */
    tick: (label: string, page: number, x: number, y: number, w: number, h: number, source: FormSource | null, match?: string, extra: Extra = {}): FormField => ({
      id: id(),
      label,
      kind: "check",
      page,
      x,
      y,
      w,
      h,
      source,
      ...(match !== undefined ? { match } : {}),
      ...extra,
    }),
    /** Where someone signs (left empty until a signed copy is made). */
    sign: (label: string, page: number, x: number, y: number, w: number, h: number, signer: "customer" | "broker" = "customer"): FormField => ({ id: id(), label, kind: "signature", page, x, y, w, h, signer }),
    /** The date someone signed. */
    signedDate: (label: string, page: number, x: number, y: number, w: number, h: number, signer: "customer" | "broker" = "customer"): FormField => ({ id: id(), label, kind: "signed_date", page, x, y, w, h, signer }),
    /** A white box over what a scanned form already shows (nothing is written). */
    mask: (label: string, page: number, x: number, y: number, w: number, h: number): FormField => ({ id: id(), label, kind: "text", page, x, y, w, h, source: null, mask: true }),
  };
}
