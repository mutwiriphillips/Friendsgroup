import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool, withTx } from '../src/db/pool.js';
import { registerMember, registerMemberSchema } from '../src/services/members.js';
import { SYSTEM, createStaff, monthsFor, newMember, pay, resetDb, KES } from './helpers.js';

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});
beforeEach(resetDb);

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}
async function login(identifier: string, password: string) {
  const r = await call('POST', '/api/auth/login', undefined, { identifier, password });
  return r.body.token as string;
}

describe('authentication', () => {
  it('rejects requests without a token and bad credentials', async () => {
    expect((await call('GET', '/api/members')).status).toBe(401);
    await createStaff('treasurer', 't@example.com');
    expect((await call('POST', '/api/auth/login', undefined, { identifier: 't@example.com', password: 'wrong-password' })).status).toBe(401);
  });

  it('locks the account after repeated failures, then refuses even the right password', async () => {
    await createStaff('treasurer', 'lock@example.com');
    for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', undefined, { identifier: 'lock@example.com', password: 'nope-nope-nope' });
    const r = await call('POST', '/api/auth/login', undefined, { identifier: 'lock@example.com', password: 'Password-12345' });
    expect(r.status).toBe(423);
  });

  it('records login activity', async () => {
    await createStaff('chairperson', 'c@example.com');
    await login('c@example.com', 'Password-12345');
    const { rows } = await pool.query(`SELECT success FROM login_activity WHERE identifier = 'c@example.com'`);
    expect(rows).toEqual([{ success: true }]);
  });

  it('a deactivated user is refused immediately even with a valid token', async () => {
    const u = await createStaff('secretary', 's@example.com');
    const token = await login('s@example.com', 'Password-12345');
    expect((await call('GET', '/api/members', token)).status).toBe(200);
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [u.id]);
    expect((await call('GET', '/api/members', token)).status).toBe(401);
  });
});

describe('role-based permissions are enforced by the backend', () => {
  it('secretary can register members; treasurer and chairperson cannot', async () => {
    await createStaff('secretary', 'sec@example.com');
    await createStaff('treasurer', 'tre@example.com');
    await createStaff('chairperson', 'cha@example.com');
    const body = { fullName: 'New Member', nationalId: '31234567', phone: '0722000111' };
    expect((await call('POST', '/api/members', await login('tre@example.com', 'Password-12345'), body)).status).toBe(403);
    expect((await call('POST', '/api/members', await login('cha@example.com', 'Password-12345'), body)).status).toBe(403);
    const ok = await call('POST', '/api/members', await login('sec@example.com', 'Password-12345'), body);
    expect(ok.status).toBe(201);
    expect(ok.body.membershipNo).toMatch(/^MBR-/);
    expect(typeof ok.body.temporaryPassword).toBe('string');
    // duplicate National ID is refused
    const dup = await call('POST', '/api/members', await login('sec@example.com', 'Password-12345'), { ...body, phone: '0722000999' });
    expect(dup.status).toBe(409);
  });

  it('only the treasurer (or super admin) can record payments; only chair/super admin can waive fines', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01'], '2026-01-11');
    await createStaff('secretary', 'sec@example.com');
    await createStaff('treasurer', 'tre@example.com');
    await createStaff('chairperson', 'cha@example.com');
    const payment = { memberId: m.id, purpose: 'savings', amountCents: KES(1500), mpesaReceipt: 'RKT1234567', paidAt: '2026-01-09T09:00:00Z' };
    expect((await call('POST', '/api/finance/payments/manual', await login('sec@example.com', 'Password-12345'), payment)).status).toBe(403);
    const ok = await call('POST', '/api/finance/payments/manual', await login('tre@example.com', 'Password-12345'), payment);
    expect(ok.status).toBe(201);
    // the same M-Pesa code cannot be recorded twice
    expect((await call('POST', '/api/finance/payments/manual', await login('tre@example.com', 'Password-12345'), payment)).status).toBe(409);

    const fine = (await pool.query('SELECT id FROM fines WHERE member_id = $1', [m.id])).rows[0].id;
    const waive = { kind: 'waiver', reason: 'Approved by committee' };
    expect((await call('POST', `/api/finance/fines/${fine}/resolve`, await login('tre@example.com', 'Password-12345'), waive)).status).toBe(403);
    expect((await call('POST', `/api/finance/fines/${fine}/resolve`, await login('cha@example.com', 'Password-12345'), waive)).status).toBe(200);
  });

  it('members cannot reach official endpoints', async () => {
    const m = await newMember();
    const token = await login(m.phone, m.temporaryPassword);
    expect(token).toBeTruthy();
    for (const path of ['/api/members', '/api/finance/payments', '/api/finance/fines']) {
      expect((await call('GET', path, token)).status).toBe(403);
    }
    expect((await call('POST', '/api/finance/obligations/generate', token, { period: '2026-01' })).status).toBe(403);
  });

  it('officials without a member profile cannot use member endpoints', async () => {
    await createStaff('treasurer', 'tre@example.com');
    expect((await call('GET', '/api/me/summary', await login('tre@example.com', 'Password-12345'))).status).toBe(403);
  });
});

describe('member data isolation', () => {
  it("a member sees their own two ledgers and cannot open another member's receipt", async () => {
    const a = await newMember('Alice');
    const b = await newMember('Bob');
    await monthsFor(['2026-01-01'], '2026-01-11');
    const pa = await pay(a.id, 'savings', KES(1500), { occurredAt: '2026-01-12T09:00:00Z' });
    const pb = await pay(b.id, 'savings', KES(1500), { occurredAt: '2026-01-12T09:00:00Z' });

    const tokenA = await login(a.phone, a.temporaryPassword);
    const summary = await call('GET', '/api/me/summary', tokenA);
    expect(summary.status).toBe(200);
    expect(summary.body.savings.balanceCents).toBe(KES(1500));
    expect(summary.body.fines.outstandingCents).toBe(KES(200)); // fines shown separately from savings
    expect(summary.body.savings.outstandingCents).toBe(0);

    expect((await call('GET', `/api/me/payments/${pa.id}/receipt`, tokenA)).status).toBe(200);
    expect((await call('GET', `/api/me/payments/${pb.id}/receipt`, tokenA)).status).toBe(404);

    const ledger = await call('GET', '/api/me/savings-ledger', tokenA);
    expect(ledger.body).toHaveLength(1);
  });

  it('National ID is never returned in member lists and is decrypted only on audited detail views', async () => {
    await createStaff('secretary', 'sec@example.com');
    const created = await withTx((c) => registerMember(c, registerMemberSchema.parse({ fullName: 'Id Check', nationalId: '29876543', phone: '0733000111' }), SYSTEM));
    const token = await login('sec@example.com', 'Password-12345');
    const list = await call('GET', '/api/members', token);
    expect(JSON.stringify(list.body)).not.toContain('29876543');
    const detail = await call('GET', `/api/members/${created.id}`, token);
    expect(detail.body.nationalId).toBe('29876543');
    const { rows } = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'member.national_id_viewed'`);
    expect(rows).toHaveLength(1);
  });
});
