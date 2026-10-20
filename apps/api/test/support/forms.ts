import { deflateSync, crc32 } from "node:zlib";
import { PDFDocument } from "pdf-lib";

/** A one-page supplier form with fillable fields, like the Bord Gáis electricity form. */
export async function supplierPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();
  form.createTextField("Customer name").addToPage(page, { x: 50, y: 760, width: 250, height: 18 });
  form.createCheckBox("Electricity").addToPage(page, { x: 50, y: 720, width: 12, height: 12 });
  form.createTextField("Client Signature").addToPage(page, { x: 50, y: 120, width: 200, height: 40 });
  form.createTextField("Signature Date").addToPage(page, { x: 300, y: 120, width: 100, height: 18 });
  const mprn = form.createTextField("MPRN boxes");
  mprn.setMaxLength(11);
  mprn.enableCombing();
  mprn.addToPage(page, { x: 50, y: 600, width: 220, height: 18 });
  return Buffer.from(await doc.save());
}

/** A small valid PNG (dark pixels on transparent), standing in for a cleaned signature photo. */
export function png(w = 40, h = 12) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) if ((x + y) % 3 === 0) row.set([20, 20, 60, 255], 1 + x * 4);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
