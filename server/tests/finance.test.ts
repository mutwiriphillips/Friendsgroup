import { beforeEach, describe, expect, it } from 'vitest';
import { pool, withTx } from '../src/db/pool.js';
import { accrueLateFines, generateObligationsForMonth } from '../src/services/obligations.js';
import { confirmPayment, resolveFine, reversePayment } from '../src/services/ledger.js';
import { registerMember, registerMemberSchema } from '../src/services/members.js';
import { KES, SYSTEM, finesOutstanding, monthsFor, newMember, obligations, pay, resetDb, savingsBalance } from './helpers.js';

beforeEach(resetDb);

describe('member registration', () => {
  it('registers a member with a generated membership number and encrypted National ID', async () => {
    const m = await newMember('Jane Wanjiru');
    expect(m.membershipNo).toMatch(/^MBR-\d{4}$/);
    const { rows } = await pool.query('SELECT national_id_enc FROM members WHERE id = $1', [m.id]);
    expect(rows[0].national_id_enc).not.toMatch(/^\d+$/); // ciphertext, not the raw ID
  });

  it('rejects a duplicate National ID', async () => {
    const input = registerMemberSchema.parse({ fullName: 'Dup Person', nationalId: '12345678', phone: '0711000111' });
    await withTx((c) => registerMember(c, input, SYSTEM));
    await expect(
      withTx((c) => registerMember(c, { ...input, phone: '254711000222' }, SYSTEM)),
    ).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_NATIONAL_ID' });
  });
});

describe('monthly obligations and rule snapshots', () => {
  it('generates one obligation per active member per month and is idempotent', async () => {
    await newMember('Member Alpha');
    await newMember('Member Bravo');
    const first = await withTx((c) => generateObligationsForMonth(c, '2026-01-01', '2026-01-02'));
    const second = await withTx((c) => generateObligationsForMonth(c, '2026-01-01', '2026-01-02'));
    expect(first).toBe(2);
    expect(second).toBe(0);
    const { rows } = await pool.query('SELECT amount_due_cents, due_date, status FROM monthly_obligations');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amount_due_cents: KES(1500), due_date: '2026-01-10', status: 'unpaid' });
  });

  it('does not generate obligations for suspended members', async () => {
    const m = await newMember('Suspended');
    await pool.query(`UPDATE members SET status = 'suspended' WHERE id = $1`, [m.id]);
    const created = await withTx((c) => generateObligationsForMonth(c, '2026-01-01', '2026-01-02'));
    expect(created).toBe(0);
  });

  it('a rule change affects only future obligations, never existing ones', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-02');
    await pool.query(
      `INSERT INTO rule_versions (effective_from, monthly_amount_cents, deadline_day, late_fine_cents, absence_fine_cents, meetings_per_year, reason, due_month_offset)
       VALUES ('2026-03-01', 200000, 12, 30000, 500000, 3, 'test', 0)`,
    );
    await monthsFor(['2026-03-01'], '2026-03-02');
    const { rows } = await pool.query(
      `SELECT to_char(period,'YYYY-MM') AS p, amount_due_cents, due_date, late_fine_cents FROM monthly_obligations WHERE member_id=$1 ORDER BY period`,
      [m.id],
    );
    expect(rows[0]).toMatchObject({ p: '2026-01', amount_due_cents: KES(1500), due_date: '2026-01-10', late_fine_cents: KES(200) });
    expect(rows[1]).toMatchObject({ p: '2026-03', amount_due_cents: KES(2000), due_date: '2026-03-12', late_fine_cents: KES(300) });
  });
});

describe('payment on or before the 10th', () => {
  it('settles the month as Paid with no fine, even at 23:59 on the deadline (Nairobi time)', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-05');
    const r = await pay(m.id, 'savings', KES(1500), { occurredAt: '2026-01-10T20:59:00Z' }); // 23:59 EAT on the 10th
    expect(r.outcome.outcome).toBe('confirmed');
    await accrueLateFines(pool, '2026-01-20');
    expect((await obligations(m.id))[0]).toMatchObject({ status: 'paid', paid_cents: KES(1500) });
    expect(await finesOutstanding(m.id)).toBe(0);
    expect(await savingsBalance(m.id)).toBe(KES(1500));
  });
});

