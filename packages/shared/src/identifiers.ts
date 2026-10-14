/**
 * Meter identifier checks (Republic of Ireland formats).
 *
 * - MPRN (electricity): 11 digits, normally starting "10".
 * - GPRN (gas): 7 digits.
 *
 * Legitimate exceptions exist (new connections awaiting a number, unmetered supplies,
 * Northern Ireland / GB sites using MPAN or MPR numbers). A meter point may therefore carry
 * a `formatExceptionReason`; when present, format checks are skipped and only "not blank" applies.
 */

export function normalizeIdentifier(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.replace(/[\s-]/g, "").toUpperCase();
  return v === "" ? null : v;
}

export function mprnFormatError(mprn: string | null): string | null {
  if (!mprn) return null;
  if (!/^\d{11}$/.test(mprn)) return `MPRN "${mprn}" should be 11 digits.`;
  if (!mprn.startsWith("10")) return `MPRN "${mprn}" should start with 10.`;
  return null;
}

export function gprnFormatError(gprn: string | null): string | null {
  if (!gprn) return null;
  if (!/^\d{7}$/.test(gprn)) return `GPRN "${gprn}" should be 7 digits.`;
  return null;
}

/** Errors to show when saving a meter point. Empty array = valid. */
export function meterPointErrors(input: {
  fuel: "electricity" | "gas";
  mprn: string | null;
  gprn: string | null;
  formatExceptionReason?: string | null;
}): string[] {
  const errors: string[] = [];
  if (input.fuel === "electricity" && input.gprn) errors.push("An electricity meter point can't have a GPRN.");
  if (input.fuel === "gas" && input.mprn) errors.push("A gas meter point can't have an MPRN.");
  if (input.formatExceptionReason?.trim()) return errors;
  const e = input.fuel === "electricity" ? mprnFormatError(input.mprn) : gprnFormatError(input.gprn);
  if (e) errors.push(`${e} If this is a genuine exception, record the reason.`);
  return errors;
}

export function percentError(label: string, value: number | null | undefined): string | null {
  if (value == null) return null;
  if (Number.isNaN(value) || value < 0 || value > 100) return `${label} must be between 0 and 100.`;
  return null;
}
