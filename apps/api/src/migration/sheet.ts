import { type MigrationField, type SheetCell, migrationColumn } from "@uo/shared";
import ExcelJS from "exceljs";

export interface SheetTab {
  name: string;
  rows: { line: number; cells: Partial<Record<MigrationField, SheetCell>> }[];
  /** Headers the import doesn't use (Month, Year...), listed in the report. */
  ignored: string[];
}

/** A cell's value without Excel's wrappers (rich text, formulas, hyperlinks such as mailto: emails). */
function plain(v: ExcelJS.CellValue): SheetCell {
  if (v == null || typeof v !== "object" || v instanceof Date) return v as SheetCell;
  if ("richText" in v) return v.richText.map((r) => r.text).join("");
  if ("result" in v) return plain(v.result as ExcelJS.CellValue);
  if ("text" in v) return typeof v.text === "string" ? v.text : plain(v.text as ExcelJS.CellValue);
  if ("error" in v) return null;
  return null;
}

/**
 * Reads every tab of the master sheet. The header row is the first of the top five rows with at
 * least three known column names; rows with nothing in the known columns are skipped.
 */
export async function readMasterSheet(buffer: Buffer): Promise<SheetTab[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const tabs: SheetTab[] = [];
  wb.eachSheet((ws) => {
    let headerRow = 0;
    let columns = new Map<number, MigrationField>();
    let ignored: string[] = [];
    for (let r = 1; r <= Math.min(5, ws.rowCount) && !headerRow; r++) {
      const found = new Map<number, MigrationField>();
      const other: string[] = [];
      ws.getRow(r).eachCell((cell, col) => {
        const f = migrationColumn(plain(cell.value));
        if (f && ![...found.values()].includes(f)) found.set(col, f);
        else if (plain(cell.value) != null) other.push(String(plain(cell.value)));
      });
      if (found.size >= 3) [headerRow, columns, ignored] = [r, found, other];
    }
    const rows: SheetTab["rows"] = [];
    if (headerRow) {
      ws.eachRow((row, line) => {
        if (line <= headerRow) return;
        const cells: SheetTab["rows"][number]["cells"] = {};
        for (const [col, field] of columns) cells[field] = plain(row.getCell(col).value);
        if (Object.values(cells).some((v) => v != null && String(v).trim() !== "")) rows.push({ line, cells });
      });
    }
    tabs.push({ name: ws.name, rows, ignored });
  });
  return tabs;
}