describe('payment after the 10th and the late fine', () => {
  it('accrues exactly one KSh 200 fine per overdue month, however often the job runs', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-05');
    for (const day of ['2026-01-11', '2026-01-11', '2026-01-12', '2026-02-01']) await withTx((c) => accrueLateFines(c, day));
    const { rows } = await pool.query(`SELECT amount_cents, category, status FROM fines WHERE member_id = $1`, [m.id]);
    expect(rows).toEqual([{ amount_cents: KES(200), category: 'late_payment', status: 'outstanding' }]);
    expect((await obligations(m.id))[0].status).toBe('overdue');
    expect(await finesOutstanding(m.id)).toBe(KES(200));
  });

  it('is Late Paid when paid after the deadline, and the fine stays separately payable', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-11'); // overdue, fine accrued
    const r = await pay(m.id, 'savings', KES(1500), { occurredAt: '2026-01-14T09:00:00Z' });
    expect(r.outcome.outcome).toBe('confirmed');
    expect((await obligations(m.id))[0].status).toBe('late_paid');
    // Paying the contribution did NOT touch the fine.
    expect(await finesOutstanding(m.id)).toBe(KES(200));
    expect(await savingsBalance(m.id)).toBe(KES(1500)); // fines are never deducted from savings
  });

  it('creates the late fine at payment time if the daily job has not run yet', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-05');
    await pay(m.id, 'savings', KES(1500), { occurredAt: '2026-01-12T09:00:00Z' });
    expect(await finesOutstanding(m.id)).toBe(KES(200));
    await withTx((c) => accrueLateFines(c, '2026-02-01'));
    expect(await finesOutstanding(m.id)).toBe(KES(200)); // still one fine
  });
});

describe('full-contribution enforcement', () => {
  it('holds an underpayment without settling anything or touching savings', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-05');
    const r = await pay(m.id, 'savings', KES(1000));
    expect(r.outcome.outcome).toBe('held');
    expect((await obligations(m.id))[0]).toMatchObject({ status: 'unpaid', paid_cents: 0 });
    expect(await savingsBalance(m.id)).toBe(0);
    const p = (await pool.query('SELECT status, hold_reason FROM payments WHERE id = $1', [r.id])).rows[0];
    expect(p.status).toBe('held');
    expect(p.hold_reason).toMatch(/Partial contributions are not accepted/);
  });

  it('holds an amount that is not a whole number of months', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01', '2026-02-01'], '2026-02-05');
    const r = await pay(m.id, 'savings', KES(2000));
    expect(r.outcome.outcome).toBe('held');
    expect(await savingsBalance(m.id)).toBe(0);
  });

  it('the database itself refuses a partially paid obligation', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-05');
    await expect(
      pool.query(`UPDATE monthly_obligations SET paid_cents = 50000, status = 'paid' WHERE member_id = $1`, [m.id]),
    ).rejects.toThrow();
  });
});

