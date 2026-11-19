import ExcelJS from 'exceljs';
import type { PoolClient } from 'pg';
import { dmyTimeEAT } from '../lib/dates.js';
import type { Db } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { audit, type Actor } from '../lib/audit.js';
import { ensureFinancialYear } from './obligations.js';
import { registerMemberLenient } from './members.js';
import { LOGO, WATERMARK_TILE } from './reports.js';
import { config } from '../config.js';

/**
 * The group's own sheet (members x months, "Cont" and "Fine" per month, meeting penalties) is the model for the
 * ledger. Conventions of the sheet, kept as they are:
 *   - contribution cell: amount paid that month
 *   - fine cell / meeting penalty cell: positive = paid, negative = unpaid (outstanding)
 * Everything lands in the append-only ledgers (savings_transactions / fine_ledger) tagged with the sheet's month.
 */

export interface SheetCell { member: string; kind: 'cont' | 'fine' | 'meeting'; period?: string; meetingIdx?: number; cents: number; paid?: boolean; ref: string }
export interface SheetMeeting { idx: number; title: string; venue: string; date: string; label: string }
export interface ParsedSheet {
  sheetName: string;
  members: string[];
  months: string[];
  meetings: SheetMeeting[];
  cells: SheetCell[];
  expenses: { description: string; period: string; cents: number }[];
  checks: { period: string; sheetCont?: number; calcCont: number; sheetFine?: number; calcFine: number }[];
  arrears: { sheet: number | null; calculated: number };
  warnings: string[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const label = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]![0]!.toUpperCase()}${MONTHS[Number(period.slice(5, 7)) - 1]!.slice(1)} ${period.slice(0, 4)}`;

function raw(v: ExcelJS.CellValue): unknown {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: string };
    if (o.result !== undefined) return o.result;
    if (o.richText) return o.richText.map((t) => t.text).join('');
    if (o.text !== undefined) return o.text;
  }
  return v;
}
const text = (v: ExcelJS.CellValue) => { const r = raw(v); return r === null || r === undefined ? '' : r instanceof Date ? r.toISOString().slice(0, 10) : String(r).trim(); };
const num = (v: ExcelJS.CellValue): number | null => { const r = raw(v); if (typeof r === 'number' && Number.isFinite(r)) return r; if (typeof r === 'string' && /^-?[\d,]+(\.\d+)?$/.test(r.trim())) return Number(r.replace(/,/g, '')); return null; };

function monthOf(v: ExcelJS.CellValue): string | null {
  const r = raw(v);
  if (r instanceof Date) return `${r.getUTCFullYear()}-${pad(r.getUTCMonth() + 1)}-01`;
  if (typeof r !== 'string') return null;
  const m = /^([A-Za-z]{3,})\.?\s*(\d{4})$/.exec(r.trim());
  if (!m) return null;
  const i = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
  return i < 0 ? null : `${m[2]}-${pad(i + 1)}-01`;
}

function parseMeetingLabel(t: string, prevDate: string | null): { date: string; venue: string } | null {
  const m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?\s*(\d{2,4})?\s*(.*)$/.exec(t.trim());
  if (!m) return null;
  const mi = MONTHS.findIndex((x) => x.startsWith(m[2]!.slice(0, 3).toLowerCase()));
  if (mi < 0) return null;
  let year: number;
  if (m[3]) year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  else {
    year = prevDate ? Number(prevDate.slice(0, 4)) : new Date().getFullYear();
    if (prevDate && `${year}-${pad(mi + 1)}-${pad(Number(m[1]))}` < prevDate) year += 1;
  }
  return { date: `${year}-${pad(mi + 1)}-${pad(Number(m[1]))}`, venue: m[4]!.trim() || 'Not recorded' };
}

export async function parseSheet(buffer: Buffer): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as unknown as ArrayBuffer); } catch { throw new HttpError(400, 'That file could not be read as an .xlsx workbook'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'The workbook has no sheets');
  const out: ParsedSheet = { sheetName: ws.name, members: [], months: [], meetings: [], cells: [], expenses: [], checks: [], arrears: { sheet: null, calculated: 0 }, warnings: [] };
  if (text(ws.getCell(1, 1).value).toLowerCase() !== 'member name') throw new HttpError(400, 'Expected "Member Name" in cell A1 — this is not the members-by-months sheet');

  // column map from header rows 1 and 2
  type Col = { col: number; kind: 'cont' | 'fine' | 'meeting'; period?: string; meetingIdx?: number };
  const cols: Col[] = [];
  let arrearsCol = 0;
  const lastCol = ws.columnCount;
  let prevMeetingDate: string | null = null;
  for (let c = 2; c <= lastCol; c++) {
    const h = ws.getCell(1, c).value;
    const t = text(h);
    const period = monthOf(h);
    if (period) {
      if (out.months.includes(period)) continue; // merged header cell repeating over the Fine column
      out.months.push(period);
      cols.push({ col: c, kind: 'cont', period });
      if (text(ws.getCell(2, c + 1).value).toLowerCase() === 'fine') cols.push({ col: c + 1, kind: 'fine', period });
    } else if (/meeting/i.test(t) && /penalt|absen/i.test(t)) {
      let c2 = c;
      while (c2 <= lastCol && (c2 === c || !text(ws.getCell(1, c2).value) || text(ws.getCell(1, c2).value) === t)) {
        const lab = text(ws.getCell(2, c2).value);
        if (lab) {
          const p = parseMeetingLabel(lab, prevMeetingDate);
          if (!p) out.warnings.push(`Meeting heading "${lab}" has no readable date; skipped`);
          else {
            prevMeetingDate = p.date;
            const idx = out.meetings.length;
            out.meetings.push({ idx, title: `Meeting at ${p.venue}`, venue: p.venue, date: p.date, label: lab });
            cols.push({ col: c2, kind: 'meeting', meetingIdx: idx });
          }
        }
        c2++;
      }
      c = c2 - 1;
    } else if (/arrears/i.test(t)) arrearsCol = c;
  }

  // member rows start on row 3 and end at the first blank name
  let r = 3;
  const rowOf: Record<string, number> = {};
  for (; r <= ws.rowCount; r++) {
    const name = text(ws.getCell(r, 1).value);
    if (!name) break;
    if (rowOf[name.toLowerCase()]) { out.warnings.push(`"${name}" appears twice in the sheet; the second row was ignored`); continue; }
    rowOf[name.toLowerCase()] = r;
    out.members.push(name);
  }
  const totalsRow = (() => { for (let x = r; x <= Math.min(r + 4, ws.rowCount); x++) { if (text(ws.getCell(x, 1).value).toLowerCase() === 'expenses') break; if (cols.some((k) => num(ws.getCell(x, k.col).value) !== null) || (arrearsCol && num(ws.getCell(x, arrearsCol).value) !== null)) return x; } return 0; })();

  const sums = new Map<string, { cont: number; fine: number }>();
  let unpaid = 0;
  for (const name of out.members) {
    const row = rowOf[name.toLowerCase()]!;
    for (const k of cols) {
      const cell = ws.getCell(row, k.col);
      const v = num(cell.value);
      if (v === null) { if (text(cell.value)) out.warnings.push(`${name}: "${text(cell.value)}" in ${cell.address} is not a number and was ignored`); continue; }
      if (v === 0) continue;
      const ref = cell.address;
      if (k.kind === 'cont') {
        if (v < 0) { out.warnings.push(`${name}: negative contribution in ${ref}; ignored`); continue; }
        out.cells.push({ member: name, kind: 'cont', period: k.period, cents: Math.round(v * 100), ref });
        const s = sums.get(k.period!) ?? { cont: 0, fine: 0 }; s.cont += v; sums.set(k.period!, s);
        if (v !== 1500) out.warnings.push(`${name}, ${label(k.period!)}: contribution is KSh ${v.toLocaleString()} (the usual amount is 1,500) — imported as written (${ref})`);
      } else if (k.kind === 'fine') {
        const paid = v > 0;
        out.cells.push({ member: name, kind: 'fine', period: k.period, cents: Math.round(Math.abs(v) * 100), paid, ref });
        const s = sums.get(k.period!) ?? { cont: 0, fine: 0 }; s.fine += Math.abs(v); sums.set(k.period!, s);
        if (!paid) unpaid += Math.abs(v);
      } else {
        const paid = v > 0;
        out.cells.push({ member: name, kind: 'meeting', meetingIdx: k.meetingIdx, cents: Math.round(Math.abs(v) * 100), paid, ref });
        if (!paid) unpaid += Math.abs(v);
      }
    }
  }
  out.arrears.calculated = unpaid * 100;

  for (const [period, s] of [...sums.entries()].sort()) {
    const contCol = cols.find((k) => k.period === period && k.kind === 'cont');
    const fineCol = cols.find((k) => k.period === period && k.kind === 'fine');
    out.checks.push({
      period, calcCont: s.cont * 100, calcFine: s.fine * 100,
      sheetCont: totalsRow && contCol ? (num(ws.getCell(totalsRow, contCol.col).value) ?? undefined) : undefined,
      sheetFine: totalsRow && fineCol ? (num(ws.getCell(totalsRow, fineCol.col).value) ?? undefined) : undefined,
    });
  }
  for (const c of out.checks) {
    if (c.sheetCont !== undefined && c.sheetCont * 100 !== c.calcCont) out.warnings.push(`${label(c.period)}: the sheet's contribution total is KSh ${c.sheetCont.toLocaleString()} but the rows add up to KSh ${(c.calcCont / 100).toLocaleString()}`);
    if (c.sheetFine !== undefined && c.sheetFine * 100 !== c.calcFine) out.warnings.push(`${label(c.period)}: the sheet's fines total is KSh ${c.sheetFine.toLocaleString()} but the rows add up to KSh ${(c.calcFine / 100).toLocaleString()}`);
  }
  if (arrearsCol && totalsRow) {
    const t = num(ws.getCell(totalsRow, arrearsCol).value);
    if (t !== null) {
      out.arrears.sheet = Math.abs(t) * 100;
      if (Math.abs(t) !== unpaid) out.warnings.push(`The sheet's arrears total is KSh ${Math.abs(t).toLocaleString()} but the unpaid penalties in the rows add up to KSh ${unpaid.toLocaleString()}`);
    }
  }

  // Expenses block
  let er = totalsRow ? totalsRow + 1 : r + 1;
  while (er <= ws.rowCount && text(ws.getCell(er, 1).value).toLowerCase() !== 'expenses') er++;
  for (er++; er <= ws.rowCount; er++) {
    const d = text(ws.getCell(er, 1).value);
    if (!d) continue;
    for (const k of cols.filter((x) => x.kind === 'cont')) {
      const v = num(ws.getCell(er, k.col).value);
      if (v && v > 0) out.expenses.push({ description: d, period: k.period!, cents: Math.round(v * 100) });
    }
  }
  if (!out.members.length) throw new HttpError(400, 'No member rows were found under the header');
  return out;
}

