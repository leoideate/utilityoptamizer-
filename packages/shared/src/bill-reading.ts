import { z } from "zod";

/**
 * What the AI reader returns for an energy bill. Every value is a suggestion: the web shows it
 * beside what the CRM holds and a person chooses what to use. Bank details are deliberately not
 * part of it, so they are never extracted or stored.
 */
export const billReadingSchema = z.object({
  /** False when the file isn't an energy bill or can't be read; the other values are then null. */
  readable: z.boolean(),
  customerName: z.string().nullable(),
  supplyAddress: z
    .object({
      line1: z.string(),
      line2: z.string().nullable(),
      city: z.string().nullable(),
      county: z.string().nullable(),
      postcode: z.string().nullable(),
    })
    .nullable(),
  fuel: z.enum(["electricity", "gas"]).nullable(),
  mprn: z.string().nullable(),
  gprn: z.string().nullable(),
  meterNumber: z.string().nullable(),
  supplierName: z.string().nullable(),
  accountNumber: z.string().nullable(),
  billDate: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  tariffName: z.string().nullable(),
  /** Current unit rates and standing charge, in euro (excluding VAT), as printed on the bill. */
  dayRate: z.number().nullable(),
  nightRate: z.number().nullable(),
  gasRate: z.number().nullable(),
  standingChargePerDay: z.number().nullable(),
  /** kWh used in the billing period. */
  usageKwh: z.number().nullable(),
  /** Annual consumption, only when the bill states it. */
  annualConsumptionKwh: z.number().nullable(),
  /** Maximum import capacity (kVA), electricity only. */
  mic: z.number().nullable(),
  readings: z.array(
    z.object({
      register: z.string().nullable(),
      /** Exactly as printed, so leading zeroes survive. */
      value: z.string(),
      readingDate: z.string().nullable(),
      readingType: z.enum(["actual", "estimated", "customer", "smart"]),
    }),
  ),
  /** Anything the person should double-check (blurry digits, two meters, a missing page). */
  notes: z.string().nullable(),
});

export type BillReading = z.infer<typeof billReadingSchema>;

/** Files the reader accepts: PDFs and the photo formats the model reads (not HEIC). */
export const BILL_READING_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
