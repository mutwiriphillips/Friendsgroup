import type { PoolClient } from 'pg';
import { audit, SYSTEM_ACTOR } from '../lib/audit.js';

/**
 * Fresh start for record keeping. Members stay exactly as they are (profiles, status, photos, logins). Everything recorded
 * against them is cleared: contributions, invoices, fines, payments, withdrawals, attendance, payment proofs, statement and
 * reconciliation data, notifications, plus data loaded from the group sheet. Kept: members, staff accounts, rules and settings,
 * financial years, the records register, other meetings, income and other expenditure, and the audit trail.
 * Receipt, fine and withdrawal numbering starts again from 1.
 */
const WIPE = [
  'attendance', 'fine_ledger', 'fines', 'member_credits', 'manual_payments', 'monthly_obligations',
  'payment_submissions', 'submission_events', 'payments', 'savings_allocations', 'savings_transactions',
  'withdrawal_approvals', 'withdrawals', 'statement_lines', 'statement_batches', 'discrepancies', 'reconciliation_periods', 'message_outbox',
];
const GUARDED = ['expenditure', 'meetings', 'documents'];

export async function eraseRecords(c: PoolClient): Promise<Record<string, number>> {
  const count = async (sql: string) => Number((await c.query(sql)).rows[0].n);
  const before = {
    membersKept: await count(`SELECT count(*) AS n FROM members`),
    savingsEntries: await count(`SELECT count(*) AS n FROM savings_transactions`),
    fines: await count(`SELECT count(*) AS n FROM fines`),
    payments: await count(`SELECT count(*) AS n FROM payments`),
    invoices: await count(`SELECT count(*) AS n FROM monthly_obligations`),
  };

  // Files that belong to members: photos and payment proofs.
  const files = (await c.query(`SELECT screenshot_id AS id FROM payment_submissions WHERE screenshot_id IS NOT NULL`)).rows.map((r) => r.id as string);

  // The append-only guards stay on everywhere else; they are lifted only for the tables we clear, inside this transaction.
  for (const t of GUARDED) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  try {
    await c.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE role = 'member')`);
    await c.query(`TRUNCATE ${WIPE.join(', ')}`);
    await c.query(`DELETE FROM expenditure WHERE payment_reference LIKE 'SHEET %'`);
    await c.query(`DELETE FROM meetings WHERE is_historical`);
    const sheetFiles = (await c.query(`SELECT file_id AS id FROM documents WHERE category = 'group_sheet'`)).rows.map((r) => r.id as string);
    await c.query(`DELETE FROM documents WHERE category = 'group_sheet'`);
    files.push(...sheetFiles);
    if (files.length) await c.query(`DELETE FROM stored_files WHERE id = ANY($1::uuid[])`, [files]);
  } finally {
    for (const t of GUARDED) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }

  const restart = ['receipt_no_seq', 'fine_ref_seq', 'withdrawal_ref_seq', 'fine_ledger_id_seq', 'member_credits_id_seq', 
    'withdrawal_approvals_id_seq', 'statement_lines_id_seq', 'submission_events_id_seq', 'discrepancies_id_seq', 'reconciliation_periods_id_seq', 'message_outbox_id_seq'];
  for (const s of restart) await c.query(`ALTER SEQUENCE ${s} RESTART WITH 1`);
  if ((await count(`SELECT count(*) AS n FROM expenditure`)) === 0) await c.query(`ALTER SEQUENCE expenditure_ref_seq RESTART WITH 1`);

  await audit(c, SYSTEM_ACTOR, 'data.records_erased', 'system', null, { after: before });
  return before;
}