/** What would be loaded, without writing anything. */
export async function previewSheet(db: Db, p: ParsedSheet) {
  const existing = (await db.query(`SELECT lower(trim(full_name)) AS n FROM members`)).rows.map((r) => r.n as string);
  const have = new Set(existing);
  const already = (await db.query(`SELECT count(*)::int AS n FROM meetings WHERE is_historical AND sheet_order IS NOT NULL`)).rows[0].n;
  const sum = (f: (c: SheetCell) => boolean) => p.cells.filter(f).reduce((a, c) => a + c.cents, 0);
  const cnt = (f: (c: SheetCell) => boolean) => p.cells.filter(f).length;
  const errors: string[] = [];
  if (already) errors.push('This sheet has already been loaded (historical meetings exist). Edit values in the ledger grid instead of re-importing.');
  return {
    sheet: p.sheetName,
    members: { total: p.members.length, newMembers: p.members.filter((n) => !have.has(n.toLowerCase())).length, existing: p.members.filter((n) => have.has(n.toLowerCase())).length },
    months: { from: p.months[0], to: p.months[p.months.length - 1] },
    contributions: { count: cnt((c) => c.kind === 'cont'), totalCents: sum((c) => c.kind === 'cont') },
    lateFines: { paid: cnt((c) => c.kind === 'fine' && !!c.paid), paidCents: sum((c) => c.kind === 'fine' && !!c.paid), unpaid: cnt((c) => c.kind === 'fine' && !c.paid), unpaidCents: sum((c) => c.kind === 'fine' && !c.paid) },
    meetings: p.meetings.map((m) => ({ ...m, paid: cnt((c) => c.kind === 'meeting' && c.meetingIdx === m.idx && !!c.paid), unpaid: cnt((c) => c.kind === 'meeting' && c.meetingIdx === m.idx && !c.paid), paidCents: sum((c) => c.kind === 'meeting' && c.meetingIdx === m.idx && !!c.paid), unpaidCents: sum((c) => c.kind === 'meeting' && c.meetingIdx === m.idx && !c.paid) })),
    expenses: p.expenses,
    arrears: p.arrears,
    warnings: p.warnings,
    errors,
  };
}

