import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createStaff, resetDb } from './helpers.js';

let server: Server;
let base: string;
beforeAll(async () => { await new Promise<void>((r) => { server = createApp().listen(0, r); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(async () => { await new Promise((r) => server.close(r)); await pool.end(); });
beforeEach(resetDb);

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, body: ct.includes('json') ? ((await res.json()) as any) : await res.arrayBuffer() };
}
async function login(role: 'super_admin' | 'chairperson' | 'treasurer' | 'secretary') {
  const s = await createStaff(role, `${role}@x.org`);
  return (await call('POST', '/api/auth/login', undefined, { identifier: s.email, password: s.password })).body.token as string;
}

/** A small workbook in the same layout as the group's sheet (merged month headers, single-column months, meeting penalties). */
async function sheet(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('June 26');
  ws.getCell('A1').value = 'Member Name';
  ws.getCell('B1').value = 'Jan 2026'; ws.mergeCells('B1:C1'); ws.getCell('B2').value = 'Cont'; ws.getCell('C2').value = 'Fine';
  ws.getCell('D1').value = 'Feb 2026'; ws.mergeCells('D1:E1'); ws.getCell('D2').value = 'Cont'; ws.getCell('E2').value = 'Fine';
  ws.getCell('F1').value = 'Meeting Absenteeism Penalty'; ws.mergeCells('F1:G1'); ws.getCell('F2').value = '26th July 2025 Nanyuki'; ws.getCell('G2').value = '28th feb 26 Sagana';
  ws.getCell('H1').value = new Date(Date.UTC(2026, 4, 1)); ws.getCell('H2').value = 'Cont';
  ws.getCell('I1').value = 'Year arrears';
  ws.getCell('A3').value = 'Alice Wanjiku'; ws.getCell('B3').value = 1500; ws.getCell('C3').value = 200; ws.getCell('D3').value = 1500; ws.getCell('F3').value = -2000; ws.getCell('H3').value = 1500; ws.getCell('I3').value = -2000;
  ws.getCell('A4').value = 'Brian Otieno'; ws.getCell('B4').value = 1500; ws.getCell('D4').value = 2000; ws.getCell('G4').value = 5000; ws.getCell('H4').value = 1500;
  ws.getCell('A7').value = 'Total'; // no totals row numbers: skipped
  ws.getCell('A8').value = 'Expenses'; ws.getCell('A9').value = 'Account opening deposit'; ws.getCell('D9').value = 2000;
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

describe('ledger grid (the group sheet)', () => {
  it('previews, imports, shows the grid, and logs every cell edit', async () => {
    const t = await login('treasurer');
    const secretary = await login('secretary');
    const payload = { filename: 'Friends_group_1.xlsx', dataBase64: await sheet() };

    const pv = await call('POST', '/api/admin/ledger-grid/import/preview', t, payload);
    expect(pv.status).toBe(200);
    expect(pv.body.members.total).toBe(2);
    expect(pv.body.contributions.count).toBe(6);
    expect(pv.body.lateFines.paid).toBe(1);
    expect(pv.body.meetings).toHaveLength(2);
    expect(pv.body.expenses).toHaveLength(1);
    expect(pv.body.meetings[1].date).toBe('2026-02-28');
    expect(pv.body.warnings.join(' ')).toMatch(/2,000/);
    expect((await call('POST', '/api/admin/ledger-grid/import/commit', secretary, payload)).status).toBe(403);

    const done = await call('POST', '/api/admin/ledger-grid/import/commit', t, payload);
    expect(done.status).toBe(201);
    expect(done.body.newMembers).toBe(2);
    // second load is refused
    expect((await call('POST', '/api/admin/ledger-grid/import/commit', t, payload)).status).toBe(409);

    const g = (await call('GET', '/api/admin/ledger-grid', t)).body;
    expect(g.months).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01']);
    expect(g.canEdit).toBe(true);
    const alice = g.rows.find((r: any) => r.name === 'Alice Wanjiku');
    const brian = g.rows.find((r: any) => r.name === 'Brian Otieno');
    expect(alice.cont['2026-01-01']).toBe(150000);
    expect(alice.fine['2026-01-01']).toEqual({ cents: 20000, paid: true });
    expect(alice.totals.arrearsCents).toBe(200000);
    expect(brian.totals.arrearsCents).toBe(0);
    expect(brian.totals.finesPaidCents).toBe(500000);
    expect(g.expenses).toHaveLength(1);
    // members arrive pending compliance, no logins
    expect(alice.profileComplete).toBe(false);
    const meetingNanyuki = g.meetings[0].id;

    const edit = (b: object) => call('POST', '/api/admin/ledger-grid/cell', t, b);
    // reason is mandatory
    expect((await edit({ memberId: alice.id, kind: 'cont', period: '2026-02-01', value: 1000, reason: '' })).status).toBe(400);
    // contribution corrected 1500 -> 1000: a correcting entry, never an update
    const before = Number((await pool.query(`SELECT count(*) FROM savings_transactions WHERE member_id = $1`, [alice.id])).rows[0].count);
    expect((await edit({ memberId: alice.id, kind: 'cont', period: '2026-02-01', value: 1000, reason: 'Receipt shows 1,000' })).body.changed).toBe(true);
    const after = Number((await pool.query(`SELECT count(*) FROM savings_transactions WHERE member_id = $1`, [alice.id])).rows[0].count);
    expect(after).toBe(before + 1);
    // fill an empty cell, then clear it
    await edit({ memberId: brian.id, kind: 'cont', period: '2026-03-01', value: 1500, reason: 'Late entry from the March register' });
    await edit({ memberId: brian.id, kind: 'cont', period: '2026-03-01', value: 0, reason: 'Entered on the wrong row' });
    const g2 = (await call('GET', '/api/admin/ledger-grid', t)).body;
    const a2 = g2.rows.find((r: any) => r.name === 'Alice Wanjiku');
    const b2 = g2.rows.find((r: any) => r.name === 'Brian Otieno');
    expect(a2.cont['2026-02-01']).toBe(100000);
    expect(b2.cont['2026-03-01']).toBe(0);
    expect(a2.totals.contributionsCents).toBe(150000 + 100000 + 150000);

    // meeting penalty: unpaid -> paid (payment recorded), then amount changed (old fine reversed, new one created)
    expect((await edit({ memberId: alice.id, kind: 'meeting', meetingId: meetingNanyuki, value: 2000, reason: 'Paid in cash at the next meeting' })).body.changed).toBe(true);
    let row = (await call('GET', '/api/admin/ledger-grid', t)).body.rows.find((r: any) => r.name === 'Alice Wanjiku');
    expect(row.meet[meetingNanyuki]).toEqual({ cents: 200000, paid: true });
    expect(row.totals.arrearsCents).toBe(0);
    await edit({ memberId: alice.id, kind: 'meeting', meetingId: meetingNanyuki, value: -1000, reason: 'Penalty reduced by resolution' });
    row = (await call('GET', '/api/admin/ledger-grid', t)).body.rows.find((r: any) => r.name === 'Alice Wanjiku');
    expect(row.meet[meetingNanyuki]).toEqual({ cents: 100000, paid: false });
    expect(row.totals.arrearsCents).toBe(100000);
    // the fines ledger for Alice still adds up to what is outstanding, and nothing was deleted
    const ledger = Number((await pool.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM fine_ledger WHERE member_id = $1`, [alice.id])).rows[0].s);
    expect(ledger).toBe(100000);
    // add a late fine in an empty cell
    await edit({ memberId: brian.id, kind: 'fine', period: '2026-02-01', value: -200, reason: 'Paid after the 10th' });
    const b3 = (await call('GET', '/api/admin/ledger-grid', t)).body.rows.find((r: any) => r.name === 'Brian Otieno');
    expect(b3.fine['2026-02-01']).toEqual({ cents: 20000, paid: false });
    // every change is in the audit trail with its reason and old/new values
    const audits = (await pool.query(`SELECT reason, before, after FROM audit_logs WHERE action = 'ledger.cell_edited' ORDER BY id`)).rows;
    expect(audits.length).toBe(6);
    expect(audits[0].reason).toBe('Receipt shows 1,000');
    expect(audits[0].before.cents).toBe(150000);
    expect(audits[0].after.cents).toBe(100000);
    // secretary can read but not edit
    expect((await call('GET', '/api/admin/ledger-grid', secretary)).body.canEdit).toBe(false);
    expect((await call('POST', '/api/admin/ledger-grid/cell', secretary, { memberId: alice.id, kind: 'cont', period: '2026-02-01', value: 1, reason: 'test' })).status).toBe(403);
    // sheet-layout export
    const x = await fetch(`${base}/api/admin/ledger-grid/export`, { headers: { authorization: `Bearer ${t}` } });
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()) as never);
    expect(wb.worksheets[0]!.getCell('A7').value).toBe('Alice Wanjiku');
  });
});

describe('member import header aliases', () => {
  it('accepts "Member Name" as the full name column', async () => {
    const t = await login('secretary');
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('S');
    ws.addRow(['Member Name', 'Jan 2026']); ws.addRow(['Zed Zulu', 1500]);
    const dataBase64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const r = await call('POST', '/api/admin/imports/members/preview', t, { filename: 'a.xlsx', dataBase64 });
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(1);
  });
});

describe('group sheet kept and shown as it is', () => {
  it('stores the workbook as a versioned record and renders cells, merges and styles', async () => {
    const sec = await login('secretary'); const t = await login('treasurer');
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('June 26');
    ws.getCell('A1').value = 'Member Name'; ws.getCell('B1').value = 'Jan 2026'; ws.mergeCells('B1:C1'); ws.getCell('B1').font = { bold: true };
    ws.getCell('B2').value = 'Cont'; ws.getCell('C2').value = 'Fine';
    ws.getCell('A3').value = 'Alice'; ws.getCell('B3').value = 1500; ws.getCell('C3').value = -200;
    ws.getCell('B4').value = { formula: 'B3*2', result: 3000 };
    const dataBase64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const up = (title: string, extra = {}) => call('POST', '/api/admin/documents', sec, { title, category: 'group_sheet', visibility: 'officials', file: { name: 'Friends_group_1.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dataBase64 }, ...extra });
    const first = await up('Group sheet (Excel)');
    expect(first.body).not.toHaveProperty('error');
    expect(first.status).toBe(201);
    const v = (await call('GET', '/api/admin/group-sheet', t)).body;
    const s = v.sheets[0];
    expect(s.name).toBe('June 26');
    expect(s.rows[0].cells[0].t).toBe('Member Name');
    expect(s.rows[0].cells[1]).toMatchObject({ t: 'Jan 2026', b: true, cs: 2 });
    expect(s.rows[0].cells[2]).toBeNull();
    expect(s.rows[2].cells[2].t).toBe('-200');
    expect(s.rows[3].cells[1].t).toBe('3000');
    const second = await up('Group sheet (Excel)', { supersedesId: first.body.id });
    expect(second.status).toBe(201);
    const v2 = (await call('GET', '/api/admin/group-sheet', t)).body;
    expect(v2.versions).toHaveLength(2);
    expect(v2.document.version).toBe(2);
    expect((await call('GET', '/api/admin/group-sheet', await login('super_admin'))).status).toBe(200);
  });
});

describe('sheet view dates', () => {
  it('shows dates as the sheet formats them', async () => {
    const { renderWorkbook } = await import('../src/services/sheetview.js');
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = new Date(Date.UTC(2024, 9, 1)); ws.getCell('A1').numFmt = 'mmm yyyy';
    ws.getCell('B1').value = new Date(Date.UTC(2026, 3, 1));
    const v = await renderWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(v[0]!.rows[0]!.cells[0]!.t).toBe('Oct 2024');
    expect(v[0]!.rows[0]!.cells[1]!.t).toBe('01/April/2026');
  });
});

const MSG = 'SJK3L8XQ4P Confirmed. Ksh paid to Friends Self Help Group';
async function newMember(no: string, name: string) {
  return (await pool.query(`INSERT INTO members (membership_no, full_name, national_id_enc, national_id_hash, phone, mpesa_phone, registered_on) VALUES ($1,$2,'x',$3,$4,$4,'2025-01-01') RETURNING id`, [no, name, 'h' + no, '2547' + no.slice(-8).padStart(8, '0')])).rows[0].id as string;
}
const idsOf = (inv: any[], kind: string, month?: string) => inv.filter((i) => i.kind === kind && (!month || i.month === month)).map((i) => i.id as string);

describe('invoices and manual payments (administrator approves what each payment pays)', () => {
  it('posting money pays nothing by itself; the administrator chooses the invoices, whole ones only', async () => {
    const admin = await login('super_admin'); const treasurer = await login('treasurer'); const chair = await login('chairperson');
    const m = await newMember('MBR-9001', 'Invoice Mary');
    const meeting = (await call('POST', '/api/admin/meetings', await login('secretary'), { title: 'Sagana meeting', scheduledAt: '2026-02-28T10:00:00+03:00', venue: 'Sagana' })).body.id as string;
    const raise = (tok: string, b: object) => call('POST', '/api/admin/invoices', tok, { memberId: m, ...b });
    expect((await raise(treasurer, { kind: 'contribution', period: '2026-01-01' })).status).toBe(403);
    expect((await raise(chair, { kind: 'contribution', period: '2026-01-01' })).status).toBe(403);
    expect((await raise(admin, { kind: 'contribution', period: '2026-01-01', lateFineApplies: false })).status).toBe(201);
    expect((await raise(admin, { kind: 'late_fine', period: '2026-01-01' })).status).toBe(201);
    expect((await raise(admin, { kind: 'late_fine', period: '2026-01-01' })).status).toBe(409);
    expect((await raise(admin, { kind: 'contribution', period: '2026-02-01', lateFineApplies: false })).status).toBe(201);
    expect((await raise(admin, { kind: 'contribution', period: '2026-02-01' })).status).toBe(409);
    expect((await raise(admin, { kind: 'meeting_fine', meetingId: meeting })).status).toBe(201);
    let owed = (await call('GET', `/api/admin/members/${m}/invoices`, treasurer)).body;
    expect(owed.totalCents).toBe(150000 + 20000 + 150000 + 500000);

    const pay = (tok: string, b: object) => call('POST', '/api/admin/manual-payments', tok, { memberId: m, message: MSG, paidOn: '2026-03-03', ...b });
    expect((await pay(treasurer, { amountKsh: 1500, mpesaCode: 'AAA1111111' })).status).toBe(403);
    // 4,500 is posted: nothing is paid, the money waits
    const p1 = await pay(admin, { amountKsh: 4500, mpesaCode: 'POST1AAAA1' });
    expect(p1.status).toBe(201);
    expect(p1.body.receivedCents).toBe(450000);
    owed = (await call('GET', `/api/admin/members/${m}/invoices`, admin)).body;
    expect(owed.totalCents).toBe(820000);
    expect(owed.creditCents).toBe(450000);
    expect(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM savings_transactions WHERE member_id = $1`, [m])).rows[0].n)).toBe(0);
    expect((await pay(admin, { amountKsh: 1500, mpesaCode: 'POST1AAAA1' })).status).toBe(409);
    const held = (await call('GET', `/api/admin/members/${m}/credit`, admin)).body;
    expect(held.payments).toHaveLength(1);
    const mp = held.payments[0].id as string;

    // the administrator skips January and pays February's contribution and the meeting fine only
    const inv = owed.invoices;
    const alloc = (tok: string, b: object, path = '/api/admin/allocations') => call('POST', path, tok, { memberId: m, manualPaymentId: mp, ...b });
    const choice = { contributionIds: idsOf(inv, 'contribution', '2026-02-01'), fineIds: idsOf(inv, 'meeting_fine') };
    expect((await alloc(treasurer, choice)).status).toBe(403);
    expect((await alloc(admin, {})).status).toBe(400);
    const pv = await alloc(admin, choice, '/api/admin/allocations/preview');
    expect(pv.body).toMatchObject({ totalCents: 650000, balanceCents: 450000, enough: false });
    expect((await alloc(admin, choice)).status).toBe(400); // 6,500 is more than the 4,500 received
    const choice2 = { contributionIds: idsOf(inv, 'contribution', '2026-02-01').concat(idsOf(inv, 'contribution', '2026-01-01')), fineIds: idsOf(inv, 'late_fine') };
    const ok = await alloc(admin, choice2);                 // Jan + Feb contributions + Jan late fine = 3,200
    expect(ok.status).toBe(201);
    expect(ok.body.paymentLeftCents).toBe(130000);
    owed = (await call('GET', `/api/admin/members/${m}/invoices`, admin)).body;
    expect(owed.invoices.map((i: any) => i.kind)).toEqual(['meeting_fine']);
    expect(owed.creditCents).toBe(130000);
    expect(Number((await pool.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM savings_transactions WHERE member_id = $1`, [m])).rows[0].s)).toBe(300000);
    expect(Number((await pool.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM fine_ledger WHERE member_id = $1`, [m])).rows[0].s)).toBe(500000 - 0);
    // the 1,300 left cannot pay the 5,000 fine, but can pay two future months? no: 1,300 < 1,500. whole invoices only
    expect((await alloc(admin, { fineIds: idsOf(owed.invoices, 'meeting_fine') })).status).toBe(400);
    expect((await alloc(admin, { advanceMonths: 1 })).status).toBe(400);
    // another payment arrives; the fine is paid from it, plus one month ahead
    const p2 = await pay(admin, { amountKsh: 6500, mpesaCode: 'POST2BBBB2', paidOn: '2026-03-05' });
    const mp2 = (await call('GET', `/api/admin/members/${m}/credit`, admin)).body.payments.find((h: any) => h.mpesaCode === 'POST2BBBB2').id as string;
    const done = await call('POST', '/api/admin/allocations', admin, { memberId: m, manualPaymentId: mp2, fineIds: idsOf(owed.invoices, 'meeting_fine'), advanceMonths: 1, note: 'Fine and next month' });
    expect(done.status).toBe(201);
    expect(done.body.inAdvance).toHaveLength(1);
    expect(p2.status).toBe(201);
    owed = (await call('GET', `/api/admin/members/${m}/invoices`, admin)).body;
    expect(owed.invoices).toHaveLength(0);
    expect(owed.creditCents).toBe(130000 + 650000 - 650000);
    // an invoice cannot be paid twice, and a used-up selection is refused
    expect((await call('POST', '/api/admin/allocations', admin, { memberId: m, manualPaymentId: mp2, advanceMonths: 0, fineIds: idsOf(inv, 'meeting_fine') })).status).toBe(400);
    // the credit record cannot be edited or removed
    await expect(pool.query(`DELETE FROM member_credits`)).rejects.toThrow();
    const list = (await call('GET', '/api/admin/manual-payments', admin)).body;
    expect(list.filter((x: any) => x.member_id === m)).toHaveLength(2);
  });
});