describe('oldest outstanding month first', () => {
  const setup = async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01', '2026-02-01', '2026-03-01'], '2026-03-05'); // Jan & Feb overdue, Mar unpaid
    return m;
  };

  it('KSh 1,500 settles January only', async () => {
    const m = await setup();
    const r = await pay(m.id, 'savings', KES(1500), { occurredAt: '2026-03-05T09:00:00Z' });
    expect(r.outcome.outcome).toBe('confirmed');
    expect((await obligations(m.id)).map((o) => o.status)).toEqual(['late_paid', 'overdue', 'unpaid']);
  });

  it('KSh 3,000 settles January and February', async () => {
    const m = await setup();
    await pay(m.id, 'savings', KES(3000), { occurredAt: '2026-03-05T09:00:00Z' });
    expect((await obligations(m.id)).map((o) => o.status)).toEqual(['late_paid', 'late_paid', 'unpaid']);
  });

  it('KSh 4,500 settles January, February and March, with one original transaction and 3 allocations', async () => {
    const m = await setup();
    const r = await pay(m.id, 'savings', KES(4500), { occurredAt: '2026-03-05T09:00:00Z' });
    expect((await obligations(m.id)).map((o) => o.status)).toEqual(['late_paid', 'late_paid', 'paid']);
    expect(r.outcome.outcome === 'confirmed' && r.outcome.allocations.map((a) => a.period)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    const txns = (await pool.query('SELECT count(*)::int AS n FROM savings_transactions WHERE payment_id = $1', [r.id])).rows[0].n;
    const allocs = (await pool.query('SELECT count(*)::int AS n FROM savings_allocations')).rows[0].n;
    expect(txns).toBe(1);
    expect(allocs).toBe(3);
    expect(await savingsBalance(m.id)).toBe(KES(4500));
  });

  it('cannot settle the same obligation twice', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-05');
    await pay(m.id, 'savings', KES(1500));
    const second = await pay(m.id, 'savings', KES(1500));
    expect(second.outcome.outcome).toBe('held'); // nothing left to allocate to
    expect(await savingsBalance(m.id)).toBe(KES(1500));
  });
});

describe('idempotency and concurrency', () => {
  it('a repeated confirmation (duplicate callback) creates no duplicate ledger entries', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01', '2026-02-01'], '2026-02-05');
    const r = await pay(m.id, 'savings', KES(1500));
    const again = await withTx((c) => confirmPayment(c, r.id, SYSTEM));
    const again2 = await withTx((c) => confirmPayment(c, r.id, SYSTEM));
    expect(again.outcome).toBe('already_confirmed');
    expect(again2.outcome).toBe('already_confirmed');
    expect(await savingsBalance(m.id)).toBe(KES(1500));
    expect((await obligations(m.id)).map((o) => o.status)).toEqual(['late_paid', 'unpaid']);
  });

  it('the same M-Pesa receipt cannot be recorded twice', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-05');
    await pay(m.id, 'savings', KES(1500), { receipt: 'QWE1234567' });
    await expect(pay(m.id, 'savings', KES(1500), { receipt: 'QWE1234567' })).rejects.toMatchObject({ code: '23505' });
  });

  it('two simultaneous payments for one outstanding month settle it exactly once', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-05');
    const results = await Promise.all([pay(m.id, 'savings', KES(1500)), pay(m.id, 'savings', KES(1500))]);
    const outcomes = results.map((r) => r.outcome.outcome).sort();
    expect(outcomes).toEqual(['confirmed', 'held']);
    expect(await savingsBalance(m.id)).toBe(KES(1500));
    const live = (await pool.query('SELECT count(*)::int AS n FROM savings_allocations WHERE reversed_at IS NULL')).rows[0].n;
    expect(live).toBe(1);
  });
});

