import type { Db } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { monthName } from '../lib/dates.js';
import type { ReportDoc, ReportFilters, Row, Section } from './reports.js';
import { creditBalance } from './invoices.js';

const EAT = `AT TIME ZONE 'Africa/Nairobi'`;
const sumOf = (rows: Row[], key: string, pred: (r: Row) => boolean = () => true) => rows.filter(pred).reduce((a, r) => a + Number(r[key] ?? 0), 0);
const KIND_WORD = `CASE i.kind WHEN 'contribution' THEN 'Contribution' WHEN 'late_fine' THEN 'Late fine' WHEN 'meeting_fine' THEN 'Missing-meeting fine' ELSE 'Other fine' END`;

/** Every invoice (contribution or fine) between two dates. Contributions by their month, fines by the date of the fine. */
function invoicesSql() {
  const memberFilter = 'AND ($1::uuid IS NULL OR #.member_id = $1::uuid)';
  return `
    SELECT i.*, ${KIND_WORD} AS type FROM (
      SELECT o.member_id, 'contribution' AS kind, o.period::text AS month, o.period AS sort_date, o.due_date::text AS due_date, o.amount_due_cents AS amount_cents,
             CASE WHEN o.status IN ('paid','late_paid') THEN 'paid' ELSE 'unpaid' END AS status,
             (SELECT (MAX(t.occurred_at) ${EAT})::date::text FROM savings_allocations a JOIN savings_transactions t ON t.id = a.savings_txn_id WHERE a.obligation_id = o.id AND a.reversed_at IS NULL) AS paid_on,
             'Contribution, ' || to_char(o.period, 'FMMonth YYYY') AS description
        FROM monthly_obligations o
       WHERE o.period >= date_trunc('month', $2::date) AND o.period <= $3::date ${memberFilter.replace(/#/g, 'o')}
      UNION ALL
      SELECT f.member_id, CASE f.category::text WHEN 'late_payment' THEN 'late_fine' WHEN 'absence' THEN 'meeting_fine' ELSE 'other_fine' END,
             COALESCE(f.period, date_trunc('month', f.imposed_on)::date)::text, f.imposed_on, f.imposed_on::text, f.amount_cents,
             CASE f.status::text WHEN 'outstanding' THEN 'unpaid' ELSE f.status::text END,
             (SELECT (MAX(l.created_at) ${EAT})::date::text FROM fine_ledger l WHERE l.fine_id = f.id AND l.entry_type = 'payment'),
             COALESCE(f.reason, '')
        FROM fines f WHERE f.imposed_on >= $2::date AND f.imposed_on <= $3::date ${memberFilter.replace(/#/g, 'f')}
    ) i`;
}

export interface AccountSummary { invoicedCents: number; paidCents: number; waivedCents: number; unpaidCents: number; accountBalanceCents: number; invoiceCount: number }

/** Total invoices, paid, unpaid and the money sitting in the member's account (received, not yet allocated). */
export async function memberAccountSummary(db: Db, memberId: string, f: ReportFilters = {}): Promise<{ summary: AccountSummary; invoices: Row[] }> {
  const from = f.from ?? '1900-01-01'; const to = f.to ?? '2999-12-31';
  const invoices = (await db.query(
    `SELECT s.month, s.type, s.description, s.due_date, s.amount_cents, s.status, s.paid_on FROM (${invoicesSql()}) s ORDER BY s.sort_date, s.kind`,
    [memberId, from, to])).rows as Row[];
  const live = invoices.filter((r) => r.status !== 'reversed');
  const invoiced = sumOf(live, 'amount_cents');
  const paid = sumOf(live, 'amount_cents', (r) => r.status === 'paid');
  const waived = sumOf(live, 'amount_cents', (r) => r.status === 'waived');
  return {
    invoices,
    summary: { invoicedCents: invoiced, paidCents: paid, waivedCents: waived, unpaidCents: invoiced - paid - waived, accountBalanceCents: await creditBalance(db, memberId), invoiceCount: live.length },
  };
}

export const INVOICE_COLUMNS = [
  { key: 'month', label: 'Month', type: 'date' as const }, { key: 'type', label: 'Invoice' }, { key: 'description', label: 'Details' }, { key: 'due_date', label: 'Due / dated', type: 'date' as const },
  { key: 'amount_cents', label: 'Amount', type: 'money' as const }, { key: 'status', label: 'Status' }, { key: 'paid_on', label: 'Paid on', type: 'date' as const },
];