async function createFine(c: PoolClient, a: { memberId: string; category: 'late_payment' | 'absence'; cents: number; date: string; reason: string; period?: string | null; meetingId?: string | null; paid: boolean; actor: Actor; note: string }) {
  const f = await c.query(
    `INSERT INTO fines (reference, member_id, category, amount_cents, imposed_on, reason, status, paid_at, is_historical, period, meeting_id, created_by)
     VALUES ('FN-' || lpad(nextval('fine_ref_seq')::text, 6, '0'), $1,$2,$3,$4::date,$5,$6, CASE WHEN $7 THEN ($4::date::timestamp AT TIME ZONE 'Africa/Nairobi') END, true, $8::date, $9, $10) RETURNING id`,
    [a.memberId, a.category, a.cents, a.date, a.reason, a.paid ? 'paid' : 'outstanding', a.paid, a.period ?? null, a.meetingId ?? null, a.actor.userId],
  );
  const id = f.rows[0].id as string;
  await c.query(`INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by, created_at) VALUES ($1,$2,'charge',$3,$4,$5,($6::date::timestamp AT TIME ZONE 'Africa/Nairobi'))`, [id, a.memberId, a.cents, a.note, a.actor.userId, a.date]);
  if (a.paid) await c.query(`INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by, created_at) VALUES ($1,$2,'payment',$3,$4,$5,($6::date::timestamp AT TIME ZONE 'Africa/Nairobi'))`, [id, a.memberId, -a.cents, `${a.note} (marked paid)`, a.actor.userId, a.date]);
  return id;
}

