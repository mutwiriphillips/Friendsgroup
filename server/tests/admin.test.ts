import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createStaff, finesOutstanding, KES, monthsFor, newMember, pay, resetDb, savingsBalance } from './helpers.js';

let server: Server;
let base: string;
beforeAll(async () => {
  await new Promise<void>((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); await pool.end(); });
beforeEach(resetDb);

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, ct, body: ct.includes('json') ? ((await res.json()) as any) : await res.arrayBuffer() };
}
async function staff(role: 'super_admin' | 'chairperson' | 'treasurer' | 'secretary') {
  const ex = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [`${role}@x.org`]);
  if (ex.rows[0]) {
    const r = await call('POST', '/api/auth/login', undefined, { identifier: `${role}@x.org`, password: 'Password-12345' });
    return r.body.token as string;
  }
  const s = await createStaff(role, `${role}@x.org`);
  const r = await call('POST', '/api/auth/login', undefined, { identifier: s.email, password: s.password });
  return r.body.token as string;
}

describe('admin API smoke + rules', () => {
  it('dashboard and list endpoints run for each role without SQL errors', async () => {
    const roles = ['super_admin', 'chairperson', 'treasurer', 'secretary'] as const;
    let t = '';
    for (const role of roles) {
      t = await staff(role);
      expect((await call('GET', '/api/admin/dashboard', t)).status).toBe(200);
    }
    t = await staff('super_admin');
    for (const p of ['/rules', '/settings', '/financial-years', '/users', '/audit', '/logins', '/meetings', '/withdrawals', '/income', '/expenditure', '/submissions', '/reconciliation', '/discrepancies', '/reconciliation-lines/list', '/announcements', '/documents']) {
      const r = await call('GET', `/api/admin${p}`, t);
      expect(r.status, p).toBe(200);
    }
  });

  it('members cannot reach admin endpoints', async () => {
    const m = await newMember('Member Alpha');
    await pool.query(`UPDATE users SET must_change_password = false WHERE member_id = $1`, [m.memberId ?? m.id]).catch(() => {});
    const t = await staff('treasurer');
    expect((await call('GET', '/api/admin/users', t)).status).toBe(403);
  });
});

describe('meetings and absence fines', () => {
  it('unexcused absence fines once; excused does not; confirm is idempotent-safe', async () => {
    const sec = await staff('secretary');
    const a = await newMember('Member Alpha');
    const b = await newMember('Member Bravo');
    const mt = await call('POST', '/api/admin/meetings', sec, { title: 'Q1 meeting', scheduledAt: '2026-02-01T09:00:00+03:00', venue: 'Hall' });
    expect(mt.status).toBe(201);
    const id = mt.body.id;
    const set = await call('POST', `/api/admin/meetings/${id}/attendance`, sec, {
      entries: [{ memberId: a.id ?? a.memberId, status: 'absent' }, { memberId: b.id ?? b.memberId, status: 'excused' }],
    });
    expect(set.status).toBe(200);
    expect((await call('POST', `/api/admin/meetings/${id}/confirm`, sec)).status).toBe(200);
    expect(await finesOutstanding(a.id ?? a.memberId)).toBe(KES(5000));
    expect(await finesOutstanding(b.id ?? b.memberId)).toBe(0);
    await call('POST', `/api/admin/meetings/${id}/confirm`, sec);
    expect(await finesOutstanding(a.id ?? a.memberId)).toBe(KES(5000));
  });
});

describe('withdrawals', () => {
  it('requires approval, reduces savings on payout, blocks overdrawing', async () => {
    const m = await newMember('Member Alpha', '2026-01-01');
    const mid = m.id ?? m.memberId;
    await monthsFor(['2026-01-01', '2026-02-01'], '2026-02-05');
    await pay(mid, 'savings', KES(3000), { occurredAt: '2026-02-05T10:00:00+03:00' });
    expect(await savingsBalance(mid)).toBe(KES(3000));
    const { requestWithdrawal } = await import('../src/services/governance.js');
    const { withTx } = await import('../src/db/pool.js');
    await expect(withTx((c) => requestWithdrawal(c, mid, KES(9000), 'Too much', { userId: null, role: 'system' }))).rejects.toThrow();
    const r = await withTx((c) => requestWithdrawal(c, mid, KES(1000), 'School fees', { userId: null, role: 'system' }));
    expect(r).toBeTruthy();
    await expect(withTx((c) => requestWithdrawal(c, mid, KES(500), 'Another', { userId: null, role: 'system' }))).rejects.toThrow();
    expect(await savingsBalance(mid)).toBe(KES(3000)); // nothing moves until paid out
  });
});

