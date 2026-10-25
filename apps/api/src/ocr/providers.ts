import type { DocumentReader } from "../ai/document-reader";
import type { CardFields } from "./card-parser";

export interface OcrResult {
  /** Full recognised text, line by line. */
  text: string;
  /** 0–1 overall confidence reported by the provider. */
  confidence: number | null;
  /** Some providers return structured fields; otherwise the text is parsed locally. */
  fields?: Partial<CardFields>;
}

/** Vendor-neutral OCR adapter. Add a vendor by implementing this and wiring it in OcrModule. */
export interface OcrProvider {
  readonly name: string;
  /** False for "manual": the user types the details while viewing the image. */
  readonly automatic: boolean;
  recognise(image: Buffer, mimeType: string): Promise<OcrResult>;
}

export const OCR_PROVIDER = Symbol("OCR_PROVIDER");

export class ManualOcrProvider implements OcrProvider {
  readonly name = "manual";
  readonly automatic = false;
  async recognise(): Promise<OcrResult> {
    return { text: "", confidence: null };
  }
}

/**
 * Generic HTTP adapter. POSTs the image as JSON { image: base64, mimeType } with a bearer key
 * and expects { text: string, confidence?: number, fields?: {...} }. Point it at a small
 * wrapper around the chosen vendor (Azure, Google, AWS Textract, ...). The key is only sent
 * in the Authorization header and is never logged.
 */
export class HttpOcrProvider implements OcrProvider {
  readonly name = "http";
  readonly automatic = true;
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs = 30_000,
  ) {}

  async recognise(image: Buffer, mimeType: string): Promise<OcrResult> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ image: image.toString("base64"), mimeType }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`OCR provider returned HTTP ${res.status}`);
    const body = (await res.json()) as { text?: unknown; confidence?: unknown; fields?: Partial<CardFields> };
    if (typeof body.text !== "string") throw new Error("OCR provider response has no text");
    const confidence = typeof body.confidence === "number" && body.confidence >= 0 && body.confidence <= 1 ? body.confidence : null;
    return { text: body.text, confidence, fields: body.fields };
  }
}

/** Reads the card with the AI document reader, which returns the fields directly. */
export class AiOcrProvider implements OcrProvider {
  readonly name = "claude";
  readonly automatic = true;
  constructor(private readonly reader: DocumentReader) {}

  async recognise(image: Buffer, mimeType: string): Promise<OcrResult> {
    const fields = await this.reader.readCard(image, mimeType);
    const text = Object.values(fields).filter(Boolean).join("\n");
    return { text, confidence: null, fields };
  }
}