export async function commitSheet(c: PoolClient, p: ParsedSheet, filename: string, actor: Actor) {
  const pv = await previewSheet(c, p);
  if (pv.errors.length) throw new HttpError(409, pv.errors[0]!);
  const note = `Imported from ${filename}`;

  const ids = new Map<string, string>();
  let created = 0;
  for (const name of p.members) {
    const found = (await c.query(`SELECT id FROM members WHERE lower(trim(full_name)) = $1`, [name.toLowerCase()])).rows[0];
    if (found) { ids.set(name, found.id); continue; }
    const firstPeriod = p.cells.filter((x) => x.member === name && x.period).map((x) => x.period!).sort()[0];
    const m = await registerMemberLenient(c, { fullName: name, registeredOn: firstPeriod } as never, actor, undefined, true);
    ids.set(name, m.id);
    created++;
  }

  const meetingIds = new Map<number, string>();
  for (const m of p.meetings) {
    const fy = await ensureFinancialYear(c, m.date);
    const row = (await c.query(
      `INSERT INTO meetings (financial_year_id, title, scheduled_at, venue, status, register_confirmed_at, register_confirmed_by, created_by, is_historical, sheet_order, minutes)
       VALUES ($1,$2,($3::date::timestamp AT TIME ZONE 'Africa/Nairobi'),$4,'register_confirmed',now(),$5,$5,true,$6,$7) RETURNING id`,
      [fy, m.title, m.date, m.venue, actor.userId, m.idx, `Loaded from the group's sheet (heading: ${m.label}). Only absenteeism penalties were recorded.`],
    )).rows[0];
    meetingIds.set(m.idx, row.id);
  }

  let n = 0;
  for (const cell of p.cells) {
    const memberId = ids.get(cell.member)!;
    if (cell.kind === 'cont') {
      await c.query(
        `INSERT INTO savings_transactions (member_id, type, amount_cents, reference, reason, is_historical, period, occurred_at, created_by)
         VALUES ($1,'historical',$2,$3,$4,true,$5::date,($5::date::timestamp AT TIME ZONE 'Africa/Nairobi'),$6)`,
        [memberId, cell.cents, `SHEET ${cell.ref}`, note, cell.period, actor.userId],
      );
    } else if (cell.kind === 'fine') {
      const d = new Date(`${cell.period}T00:00:00Z`); d.setUTCDate(11);
      await createFine(c, { memberId, category: 'late_payment', cents: cell.cents, date: d.toISOString().slice(0, 10), reason: `Late contribution fine, ${label(cell.period!)}`, period: cell.period, paid: !!cell.paid, actor, note });
    } else {
      const m = p.meetings[cell.meetingIdx!]!;
      const meetingId = meetingIds.get(m.idx)!;
      await createFine(c, { memberId, category: 'absence', cents: cell.cents, date: m.date, reason: `Absence penalty, ${m.title} (${m.date})`, meetingId, paid: !!cell.paid, actor, note });
      await c.query(`INSERT INTO attendance (meeting_id, member_id, status, updated_by) VALUES ($1,$2,'absent',$3) ON CONFLICT (meeting_id, member_id) DO UPDATE SET status = 'absent'`, [meetingId, memberId, actor.userId]);
    }
    n++;
  }

  for (const e of p.expenses) {
    await c.query(
      `INSERT INTO expenditure (reference, category, amount_cents, spent_on, description, recipient, status, requested_by, approved_by, approved_at, payment_reference, paid_at)
       VALUES ('EX-' || lpad(nextval('expenditure_ref_seq')::text, 5, '0'),'administrative',$1,$2::date,$3,'As recorded in the group sheet','paid',$4,$4,now(),$5,($2::date::timestamp AT TIME ZONE 'Africa/Nairobi'))`,
      [e.cents, e.period, e.description, actor.userId, `SHEET ${filename}`],
    );
  }

  await audit(c, actor, 'sheet.imported', 'import', 'friends_sheet', { after: { filename, newMembers: created, entries: n, expenses: p.expenses.length, warnings: p.warnings.length } });
  return { newMembers: created, entries: n, meetings: p.meetings.length, expenses: p.expenses.length, warnings: p.warnings };
}

