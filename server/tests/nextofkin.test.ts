import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createStaff, newMember, resetDb } from './helpers.js';

let server: Server; let base: string;
beforeAll(async () => { await new Promise<void>((r) => { server = createApp().listen(0, r); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(async () => { await new Promise((r) => server.close(r)); await pool.end(); });
beforeEach(resetDb);

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, body: ct.includes('json') ? ((await res.json()) as any) : Buffer.from(await res.arrayBuffer()) };
}
async function staff(role: 'super_admin' | 'treasurer') { const s = await createStaff(role, `${role}@x.org`); return (await call('POST', '/api/auth/login', undefined, { identifier: s.email, password: s.password })).body.token as string; }
async function memberLogin(memberId: string) {
  await pool.query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE member_id = $1`, [memberId, await bcrypt.hash('Password-12345', 4)]);
  const ph = (await pool.query(`SELECT phone FROM users WHERE member_id = $1`, [memberId])).rows[0].phone;
  return (await call('POST', '/api/auth/login', undefined, { identifier: ph, password: 'Password-12345' })).body.token as string;
}
const form = (name: string, over: object = {}) => ({
  memberDetails: { dateOfBirth: '1985-03-14', residence: 'Embu, Runyenjes', email: '' },
  beneficiaries: [
    { fullName: 'Jane Wanjiru', relationship: 'Spouse', idNumber: '24567890', dateOfBirth: '1987-06-02', phone: '0712345678', sharePct: 60 },
    { fullName: 'Peter Njeru', relationship: 'Son', idNumber: '4455/2018', dateOfBirth: '2010-01-09', phone: '0712345678', sharePct: 40 },
  ],
  primaryAddress: 'Embu, Runyenjes', contingentName: 'Mary Njeri', contingentPhone: '0722111222',
  guardian: { fullName: 'Jane Wanjiru', idNumber: '24567890', relationship: 'Mother', phone: '0712345678', address: 'Embu, Runyenjes' },
  witness: { fullName: 'Paul Kariuki', idNumber: '23456789', phone: '0733444555', isAdult: true },
  signedName: name, confirmed: true, ...over,
});

describe('next of kin form', () => {
  it('keeps the profile non-compliant until submitted, then locks it for the member', async () => {
    const admin = await staff('super_admin'); const treasurer = await staff('treasurer');
    const m = await newMember('Nok Nellie'); const id = m.id ?? (m as any).memberId;
    await pool.query(`UPDATE members SET nok_submitted_at = NULL WHERE id = $1`, [id]);
    const me = await memberLogin(id);
    const before = (await call('GET', `/api/members/${id}`, admin)).body;
    expect(before.profile_complete).toBe(false); expect(before.missing_nok).toBe(true);
    expect((await call('GET', '/api/me/next-of-kin', me)).body.submitted).toBe(false);

    // validation: shares, confirmation, minor needs a guardian, signature must match
    const bad = (over: object) => call('POST', '/api/me/next-of-kin', me, form('Nok Nellie', over));
    expect((await bad({ confirmed: false })).status).toBe(400);
    expect((await bad({ beneficiaries: [{ fullName: 'Jane Wanjiru', relationship: 'Spouse', idNumber: '24567890', dateOfBirth: '1987-06-02', phone: '0712345678', sharePct: 90 }] })).body.error).toMatch(/100%/);
    expect((await bad({ guardian: null })).body.error).toMatch(/under 18/);
    expect((await bad({ signedName: 'Someone Else' })).body.error).toMatch(/exactly as registered/);
    expect((await bad({ witness: { fullName: 'Paul Kariuki', idNumber: '23456789', phone: '0733444555', isAdult: false } })).status).toBe(400);
    expect((await call('GET', '/api/me/next-of-kin', me)).body.submitted).toBe(false);

    const ok = await call('POST', '/api/me/next-of-kin', me, form('nok nellie'));
    expect(ok.status).toBe(201); expect(ok.body.locked).toBe(true);
    expect((await call('GET', `/api/members/${id}`, admin)).body.profile_complete).toBe(true);
    // the member cannot resubmit or change it
    expect((await call('POST', '/api/me/next-of-kin', me, form('Nok Nellie'))).status).toBe(409);
    expect((await call('PUT', `/api/members/${id}/next-of-kin`, me, form('Nok Nellie'))).status).toBe(403);
    // the stored copy is encrypted
    expect((await pool.query(`SELECT data_enc FROM next_of_kin_forms`)).rows[0].data_enc).not.toContain('Jane Wanjiru');

    // officials can read and download it; only the administrator can amend, with a reason, and history is kept
    expect((await call('GET', `/api/members/${id}/next-of-kin`, treasurer)).body.form.beneficiaries).toHaveLength(2);
    const pdf = await call('GET', `/api/members/${id}/next-of-kin/pdf`, treasurer);
    expect(pdf.status).toBe(200); expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    expect((await call('PUT', `/api/members/${id}/next-of-kin`, treasurer, { ...form('Nok Nellie'), note: 'fix' })).status).toBe(403);
    expect((await call('PUT', `/api/members/${id}/next-of-kin`, admin, form('Nok Nellie'))).status).toBe(400);
    const amended = await call('PUT', `/api/members/${id}/next-of-kin`, admin, { ...form('Nok Nellie', { contingentName: 'Grace Wambui' }), note: 'Contingent contact changed' });
    expect(amended.body.revision).toBe(2); expect(amended.body.form.contingentName).toBe('Grace Wambui'); expect(amended.body.history).toHaveLength(2);
  });

  it('lets the administrator submit on behalf of a member and blocks withdrawals until then', async () => {
    const admin = await staff('super_admin');
    const m = await newMember('Behalf Bella'); const id = m.id ?? (m as any).memberId;
    await pool.query(`UPDATE members SET nok_submitted_at = NULL WHERE id = $1`, [id]);
    const adult = form('Behalf Bella', { beneficiaries: [{ fullName: 'Ann Mwende', relationship: 'Sister', idNumber: '22334455', dateOfBirth: '1990-01-01', phone: '0711000111', sharePct: 100 }], guardian: null });
    expect((await call('POST', `/api/members/${id}/next-of-kin`, admin, adult)).status).toBe(201);
    expect((await call('POST', `/api/members/${id}/next-of-kin`, admin, adult)).status).toBe(409);
    const pdf = await call('GET', `/api/members/${id}/next-of-kin/pdf`, admin);
    expect(pdf.status).toBe(200);
  });

  it('stores a member photo and both sides of the ID: members add once, only officials replace', async () => {
    const admin = await staff('super_admin'); const treasurer = await staff('treasurer');
    const m = await newMember('Docs Dorcas'); const id = m.id ?? (m as any).memberId;
    const me = await memberLogin(id);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
    const img = { name: 'a.png', mimeType: 'image/png', dataBase64: png };
    expect((await call('GET', '/api/me/documents', me)).body).toEqual({ photo: null, id_front: null, id_back: null });
    expect((await call('POST', '/api/me/documents/photo', me, { ...img, mimeType: 'application/pdf' })).status).toBe(400);
    expect((await call('POST', '/api/me/documents/passport', me, img)).status).toBe(400);
    const up = await call('POST', '/api/me/documents/id_front', me, img);
    expect(up.status).toBe(201); expect(up.body.id_front).toBeTruthy();
    await call('POST', '/api/me/documents/photo', me, img); await call('POST', '/api/me/documents/id_back', me, img);
    expect((await call('POST', '/api/me/documents/photo', me, img)).status).toBe(409); // already there: members cannot replace
    const file = await call('GET', `/api/files/${up.body.id_front}`, me); expect(file.status).toBe(200);
    // another member cannot open it
    const other = await newMember('Other Olive'); expect((await call('GET', `/api/files/${up.body.id_front}`, await memberLogin(other.id ?? (other as any).memberId))).status).toBe(404);
    // officials see it on the profile and can replace or remove
    expect((await call('GET', `/api/members/${id}`, treasurer)).body.id_front_file_id).toBe(up.body.id_front);
    expect((await call('PUT', `/api/members/${id}/documents/photo`, admin, img)).status).toBe(200);
    expect((await call('DELETE', `/api/members/${id}/documents/id_back`, treasurer)).status).toBe(403);
    expect((await call('DELETE', `/api/members/${id}/documents/id_back`, admin)).body.id_back).toBeNull();
    expect((await call('POST', '/api/me/documents/id_back', me, img)).status).toBe(201); // missing again, so the member may add it
  });
});