describe('corrections (administrator only, always with a reason)', () => {
  it('fixes fine dates and amounts, invoice months, meetings, and reverses a wrong payment so it can be re-entered', async () => {
    const admin = await login('super_admin'); const treasurer = await login('treasurer');
    const m = await newMember('MBR-9100', 'Fix Faith');
    const meeting = (await call('POST', '/api/admin/meetings', await login('secretary'), { title: 'Fix meeting', scheduledAt: '2026-02-28T10:00:00+03:00', venue: 'Embu' })).body.id as string;
    await call('POST', '/api/admin/invoices', admin, { memberId: m, kind: 'contribution', period: '2026-01-01', lateFineApplies: false });
    await call('POST', '/api/admin/invoices', admin, { memberId: m, kind: 'meeting_fine', meetingId: meeting });
    const fine = (await pool.query(`SELECT id FROM fines WHERE member_id = $1`, [m])).rows[0].id as string;
    const ob = (await pool.query(`SELECT id FROM monthly_obligations WHERE member_id = $1`, [m])).rows[0].id as string;
    expect((await call('PATCH', `/api/admin/fines/${fine}/correct`, admin, { imposedOn: '2026-02-27' })).status).toBe(400);
    expect((await call('PATCH', `/api/admin/fines/${fine}/correct`, treasurer, { imposedOn: '2026-02-27', note: 'typo' })).status).toBe(403);
    const fx = await call('PATCH', `/api/admin/fines/${fine}/correct`, admin, { imposedOn: '2026-02-27', amountKsh: 3000, note: 'Wrong date and amount' });
    expect(fx.status).toBe(200);
    expect(fx.body).toMatchObject({ imposedOn: '2026-02-27', amountCents: 300000 });
    expect(Number((await pool.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM fine_ledger WHERE member_id = $1`, [m])).rows[0].s)).toBe(300000);
    const ix = await call('PATCH', `/api/admin/obligations/${ob}/correct`, admin, { period: '2026-03-01', note: 'Wrong month' });
    expect(ix.status).toBe(200);
    expect(ix.body.period).toBe('2026-03-01');
    const mc = await call('PATCH', `/api/admin/meetings/${meeting}/correct`, admin, { scheduledAt: '2026-03-01T10:00:00+03:00', venue: 'Runyenjes', note: 'Wrong date and venue' });
    expect(mc.status).toBe(200);
    expect(mc.body).toMatchObject({ venue: 'Runyenjes', scheduledAt: '2026-03-01T07:00:00.000Z' });
    expect((await call('PATCH', `/api/admin/meetings/${meeting}/correct`, treasurer, { venue: 'X', note: 'abc' })).status).toBe(403);
    const log = (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('fine.corrected','invoice.corrected','meeting.corrected')`)).rows[0].n;
    expect(log).toBe(3);

    // a payment is posted, then allocated, then found to be wrong
    const pay = (b: object) => call('POST', '/api/admin/manual-payments', admin, { memberId: m, message: MSG, paidOn: '2026-03-03', ...b });
    expect((await pay({ amountKsh: 4500, mpesaCode: 'FIX1AAAA11' })).status).toBe(201);
    const credit = () => call('GET', `/api/admin/members/${m}/credit`, admin);
    const mp = (await credit()).body.payments[0].id as string;
    const inv = (await call('GET', `/api/admin/members/${m}/invoices`, admin)).body.invoices;
    const al = await call('POST', '/api/admin/allocations', admin, { memberId: m, manualPaymentId: mp, contributionIds: idsOf(inv, 'contribution'), fineIds: idsOf(inv, 'meeting_fine') });
    expect(al.status).toBe(201);
    expect((await call('GET', `/api/admin/members/${m}/invoices`, admin)).body.totalCents).toBe(0);
    expect((await call('PATCH', `/api/admin/manual-payments/${mp}/correct`, admin, { paidOn: '2026-03-02', note: 'Wrong date' })).status).toBe(200);
    // undo just the allocation: invoices open again, money returns to the payment
    const entryId = (await credit()).body.entries.find((e: any) => e.undoable).id as number;
    expect((await call('POST', `/api/admin/allocations/${entryId}/undo`, treasurer, { note: 'wrong invoices' })).status).toBe(403);
    expect((await call('POST', `/api/admin/allocations/${entryId}/undo`, admin, {})).status).toBe(400);
    expect((await call('POST', `/api/admin/allocations/${entryId}/undo`, admin, { note: 'Chose the wrong invoices' })).status).toBe(200);
    expect((await call('POST', `/api/admin/allocations/${entryId}/undo`, admin, { note: 'again' })).status).toBe(409);
    expect((await call('GET', `/api/admin/members/${m}/invoices`, admin)).body.totalCents).toBe(450000);
    expect((await credit()).body.balanceCents).toBe(450000);
    expect(Number((await pool.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM savings_transactions WHERE member_id = $1`, [m])).rows[0].s)).toBe(0);
    // allocate again correctly, then reverse the whole payment
    const inv2 = (await call('GET', `/api/admin/members/${m}/invoices`, admin)).body.invoices;
    expect((await call('POST', '/api/admin/allocations', admin, { memberId: m, manualPaymentId: mp, contributionIds: idsOf(inv2, 'contribution'), fineIds: idsOf(inv2, 'meeting_fine') })).status).toBe(201);
    expect((await call('POST', `/api/admin/manual-payments/${mp}/reverse`, admin, {})).status).toBe(400);
    expect((await call('POST', `/api/admin/manual-payments/${mp}/reverse`, treasurer, { note: 'x y z' })).status).toBe(403);
    expect((await call('POST', `/api/admin/manual-payments/${mp}/reverse`, admin, { note: 'Entered against the wrong member' })).status).toBe(200);
    expect((await call('POST', `/api/admin/manual-payments/${mp}/reverse`, admin, { note: 'again' })).status).toBe(409);
    expect((await call('GET', `/api/admin/members/${m}/invoices`, admin)).body.totalCents).toBe(450000);
    expect((await credit()).body.balanceCents).toBe(0);
    // the same M-Pesa code can be entered again
    expect((await pay({ amountKsh: 4500, mpesaCode: 'FIX1AAAA11' })).status).toBe(201);
    expect((await pay({ amountKsh: 1500, mpesaCode: 'FIX1AAAA11' })).status).toBe(409);
    expect((await credit()).body.balanceCents).toBe(450000);
  });
});

describe('invoices list, month format and clearing fines', () => {
  it('lists every invoice posted, clears fines and lets them be posted afresh', async () => {
    const admin = await login('super_admin'); const treasurer = await login('treasurer');
    const m = await newMember('MBR-9200', 'Clear Cate');
    const raise = (b: object) => call('POST', '/api/admin/invoices', admin, { memberId: m, ...b });
    await raise({ kind: 'contribution', period: '2026-01-01', lateFineApplies: false });
    expect((await raise({ kind: 'late_fine', period: '2026-01-01' })).status).toBe(201);
    expect((await raise({ kind: 'late_fine', period: '2026-01-01' })).status).toBe(409);
    await call('POST', '/api/admin/manual-payments', admin, { memberId: m, amountKsh: 1500, message: MSG, paidOn: '2026-03-03', mpesaCode: 'INV1AAAA11' });
    const held = (await call('GET', `/api/admin/members/${m}/credit`, admin)).body.payments[0].id as string;
    const inv = (await call('GET', `/api/admin/members/${m}/invoices`, admin)).body.invoices;
    expect((await call('POST', '/api/admin/allocations', admin, { memberId: m, manualPaymentId: held, contributionIds: idsOf(inv, 'contribution') })).status).toBe(201);
    const ov = (await call('GET', `/api/members/${m}/overview`, admin)).body;
    expect(ov.invoices.map((i: any) => [i.kind, i.status])).toEqual([['contribution', 'paid'], ['late_fine', 'unpaid']]);
    expect(ov.penalties[0].reason).toContain('January 2026');
    expect((await call('POST', '/api/admin/fines/clear', treasurer, { memberId: m, note: 'repost' })).status).toBe(403);
    expect((await call('POST', '/api/admin/fines/clear', admin, { memberId: m })).status).toBe(400);
    const cl = await call('POST', '/api/admin/fines/clear', admin, { memberId: m, note: 'Posting afresh' });
    expect(cl.body).toMatchObject({ cleared: 1, paidKept: 0 });
    const after = (await call('GET', `/api/members/${m}/overview`, admin)).body;
    expect(after.penalties).toHaveLength(0);
    expect(after.owed.penaltiesCents).toBe(0);
    expect((await raise({ kind: 'late_fine', period: '2026-01-01', note: 'again' })).status).toBe(201);
    expect((await call('GET', `/api/members/${m}/overview`, admin)).body.owed.penaltiesCents).toBe(20000);
  });
});

describe('statements', () => {
  it('shows invoiced, paid, unpaid and account balance, and builds a full group statement for a period', async () => {
    const admin = await login('super_admin'); const sec = await login('treasurer');
    const m = await newMember('MBR-9300', 'Statement Stella');
    const raise = (b: object) => call('POST', '/api/admin/invoices', admin, { memberId: m, ...b });
    await raise({ kind: 'contribution', period: '2026-01-01', lateFineApplies: false });
    await raise({ kind: 'contribution', period: '2026-02-01', lateFineApplies: false });
    await raise({ kind: 'late_fine', period: '2026-01-01' });
    await call('POST', '/api/admin/manual-payments', admin, { memberId: m, amountKsh: 4000, message: MSG, paidOn: '2026-02-03', mpesaCode: 'STM1AAAA11' });
    const held = (await call('GET', `/api/admin/members/${m}/credit`, admin)).body.payments[0].id as string;
    const inv = (await call('GET', `/api/admin/members/${m}/invoices`, admin)).body.invoices;
    expect((await call('POST', '/api/admin/allocations', admin, { memberId: m, manualPaymentId: held, contributionIds: [idsOf(inv, 'contribution')[0]] })).status).toBe(201);

    const doc = (await call('GET', `/api/reports/member_report?memberId=${m}`, admin)).body;
    const sum = doc.sections.find((x: any) => x.heading === 'Account summary').rows;
    const val = (k: string) => sum.find((r: any) => r.item === k).amount_cents;
    expect(val('Total invoices')).toBe(320000); // 2 x 1,500 + 200 late fine
    expect(val('Paid')).toBe(150000);
    expect(val('Unpaid')).toBe(170000);
    expect(val('Balance left in member account')).toBe(250000);
    expect(doc.sections.find((x: any) => x.heading === 'Invoices').rows).toHaveLength(3);

    const g = await call('GET', '/api/reports/group_statement?from=2026-01-01&to=2026-12-31', sec);
    expect(g.status).toBe(200);
    const heads = g.body.sections.map((x: any) => x.heading);
    expect(heads).toEqual(expect.arrayContaining(['Statement summary', 'Member accounts', 'All invoices raised', 'All payments received', 'Allocations approved by the administrator', 'Fines register', 'Savings ledger', 'Expenditure', 'Meetings and attendance']));
    expect(g.body.sections.find((x: any) => x.heading === 'All invoices raised').rows).toHaveLength(3);
    expect(g.body.sections.find((x: any) => x.heading === 'All payments received').rows[0].amount_cents).toBe(400000);
    expect(g.body.sections.find((x: any) => x.heading === 'Member accounts').rows[0].account_cents).toBe(250000);
    const narrow = (await call('GET', '/api/reports/group_statement?from=2026-02-01&to=2026-02-28', sec)).body;
    expect(narrow.sections.find((x: any) => x.heading === 'All invoices raised').rows).toHaveLength(1);
    expect((await call('GET', '/api/reports/group_statement?from=2026-03-01&to=2026-02-01', sec)).status).toBe(400);
    for (const f of ['pdf', 'xlsx', 'csv']) expect((await fetch(`${base}/api/reports/group_statement?from=2026-01-01&to=2026-12-31&format=${f}`, { headers: { authorization: `Bearer ${sec}` } })).status).toBe(200);
  });
});

describe('profiles without the field encryption key', () => {
  it('registers and completes profiles while no key is set, and keeps duplicate detection', async () => {
    const { config } = await import('../src/config.js');
    const { decryptField } = await import('../src/lib/crypto.js');
    const saved = config.fieldKey; (config as { fieldKey: string }).fieldKey = '';
    try {
      const sec = await login('secretary');
      const mk = (name: string, id?: string) => call('POST', '/api/members', sec, { fullName: name, nationalId: id, phone: '0711222333', completeLater: !id });
      const a = await call('POST', '/api/members', sec, { fullName: 'No Key Nora', nationalId: '31234567', phone: '0711000111' });
      expect(a.status).toBe(201);
      const dup = await call('POST', '/api/members', sec, { fullName: 'Copy Cat', nationalId: '31234567', phone: '0711000222' });
      expect(dup.status).toBe(409);
      const b = await mk('Later Larry');
      expect(b.status).toBe(201);
      const done = await call('POST', `/api/members/${b.body.id ?? b.body.member?.id}/complete-profile`, sec, { nationalId: '32345678', phone: '0711000333' });
      expect(done.status).toBe(200);
      const row = (await pool.query(`SELECT national_id_enc FROM members WHERE full_name = 'No Key Nora'`)).rows[0];
      expect(row.national_id_enc).toBe('plain:31234567');
      expect(decryptField(row.national_id_enc)).toBe('31234567');
    } finally { (config as { fieldKey: string }).fieldKey = saved; }
  });
});

describe('member profile overview and individual report', () => {
  it('shows contributions, penalties and a downloadable report', async () => {
    const admin = await login('super_admin'); const sec = await login('secretary'); const t = await login('treasurer');
    const m = (await pool.query(`INSERT INTO members (membership_no, full_name, national_id_enc, national_id_hash, phone, mpesa_phone, registered_on) VALUES ('MBR-9002','Overview Ovia','x','h2','254700000002','254700000002','2025-01-01') RETURNING id`)).rows[0].id as string;
    await call('POST', '/api/admin/invoices', admin, { memberId: m, kind: 'contribution', period: '2026-01-01', lateFineApplies: false });
    await call('POST', '/api/admin/invoices', admin, { memberId: m, kind: 'contribution', period: '2026-02-01', lateFineApplies: false });
    await call('POST', '/api/admin/manual-payments', admin, { memberId: m, amountKsh: 3000, paidOn: '2026-02-05', message: 'ABC1DEF2GH Confirmed. Ksh3,000.00 paid' });
    const mp0 = (await call('GET', `/api/admin/members/${m}/credit`, admin)).body.payments[0].id as string;
    const inv0 = (await call('GET', `/api/admin/members/${m}/invoices`, admin)).body.invoices;
    await call('POST', '/api/admin/allocations', admin, { memberId: m, manualPaymentId: mp0, contributionIds: inv0.map((i: any) => i.id) });
    await pool.query(`INSERT INTO fines (reference, member_id, category, amount_cents, imposed_on, reason, status, is_historical) VALUES ('FN-T1',$1,'other',200000,'2026-02-28','Absence penalty','outstanding',true)`, [m]);
    await pool.query(`INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note) SELECT id, member_id, 'charge', amount_cents, 't' FROM fines WHERE reference='FN-T1'`);
    const o = await call('GET', `/api/members/${m}/overview`, sec);
    expect(o.status).toBe(200);
    expect(o.body.totals.contributionsCents).toBe(300000);
    expect(o.body.totals.monthsPaid).toBe(2);
    expect(o.body.totals.penaltiesAccruedCents).toBe(200000);
    expect(o.body.totals.penaltiesOutstandingCents).toBe(200000);
    expect(o.body.months).toHaveLength(2);
    expect(o.body.manual).toHaveLength(1);
    expect(o.body.owed.penaltiesCents).toBe(200000);
    for (const who of [sec, t, admin]) {
      const r = await fetch(`${base}/api/reports/member_report?memberId=${m}&format=csv`, { headers: { authorization: `Bearer ${who}` } });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Overview Ovia');
    }
    const pdf = await fetch(`${base}/api/reports/member_report?memberId=${m}&format=pdf`, { headers: { authorization: `Bearer ${sec}` } });
    expect(pdf.headers.get('content-type')).toContain('pdf');
    expect((await call('GET', `/api/members/${m}/overview`, await login('chairperson'))).status).toBe(200);
  });
});

describe('member payments summary', () => {
  it('lists every member with contributions and penalties for officials', async () => {
    const t = await login('treasurer');
    await pool.query(`INSERT INTO members (membership_no, full_name, national_id_enc, national_id_hash, phone, mpesa_phone, registered_on) VALUES ('MBR-9003','Summary Sam','x','h3','254700000003','254700000003','2025-01-01')`);
    const r = await call('GET', '/api/members/finance-summary', t);
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ full_name: 'Summary Sam', contributions_cents: 0, penalties_outstanding_cents: 0 });
    expect((await call('GET', '/api/members/finance-summary')).status).toBe(401);
  });
});
