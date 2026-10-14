/**
 * Turns raw business-card text into fields. Providers that return structured fields can
 * skip this; generic OCR providers only return lines of text.
 */

export interface CardFields {
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  website: string | null;
  address: string | null;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const URL_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ie|com|co\.uk|uk|eu|net|org|biz|io))(?:\/\S*)?\b/i;
const PHONE = /(?:\+?\d[\d\s().-]{6,}\d)/;
const MOBILE_HINT = /\b(m|mob|mobile|cell)\b[:.]?/i;
const TITLE_WORDS =
  /\b(director|manager|owner|ceo|cfo|coo|founder|partner|head|officer|consultant|executive|sales|accountant|proprietor|secretary|administrator|engineer|supervisor|chairman|president|md)\b/i;
const COMPANY_WORDS = /\b(ltd|limited|plc|dac|clg|llp|inc|gmbh|group|holdings|services|solutions|& co|company|teoranta|t\/a)\b/i;
const ADDRESS_WORDS = /\b(road|rd|street|st|avenue|ave|lane|park|business park|unit|floor|suite|co\.|county|dublin|cork|galway|limerick|waterford|belfast|eircode|d\d{2}|[a-z]\d{2}\s?[a-z0-9]{4})\b/i;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const isMobileNumber = (digits: string) => /^(?:353|0)?8[35-9]/.test(digits) || /^(?:44|0)?7/.test(digits);

export function parseCardText(text: string): CardFields {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const used = new Set<number>();
  const f: CardFields = { firstName: null, lastName: null, company: null, jobTitle: null, email: null, phone: null, mobile: null, website: null, address: null };

  lines.forEach((line, i) => {
    const email = line.match(EMAIL)?.[0];
    if (email && !f.email) {
      f.email = email.toLowerCase();
      used.add(i);
    }
    const phones = line.match(new RegExp(PHONE.source, "g")) ?? [];
    for (const p of phones) {
      const digits = p.replace(/\D/g, "");
      if (digits.length < 7) continue;
      const mobile = MOBILE_HINT.test(line) || isMobileNumber(digits);
      if (mobile && !f.mobile) f.mobile = clean(p);
      else if (!f.phone) f.phone = clean(p);
      used.add(i);
    }
    if (!email) {
      const url = line.match(URL_RE)?.[1];
      if (url && !f.website) {
        f.website = url.toLowerCase();
        used.add(i);
      }
    }
  });

  const addressLines: string[] = [];
  lines.forEach((line, i) => {
    if (used.has(i)) return;
    if (ADDRESS_WORDS.test(line) && /\d|,/.test(line)) {
      addressLines.push(line);
      used.add(i);
    }
  });
  if (addressLines.length) f.address = addressLines.join(", ");

  lines.forEach((line, i) => {
    if (used.has(i)) return;
    if (!f.company && COMPANY_WORDS.test(line)) {
      f.company = line;
      used.add(i);
    } else if (!f.jobTitle && TITLE_WORDS.test(line)) {
      f.jobTitle = line;
      used.add(i);
    }
  });

  // Name: first remaining line that looks like 2-4 capitalised words.
  const nameIdx = lines.findIndex((l, i) => !used.has(i) && /^[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,3}$/.test(l));
  if (nameIdx >= 0) {
    const parts = lines[nameIdx].split(" ");
    f.firstName = parts[0];
    f.lastName = parts.slice(1).join(" ");
    used.add(nameIdx);
  }
  if (!f.company) {
    const rest = lines.findIndex((_, i) => !used.has(i));
    if (rest >= 0) f.company = lines[rest];
  }
  if (!f.company && f.email) {
    const domain = f.email.split("@")[1].split(".")[0];
    if (!/gmail|hotmail|outlook|yahoo|icloud|eircom/.test(domain)) f.company = domain.charAt(0).toUpperCase() + domain.slice(1);
  }
  return f;
}