describe('separate fines ledger', () => {
  it('fine payments never change savings, and savings payments never change fines', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01', '2026-02-01'], '2026-02-11'); // both overdue, 2 fines of KSh 200
    expect(await finesOutstanding(m.id)).toBe(KES(400));

    await pay(m.id, 'fine', KES(200));
    expect(await finesOutstanding(m.id)).toBe(KES(200));
    expect(await savingsBalance(m.id)).toBe(0);
    expect((await obligations(m.id)).every((o) => o.status === 'overdue')).toBe(true);

    await pay(m.id, 'savings', KES(1500), { occurredAt: '2026-02-12T09:00:00Z' });
    expect(await finesOutstanding(m.id)).toBe(KES(200)); // unchanged by the savings payment
    expect(await savingsBalance(m.id)).toBe(KES(1500));
  });

  it('holds a fine payment that does not match the selected fines', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-11');
    const fine = (await pool.query('SELECT id FROM fines WHERE member_id = $1', [m.id])).rows[0].id;
    const r = await pay(m.id, 'fine', KES(150), { fineIds: [fine] });
    expect(r.outcome.outcome).toBe('held');
    expect(await finesOutstanding(m.id)).toBe(KES(200));
  });

  it('waiving a fine records a ledger entry, keeps the fine, and requires a reason', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-11');
    const fine = (await pool.query('SELECT id FROM fines WHERE member_id = $1', [m.id])).rows[0].id;
    await expect(withTx((c) => resolveFine(c, fine, 'waiver', '  ', SYSTEM))).rejects.toMatchObject({ status: 400 });
    await withTx((c) => resolveFine(c, fine, 'waiver', 'Hospitalised that week', SYSTEM));
    expect(await finesOutstanding(m.id)).toBe(0);
    const f = (await pool.query('SELECT status, resolution_note FROM fines WHERE id = $1', [fine])).rows[0];
    expect(f).toEqual({ status: 'waived', resolution_note: 'Hospitalised that week' });
    // A waived fine is not re-accrued by the daily job.
    await withTx((c) => accrueLateFines(c, '2026-03-01'));
    expect((await pool.query('SELECT count(*)::int AS n FROM fines')).rows[0].n).toBe(1);
    await expect(withTx((c) => resolveFine(c, fine, 'waiver', 'again please', SYSTEM))).rejects.toMatchObject({ status: 409 });
  });
});

describe('reversals and immutability', () => {
  it('reversing a savings payment appends a reversal, re-opens the month, and keeps the original', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-05');
    const r = await pay(m.id, 'savings', KES(1500));
    await withTx((c) => reversePayment(c, r.id, 'Reversed by Safaricom', SYSTEM));
    expect(await savingsBalance(m.id)).toBe(0);
    expect((await obligations(m.id))[0]).toMatchObject({ status: expect.stringMatching(/unpaid|overdue/), paid_cents: 0 });
    const txns = (await pool.query('SELECT type, amount_cents FROM savings_transactions ORDER BY created_at')).rows;
    expect(txns).toEqual([{ type: 'contribution', amount_cents: KES(1500) }, { type: 'reversal', amount_cents: -KES(1500) }]);
    // The month can be paid again afterwards.
    const again = await pay(m.id, 'savings', KES(1500));
    expect(again.outcome.outcome).toBe('confirmed');
  });

  it('reversing a fine payment restores the outstanding fine', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-11');
    const r = await pay(m.id, 'fine', KES(200));
    expect(await finesOutstanding(m.id)).toBe(0);
    await withTx((c) => reversePayment(c, r.id, 'Chargeback', SYSTEM));
    expect(await finesOutstanding(m.id)).toBe(KES(200));
    expect((await pool.query('SELECT status FROM fines WHERE member_id = $1', [m.id])).rows[0].status).toBe('outstanding');
  });

  it('confirmed ledger rows cannot be edited or deleted, even with direct SQL', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-11');
    const r = await pay(m.id, 'savings', KES(1500));
    await expect(pool.query('UPDATE savings_transactions SET amount_cents = 1 WHERE payment_id = $1', [r.id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM savings_transactions')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM fine_ledger')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    await expect(pool.query('UPDATE payments SET amount_cents = 1 WHERE id = $1', [r.id])).rejects.toThrow(/cannot be altered/);
    await expect(pool.query('DELETE FROM payments')).rejects.toThrow(/cannot be deleted/);
    await expect(pool.query('DELETE FROM members')).rejects.toThrow(/cannot be deleted/);
  });
});

describe('audit trail', () => {
  it('records confirmations and holds', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-05');
    await pay(m.id, 'savings', KES(500));
    await pay(m.id, 'savings', KES(1500));
    const actions = (await pool.query('SELECT action FROM audit_logs ORDER BY id')).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['member.registered', 'obligations.generated', 'payment.held', 'payment.confirmed']));
  });
});
