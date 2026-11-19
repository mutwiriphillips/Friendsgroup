import ExcelJS from 'exceljs';
import { HttpError } from '../lib/http.js';
import { MONTHS } from '../lib/dates.js';

export interface ViewCell { t: string; b?: boolean; i?: boolean; c?: string; bg?: string; al?: 'left' | 'center' | 'right'; n?: boolean; cs?: number; rs?: number; bd?: boolean }
export interface ViewSheet { name: string; widths: number[]; rows: { h?: number; cells: (ViewCell | null)[] }[]; truncated: boolean }

const argb = (c?: Partial<ExcelJS.Color>): string | undefined => (c?.argb && c.argb.length === 8 && c.argb !== 'FF000000' ? `#${c.argb.slice(2)}` : undefined);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Formats a date the way the cell's own number format asks (Excel dates are UTC midnight). */
function fmtDate(d: Date, fmt?: string): string {
  const f = (fmt ?? '').toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/"/g, '');
  const Y = d.getUTCFullYear(), M = d.getUTCMonth(), D = d.getUTCDate();
  if (!/[dmy]/.test(f) || f === 'mm-dd-yy' || f === 'general') return `${String(D).padStart(2, '0')}/${MONTHS[M]}/${Y}`;
  return f.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/g, (t) => ({
    yyyy: String(Y), yy: String(Y).slice(2), mmmm: MONL[M]!, mmm: MON[M]!, mm: String(M + 1).padStart(2, '0'), m: String(M + 1), dd: String(D).padStart(2, '0'), d: String(D),
  } as Record<string, string>)[t]!);
}
const MAX_ROWS = 1000; const MAX_COLS = 120;

/** Renders every sheet of a stored workbook as plain data: what each cell shows, merges, bold, fills, widths. Nothing is interpreted or imported. */
export async function renderWorkbook(buf: Buffer): Promise<ViewSheet[]> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { throw new HttpError(400, 'This file is not a readable Excel workbook'); }
  return wb.worksheets.filter((w) => w.state !== 'hidden').map((ws) => {
    const nRows = Math.min(ws.rowCount, MAX_ROWS); const nCols = Math.min(Math.max(ws.columnCount, 1), MAX_COLS);
    const merged = new Map<string, { cs: number; rs: number }>(); const covered = new Set<string>();
    for (const m of (ws.model.merges ?? []) as string[]) {
      const [a, b] = m.split(':'); if (!a || !b) continue;
      const tl = ws.getCell(a); const br = ws.getCell(b);
      const r1 = Number(tl.row), c1 = Number(tl.col), r2 = Number(br.row), c2 = Number(br.col);
      merged.set(`${r1},${c1}`, { cs: c2 - c1 + 1, rs: r2 - r1 + 1 });
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(`${r},${c}`);
    }
    const rows: ViewSheet['rows'] = [];
    for (let r = 1; r <= nRows; r++) {
      const row = ws.getRow(r);
      if (row.hidden) { rows.push({ cells: [] }); continue; }
      const cells: (ViewCell | null)[] = [];
      for (let c = 1; c <= nCols; c++) {
        if (covered.has(`${r},${c}`)) { cells.push(null); continue; }
        const cell = row.getCell(c);
        let t = '';
        if (cell.value instanceof Date) t = fmtDate(cell.value, cell.numFmt);
        else { try { t = cell.text ?? ''; } catch { t = String(cell.value ?? ''); } }
        const v: ViewCell = { t };
        if (cell.font?.bold) v.b = true;
        if (cell.font?.italic) v.i = true;
        const fc = argb(cell.font?.color); if (fc) v.c = fc;
        const f = cell.fill as ExcelJS.FillPattern | undefined;
        if (f?.type === 'pattern' && f.pattern === 'solid') { const bg = argb(f.fgColor); if (bg && bg !== '#FFFFFF') v.bg = bg; }
        const al = cell.alignment?.horizontal; if (al === 'left' || al === 'center' || al === 'right') v.al = al;
        if (typeof cell.value === 'number' || (typeof cell.value === 'object' && cell.value && 'result' in cell.value && typeof (cell.value as { result: unknown }).result === 'number')) v.n = true;
        const m = merged.get(`${r},${c}`); if (m) { if (m.cs > 1) v.cs = m.cs; if (m.rs > 1) v.rs = m.rs; }
        if (cell.border && Object.values(cell.border).some(Boolean)) v.bd = true;
        cells.push(v);
      }
      rows.push({ h: row.height || undefined, cells });
    }
    const widths = Array.from({ length: nCols }, (_, i) => Math.min(ws.getColumn(i + 1).width ?? 9, 40));
    return { name: ws.name, widths, rows, truncated: ws.rowCount > MAX_ROWS || ws.columnCount > MAX_COLS };
  });
}