// ============================================================ grid
export interface GridMeeting { id: string; title: string; venue: string; date: string }
export async function getGrid(db: Db) {
  const members = (await db.query(`SELECT id, membership_no, full_name, profile_complete FROM members WHERE status <> 'withdrawn' OR EXISTS (SELECT 1 FROM savings_transactions s WHERE s.member_id = members.id) ORDER BY membership_no`)).rows;
  const meetings = (await db.query(`SELECT id, title, venue, (scheduled_at AT TIME ZONE 'Africa/Nairobi')::date::text AS date FROM meetings WHERE is_historical ORDER BY sheet_order, scheduled_at`)).rows as GridMeeting[];
  const cont = (await db.query(
    `SELECT member_id, period::text AS period, SUM(amount_cents)::bigint AS cents FROM savings_transactions WHERE period IS NOT NULL AND type IN ('historical','adjustment') GROUP BY 1,2`)).rows;
  const fines = (await db.query(
    `SELECT f.id, f.member_id, f.category, f.period::text AS period, f.meeting_id, f.amount_cents AS cents, (f.status = 'paid') AS paid
       FROM fines f WHERE f.is_historical AND f.status IN ('paid','outstanding') AND ((f.category = 'late_payment' AND f.period IS NOT NULL) OR (f.category = 'absence' AND f.meeting_id IS NOT NULL))`)).rows;
  const live = (await db.query(`SELECT member_id, period::text AS period, paid_cents FROM monthly_obligations WHERE NOT is_historical`)).rows;
  const periods = new Set<string>();
  [...cont, ...fines.filter((f) => f.period), ...live].forEach((r) => periods.add(r.period));
  const sorted = [...periods].sort();
  const months: string[] = [];
  if (sorted.length) {
    let [y, m] = [Number(sorted[0]!.slice(0, 4)), Number(sorted[0]!.slice(5, 7))];
    const end = sorted[sorted.length - 1]!;
    while (`${y}-${pad(m)}-01` <= end) { months.push(`${y}-${pad(m)}-01`); m++; if (m > 12) { m = 1; y++; } }
  }
  const byMember = new Map<string, { cont: Record<string, number>; fine: Record<string, { cents: number; paid: boolean }>; meet: Record<string, { cents: number; paid: boolean }>; live: Record<string, number> }>();
  const slot = (id: string) => { let s = byMember.get(id); if (!s) { s = { cont: {}, fine: {}, meet: {}, live: {} }; byMember.set(id, s); } return s; };
  cont.forEach((r) => { slot(r.member_id).cont[r.period] = r.cents; });
  live.forEach((r) => { slot(r.member_id).live[r.period] = r.paid_cents; });
  fines.forEach((f) => { if (f.category === 'late_payment') slot(f.member_id).fine[f.period] = { cents: f.cents, paid: f.paid }; else slot(f.member_id).meet[f.meeting_id] = { cents: f.cents, paid: f.paid }; });
  const rows = members.map((m) => {
    const s = slot(m.id);
    const contTotal = Object.values(s.cont).reduce((a, b) => a + Number(b), 0);
    const fines = [...Object.values(s.fine), ...Object.values(s.meet)];
    return {
      id: m.id, membershipNo: m.membership_no, name: m.full_name, profileComplete: m.profile_complete,
      cont: s.cont, fine: s.fine, meet: s.meet, live: s.live,
      totals: { contributionsCents: contTotal, finesPaidCents: fines.filter((f) => f.paid).reduce((a, f) => a + f.cents, 0), arrearsCents: fines.filter((f) => !f.paid).reduce((a, f) => a + f.cents, 0) },
    };
  });
  const expenses = (await db.query(`SELECT reference, description, amount_cents, spent_on::text AS spent_on FROM expenditure WHERE status = 'paid' AND payment_reference LIKE 'SHEET %' ORDER BY spent_on`)).rows;
  return { months, meetings, rows, expenses };
}

