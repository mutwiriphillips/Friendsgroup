import { memberAccountSummary, accountSections, memberPaymentsSection, groupStatementDoc } from './statements.js';
import { memberOverview } from './memberOverview.js';
import ExcelJS from 'exceljs';
import { dmy, dmyEAT, dmyTimeEAT, monthName } from '../lib/dates.js';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';
import type { Db } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { getPeriodReport, memberSchedule } from './reconciliation.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// assets/ sits next to src/ and dist/, so the same relative path works in dev and production.
const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets');
export const LOGO = Buffer.from(readFileSync(path.join(assetsDir, 'logo.png')));
export const WATERMARK_TILE = Buffer.from(readFileSync(path.join(assetsDir, 'watermark-tile.png')));

export interface Col {
  key: string;
  label: string;
  type?: 'money' | 'date' | 'datetime' | 'text' | 'number';
}
export type Row = Record<string, string | number | null>;
export interface Section {
  heading?: string;
  columns: Col[];
  rows: Row[];
  summary?: { label: string; value: string | number; money?: boolean }[];
}
export interface ReportDoc {
  title: string;
  subtitle?: string;
  sections: Section[];
}

export interface ReportFilters {
  memberId?: string;
  month?: string; // YYYY-MM
  year?: string; // financial year label
  from?: string;
  to?: string;
  asOf?: string;
  meetingId?: string;
  status?: string;
}

const EAT = `AT TIME ZONE 'Africa/Nairobi'`;
const sum = (rows: Row[], key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);

export const REPORT_NAMES = [
  'membership_register', 'member_report', 'savings_statement', 'fine_statement', 'monthly_collections', 'annual_collections',
  'outstanding_contributions', 'late_fines', 'absence_fines', 'fine_collections', 'mpesa_reconciliation',
  'attendance', 'income_expenditure', 'financial_position', 'historical_savings', 'withdrawals', 'reconciliation_statement', 'group_statement',
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

async function fyRange(db: Db, label?: string) {
  const { rows } = label
    ? await db.query(`SELECT * FROM financial_years WHERE label = $1`, [label])
    : await db.query(`SELECT * FROM financial_years WHERE is_current LIMIT 1`);
  if (!rows[0]) throw new HttpError(404, 'Financial year not found');
  return rows[0] as { id: number; label: string; start_date: string; end_date: string };
}

export async function savingsStatementSection(db: Db, memberId: string, f: ReportFilters = {}): Promise<Section> {
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT (occurred_at ${EAT})::date AS date, type::text AS type, COALESCE(reference,'') AS reference, COALESCE(reason,'') AS note,
              is_historical, amount_cents,
              SUM(amount_cents) OVER (ORDER BY occurred_at, created_at, id) AS balance_cents
         FROM savings_transactions WHERE member_id = $1
     ) s WHERE ($2::date IS NULL OR date >= $2::date) AND ($3::date IS NULL OR date <= $3::date) ORDER BY date, balance_cents`,
    [memberId, f.from ?? null, f.to ?? null],
  );
  const out: Row[] = rows.map((r) => ({ ...r, type: r.is_historical ? `${r.type} (imported)` : r.type }));
  const bal = Number((await db.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM savings_transactions WHERE member_id = $1`, [memberId])).rows[0].b);
  return {
    heading: 'Savings account',
    columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'type', label: 'Type' }, { key: 'reference', label: 'Reference' },
      { key: 'note', label: 'Note' }, { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'balance_cents', label: 'Balance', type: 'money' },
    ],
    rows: out,
    summary: [{ label: 'Savings balance', value: bal, money: true }],
  };
}

export async function fineStatementSection(db: Db, memberId: string, f: ReportFilters = {}): Promise<Section> {
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT (fl.created_at ${EAT})::date AS date, fi.reference, fi.category::text AS category, fl.entry_type::text AS entry, COALESCE(fl.note,'') AS note, fl.amount_cents,
              SUM(fl.amount_cents) OVER (ORDER BY fl.created_at, fl.id) AS balance_cents
         FROM fine_ledger fl JOIN fines fi ON fi.id = fl.fine_id WHERE fl.member_id = $1
     ) s WHERE ($2::date IS NULL OR date >= $2::date) AND ($3::date IS NULL OR date <= $3::date) ORDER BY date, balance_cents`,
    [memberId, f.from ?? null, f.to ?? null],
  );
  const out = Number((await db.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM fine_ledger WHERE member_id = $1`, [memberId])).rows[0].b);
  return {
    heading: 'Fines account (separate from savings)',
    columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Fine ref' }, { key: 'category', label: 'Category' },
      { key: 'entry', label: 'Entry' }, { key: 'note', label: 'Note' }, { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'balance_cents', label: 'Balance owed', type: 'money' },
    ],
    rows: rows as Row[],
    summary: [{ label: 'Outstanding fines', value: out, money: true }],
  };
}

export async function memberHeader(db: Db, memberId: string) {
  const { rows } = await db.query(`SELECT full_name, membership_no FROM members WHERE id = $1`, [memberId]);
  if (!rows[0]) throw new HttpError(404, 'Member not found');
  return rows[0] as { full_name: string; membership_no: string };
}