/** The member's account at a glance, for the top of an individual statement. */
export function accountSections(a: AccountSummary, invoices: Row[], savingsBalance: number): Section[] {
  return [
    { heading: 'Account summary', columns: [{ key: 'item', label: 'Item' }, { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'note', label: 'Meaning' }], rows: [
      { item: 'Total invoices', amount_cents: a.invoicedCents, note: `${a.invoiceCount} invoices raised (contributions and fines)` },
      { item: 'Paid', amount_cents: a.paidCents, note: 'Invoices settled' },
      ...(a.waivedCents ? [{ item: 'Waived', amount_cents: a.waivedCents, note: 'Fines forgiven by the group' }] : []),
      { item: 'Unpaid', amount_cents: a.unpaidCents, note: 'Still owed to the group' },
      { item: 'Balance left in member account', amount_cents: a.accountBalanceCents, note: 'Money received but not yet allocated to invoices' },
      { item: 'Savings balance', amount_cents: savingsBalance, note: 'Contributions held in the savings account' },
    ] },
    { heading: 'Invoices', columns: INVOICE_COLUMNS, rows: invoices.map((r) => ({ ...r, status: r.status === 'reversed' ? 'cleared (reversed)' : r.status })) as Row[],
      summary: [{ label: 'Total invoices', value: a.invoicedCents, money: true }, { label: 'Paid', value: a.paidCents, money: true }, { label: 'Unpaid', value: a.unpaidCents, money: true }] },
  ];
}

/** Money posted for the member, and what became of it. */
export async function memberPaymentsSection(db: Db, memberId: string, f: ReportFilters = {}): Promise<Section> {
  const rows = (await db.query(
    `SELECT mp.paid_on::text AS paid_on, mp.mpesa_code, mp.amount_cents,
            mp.amount_cents + COALESCE((SELECT SUM(amount_cents) FROM member_credits c WHERE c.manual_payment_id = mp.id AND c.entry_type IN ('applied','adjustment')), 0)
                            + COALESCE((SELECT SUM(amount_cents) FROM member_credits c WHERE c.manual_payment_id = mp.id AND c.entry_type = 'reinstated'), 0) AS left_cents,
            CASE WHEN mp.reversed_at IS NOT NULL THEN 'reversed' ELSE 'recorded' END AS status, mp.transaction_message AS message
       FROM manual_payments mp WHERE mp.member_id = $1 AND ($2::date IS NULL OR mp.paid_on >= $2::date) AND ($3::date IS NULL OR mp.paid_on <= $3::date) ORDER BY mp.paid_on, mp.created_at`,
    [memberId, f.from ?? null, f.to ?? null])).rows as Row[];
  const live = rows.filter((r) => r.status !== 'reversed');
  return {
    heading: 'Payments received',
    columns: [{ key: 'paid_on', label: 'Date paid', type: 'date' }, { key: 'mpesa_code', label: 'M-Pesa code' }, { key: 'amount_cents', label: 'Amount', type: 'money' },
      { key: 'left_cents', label: 'Not yet allocated', type: 'money' }, { key: 'status', label: 'Status' }, { key: 'message', label: 'Transaction message' }],
    rows,
    summary: [{ label: 'Total received', value: sumOf(live, 'amount_cents'), money: true }, { label: 'Not yet allocated', value: sumOf(live, 'left_cents'), money: true }],
  };
}

const section = (heading: string, columns: Section['columns'], rows: Row[], summary?: Section['summary']): Section => ({ heading, columns, rows, ...(summary ? { summary } : {}) });