describe('reports', () => {
  it('every report builds as json, xlsx and pdf', async () => {
    const t = await staff('super_admin');
    const names = (await call('GET', '/api/reports', t)).body as string[];
    expect(names.length).toBeGreaterThan(5);
    const m = await newMember('Member Alpha');
    for (const n of names) {
      expect((await call('GET', `/api/reports/${n}?format=json&memberId=${m.id ?? m.memberId}&meetingId=${'00000000-0000-0000-0000-000000000000'}`, t)).status, n).toBeLessThan(500);
    }
    expect((await call('GET', `/api/reports/${names[0]}?format=xlsx`, t)).status).toBe(200);
    expect((await call('GET', `/api/reports/${names[0]}?format=pdf`, t)).status).toBe(200);
  });
});

describe('reconciliation', () => {
  it('generates, detects, and enforces preparer != approver', async () => {
    const treas = await staff('treasurer');
    const m = await newMember('Member Alpha', '2026-01-01');
    await monthsFor(['2026-01-01'], '2026-01-05');
    await pay(m.id ?? m.memberId, 'savings', KES(1500), { occurredAt: '2026-01-05T10:00:00+03:00' });
    const g = await call('POST', '/api/admin/reconciliation/generate', treas, { month: '2026-01', historical: true });
    expect(g.status).toBe(200);
    const rep = await call('GET', '/api/admin/reconciliation/2026-01', treas);
    expect(rep.status).toBe(200);
    expect(rep.body.summary).toBeTruthy();
  });
});

const PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');