export async function buildReport(db: Db, name: ReportName, f: ReportFilters): Promise<ReportDoc> {
  switch (name) {
    case 'membership_register': {
      // National ID is deliberately not exported; it is only shown on audited member detail views.
      const { rows } = await db.query(
        `SELECT m.membership_no, m.full_name, m.phone, m.mpesa_phone, COALESCE(m.email,'') AS email, COALESCE(m.physical_address,'') AS physical_address,
                m.status::text AS status, m.registered_on,
                CASE WHEN m.profile_complete THEN 'Compliant' ELSE 'Non-compliant: ' || concat_ws(', ', CASE WHEN m.national_id_enc IS NULL THEN 'National ID' END, CASE WHEN m.phone IS NULL THEN 'Phone' END, CASE WHEN m.nok_submitted_at IS NULL THEN 'Next of kin form' END) END AS compliance,
                COALESCE((SELECT SUM(amount_cents) FROM savings_transactions s WHERE s.member_id = m.id),0) AS savings_cents,
                COALESCE((SELECT SUM(amount_cents) FROM fine_ledger fl WHERE fl.member_id = m.id),0) AS fines_outstanding_cents
           FROM members m WHERE ($1 = '' OR m.status = $1::member_status) ORDER BY m.membership_no`,
        [f.status ?? ''],
      );
      return { title: 'Membership register', subtitle: `As at ${dmyEAT(new Date())}`, sections: [{
        columns: [
          { key: 'membership_no', label: 'Member no.' }, { key: 'full_name', label: 'Name' }, { key: 'phone', label: 'Phone' },
          { key: 'mpesa_phone', label: 'M-Pesa' }, { key: 'email', label: 'Email' }, { key: 'physical_address', label: 'Address' }, { key: 'status', label: 'Status' },
          { key: 'registered_on', label: 'Registered', type: 'date' }, { key: 'compliance', label: 'Profile' }, { key: 'savings_cents', label: 'Savings (KSh)', type: 'money' }, { key: 'fines_outstanding_cents', label: 'Fines owed (KSh)', type: 'money' },
        ],
        rows: rows as Row[], summary: [{ label: 'Members', value: rows.length }, { label: 'Total savings', value: rows.reduce((a, r) => a + Number(r.savings_cents), 0), money: true }],
      }] };
    }
    case 'member_report': {
      if (!f.memberId) throw new HttpError(400, 'memberId is required');
      const h = await memberHeader(db, f.memberId);
      const o = await memberOverview(db, f.memberId);
      const t = o.totals;
      const acct = await memberAccountSummary(db, f.memberId, f);
      const word = (v: string) => v.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
      return {
        title: 'Member report', subtitle: `${h.full_name} (${h.membership_no})`,
        sections: [
          ...accountSections(acct.summary, acct.invoices, t.balanceCents),
          await memberPaymentsSection(db, f.memberId, f),
          { heading: 'Summary', columns: [{ key: 'item', label: 'Item' }, { key: 'value', label: 'Value' }], rows: [
            { item: 'Total contributions', value: fmtMoney(t.contributionsCents) }, { item: 'Months paid', value: String(t.monthsPaid) }, { item: 'Withdrawn', value: fmtMoney(t.withdrawnCents) },
            { item: 'Savings balance', value: fmtMoney(t.balanceCents) }, { item: 'Penalties accrued', value: fmtMoney(t.penaltiesAccruedCents) }, { item: 'Penalties paid', value: fmtMoney(t.penaltiesPaidCents) },
            { item: 'Penalties waived', value: fmtMoney(t.penaltiesWaivedCents) }, { item: 'Penalties outstanding', value: fmtMoney(t.penaltiesOutstandingCents) },
            { item: 'Meetings present / absent / excused', value: `${o.attendance.present} / ${o.attendance.absent} / ${o.attendance.excused}` },
          ] as Row[] },
          { heading: 'Contributions by month', columns: [{ key: 'period', label: 'Month', type: 'date' }, { key: 'amount_cents', label: 'Paid', type: 'money' }, { key: 'reference', label: 'Reference' }, { key: 'source', label: 'Source' }], rows: o.months.map((m) => ({ period: m.period, amount_cents: m.amount_cents, reference: m.reference ?? '', source: m.imported ? 'Group sheet / manual entry' : 'Live payment' })) as Row[],
            summary: [{ label: 'Total contributions', value: t.contributionsCents, money: true }] },
          { heading: 'Penalties', columns: [{ key: 'imposed_on', label: 'Date', type: 'date' }, { key: 'reference', label: 'Reference' }, { key: 'category', label: 'Type' }, { key: 'reason', label: 'Reason' }, { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'status', label: 'Status' }], rows: o.penalties.map((p) => ({ ...p, category: word(p.category), status: word(p.status) })) as Row[],
            summary: [{ label: 'Outstanding', value: t.penaltiesOutstandingCents, money: true }] },
          ...(o.manual.length ? [{ heading: 'Payments entered by the administrator', columns: [{ key: 'created_at', label: 'Entered', type: 'datetime' as const }, { key: 'period', label: 'Month paid', type: 'date' as const }, { key: 'amount_cents', label: 'Amount', type: 'money' as const }, { key: 'mpesa_code', label: 'M-Pesa code' }, { key: 'transaction_message', label: 'Message' }], rows: o.manual.map((m) => ({ ...m, created_at: String(m.created_at) })) as Row[] }] : []),
        ],
      };
    }
    case 'group_statement':
      return groupStatementDoc(db, f);
    case 'savings_statement': {
      if (!f.memberId) throw new HttpError(400, 'memberId is required');
      const h = await memberHeader(db, f.memberId);
      return { title: 'Savings statement', subtitle: `${h.full_name} (${h.membership_no})`, sections: [await savingsStatementSection(db, f.memberId, f)] };
    }
    case 'fine_statement': {
      if (!f.memberId) throw new HttpError(400, 'memberId is required');
      const h = await memberHeader(db, f.memberId);
      return { title: 'Fine statement', subtitle: `${h.full_name} (${h.membership_no})`, sections: [await fineStatementSection(db, f.memberId, f)] };
    }
    case 'monthly_collections': {
      const month = `${(f.month ?? new Date().toISOString().slice(0, 7))}-01`;
      const rows = (
        await db.query(
          `SELECT m.membership_no, m.full_name, o.amount_due_cents, o.status::text AS status, o.paid_cents, (o.paid_at ${EAT})::date AS paid_on, COALESCE(p.mpesa_receipt,'') AS mpesa_receipt
             FROM monthly_obligations o JOIN members m ON m.id = o.member_id LEFT JOIN payments p ON p.id = o.payment_id
            WHERE o.period = $1::date AND NOT o.is_historical ORDER BY m.membership_no`,
          [month],
        )
      ).rows as Row[];
      return { title: 'Monthly savings collections', subtitle: month.slice(0, 7), sections: [{
        columns: [
          { key: 'membership_no', label: 'Member no.' }, { key: 'full_name', label: 'Name' }, { key: 'amount_due_cents', label: 'Due', type: 'money' },
          { key: 'status', label: 'Status' }, { key: 'paid_cents', label: 'Paid', type: 'money' }, { key: 'paid_on', label: 'Paid on', type: 'date' }, { key: 'mpesa_receipt', label: 'M-Pesa ref' },
        ],
        rows,
        summary: [
          { label: 'Expected', value: sum(rows, 'amount_due_cents'), money: true },
          { label: 'Collected (savings only)', value: sum(rows, 'paid_cents'), money: true },
          { label: 'Outstanding', value: sum(rows, 'amount_due_cents') - sum(rows, 'paid_cents'), money: true },
        ],
      }] };
    }
    case 'annual_collections': {
      const fy = await fyRange(db, f.year);
      const rows = (
        await db.query(
          `SELECT m.membership_no, m.full_name,
                  COALESCE(SUM(o.amount_due_cents) FILTER (WHERE NOT o.is_historical),0) AS expected_cents,
                  COALESCE(SUM(o.paid_cents) FILTER (WHERE NOT o.is_historical),0) AS paid_cents,
                  COALESCE(SUM(o.amount_due_cents) FILTER (WHERE o.status IN ('unpaid','overdue')),0) AS outstanding_cents
             FROM members m LEFT JOIN monthly_obligations o ON o.member_id = m.id AND o.financial_year_id = $1
            GROUP BY m.id ORDER BY m.membership_no`,
          [fy.id],
        )
      ).rows as Row[];
      return { title: 'Annual savings collections', subtitle: `Financial year ${fy.label}`, sections: [{
        columns: [
          { key: 'membership_no', label: 'Member no.' }, { key: 'full_name', label: 'Name' }, { key: 'expected_cents', label: 'Expected', type: 'money' },
          { key: 'paid_cents', label: 'Paid', type: 'money' }, { key: 'outstanding_cents', label: 'Outstanding', type: 'money' },
        ],
        rows, summary: [{ label: 'Total collected', value: sum(rows, 'paid_cents'), money: true }, { label: 'Total outstanding', value: sum(rows, 'outstanding_cents'), money: true }],
      }] };
    }
    case 'outstanding_contributions': {
      const rows = (
        await db.query(
          `SELECT m.membership_no, m.full_name, count(*)::int AS months, MIN(o.period) AS oldest_period, SUM(o.amount_due_cents) AS outstanding_cents
             FROM monthly_obligations o JOIN members m ON m.id = o.member_id WHERE o.status IN ('unpaid','overdue') GROUP BY m.id ORDER BY MIN(o.period), m.membership_no`,
        )
      ).rows as Row[];
      return { title: 'Outstanding contributions', subtitle: 'Savings only. Fines are reported separately.', sections: [{
        columns: [
          { key: 'membership_no', label: 'Member no.' }, { key: 'full_name', label: 'Name' }, { key: 'months', label: 'Months', type: 'number' },
          { key: 'oldest_period', label: 'Oldest month', type: 'date' }, { key: 'outstanding_cents', label: 'Outstanding', type: 'money' },
        ],
        rows, summary: [{ label: 'Total outstanding', value: sum(rows, 'outstanding_cents'), money: true }],
      }] };
    }
    case 'late_fines':
    case 'absence_fines': {
      const cat = name === 'late_fines' ? 'late_payment' : 'absence';
      const rows = (
        await db.query(
          `SELECT f.reference, m.membership_no, m.full_name, f.imposed_on, f.reason, f.amount_cents, f.status::text AS status
             FROM fines f JOIN members m ON m.id = f.member_id
            WHERE f.category = $1 AND ($2::date IS NULL OR f.imposed_on >= $2::date) AND ($3::date IS NULL OR f.imposed_on <= $3::date)
              AND ($4 = '' OR f.status = $4::fine_status) ORDER BY f.imposed_on, f.reference`,
          [cat, f.from ?? null, f.to ?? null, f.status ?? ''],
        )
      ).rows as Row[];
      return { title: name === 'late_fines' ? 'Late payment fines' : 'Meeting absenteeism fines', sections: [{
        columns: [
          { key: 'reference', label: 'Fine ref' }, { key: 'membership_no', label: 'Member no.' }, { key: 'full_name', label: 'Name' },
          { key: 'imposed_on', label: 'Imposed', type: 'date' }, { key: 'reason', label: 'Reason' }, { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'status', label: 'Status' },
        ],
        rows,
        summary: [
          { label: 'Total accrued', value: sum(rows, 'amount_cents'), money: true },
          { label: 'Outstanding', value: sum(rows.filter((r) => r.status === 'outstanding'), 'amount_cents'), money: true },
        ],
      }] };
    }
    case 'fine_collections': {
      const rows = (
        await db.query(
          `SELECT (fl.created_at ${EAT})::date AS date, fi.reference, m.membership_no, m.full_name, COALESCE(p.mpesa_receipt,'') AS mpesa_receipt, p.receipt_no, -fl.amount_cents AS amount_cents
             FROM fine_ledger fl JOIN fines fi ON fi.id = fl.fine_id JOIN members m ON m.id = fl.member_id LEFT JOIN payments p ON p.id = fl.payment_id
            WHERE fl.entry_type = 'payment' AND ($1::date IS NULL OR (fl.created_at ${EAT})::date >= $1::date) AND ($2::date IS NULL OR (fl.created_at ${EAT})::date <= $2::date)
            ORDER BY fl.created_at`,
          [f.from ?? null, f.to ?? null],
        )
      ).rows as Row[];
      return { title: 'Fine collection statement', sections: [{
        columns: [
          { key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Fine ref' }, { key: 'membership_no', label: 'Member no.' }, { key: 'full_name', label: 'Name' },
          { key: 'receipt_no', label: 'Receipt' }, { key: 'mpesa_receipt', label: 'M-Pesa ref' }, { key: 'amount_cents', label: 'Amount', type: 'money' },
        ],
        rows, summary: [{ label: 'Fines collected', value: sum(rows, 'amount_cents'), money: true }],
      }] };
    }
    case 'mpesa_reconciliation': {
      const month = f.month ? `${f.month}-01` : null;
      const rows = (
        await db.query(
          `SELECT l.receipt, (l.txn_time ${EAT})::date AS date, l.amount_cents, l.phone, l.match_status AS status, COALESCE(m.membership_no,'') AS membership_no, COALESCE(l.note,'') AS note
             FROM statement_lines l LEFT JOIN payments p ON p.id = l.payment_id LEFT JOIN members m ON m.id = p.member_id
            WHERE ($1::date IS NULL OR date_trunc('month', l.txn_time ${EAT}) = $1::date) ORDER BY l.txn_time NULLS LAST, l.id`,
          [month],
        )
      ).rows as Row[];
      const count = (s: string) => rows.filter((r) => r.status === s).length;
      return { title: 'M-Pesa reconciliation', subtitle: f.month, sections: [{
        columns: [
          { key: 'receipt', label: 'M-Pesa ref' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'phone', label: 'Phone' },
          { key: 'status', label: 'Match' }, { key: 'membership_no', label: 'Member' }, { key: 'note', label: 'Note' },
        ],
        rows,
        summary: [
          { label: 'Matched', value: count('matched') + count('manual_match') }, { label: 'Unmatched', value: count('unmatched') },
          { label: 'Duplicates', value: count('duplicate') }, { label: 'Amount mismatches', value: count('amount_mismatch') },
        ],
      }] };
    }
    case 'attendance': {
      const fy = f.meetingId ? null : await fyRange(db, f.year);
      const rows = (
        await db.query(
          `SELECT mt.title, (mt.scheduled_at ${EAT})::date AS date, m.membership_no, m.full_name, a.status::text AS status, COALESCE(a.apology_reason,'') AS apology,
                  COALESCE((SELECT fi.reference FROM fines fi WHERE fi.meeting_id = mt.id AND fi.member_id = m.id AND fi.category='absence' AND fi.status <> 'reversed' LIMIT 1),'') AS fine_ref
             FROM attendance a JOIN meetings mt ON mt.id = a.meeting_id JOIN members m ON m.id = a.member_id
            WHERE mt.status <> 'cancelled' AND (($1::uuid IS NOT NULL AND mt.id = $1::uuid) OR ($1::uuid IS NULL AND mt.financial_year_id = $2))
            ORDER BY mt.scheduled_at, m.membership_no`,
          [f.meetingId ?? null, fy?.id ?? null],
        )
      ).rows as Row[];
      return { title: 'Meeting attendance', subtitle: fy ? `Financial year ${fy.label}` : undefined, sections: [{
        columns: [
          { key: 'title', label: 'Meeting' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'membership_no', label: 'Member no.' }, { key: 'full_name', label: 'Name' },
          { key: 'status', label: 'Status' }, { key: 'apology', label: 'Apology' }, { key: 'fine_ref', label: 'Fine' },
        ],
        rows,
        summary: [
          { label: 'Present', value: rows.filter((r) => r.status === 'present').length }, { label: 'Excused', value: rows.filter((r) => r.status === 'excused').length },
          { label: 'Absent', value: rows.filter((r) => r.status === 'absent').length },
        ],
      }] };
    }
    case 'income_expenditure': {
      const from = f.from ?? `${new Date().getFullYear()}-01-01`;
      const to = f.to ?? new Date().toISOString().slice(0, 10);
      const rows = (
        await db.query(
          `SELECT date, kind, description, amount_cents FROM (
             SELECT (t.created_at ${EAT})::date AS date, 'Member savings received' AS kind, COALESCE(t.reference,'') || ' ' || t.type::text AS description, t.amount_cents
               FROM savings_transactions t WHERE t.type IN ('contribution','reversal') AND NOT t.is_historical
             UNION ALL
             SELECT (fl.created_at ${EAT})::date, 'Fine collections', fi.reference, -fl.amount_cents
               FROM fine_ledger fl JOIN fines fi ON fi.id = fl.fine_id WHERE fl.entry_type IN ('payment','payment_reversal')
             UNION ALL SELECT received_on, 'Other income: ' || category, description, amount_cents FROM income
             UNION ALL SELECT spent_on, 'Expenditure: ' || category::text, reference || ' ' || description || ' (' || recipient || ')', -amount_cents FROM expenditure WHERE status = 'paid'
             UNION ALL SELECT (t.created_at ${EAT})::date, 'Member withdrawals', COALESCE(t.reference,''), t.amount_cents FROM savings_transactions t WHERE t.type = 'withdrawal'
           ) x WHERE date >= $1::date AND date <= $2::date ORDER BY date, kind`,
          [from, to],
        )
      ).rows as Row[];
      const inc = rows.filter((r) => Number(r.amount_cents) > 0);
      const out = rows.filter((r) => Number(r.amount_cents) < 0);
      return { title: 'Group income and expenditure', subtitle: `${from} to ${to}`, sections: [{
        columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'kind', label: 'Category' }, { key: 'description', label: 'Description' }, { key: 'amount_cents', label: 'Amount', type: 'money' }],
        rows,
        summary: [
          { label: 'Total income', value: sum(inc, 'amount_cents'), money: true }, { label: 'Total expenditure and withdrawals', value: -sum(out, 'amount_cents'), money: true },
          { label: 'Net', value: sum(rows, 'amount_cents'), money: true },
        ],
      }] };
    }
    case 'financial_position': {
      const asOf = f.asOf ?? new Date().toISOString().slice(0, 10);
      const next = (await db.query(`SELECT ($1::date + 1) AS d`, [asOf])).rows[0].d;
      const { cashBalanceBefore } = await import('./reconciliation.js');
      const cash = await cashBalanceBefore(db, next);
      const savings = Number((await db.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM savings_transactions WHERE (created_at ${EAT})::date <= $1::date`, [asOf])).rows[0].b);
      const fines = Number((await db.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM fine_ledger WHERE (created_at ${EAT})::date <= $1::date`, [asOf])).rows[0].b);
      const contrib = Number((await db.query(`SELECT COALESCE(SUM(amount_due_cents),0) AS b FROM monthly_obligations WHERE status IN ('unpaid','overdue') AND NOT is_historical`)).rows[0].b);
      const held = Number((await db.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM payments WHERE status IN ('held','unmatched')`)).rows[0].b);
      const rows: Row[] = [
        { item: 'Actual available cash (reconciled records)', amount_cents: cash, note: 'Confirmed income less confirmed expenditure and withdrawals' },
        { item: 'Total member savings (liability to members)', amount_cents: savings, note: 'Savings ledger only' },
        { item: 'Outstanding fines (receivable, not cash)', amount_cents: fines, note: 'Fines ledger; never counted as cash' },
        { item: 'Outstanding contributions (receivable, not cash)', amount_cents: contrib, note: 'Never counted as cash' },
        { item: 'Pending / unmatched payments (not confirmed)', amount_cents: held, note: 'Not counted as savings or cash' },
      ];
      return { title: 'Overall financial position', subtitle: `As at ${asOf}`, sections: [{
        columns: [{ key: 'item', label: 'Item' }, { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'note', label: 'Basis' }], rows,
      }] };
    }
    case 'historical_savings': {
      const rows = (
        await db.query(
          `SELECT m.membership_no, m.full_name, (t.occurred_at ${EAT})::date AS date, COALESCE(t.reference,'') AS reference, t.amount_cents
             FROM savings_transactions t JOIN members m ON m.id = t.member_id WHERE t.is_historical AND t.type = 'historical'
              AND ($1::uuid IS NULL OR t.member_id = $1::uuid) ORDER BY m.membership_no, t.occurred_at`,
          [f.memberId ?? null],
        )
      ).rows as Row[];
      return { title: 'Historical savings (imported)', sections: [{
        columns: [{ key: 'membership_no', label: 'Member no.' }, { key: 'full_name', label: 'Name' }, { key: 'date', label: 'Original date', type: 'date' }, { key: 'reference', label: 'Reference' }, { key: 'amount_cents', label: 'Amount', type: 'money' }],
        rows, summary: [{ label: 'Total imported', value: sum(rows, 'amount_cents'), money: true }],
      }] };
    }
    case 'withdrawals': {
      const rows = (
        await db.query(
          `SELECT w.reference, m.membership_no, m.full_name, (w.created_at ${EAT})::date AS requested, w.amount_cents, w.status::text AS status, COALESCE(w.payout_reference,'') AS payout_reference, (w.paid_at ${EAT})::date AS paid_on
             FROM withdrawals w JOIN members m ON m.id = w.member_id
            WHERE ($1::date IS NULL OR (w.created_at ${EAT})::date >= $1::date) AND ($2::date IS NULL OR (w.created_at ${EAT})::date <= $2::date) ORDER BY w.created_at`,
          [f.from ?? null, f.to ?? null],
        )
      ).rows as Row[];
      return { title: 'Withdrawal requests and payments', sections: [{
        columns: [
          { key: 'reference', label: 'Ref' }, { key: 'membership_no', label: 'Member no.' }, { key: 'full_name', label: 'Name' }, { key: 'requested', label: 'Requested', type: 'date' },
          { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'status', label: 'Status' }, { key: 'payout_reference', label: 'Payout ref' }, { key: 'paid_on', label: 'Paid on', type: 'date' },
        ],
        rows, summary: [{ label: 'Paid out', value: sum(rows.filter((r) => r.status === 'paid'), 'amount_cents'), money: true }],
      }] };
    }
    case 'reconciliation_statement': {
      const month = f.month ?? new Date().toISOString().slice(0, 7);
      const { row, summary: s, frozen } = await getPeriodReport(db, month);
      const names = row ? (await db.query(
        `SELECT (SELECT email FROM users WHERE id = $1) AS prepared, (SELECT email FROM users WHERE id = $2) AS reviewed`, [row.prepared_by, row.reviewed_by])).rows[0] : { prepared: null, reviewed: null };
      const fy = (await db.query(`SELECT label FROM financial_years WHERE $1::date BETWEEN start_date AND end_date`, [`${month}-01`])).rows[0]?.label ?? '';
      const status = row?.status ?? 'pending';
      const label: Record<string, string> = {
        pending: 'Pending Reconciliation', in_progress: 'Reconciliation in Progress', discrepancies_found: 'Discrepancies Found',
        awaiting_approval: 'Awaiting Approval', closed: 'Approved and Closed',
      };
      const open = Number((await db.query(`SELECT count(*) AS n FROM discrepancies WHERE status IN ('unresolved','investigating')`)).rows[0].n);
      const pairs: [string, string | number][] = [
        ['Group name', config.groupName], ['Reporting month', month], ['Financial year', fy], ['Total active members', s.expected.activeMembers],
        ['Total expected savings', s.expected.expectedCents], ['Total confirmed savings received', s.collections.verifiedSavingsCents], ['Outstanding contributions', s.expected.outstanding.cents],
        ['Total fines accrued', s.fines.lateAccruedCents + s.fines.absenceAccruedCents + s.fines.otherAccruedCents], ['Total fines collected', s.fines.verifiedPaymentsCents],
        ['Outstanding fines', s.fines.outstandingCents], ['Other confirmed income', s.position.otherIncomeCents], ['Group expenditure', s.position.groupExpenditureCents],
        ['Member withdrawals paid', s.position.memberWithdrawalsCents], ['Opening cash balance', s.position.openingCashCents], ['Closing cash balance', s.position.closingCashCents],
        ['Pending M-Pesa transactions', s.collections.pendingOrUnmatched.cents], ['Unmatched payments', s.collections.pendingOrUnmatched.count], ['Outstanding discrepancies', open],
        ['Evidence level', row?.evidence_level ?? s.evidenceLevel], ['Reconciliation status', label[status] ?? status], ['Figures', frozen ? 'Frozen at approval' : 'Live (not yet approved)'],
        ['Prepared by', names.prepared ?? ''], ['Reviewed by', names.reviewed ?? ''], ['Approval date', row?.approved_at ? dmyEAT(row.approved_at) : ''],
      ];
      const moneyItems = new Set(['Total expected savings', 'Total confirmed savings received', 'Outstanding contributions', 'Total fines accrued', 'Total fines collected', 'Outstanding fines', 'Other confirmed income', 'Group expenditure', 'Member withdrawals paid', 'Opening cash balance', 'Closing cash balance', 'Pending M-Pesa transactions']);
      const display: Row[] = pairs.map(([item, value]) => ({ item, value: moneyItems.has(item) ? `KSh ${(Number(value) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2 })}` : value }));
      const schedule = await memberSchedule(db, month);
      return { title: 'Monthly financial reconciliation statement', subtitle: month, sections: [
        { heading: 'Summary', columns: [{ key: 'item', label: 'Item' }, { key: 'value', label: 'Value' }], rows: display },
        { heading: 'Member-by-member schedule (savings and fines shown separately)', columns: [
          { key: 'membership_no', label: 'Member no.' }, { key: 'full_name', label: 'Name' }, { key: 'amount_due_cents', label: 'Due', type: 'money' }, { key: 'status', label: 'Status' },
          { key: 'paid_cents', label: 'Paid', type: 'money' }, { key: 'mpesa_receipt', label: 'M-Pesa ref' }, { key: 'late_fine_cents', label: 'Late fine', type: 'money' },
          { key: 'late_fine_status', label: 'Fine status' }, { key: 'fines_outstanding_cents', label: 'Fines owed', type: 'money' }, { key: 'savings_balance_cents', label: 'Savings bal.', type: 'money' },
        ], rows: schedule as Row[] },
      ] };
    }
  }
}

// ================================================================ exporters

const fmtMoney = (cents: unknown) => (Number(cents ?? 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtCell(col: Col, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (col.type === 'money') return fmtMoney(v);
  if (col.type === 'date') { const d = String(v).slice(0, 10); return /month/i.test(col.label) ? monthName(d) : dmy(d); }
  if (col.type === 'datetime') return dmyTimeEAT(String(v));
  return String(v);
}

export async function toXlsx(doc: ReportDoc): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = config.groupName;
  wb.created = new Date();
  doc.sections.forEach((s, i) => {
    const base = ((s.heading ?? doc.title).replace(/[\\/?*[\]:]/g, ' ').slice(0, 26) || `Sheet ${i + 1}`).trim();
    let nm = base; for (let k = 2; wb.getWorksheet(nm); k++) nm = `${base} ${k}`;
    const ws = wb.addWorksheet(nm);
    ws.addBackgroundImage(wb.addImage({ buffer: WATERMARK_TILE as never, extension: 'png' }));
    ws.addImage(wb.addImage({ buffer: LOGO as never, extension: 'png' }), { tl: { col: 0.1, row: 0.1 }, ext: { width: 78, height: 78 } });
    for (let r = 1; r <= 4; r++) ws.getRow(r).height = 20;
    ws.getCell('B1').value = config.groupName; ws.getCell('B1').font = { bold: true, size: 14, color: { argb: 'FF064E3B' } };
    ws.getCell('B2').value = doc.title + (doc.subtitle ? ` — ${doc.subtitle}` : ''); ws.getCell('B2').font = { bold: true };
    ws.getCell('B3').value = `Generated ${dmyTimeEAT(new Date())} (EAT)`;
    ws.addRow([]); // row 4 stays blank so the table starts on row 5
    const head = ws.addRow(s.columns.map((c) => c.label));
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF047857' } }; });
    for (const r of s.rows) {
      const row = ws.addRow(s.columns.map((c) => {
        const v = r[c.key];
        if (v === null || v === undefined) return '';
        if (c.type === 'money') return Number(v) / 100;
        if (c.type === 'number') return Number(v);
        if (c.type === 'date' || c.type === 'datetime') return fmtCell(c, v);
        return v;
      }));
      s.columns.forEach((c, idx) => { if (c.type === 'money') row.getCell(idx + 1).numFmt = '#,##0.00'; });
    }
    if (s.summary?.length) {
      ws.addRow([]);
      for (const m of s.summary) {
        const r = ws.addRow([m.label, m.money ? Number(m.value) / 100 : m.value]);
        r.font = { bold: true };
        if (m.money) r.getCell(2).numFmt = '#,##0.00';
      }
    }
    s.columns.forEach((c, idx) => {
      const widest = Math.max(c.label.length, ...s.rows.slice(0, 200).map((r) => fmtCell(c, r[c.key]).length));
      ws.getColumn(idx + 1).width = Math.min(Math.max(widest + 2, 10), 48);
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** CSV (UTF-8 with BOM so Excel opens it correctly). One block per section, separated by a blank line. */
export function toCsv(doc: ReportDoc): Buffer {
  const esc = (v: unknown) => {
    let t = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t) && Number.isNaN(Number(t))) t = `'${t}`; // neutralise spreadsheet formula injection
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines: string[] = [esc(config.groupName), esc(doc.title + (doc.subtitle ? ` - ${doc.subtitle}` : '')), ''];
  for (const s of doc.sections) {
    if (s.heading) lines.push(esc(s.heading));
    lines.push(s.columns.map((c) => esc(c.label)).join(','));
    for (const r of s.rows) {
      lines.push(s.columns.map((c) => {
        const v = r[c.key];
        if (v === null || v === undefined) return '';
        if (c.type === 'money') return (Number(v) / 100).toFixed(2);
        if (c.type === 'date') return esc(String(v).slice(0, 10));
        return esc(v);
      }).join(','));
    }
    lines.push('');
  }
  return Buffer.from('\ufeff' + lines.join('\r\n'), 'utf8');
}

export function toPdf(doc: ReportDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const widest = Math.max(...doc.sections.map((s) => s.columns.length));
    const pdf = new PDFDocument({ size: 'A4', layout: widest > 6 ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const left = pdf.page.margins.left;
    const usable = pdf.page.width - left - pdf.page.margins.right;
    pdf.image(LOGO, left, 30, { width: 58 });
    const hx = left + 68;
    pdf.fillColor('#064e3b').fontSize(16).font('Helvetica-Bold').text(config.groupName, hx, 36);
    pdf.fillColor('#111827').fontSize(13).text(doc.title);
    if (doc.subtitle) pdf.font('Helvetica').fontSize(10).fillColor('#4b5563').text(doc.subtitle);
    pdf.font('Helvetica').fontSize(8).fillColor('#6b7280').text(`Generated ${dmyTimeEAT(new Date())} (EAT)`);
    pdf.x = left; pdf.y = Math.max(pdf.y + 10, 100);

    for (const s of doc.sections) {
      if (s.heading) {
        if (pdf.y > pdf.page.height - 110) pdf.addPage();
        pdf.font('Helvetica-Bold').fontSize(11).fillColor('#064e3b').text(s.heading, left);
        pdf.moveDown(0.3);
      }
      const weights = s.columns.map((c) => (c.type === 'money' ? 1.4 : c.type === 'date' || c.type === 'number' ? 1.1 : 1.6));
      const total = weights.reduce((a, b) => a + b, 0);
      const widths = weights.map((w) => (w / total) * usable);
      const drawRow = (cells: string[], opts: { header?: boolean; shade?: boolean }) => {
        if (pdf.y > pdf.page.height - pdf.page.margins.bottom - 20) pdf.addPage();
        const y = pdf.y;
        if (opts.header) pdf.rect(left, y - 2, usable, 16).fill('#047857');
        else if (opts.shade) pdf.rect(left, y - 2, usable, 15).fill('#f3f4f6');
        pdf.fillColor(opts.header ? '#ffffff' : '#111827').font(opts.header ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        let x = left;
        cells.forEach((t, i) => {
          const right = s.columns[i]!.type === 'money' || s.columns[i]!.type === 'number';
          pdf.text(t, x + 2, y + 1, { width: widths[i]! - 4, height: 11, ellipsis: true, lineBreak: false, align: right ? 'right' : 'left' });
          x += widths[i]!;
        });
        pdf.y = y + 15;
      };
      drawRow(s.columns.map((c) => c.label), { header: true });
      s.rows.forEach((r, idx) => drawRow(s.columns.map((c) => fmtCell(c, r[c.key])), { shade: idx % 2 === 1 }));
      if (s.rows.length === 0) pdf.fillColor('#6b7280').fontSize(9).text('No records for the selected filters.', left, pdf.y + 4);
      if (s.summary?.length) {
        pdf.moveDown(0.6);
        for (const m of s.summary) {
          pdf.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text(`${m.label}: ${m.money ? 'KSh ' + fmtMoney(m.value) : m.value}`, left);
        }
      }
      pdf.moveDown(1);
    }
    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(range.start + i);
      // Official logo as a faint watermark centred on every page.
      if (i > 0) pdf.image(LOGO, left, 8, { width: 26 });
      const size = Math.min(pdf.page.width, pdf.page.height) * 0.62;
      pdf.save().opacity(0.07).image(LOGO, (pdf.page.width - size) / 2, (pdf.page.height - size) / 2, { width: size }).restore();
      pdf.page.margins.bottom = 0; // otherwise writing the footer inside the margin appends a blank page
      pdf.font('Helvetica').fontSize(7).fillColor('#9ca3af')
        .text(`Page ${i + 1} of ${range.count}`, left, pdf.page.height - 26, { width: usable, align: 'center', lineBreak: false });
    }
    pdf.end();
  });
}

/** A member's personal statement: savings and fines on separate sections, never combined. */
export async function memberStatementDoc(db: Db, memberId: string, f: ReportFilters = {}): Promise<ReportDoc> {
  const h = await memberHeader(db, memberId);
  const acct = await memberAccountSummary(db, memberId, f);
  const bal = Number((await db.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM savings_transactions WHERE member_id = $1`, [memberId])).rows[0].s);
  return {
    title: 'Member statement',
    subtitle: `${h.full_name} (${h.membership_no})`,
    sections: [...accountSections(acct.summary, acct.invoices, bal), await savingsStatementSection(db, memberId, f), await fineStatementSection(db, memberId, f)],
  };
}
