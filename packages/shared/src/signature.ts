/**
 * Email signatures: a company template (logo, company details) set by an administrator, and each
 * person's own signature, which starts from the template and can be customised (their own
 * picture, text, colour, picture size). One renderer builds the HTML and plain-text versions, so
 * the preview in the CRM is exactly what recipients see.
 */
import { z } from "zod";

export const SIGNATURE_IMAGE_CHOICES = ["company", "own", "none"] as const;
export type SignatureImageChoice = (typeof SIGNATURE_IMAGE_CHOICES)[number];
export const SIGNATURE_IMAGE_LABELS: Record<SignatureImageChoice, string> = { company: "Company logo", own: "My own picture", none: "No picture" };

const opt = (max: number) => z.string().trim().max(max).nullable().optional();
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Choose a colour.");

export const companySignatureSchema = z.object({
  companyName: z.string().trim().min(1, "Enter the company name.").max(200),
  address: opt(300),
  phone: opt(40),
  website: z.string().trim().max(200).regex(/^(https?:\/\/)?[^\s<>"]+\.[^\s<>"]+$/, "Enter a web address such as utilityoptimizer.ie.").nullable().optional().or(z.literal("")),
  email: z.string().trim().email("Enter a valid email address.").nullable().optional().or(z.literal("")),
  /** Shown in small print under every signature, e.g. registered company details. */
  disclaimer: opt(600),
});
export type CompanySignature = z.infer<typeof companySignatureSchema>;

export const emailSignatureSchema = z.object({
  enabled: z.boolean(),
  fullName: z.string().trim().min(1, "Enter your name.").max(120),
  jobTitle: opt(120),
  phone: opt(40),
  mobile: opt(40),
  email: z.string().trim().email("Enter a valid email address.").nullable().optional().or(z.literal("")),
  /** Extra lines under the contact details (one per line), e.g. a qualification or opening hours. */
  extra: opt(600),
  image: z.enum(SIGNATURE_IMAGE_CHOICES),
  /** Picture width in pixels. */
  imageWidth: z.number().int().min(40).max(320),
  /** Colour of the name and the divider line. */
  accentColor: hex,
  /** Include the company name, address, phone and website from the company template. */
  showCompany: z.boolean(),
});
export type EmailSignature = z.infer<typeof emailSignatureSchema>;

export const DEFAULT_SIGNATURE_STYLE = { image: "company" as SignatureImageChoice, imageWidth: 160, accentColor: "#036b5c", showCompany: true };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const lines = (s: string | null | undefined) => (s ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const webHref = (w: string) => (/^https?:\/\//i.test(w) ? w : `https://${w}`);

/**
 * Builds the signature. `images` are absolute URLs (recipients' mail apps load them), or null when
 * there is no such picture. Every value is escaped; nothing the user types becomes markup.
 */
export function renderSignature(sig: EmailSignature, company: CompanySignature, images: { company: string | null; own: string | null }): { html: string; text: string } {
  // Values are validated when saved; checked again here because they go into style attributes.
  sig = { ...sig, accentColor: /^#[0-9a-fA-F]{6}$/.test(sig.accentColor) ? sig.accentColor : DEFAULT_SIGNATURE_STYLE.accentColor, imageWidth: Math.min(320, Math.max(40, Math.round(sig.imageWidth) || 160)) };
  const img = sig.image === "none" ? null : images[sig.image];
  const contact = [sig.phone ? `T ${sig.phone}` : null, sig.mobile ? `M ${sig.mobile}` : null].filter((x): x is string => !!x);
  const email = sig.email || null;
  const extra = lines(sig.extra);
  const co = sig.showCompany ? company : null;
  const coLines = co ? [co.companyName, ...lines(co.address)] : [];
  const coContact = co ? [co.phone ? `T ${co.phone}` : null, co.website || null, co.email || null].filter((x): x is string => !!x) : [];
  const disclaimer = co?.disclaimer?.trim() || null;

  const text = [
    sig.fullName,
    sig.jobTitle,
    contact.join(" · ") || null,
    email,
    ...extra,
    ...(coLines.length ? ["", ...coLines] : []),
    coContact.join(" · ") || null,
    ...(disclaimer ? ["", disclaimer] : []),
  ]
    .filter((x) => x !== null && x !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const font = "font-family:Arial,Helvetica,sans-serif;";
  const small = `${font}font-size:13px;line-height:1.45;color:#3c4043;`;
  const link = (href: string, label: string) => `<a href="${esc(href)}" style="color:${sig.accentColor};text-decoration:none;">${esc(label)}</a>`;
  const rows: string[] = [];
  rows.push(`<div style="${font}font-size:15px;font-weight:bold;color:${sig.accentColor};">${esc(sig.fullName)}</div>`);
  if (sig.jobTitle) rows.push(`<div style="${small}">${esc(sig.jobTitle)}</div>`);
  if (contact.length || email) rows.push(`<div style="${small}">${[...contact.map(esc), ...(email ? [link(`mailto:${email}`, email)] : [])].join(" &middot; ")}</div>`);
  for (const l of extra) rows.push(`<div style="${small}">${esc(l)}</div>`);
  if (coLines.length) {
    rows.push(`<div style="border-top:1px solid ${sig.accentColor};margin:8px 0 6px;width:220px;line-height:0;font-size:0;">&nbsp;</div>`);
    rows.push(`<div style="${small}font-weight:bold;">${esc(coLines[0])}</div>`);
    for (const l of coLines.slice(1)) rows.push(`<div style="${small}">${esc(l)}</div>`);
    if (coContact.length) {
      const parts = [co!.phone ? esc(`T ${co!.phone}`) : null, co!.website ? link(webHref(co!.website), co!.website) : null, co!.email ? link(`mailto:${co!.email}`, co!.email) : null].filter(Boolean);
      rows.push(`<div style="${small}">${parts.join(" &middot; ")}</div>`);
    }
  }
  const imageCell = img ? `<td style="padding:0 14px 0 0;vertical-align:top;"><img src="${esc(img)}" width="${sig.imageWidth}" alt="${esc(sig.image === "company" ? (company.companyName ?? "Logo") : sig.fullName)}" style="display:block;width:${sig.imageWidth}px;max-width:${sig.imageWidth}px;height:auto;border:0;" /></td>` : "";
  const disclaimerRow = disclaimer ? `<tr><td colspan="${img ? 2 : 1}" style="${font}font-size:11px;line-height:1.4;color:#80868b;padding-top:10px;">${esc(disclaimer).replace(/\n/g, "<br>")}</td></tr>` : "";
  const html = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>${imageCell}<td style="vertical-align:top;">${rows.join("")}</td></tr>${disclaimerRow}</table>`;
  return { html, text };
}

/** Turns a plain-text email body into simple HTML (escaped, line breaks kept). */
export function textToHtml(body: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124;">${esc(body).replace(/\r?\n/g, "<br>")}</div>`;
}

/** The full message: body, then the signature, as text and HTML. */
export function withSignature(body: string, signature: { html: string; text: string } | null): { text: string; html?: string } {
  if (!signature) return { text: body };
  return { text: `${body.trimEnd()}\n\n-- \n${signature.text}`, html: `${textToHtml(body.trimEnd())}<br><br>${signature.html}` };
}
