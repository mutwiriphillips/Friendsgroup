import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import type pg from 'pg';
import { audit, type Actor } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { blindIndex, blindIndexAll } from '../lib/crypto.js';
import { assessLenientMember, registerMember, registerMemberLenient, registerMemberSchema } from './members.js';
import { ensureFinancialYear } from './obligations.js';

type Client = pg.PoolClient;
export type ImportKind = 'members' | 'historical_savings' | 'previous_fines' | 'opening_balances' | 'previous_attendance';

export interface ImportRow {
  line: number;
  data: Record<string, string>;
  errors: string[];
  warnings: string[];
}

const ALIASES: Record<string, string> = {
  member_name: 'full_name', name: 'full_name', member: 'full_name', names: 'full_name', full_names: 'full_name', fullname: 'full_name',
  id_number: 'national_id', id_no: 'national_id', national_id_number: 'national_id', phone_number: 'phone', mobile: 'phone', telephone: 'phone',
};
const norm = (s: string) => { const k = s.trim().toLowerCase().replace(/[\s-]+/g, '_'); return ALIASES[k] ?? k; };

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((t) => t.text).join('').trim();
    if (o.text) return String(o.text).trim();
    if (o.result !== undefined) return String(o.result).trim();
  }
  return String(v).trim();
}

/** Reads the first sheet of an .xlsx or .csv into header-keyed rows. */
export async function parseTable(buffer: Buffer, filename: string): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename)) await wb.csv.read(Readable.from(buffer));
  else if (/\.xlsx$/i.test(filename)) await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  else throw new HttpError(400, 'Upload a .csv or .xlsx file');
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) throw new HttpError(400, 'The file has no data rows');
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i] = norm(cellText(c.value)); });
  const rows: Record<string, string>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const rec: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const t = cellText(row.getCell(i).value);
      if (t) any = true;
      rec[h] = t;
    });
    if (any) rows.push({ ...rec, __line: String(n) });
  });
  if (rows.length > 5000) throw new HttpError(400, 'Import at most 5,000 rows at a time');
  return rows;
}