export interface CellEdit { memberId: string; kind: 'cont' | 'fine' | 'meeting'; period?: string; meetingId?: string; /** KSh. Contribution: >= 0. Fines: positive = paid, negative = unpaid, 0 = none. */ value: number; reason: string }

/** Changes a cell by writing correcting ledger entries; nothing is ever updated or deleted in the ledgers. */
export async function editCell(c: PoolClient, e: CellEdit, actor: Actor) {
  const reason = e.reason.trim();
  if (reason.length < 3) throw new HttpError(400, 'A reason is required for every change');
  const cents = Math.round(Math.abs(e.value) * 100);
  if (!Number.isFinite(e.value)) throw new HttpError(400, 'Enter a number');
  const member = (await c.query(`SELECT id, full_name FROM members WHERE id = $1`, [e.memberId])).rows[0];
  if (!member) throw new HttpError(404, 'Member not found');

  if (e.kind === 'cont') {
    if (!e.period || !/^\d{4}-\d{2}-01$/.test(e.period)) throw new HttpError(400, 'A month (first day) is required');
    if (e.value < 0) throw new HttpError(400, 'A contribution cannot be negative');
    const live = (await c.query(`SELECT 1 FROM monthly_obligations WHERE member_id = $1 AND period = $2::date AND NOT is_historical`, [e.memberId, e.period])).rows[0];
    if (live) throw new HttpError(409, 'This month is handled by the live payment system (M-Pesa and obligations). Use a savings adjustment instead.');
    const cur = Number((await c.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM savings_transactions WHERE member_id = $1 AND period = $2::date AND type IN ('historical','adjustment')`, [e.memberId, e.period])).rows[0].s);
    const diff = cents - cur;
    if (diff === 0) return { changed: false };
    await c.query(
      `INSERT INTO savings_transactions (member_id, type, amount_cents, reason, reference, is_historical, period, occurred_at, created_by)
       VALUES ($1,$2,$3,$4,'GRID EDIT',true,$5::date,now(),$6)`,
      [e.memberId, cur === 0 ? 'historical' : 'adjustment', diff, `Ledger grid: ${reason}`, e.period, actor.userId],
    );
    await audit(c, actor, 'ledger.cell_edited', 'member', e.memberId, { reason, before: { kind: 'cont', period: e.period, cents: cur }, after: { kind: 'cont', period: e.period, cents } });
    return { changed: true, before: cur, after: cents };
  }

  // fines: late fine for a month, or a meeting absence penalty
  let where: string; let args: unknown[]; let category: 'late_payment' | 'absence';
  if (e.kind === 'fine') {
    if (!e.period || !/^\d{4}-\d{2}-01$/.test(e.period)) throw new HttpError(400, 'A month (first day) is required');
    const live = (await c.query(`SELECT 1 FROM monthly_obligations WHERE member_id = $1 AND period = $2::date AND NOT is_historical`, [e.memberId, e.period])).rows[0];
    if (live) throw new HttpError(409, 'Late fines for this month are handled by the live system.');
    category = 'late_payment'; where = `category = 'late_payment' AND period = $2::date AND obligation_id IS NULL`; args = [e.memberId, e.period];
  } else {
    if (!e.meetingId) throw new HttpError(400, 'A meeting is required');
    const mt = (await c.query(`SELECT id, is_historical FROM meetings WHERE id = $1`, [e.meetingId])).rows[0];
    if (!mt?.is_historical) throw new HttpError(409, 'Only the meetings loaded from the sheet can be edited here. Use the Meetings page for new meetings.');
    category = 'absence'; where = `category = 'absence' AND meeting_id = $2`; args = [e.memberId, e.meetingId];
  }
  const cur = (await c.query(`SELECT id, amount_cents, status FROM fines WHERE member_id = $1 AND ${where} AND status IN ('paid','outstanding')`, args)).rows[0];
  const before = cur ? { cents: Number(cur.amount_cents), paid: cur.status === 'paid' } : null;
  const wantPaid = e.value > 0;
  if ((!before && cents === 0) || (before && before.cents === cents && before.paid === wantPaid && cents !== 0)) return { changed: false };
  if (before && cents !== 0 && before.cents === cents && before.paid !== wantPaid) {
    // Only the paid state changes: append a payment, or reverse the payment.
    if (wantPaid) {
      await c.query(`INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by) VALUES ($1,$2,'payment',$3,$4,$5)`, [cur.id, e.memberId, -cents, `Ledger grid: marked paid. ${reason}`, actor.userId]);
      await c.query(`UPDATE fines SET status = 'paid', paid_at = now(), resolution_note = $2 WHERE id = $1`, [cur.id, reason]);
    } else {
      await c.query(`INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by) VALUES ($1,$2,'payment_reversal',$3,$4,$5)`, [cur.id, e.memberId, cents, `Ledger grid: payment reversed. ${reason}`, actor.userId]);
      await c.query(`UPDATE fines SET status = 'outstanding', paid_at = NULL, resolution_note = $2 WHERE id = $1`, [cur.id, reason]);
    }
  } else {
    if (before) {
      // Retire the old fine by reversal entries, then (if wanted) create the corrected one.
      if (before.paid) await c.query(`INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by) VALUES ($1,$2,'payment_reversal',$3,$4,$5)`, [cur.id, e.memberId, before.cents, `Ledger grid: payment reversed for correction. ${reason}`, actor.userId]);
      await c.query(`INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by) VALUES ($1,$2,'reversal',$3,$4,$5)`, [cur.id, e.memberId, -before.cents, `Ledger grid: replaced. ${reason}`, actor.userId]);
      await c.query(`UPDATE fines SET status = 'reversed', resolution_note = $2, resolved_by = $3 WHERE id = $1`, [cur.id, `Corrected in the ledger grid: ${reason}`, actor.userId]);
    }
    if (cents > 0) {
      const today = (await c.query(`SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date::text AS d`)).rows[0].d as string;
      let reasonText: string; let date = today;
      if (category === 'late_payment') { reasonText = `Late contribution fine, ${label(e.period!)}`; }
      else { const m = (await c.query(`SELECT title, (scheduled_at AT TIME ZONE 'Africa/Nairobi')::date::text AS d FROM meetings WHERE id = $1`, [e.meetingId])).rows[0]; reasonText = `Absence penalty, ${m.title} (${m.d})`; }
      await createFine(c, { memberId: e.memberId, category, cents, date, reason: reasonText, period: e.period ?? null, meetingId: e.meetingId ?? null, paid: wantPaid, actor, note: `Ledger grid edit: ${reason}` });
      if (category === 'absence') await c.query(`INSERT INTO attendance (meeting_id, member_id, status, updated_by) VALUES ($1,$2,'absent',$3) ON CONFLICT (meeting_id, member_id) DO UPDATE SET status = 'absent', updated_at = now()`, [e.meetingId, e.memberId, actor.userId]);
    }
  }
  await audit(c, actor, 'ledger.cell_edited', 'member', e.memberId, {
    reason, before: { kind: e.kind, period: e.period, meetingId: e.meetingId, ...(before ?? { cents: 0, paid: false }) }, after: { kind: e.kind, period: e.period, meetingId: e.meetingId, cents, paid: cents ? wantPaid : false },
  });
  return { changed: true, before, after: { cents, paid: wantPaid } };
}

// ============================================================ export in the sheet's layout
export async function gridToXlsx(db: Db): Promise<Buffer> {
  const g = await getGrid(db);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ledger', { views: [{ state: 'frozen', xSplit: 1, ySplit: 6 }] });
  ws.addBackgroundImage(wb.addImage({ buffer: WATERMARK_TILE as never, extension: 'png' }));
  ws.addImage(wb.addImage({ buffer: LOGO as never, extension: 'png' }), { tl: { col: 0.1, row: 0.1 }, ext: { width: 78, height: 78 } });
  ws.getCell('B1').value = config.groupName; ws.getCell('B1').font = { bold: true, size: 14, color: { argb: 'FF064E3B' } };
  ws.getCell('B2').value = 'Member ledger: contributions and fines by month'; ws.getCell('B2').font = { bold: true };
  ws.getCell('B3').value = `Generated ${dmyTimeEAT(new Date())} (EAT). Fines: positive = paid, negative = unpaid.`;
  for (let r = 1; r <= 4; r++) ws.getRow(r).height = 20;
  const H1 = 5; const H2 = 6;
  ws.getRow(H1).getCell(1).value = 'Member Name';
  ws.getRow(H2).getCell(1).value = 'Membership no.';
  let col = 2;
  const twoCol = (p: string) => g.rows.some((r) => r.fine[p]);
  const map: { kind: string; key: string; col: number }[] = [];
  for (const p of g.months) {
    ws.getCell(H1, col).value = label(p); ws.getCell(H2, col).value = 'Cont';
    map.push({ kind: 'cont', key: p, col }); col++;
    if (twoCol(p)) { ws.getCell(H2, col).value = 'Fine'; map.push({ kind: 'fine', key: p, col }); col++; }
  }
  if (g.meetings.length) {
    ws.getCell(H1, col).value = 'Meeting Absenteeism Penalty';
    for (const m of g.meetings) { ws.getCell(H2, col).value = `${m.date} ${m.venue}`; map.push({ kind: 'meet', key: m.id, col }); col++; }
  }
  const tc = { contrib: col, paid: col + 1, arrears: col + 2 };
  ws.getCell(H1, tc.contrib).value = 'Total contributions'; ws.getCell(H1, tc.paid).value = 'Fines paid'; ws.getCell(H1, tc.arrears).value = 'Arrears (unpaid penalties, shown negative)';
  g.rows.forEach((r, i) => {
    const row = i + 7;
    ws.getCell(row, 1).value = r.name;
    ws.getCell(row, 1).value = `${r.name}`;
    for (const m of map) {
      const v = m.kind === 'cont' ? (r.cont[m.key] ?? r.live[m.key]) : m.kind === 'fine' ? r.fine[m.key] : r.meet[m.key];
      if (v === undefined) continue;
      ws.getCell(row, m.col).value = typeof v === 'number' || typeof v === 'string' ? Number(v) / 100 : (v.paid ? 1 : -1) * v.cents / 100;
    }
    ws.getCell(row, tc.contrib).value = r.totals.contributionsCents / 100;
    ws.getCell(row, tc.paid).value = r.totals.finesPaidCents / 100;
    ws.getCell(row, tc.arrears).value = -r.totals.arrearsCents / 100;
  });
  const tr = g.rows.length + 7;
  ws.getCell(tr, 1).value = 'Total';
  for (let c2 = 2; c2 <= tc.arrears; c2++) {
    const L = ws.getColumn(c2).letter;
    ws.getCell(tr, c2).value = { formula: `SUM(${L}7:${L}${tr - 1})` };
  }
  ws.getRow(H1).font = { bold: true }; ws.getRow(H2).font = { bold: true }; ws.getRow(tr).font = { bold: true };
  ws.getColumn(1).width = 32;
  for (let c2 = 2; c2 <= tc.arrears; c2++) ws.getColumn(c2).width = c2 >= tc.contrib ? 18 : 11;
  if (g.expenses.length) {
    ws.getCell(tr + 2, 1).value = 'Expenses'; ws.getCell(tr + 2, 1).font = { bold: true };
    g.expenses.forEach((x, i) => { ws.getCell(tr + 3 + i, 1).value = `${x.description} (${x.spent_on})`; ws.getCell(tr + 3 + i, 2).value = Number(x.amount_cents) / 100; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