/** The complete group statement for a chosen period: every invoice, payment, allocation, fine, saving, withdrawal, income, expense and meeting. */
export async function groupStatementDoc(db: Db, f: ReportFilters): Promise<ReportDoc> {
  const today = (await db.query(`SELECT (now() ${EAT})::date::text AS d`)).rows[0].d as string;
  const from = f.from ?? `${today.slice(0, 4)}-01-01`; const to = f.to ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new HttpError(400, 'Choose a valid period');
  if (from > to) throw new HttpError(400, 'The period starts after it ends');
  const P = [from, to];

  // 1. invoices in the period (all members)
  const invoices = (await db.query(
    `SELECT m.membership_no, m.full_name, s.month, s.type, s.description, s.due_date, s.amount_cents, s.status, s.paid_on
       FROM (${invoicesSql()}) s JOIN members m ON m.id = s.member_id ORDER BY s.sort_date, m.membership_no, s.kind`, [null, ...P])).rows as Row[];
  const live = invoices.filter((r) => r.status !== 'reversed');
  const invoicedTotal = sumOf(live, 'amount_cents');
  const paidTotal = sumOf(live, 'amount_cents', (r) => r.status === 'paid');
  const waivedTotal = sumOf(live, 'amount_cents', (r) => r.status === 'waived');

  // 2. money received in the period
  const received = (await db.query(
    `SELECT mp.paid_on::text AS date, m.membership_no, m.full_name, mp.mpesa_code AS reference, 'Posted by administrator' AS source, mp.amount_cents,
            mp.amount_cents + COALESCE((SELECT SUM(amount_cents) FROM member_credits c WHERE c.manual_payment_id = mp.id AND c.entry_type IN ('applied','adjustment','reinstated')), 0) AS left_cents,
            CASE WHEN mp.reversed_at IS NOT NULL THEN 'reversed' ELSE 'recorded' END AS status, mp.transaction_message AS message
       FROM manual_payments mp JOIN members m ON m.id = mp.member_id WHERE mp.paid_on >= $1::date AND mp.paid_on <= $2::date
     UNION ALL
     SELECT (p.occurred_at ${EAT})::date::text, m.membership_no, m.full_name, p.mpesa_receipt, 'M-Pesa', p.amount_cents, 0, 'recorded', ''
       FROM payments p JOIN members m ON m.id = p.member_id
      WHERE p.channel <> 'manual' AND p.status = 'confirmed' AND (p.occurred_at ${EAT})::date >= $1::date AND (p.occurred_at ${EAT})::date <= $2::date
     ORDER BY 1, 2`, P)).rows as Row[];
  const receivedLive = received.filter((r) => r.status !== 'reversed');

  // 3. allocations (what the administrator approved)
  const allocations = (await db.query(
    `SELECT (c.created_at ${EAT})::date::text AS date, m.membership_no, m.full_name, mp.mpesa_code AS source, -c.amount_cents AS amount_cents,
            COALESCE((SELECT string_agg(x->>'label', '; ') FROM jsonb_array_elements(COALESCE(c.allocation->'cleared', '[]'::jsonb)) x), '')
              || CASE WHEN jsonb_array_length(COALESCE(c.allocation->'inAdvance', '[]'::jsonb)) > 0 THEN ' + ' || jsonb_array_length(c.allocation->'inAdvance') || ' month(s) in advance' ELSE '' END AS cleared,
            COALESCE(c.note, '') AS note,
            CASE WHEN EXISTS (SELECT 1 FROM member_credits r WHERE r.entry_type = 'reinstated' AND (r.allocation->>'undoes')::bigint = c.id) THEN 'undone' ELSE 'in force' END AS status
       FROM member_credits c JOIN members m ON m.id = c.member_id LEFT JOIN manual_payments mp ON mp.id = c.manual_payment_id
      WHERE c.entry_type = 'applied' AND (c.created_at ${EAT})::date >= $1::date AND (c.created_at ${EAT})::date <= $2::date ORDER BY c.created_at`, P)).rows as Row[];

  // 4. fines register
  const fines = (await db.query(
    `SELECT f.imposed_on::text AS date, f.reference, m.membership_no, m.full_name, f.category::text AS category, COALESCE(f.reason,'') AS reason, f.amount_cents, f.status::text AS status
       FROM fines f JOIN members m ON m.id = f.member_id WHERE f.imposed_on >= $1::date AND f.imposed_on <= $2::date ORDER BY f.imposed_on, f.reference`, P)).rows as Row[];

  // 5. savings ledger
  const savings = (await db.query(
    `SELECT (t.occurred_at ${EAT})::date::text AS date, m.membership_no, m.full_name, t.type::text AS type, COALESCE(t.reference,'') AS reference, COALESCE(t.reason,'') AS note, t.amount_cents
       FROM savings_transactions t JOIN members m ON m.id = t.member_id
      WHERE (t.occurred_at ${EAT})::date >= $1::date AND (t.occurred_at ${EAT})::date <= $2::date ORDER BY t.occurred_at, t.created_at`, P)).rows as Row[];

  const withdrawals = (await db.query(
    `SELECT (w.created_at ${EAT})::date::text AS date, w.reference, m.membership_no, m.full_name, w.amount_cents, w.status::text AS status
       FROM withdrawals w JOIN members m ON m.id = w.member_id WHERE (w.created_at ${EAT})::date >= $1::date AND (w.created_at ${EAT})::date <= $2::date ORDER BY w.created_at`, P)).rows as Row[];
  const income = (await db.query(`SELECT received_on::text AS date, category, description, COALESCE(reference,'') AS reference, amount_cents FROM income WHERE received_on >= $1::date AND received_on <= $2::date ORDER BY received_on`, P)).rows as Row[];
  const spend = (await db.query(`SELECT spent_on::text AS date, reference, category, description, recipient, status::text AS status, amount_cents FROM expenditure WHERE spent_on >= $1::date AND spent_on <= $2::date ORDER BY spent_on, reference`, P)).rows as Row[];
  const meetings = (await db.query(
    `SELECT (mt.scheduled_at ${EAT})::date::text AS date, mt.title, mt.venue, mt.status::text AS status,
            COUNT(a.*) FILTER (WHERE a.status = 'present')::int AS present, COUNT(a.*) FILTER (WHERE a.status = 'absent')::int AS absent, COUNT(a.*) FILTER (WHERE a.status = 'excused')::int AS excused
       FROM meetings mt LEFT JOIN attendance a ON a.meeting_id = mt.id
      WHERE (mt.scheduled_at ${EAT})::date >= $1::date AND (mt.scheduled_at ${EAT})::date <= $2::date GROUP BY mt.id ORDER BY mt.scheduled_at`, P)).rows as Row[];

  // 6. member accounts
  const accounts = (await db.query(
    `SELECT m.id, m.membership_no, m.full_name, m.status::text AS status,
            COALESCE((SELECT SUM(amount_cents) FROM savings_transactions t WHERE t.member_id = m.id AND (t.occurred_at ${EAT})::date <= $1::date), 0) AS savings_cents,
            COALESCE((SELECT SUM(amount_cents) FROM member_credits c WHERE c.member_id = m.id), 0) AS account_cents
       FROM members m ORDER BY m.membership_no`, [to])).rows as Row[];
  const byMember = new Map<string, { inv: number; paid: number; waived: number }>();
  const names = new Map(accounts.map((a) => [`${a.membership_no}`, a]));
  for (const r of live) {
    const k = String(r.membership_no); const cur = byMember.get(k) ?? { inv: 0, paid: 0, waived: 0 };
    cur.inv += Number(r.amount_cents); if (r.status === 'paid') cur.paid += Number(r.amount_cents); if (r.status === 'waived') cur.waived += Number(r.amount_cents);
    byMember.set(k, cur);
  }
  const recByMember = new Map<string, number>();
  for (const r of receivedLive) recByMember.set(String(r.membership_no), (recByMember.get(String(r.membership_no)) ?? 0) + Number(r.amount_cents));
  const memberRows = accounts.map((a) => {
    const k = String(a.membership_no); const t = byMember.get(k) ?? { inv: 0, paid: 0, waived: 0 };
    return { membership_no: a.membership_no, full_name: a.full_name, status: a.status, invoiced_cents: t.inv, paid_cents: t.paid, unpaid_cents: t.inv - t.paid - t.waived,
      received_cents: recByMember.get(k) ?? 0, account_cents: a.account_cents, savings_cents: a.savings_cents } as Row;
  }).filter((r) => r.status === 'active' || Number(r.invoiced_cents) || Number(r.received_cents) || Number(r.account_cents) || Number(r.savings_cents));
  void names;

  const savingsIn = sumOf(savings, 'amount_cents', (r) => Number(r.amount_cents) > 0 && r.type !== 'withdrawal');
  const withdrawnOut = -sumOf(savings, 'amount_cents', (r) => r.type === 'withdrawal');
  const incomeTotal = sumOf(income, 'amount_cents');
  const spendTotal = sumOf(spend, 'amount_cents', (r) => r.status === 'paid');
  const fineLedgerPaid = Number((await db.query(`SELECT COALESCE(-SUM(amount_cents),0) AS s FROM fine_ledger WHERE entry_type IN ('payment','payment_reversal') AND (created_at ${EAT})::date >= $1::date AND (created_at ${EAT})::date <= $2::date`, P)).rows[0].s);
  const unallocatedNow = sumOf(memberRows, 'account_cents');
  const unpaidAll = (await db.query(`SELECT COALESCE(SUM(amount_due_cents),0) AS s FROM monthly_obligations WHERE status IN ('unpaid','overdue')`)).rows[0].s as number;
  const finesOutstanding = Number((await db.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM fines WHERE status = 'outstanding'`)).rows[0].s);

  const summaryRows: Row[] = [
    { item: 'Members listed', amount_cents: memberRows.length, note: 'Active members and anyone with activity in the period', count: 1 },
    { item: 'Invoices raised in the period', amount_cents: invoicedTotal, note: `${live.length} invoices: contributions by their month, fines by their date` },
    { item: '   of which paid', amount_cents: paidTotal, note: 'Settled so far' },
    ...(waivedTotal ? [{ item: '   of which waived', amount_cents: waivedTotal, note: 'Fines forgiven' }] : []),
    { item: '   of which unpaid', amount_cents: invoicedTotal - paidTotal - waivedTotal, note: 'Still owed on those invoices' },
    { item: 'Money received from members in the period', amount_cents: sumOf(receivedLive, 'amount_cents'), note: `${receivedLive.length} payments (posted by the administrator or via M-Pesa)` },
    { item: 'Received money not yet allocated to invoices (now)', amount_cents: unallocatedNow, note: 'Waiting for the administrator to allocate' },
    { item: 'Contributions saved in the period', amount_cents: savingsIn, note: 'Savings ledger credits' },
    { item: 'Withdrawals paid in the period', amount_cents: withdrawnOut, note: '' },
    { item: 'Fines collected in the period', amount_cents: fineLedgerPaid, note: 'Fines ledger payments' },
    { item: 'Other income in the period', amount_cents: incomeTotal, note: '' },
    { item: 'Expenditure paid in the period', amount_cents: spendTotal, note: '' },
    { item: 'All unpaid contribution invoices (now)', amount_cents: unpaidAll, note: 'Every month, not only this period' },
    { item: 'All outstanding fines (now)', amount_cents: finesOutstanding, note: 'Every period' },
    { item: 'Total member savings at end of period', amount_cents: sumOf(memberRows, 'savings_cents'), note: 'Savings ledger up to the end date' },
  ];

  const moneyMembers = [{ key: 'invoiced_cents', label: 'Invoiced', type: 'money' as const }, { key: 'paid_cents', label: 'Paid', type: 'money' as const }, { key: 'unpaid_cents', label: 'Unpaid', type: 'money' as const }];
  return {
    title: 'Group statement',
    subtitle: `${from.split('-').reverse().join('/')} to ${to.split('-').reverse().join('/')}`.replace(/(\d{2})\/(\d{2})\/(\d{4})/g, (_m, d, mo, y) => `${d}/${monthName(`${y}-${mo}-01`).split(' ')[0]}/${y}`),
    sections: [
      { heading: 'Statement summary', columns: [{ key: 'item', label: 'Item' }, { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'note', label: 'Basis' }],
        rows: summaryRows.map(({ count: _c, ...r }) => (r.item === 'Members listed' ? { ...r, amount_cents: null, note: `${memberRows.length} members. ${r.note}` } : r)) as Row[] },
      section('Member accounts', [{ key: 'membership_no', label: 'No.' }, { key: 'full_name', label: 'Member' }, { key: 'status', label: 'Status' }, ...moneyMembers,
        { key: 'received_cents', label: 'Received in period', type: 'money' }, { key: 'account_cents', label: 'Balance in account', type: 'money' }, { key: 'savings_cents', label: 'Savings at end', type: 'money' }], memberRows,
        [{ label: 'Invoiced', value: sumOf(memberRows, 'invoiced_cents'), money: true }, { label: 'Paid', value: sumOf(memberRows, 'paid_cents'), money: true }, { label: 'Unpaid', value: sumOf(memberRows, 'unpaid_cents'), money: true },
          { label: 'Received', value: sumOf(memberRows, 'received_cents'), money: true }, { label: 'Balance in accounts', value: unallocatedNow, money: true }, { label: 'Savings', value: sumOf(memberRows, 'savings_cents'), money: true }]),
      section('All invoices raised', [{ key: 'membership_no', label: 'No.' }, { key: 'full_name', label: 'Member' }, ...INVOICE_COLUMNS],
        invoices.map((r) => ({ ...r, status: r.status === 'reversed' ? 'cleared (reversed)' : r.status })) as Row[],
        [{ label: 'Total invoiced', value: invoicedTotal, money: true }, { label: 'Paid', value: paidTotal, money: true }, { label: 'Unpaid', value: invoicedTotal - paidTotal - waivedTotal, money: true }]),
      section('All payments received', [{ key: 'date', label: 'Date paid', type: 'date' }, { key: 'membership_no', label: 'No.' }, { key: 'full_name', label: 'Member' }, { key: 'reference', label: 'Reference' }, { key: 'source', label: 'Source' },
        { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'left_cents', label: 'Not yet allocated', type: 'money' }, { key: 'status', label: 'Status' }, { key: 'message', label: 'Transaction message' }], received,
        [{ label: 'Total received', value: sumOf(receivedLive, 'amount_cents'), money: true }, { label: 'Not yet allocated', value: sumOf(receivedLive, 'left_cents'), money: true }]),
      section('Allocations approved by the administrator', [{ key: 'date', label: 'Date', type: 'date' }, { key: 'membership_no', label: 'No.' }, { key: 'full_name', label: 'Member' }, { key: 'source', label: 'From payment' },
        { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'cleared', label: 'Invoices paid' }, { key: 'note', label: 'Note' }, { key: 'status', label: 'Status' }], allocations,
        [{ label: 'Total allocated (in force)', value: sumOf(allocations, 'amount_cents', (r) => r.status === 'in force'), money: true }]),
      section('Fines register', [{ key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Ref' }, { key: 'membership_no', label: 'No.' }, { key: 'full_name', label: 'Member' }, { key: 'category', label: 'Category' },
        { key: 'reason', label: 'Reason' }, { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'status', label: 'Status' }], fines,
        [{ label: 'Fines in the period', value: sumOf(fines, 'amount_cents', (r) => r.status !== 'reversed'), money: true }]),
      section('Savings ledger', [{ key: 'date', label: 'Date', type: 'date' }, { key: 'membership_no', label: 'No.' }, { key: 'full_name', label: 'Member' }, { key: 'type', label: 'Type' }, { key: 'reference', label: 'Reference' },
        { key: 'note', label: 'Note' }, { key: 'amount_cents', label: 'Amount', type: 'money' }], savings, [{ label: 'Net savings movement', value: sumOf(savings, 'amount_cents'), money: true }]),
      section('Withdrawals', [{ key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Ref' }, { key: 'membership_no', label: 'No.' }, { key: 'full_name', label: 'Member' }, { key: 'amount_cents', label: 'Amount', type: 'money' }, { key: 'status', label: 'Status' }], withdrawals),
      section('Other income', [{ key: 'date', label: 'Date', type: 'date' }, { key: 'category', label: 'Category' }, { key: 'description', label: 'Description' }, { key: 'reference', label: 'Reference' }, { key: 'amount_cents', label: 'Amount', type: 'money' }], income,
        [{ label: 'Total', value: incomeTotal, money: true }]),
      section('Expenditure', [{ key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Ref' }, { key: 'category', label: 'Category' }, { key: 'description', label: 'Description' }, { key: 'recipient', label: 'Paid to' },
        { key: 'status', label: 'Status' }, { key: 'amount_cents', label: 'Amount', type: 'money' }], spend, [{ label: 'Total paid', value: spendTotal, money: true }]),
      section('Meetings and attendance', [{ key: 'date', label: 'Date', type: 'date' }, { key: 'title', label: 'Meeting' }, { key: 'venue', label: 'Venue' }, { key: 'status', label: 'Status' },
        { key: 'present', label: 'Present', type: 'number' }, { key: 'absent', label: 'Absent', type: 'number' }, { key: 'excused', label: 'Excused', type: 'number' }], meetings),
    ],
  };
}