const lenientInput = (r: Record<string, string>) => ({
  fullName: r.full_name ?? '', nationalId: r.national_id, phone: r.phone, mpesaPhone: r.mpesa_phone, email: r.email, physicalAddress: r.physical_address,
  nextOfKinName: r.next_of_kin_name, nextOfKinPhone: r.next_of_kin_phone, registeredOn: r.registered_on,
});
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const money = (s: string) => {
  const n = Number(s.replace(/[,\sKSh]/gi, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

const REQUIRED: Record<ImportKind, string[]> = {
  members: ['full_name'], // everything else is optional and can be completed later; strict mode also requires national_id and phone
  historical_savings: ['membership_no', 'date', 'amount'],
  previous_fines: ['membership_no', 'date', 'amount', 'reason'],
  opening_balances: ['membership_no', 'amount'],
  previous_attendance: ['meeting_title', 'meeting_date', 'membership_no', 'status'],
};

/** Validates every row without writing anything: duplicates, bad values, unknown members. */
export interface ImportOptions {
  /** Members only. Default false: import as is, record anything missing or invalid as pending compliance. */
  strict?: boolean;
}

export async function previewImport(db: Client, kind: ImportKind, raw: Record<string, string>[], opts: ImportOptions = {}): Promise<ImportRow[]> {
  const first = raw[0] ?? {};
  const required = kind === 'members' && opts.strict ? ['full_name', 'national_id', 'phone'] : REQUIRED[kind];
  const missing = required.filter((c) => !(c in first));
  if (missing.length) throw new HttpError(400, `Missing column(s): ${missing.join(', ')}. Required: ${required.join(', ')}.${'full_name' in first || kind !== 'members' ? '' : ''}`);

  const memberNos = new Map<string, string>(
    (await db.query(`SELECT membership_no, id FROM members`)).rows.map((r) => [String(r.membership_no).toUpperCase(), r.id as string]),
  );
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  const out: ImportRow[] = [];
  for (const r of raw) {
    const row: ImportRow = { line: Number(r.__line), data: r, errors: [], warnings: [] };
    const no = (r.membership_no ?? '').toUpperCase();
    if (kind !== 'members' && !memberNos.has(no)) row.errors.push(`Unknown membership number "${r.membership_no ?? ''}"`);

    if (kind === 'members' && !opts.strict) {
      const a = await assessLenientMember(db, lenientInput(r), seenIds);
      if (a.value.fullName.length < 2) row.errors.push('full_name is required');
      a.issues.forEach((i) => row.warnings.push(`Pending compliance: ${i}`));
    } else if (kind === 'members') {
      const parsed = registerMemberSchema.safeParse({
        fullName: r.full_name, nationalId: r.national_id, phone: r.phone, mpesaPhone: r.mpesa_phone || undefined,
        email: r.email || undefined, registeredOn: r.registered_on || undefined,
      });
      if (!parsed.success) parsed.error.issues.forEach((i) => row.errors.push(`${i.path.join('.')}: ${i.message}`));
      const key = `id:${blindIndex(r.national_id ?? '')}`;
      if (seen.has(key)) row.errors.push('Duplicate National ID within the file');
      seen.add(key);
      const dup = await db.query(`SELECT membership_no FROM members WHERE national_id_hash = ANY($1::text[])`, [blindIndexAll(r.national_id ?? '')]);
      if (dup.rows[0]) row.errors.push(`National ID already registered (${dup.rows[0].membership_no})`);
    } else if (kind === 'historical_savings') {
      if (!isDate(r.date ?? '')) row.errors.push('date must be YYYY-MM-DD');
      if (money(r.amount ?? '') === null) row.errors.push('amount must be a positive number');
      const key = `${no}|${r.date}|${r.amount}|${r.reference ?? ''}`;
      if (seen.has(key)) row.errors.push('Duplicate row within the file');
      seen.add(key);
      if (memberNos.has(no) && isDate(r.date ?? '')) {
        const dup = await db.query(
          `SELECT 1 FROM savings_transactions WHERE member_id = $1 AND is_historical AND type = 'historical' AND amount_cents = $2 AND COALESCE(reference,'') = $3 AND (occurred_at AT TIME ZONE 'Africa/Nairobi')::date = $4::date`,
          [memberNos.get(no), money(r.amount ?? ''), r.reference ?? '', r.date],
        );
        if (dup.rows[0]) row.errors.push('Already imported (same member, date, amount and reference)');
      }
    } else if (kind === 'previous_fines') {
      if (!isDate(r.date ?? '')) row.errors.push('date must be YYYY-MM-DD');
      if (money(r.amount ?? '') === null) row.errors.push('amount must be a positive number');
      if (r.status && !['outstanding', 'paid'].includes(r.status.toLowerCase())) row.errors.push('status must be outstanding or paid');
      if (r.reference) {
        if (seen.has(`ref:${r.reference}`)) row.errors.push('Duplicate fine reference within the file');
        seen.add(`ref:${r.reference}`);
        const dup = await db.query(`SELECT 1 FROM fines WHERE reference = $1`, [r.reference]);
        if (dup.rows[0]) row.errors.push('Fine reference already exists');
      }
    } else if (kind === 'opening_balances') {
      if (money(r.amount ?? '') === null) row.errors.push('amount must be a positive number');
      if (r.as_of && !isDate(r.as_of)) row.errors.push('as_of must be YYYY-MM-DD');
      if (seen.has(`ob:${no}`)) row.errors.push('More than one opening balance for this member in the file');
      seen.add(`ob:${no}`);
      if (memberNos.has(no)) {
        const dup = await db.query(`SELECT 1 FROM savings_transactions WHERE member_id = $1 AND is_historical AND reason = 'Opening balance'`, [memberNos.get(no)]);
        if (dup.rows[0]) row.errors.push('An opening balance was already imported for this member');
      }
    } else if (kind === 'previous_attendance') {
      if (!isDate(r.meeting_date ?? '')) row.errors.push('meeting_date must be YYYY-MM-DD');
      if (!['present', 'absent', 'excused'].includes((r.status ?? '').toLowerCase())) row.errors.push('status must be present, absent or excused');
      const key = `${r.meeting_title}|${r.meeting_date}|${no}`;
      if (seen.has(key)) row.errors.push('Duplicate attendance row within the file');
      seen.add(key);
    }
    out.push(row);
  }
  return out;
}

/** Commits only when every row is valid, as one transaction. Imported records are flagged historical. */
export async function commitImport(client: Client, kind: ImportKind, raw: Record<string, string>[], filename: string, actor: Actor, opts: ImportOptions = {}) {
  const rows = await previewImport(client, kind, raw, opts);
  const bad = rows.filter((r) => r.errors.length);
  if (bad.length) throw new HttpError(422, `${bad.length} row(s) have errors. Fix the file and try again; nothing was imported.`);

  const memberId = async (no: string) => (await client.query(`SELECT id FROM members WHERE membership_no = $1`, [no.toUpperCase()])).rows[0]?.id as string;
  const credentials: { membershipNo: string; name: string; phone: string; temporaryPassword: string }[] = [];
  const pending: { membershipNo: string; name: string; missing: string }[] = [];
  const seenIds = new Set<string>();
  let imported = 0;

  for (const { data: r } of rows) {
    if (kind === 'members' && !opts.strict) {
      const res = await registerMemberLenient(client, lenientInput(r), actor, seenIds);
      if (res.temporaryPassword) credentials.push({ membershipNo: res.membershipNo, name: r.full_name!, phone: res.phone ?? '', temporaryPassword: res.temporaryPassword });
      if (res.issues.length) pending.push({ membershipNo: res.membershipNo, name: r.full_name!, missing: res.issues.join('; ') });
    } else if (kind === 'members') {
      const input = registerMemberSchema.parse({
        fullName: r.full_name, nationalId: r.national_id, phone: r.phone, mpesaPhone: r.mpesa_phone || undefined,
        email: r.email || undefined, registeredOn: r.registered_on || undefined,
      });
      const res = await registerMember(client, input, actor);
      credentials.push({ membershipNo: res.membershipNo, name: input.fullName, phone: input.phone, temporaryPassword: res.temporaryPassword });
    } else if (kind === 'historical_savings') {
      await client.query(
        `INSERT INTO savings_transactions (member_id, type, amount_cents, reference, reason, is_historical, occurred_at, created_by)
         VALUES ($1,'historical',$2,$3,'Imported historical record',true,($4::date::timestamp AT TIME ZONE 'Africa/Nairobi'),$5)`,
        [await memberId(r.membership_no!), money(r.amount!), r.reference || null, r.date, actor.userId],
      );
    } else if (kind === 'opening_balances') {
      await client.query(
        `INSERT INTO savings_transactions (member_id, type, amount_cents, reason, is_historical, occurred_at, created_by)
         VALUES ($1,'historical',$2,'Opening balance',true,COALESCE(($3::date::timestamp AT TIME ZONE 'Africa/Nairobi'), now()),$4)`,
        [await memberId(r.membership_no!), money(r.amount!), r.as_of || null, actor.userId],
      );
    } else if (kind === 'previous_fines') {
      const mid = await memberId(r.membership_no!);
      const cents = money(r.amount!)!;
      const paid = (r.status ?? '').toLowerCase() === 'paid';
      const f = await client.query(
        `INSERT INTO fines (reference, member_id, category, amount_cents, imposed_on, reason, status, paid_at, is_historical, created_by)
         VALUES (COALESCE($1, 'FN-' || lpad(nextval('fine_ref_seq')::text, 6, '0')), $2,'other',$3,$4::date,$5,$6,$7,true,$8) RETURNING id`,
        [r.reference || null, mid, cents, r.date, r.reason, paid ? 'paid' : 'outstanding', paid ? r.date : null, actor.userId],
      );
      await client.query(
        `INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by, created_at) VALUES ($1,$2,'charge',$3,'Imported historical fine',$4,($5::date::timestamp AT TIME ZONE 'Africa/Nairobi'))`,
        [f.rows[0].id, mid, cents, actor.userId, r.date],
      );
      if (paid) {
        await client.query(
          `INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by, created_at) VALUES ($1,$2,'payment',$3,'Imported: paid before system start',$4,($5::date::timestamp AT TIME ZONE 'Africa/Nairobi'))`,
          [f.rows[0].id, mid, -cents, actor.userId, r.date],
        );
      }
    } else if (kind === 'previous_attendance') {
      const date = r.meeting_date!;
      const fy = await ensureFinancialYear(client, date);
      let m = (await client.query(`SELECT id FROM meetings WHERE title = $1 AND (scheduled_at AT TIME ZONE 'Africa/Nairobi')::date = $2::date`, [r.meeting_title, date])).rows[0];
      if (!m) {
        m = (await client.query(
          `INSERT INTO meetings (financial_year_id, title, scheduled_at, venue, status, register_confirmed_at, register_confirmed_by, created_by)
           VALUES ($1,$2,($3::date::timestamp AT TIME ZONE 'Africa/Nairobi'),'Imported record','register_confirmed',now(),$4,$4) RETURNING id`,
          [fy, r.meeting_title, date, actor.userId],
        )).rows[0];
      }
      await client.query(
        `INSERT INTO attendance (meeting_id, member_id, status, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (meeting_id, member_id) DO UPDATE SET status = EXCLUDED.status`,
        [m.id, await memberId(r.membership_no!), r.status!.toLowerCase(), actor.userId],
      );
    }
    imported++;
  }
  await audit(client, actor, 'import.committed', 'import', kind, { after: { filename, rows: imported, strict: !!opts.strict, pendingCompliance: pending.length } });
  return { imported, credentials, pending };
}