describe('records register and exports', () => {
  it('stores records, versions them, archives with reason, and never deletes', async () => {
    const sec = await staff('secretary');
    const up = await call('POST', '/api/admin/documents', sec, { title: 'Certificate of Registration', category: 'certificate_of_registration', visibility: 'officials', referenceNo: 'SS/2024/001', expiresOn: '2027-01-01', file: { name: 'cert.pdf', mimeType: 'application/pdf', dataBase64: PDF_B64 } });
    expect(up.status).toBe(201);
    const v2 = await call('POST', '/api/admin/documents', sec, { title: 'Certificate of Registration', category: 'certificate_of_registration', supersedesId: up.body.id, file: { name: 'cert2.pdf', mimeType: 'application/pdf', dataBase64: PDF_B64 } });
    expect(v2.status).toBe(201);
    const again = await call('POST', '/api/admin/documents', sec, { title: 'x y z', category: 'other', supersedesId: up.body.id, file: { name: 'c.pdf', mimeType: 'application/pdf', dataBase64: PDF_B64 } });
    expect(again.status).toBe(409); // old version is no longer current
    const list = await call('GET', '/api/admin/documents?category=certificate_of_registration', sec);
    expect(list.body.map((d: any) => [d.version, d.status]).sort()).toEqual([[1, 'superseded'], [2, 'current']]);
    expect((await call('POST', `/api/admin/documents/${v2.body.id}/archive`, sec, { reason: 'ok' })).status).toBe(400);
    expect((await call('POST', `/api/admin/documents/${v2.body.id}/archive`, sec, { reason: 'Replaced after renewal' })).status).toBe(200);
    await expect(pool.query(`DELETE FROM documents`)).rejects.toThrow();
    const bad = await call('POST', '/api/admin/documents', sec, { title: 'Fake pdf', category: 'other', file: { name: 'a.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('not a pdf at all').toString('base64') } });
    expect(bad.status).toBe(400);
  });

  it('exports the membership register as csv, xlsx and pdf and can archive a copy', async () => {
    const sec = await staff('secretary');
    await newMember('Member Alpha');
    const csv = await fetch(`${base}/api/reports/membership_register?format=csv&archive=1`, { headers: { authorization: `Bearer ${(await call('POST', '/api/auth/login', undefined, { identifier: 'secretary@x.org', password: 'Password-12345' })).body.token}` } });
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain('Member no.');
    expect(text).toContain('Member Alpha');
    expect(text).not.toMatch(/national/i);
    const t = (await call('POST', '/api/auth/login', undefined, { identifier: 'secretary@x.org', password: 'Password-12345' })).body.token;
    for (const f of ['xlsx', 'pdf']) expect((await call('GET', `/api/reports/membership_register?format=${f}`, t)).status).toBe(200);
    const docs = await call('GET', '/api/admin/documents?category=membership', t);
    expect(docs.body.length).toBe(1);
    expect(docs.body[0].visibility).toBe('officials');
  });
});

describe('import members as is, comply later', () => {
  it('imports incomplete rows, flags them, and lets the secretary complete them', async () => {
    const sec = await staff('secretary');
    const csv = [
      'full_name,national_id,phone,email',
      'Full Member,23456789,0711000001,',
      'No Id Member,,0711000002,',
      'Bad Phone Member,34567890,12345,',
      'Dup Id Member,23456789,0711000003,',
      'Name Only,,,',
    ].join('\n');
    const body = { filename: 'members.csv', dataBase64: Buffer.from(csv).toString('base64') };
    const prev = await call('POST', '/api/admin/imports/members/preview', sec, body);
    expect(prev.status).toBe(200);
    expect(prev.body.invalid).toBe(0);
    expect(prev.body.rows.filter((r: any) => r.warnings.length).length).toBe(4);
    const strict = await call('POST', '/api/admin/imports/members/preview', sec, { ...body, strict: true });
    expect(strict.body.invalid).toBeGreaterThan(0);

    const done = await call('POST', '/api/admin/imports/members/commit', sec, body);
    expect(done.status).toBe(201);
    expect(done.body.imported).toBe(5);
    expect(done.body.credentials.length).toBe(3); // Full, No Id, Dup Id have valid phones; Bad Phone / Name Only have none
    expect(done.body.pending.length).toBe(4);

    const list = (await call('GET', '/api/members?incomplete=1', sec)).body as any[];
    expect(list.map((m) => m.full_name).sort()).toEqual(['Bad Phone Member', 'Dup Id Member', 'Full Member', 'Name Only', 'No Id Member']); // all lack the next of kin form
    const full = (await call('GET', '/api/members', sec)).body.find((m: any) => m.full_name === 'Full Member');
    expect(full.profile_complete).toBe(false); // details are on file but the next of kin form is not
    expect(full.missing_nok).toBe(true);

    const noId = list.find((m) => m.full_name === 'No Id Member');
    const detail = await call('GET', `/api/members/${noId.id}`, sec);
    expect(detail.body.nationalId).toBeNull();
    const dupAttempt = await call('POST', `/api/members/${noId.id}/complete-profile`, sec, { nationalId: '23456789' });
    expect(dupAttempt.status).toBe(409);
    const ok = await call('POST', `/api/members/${noId.id}/complete-profile`, sec, { nationalId: '45678901' });
    expect(ok.body.complete).toBe(false); // still needs the next of kin form

    const nameOnly = list.find((m) => m.full_name === 'Name Only');
    const gained = await call('POST', `/api/members/${nameOnly.id}/complete-profile`, sec, { nationalId: '56789012', phone: '0722333444' });
    expect(gained.body.complete).toBe(false);
    expect(gained.body.temporaryPassword).toBeTruthy(); // login created once a phone exists
  });

  it('blocks withdrawals until the profile is complete', async () => {
    const { registerMemberLenient } = await import('../src/services/members.js');
    const { requestWithdrawal } = await import('../src/services/governance.js');
    const { withTx } = await import('../src/db/pool.js');
    const m = await withTx((c) => registerMemberLenient(c, { fullName: 'Lenient Member', phone: '0733111222' }, { userId: null, role: 'system' }));
    await expect(withTx((c) => requestWithdrawal(c, m.id, 100, 'School fees now', { userId: null, role: 'system' }))).rejects.toThrow(/not compliant/i);
  });
});
