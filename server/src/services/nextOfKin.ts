import PDFDocument from 'pdfkit';
import { z } from 'zod';
import type pg from 'pg';
import { audit, type Actor } from '../lib/audit.js';
import { decryptField, encryptField } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { dmy, dmyTimeEAT } from '../lib/dates.js';
import { normalizePhone } from '../lib/phone.js';
import { config } from '../config.js';
import { completeMemberProfile } from './members.js';
import { LOGO } from './reports.js';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a full date').refine((v) => !Number.isNaN(Date.parse(v)), 'Choose a valid date');
const text = (label: string, max = 200) => z.string({ required_error: `${label} is required` }).trim().min(2, `${label} is required`).max(max);
const phones = (label: string) => z.string({ required_error: `${label} is required` }).trim().min(9, `${label} is required`).max(80)
  .refine((v) => v.split(/[,/;]+/).every((p) => !p.trim() || normalizePhone(p.trim())), `${label}: enter valid Kenyan mobile numbers, separated by commas`);
const idNo = (label: string) => z.string({ required_error: `${label} is required` }).trim().regex(/^[A-Za-z0-9\-\/]{4,20}$/, `${label}: enter a valid number`);

export const nokSchema = z.object({
  // Section 1: anything missing from the member's profile is supplied here
  memberDetails: z.object({ nationalId: z.string().trim().optional(), phone: z.string().trim().optional(), email: z.string().trim().email().optional().or(z.literal('')), dateOfBirth: iso, residence: text('Physical residence / county / sub-county', 300) }),
  // Section 2
  beneficiaries: z.array(z.object({
    fullName: text('Beneficiary full legal name', 150), relationship: text('Relationship', 60), idNumber: idNo('Beneficiary National ID / Birth Cert No.'),
    dateOfBirth: iso, phone: phones('Beneficiary phone number'), sharePct: z.number().int().min(1, 'Each share must be at least 1%').max(100),
  })).min(1, 'Add at least one beneficiary').max(5, 'At most 5 beneficiaries'),
  primaryAddress: text('Primary next of kin physical address / county', 300),
  contingentName: text('Contingent (backup) next of kin name', 150),
  contingentPhone: phones('Contingent next of kin phone'),
  // Section 3 (only when a beneficiary is under 18)
  guardian: z.object({ fullName: text('Guardian full legal name', 150), idNumber: idNo('Guardian National ID / Passport No.'), relationship: text('Guardian relationship to minor', 60), phone: phones('Guardian phone number'), address: text('Guardian physical address / county', 300) }).nullable().optional(),
  // Section 4
  witness: z.object({ fullName: text('Witness full name', 150), idNumber: idNo('Witness National ID No.'), phone: phones('Witness phone number'), isAdult: z.literal(true, { errorMap: () => ({ message: 'The witness must be 18 or older' }) }) }),
  signedName: text('Signature (type your full name)', 150),
  confirmed: z.literal(true, { errorMap: () => ({ message: 'Tick the box to confirm your details are correct before submitting' }) }),
});
export type NokInput = z.infer<typeof nokSchema>;

export interface NokForm extends Omit<NokInput, 'confirmed'> { declarationDate: string; confirmed: true }

const todayEAT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const ageOn = (dob: string, on: string) => { const a = new Date(dob), b = new Date(on); let n = b.getUTCFullYear() - a.getUTCFullYear(); if (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) n--; return n; };

/** Everything beyond field formats: shares total 100, guardian present exactly when a beneficiary is a minor, member is an adult, signature matches. */
export function validateNok(input: NokInput, memberName: string): void {
  const today = todayEAT();
  if (input.memberDetails.dateOfBirth >= today) throw new HttpError(400, 'Your date of birth must be in the past');
  if (ageOn(input.memberDetails.dateOfBirth, today) < 18) throw new HttpError(400, 'Members must be 18 or older');
  const total = input.beneficiaries.reduce((a, b) => a + b.sharePct, 0);
  if (total !== 100) throw new HttpError(400, `The beneficiary shares must add up to exactly 100% (they add up to ${total}%)`);
  for (const b of input.beneficiaries) if (b.dateOfBirth > today) throw new HttpError(400, `${b.fullName}: date of birth cannot be in the future`);
  const minor = input.beneficiaries.some((b) => ageOn(b.dateOfBirth, today) < 18);
  if (minor && !input.guardian) throw new HttpError(400, 'A beneficiary is under 18, so Section 3 (guardian / trustee) must be completed');
  if (!minor && input.guardian) throw new HttpError(400, 'Section 3 is only for when a beneficiary is under 18. Remove the guardian details');
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm(input.signedName) !== norm(memberName)) throw new HttpError(400, `Type your full name exactly as registered to sign: ${memberName}`);
}

async function memberRow(db: pg.Pool | pg.PoolClient, memberId: string) {
  const m = (await db.query(`SELECT id, membership_no, full_name, phone, email, physical_address, national_id_enc, nok_submitted_at FROM members WHERE id = $1`, [memberId])).rows[0];
  if (!m) throw new HttpError(404, 'Member not found');
  return m;
}
const memberView = (m: any) => ({ id: m.id as string, membershipNo: m.membership_no as string, fullName: m.full_name as string, phone: (m.phone ?? null) as string | null, email: (m.email ?? null) as string | null,
  address: (m.physical_address ?? null) as string | null, nationalId: m.national_id_enc ? decryptField(m.national_id_enc) : null });

/** The form as currently on file (null before submission), with the member's profile details. */
export async function getNok(db: pg.Pool | pg.PoolClient, memberId: string, withHistory = false) {
  const m = await memberRow(db, memberId);
  const f = (await db.query(`SELECT data_enc, submitted_at, submitted_via, revision, updated_at FROM next_of_kin_forms WHERE member_id = $1`, [memberId])).rows[0];
  const history = withHistory ? (await db.query(
    `SELECT r.revision, r.note, r.changed_at, u.email AS changed_by FROM next_of_kin_revisions r LEFT JOIN users u ON u.id = r.changed_by WHERE r.member_id = $1 ORDER BY r.id DESC`, [memberId])).rows : undefined;
  return {
    member: memberView(m), submitted: Boolean(f), locked: Boolean(f),
    form: f ? (JSON.parse(decryptField(f.data_enc)) as NokForm) : null,
    submittedAt: f?.submitted_at ?? null, submittedVia: f?.submitted_via ?? null, revision: f?.revision ?? 0, updatedAt: f?.updated_at ?? null, history,
  };
}

/** Stores the form. First submission by the member or on their behalf; later changes only through amendNok. */
export async function submitNok(c: pg.PoolClient, memberId: string, raw: unknown, actor: Actor, via: 'member' | 'administrator') {
  const input = nokSchema.parse(raw);
  const m = (await c.query(`SELECT * FROM members WHERE id = $1 FOR UPDATE`, [memberId])).rows[0];
  if (!m) throw new HttpError(404, 'Member not found');
  if ((await c.query(`SELECT 1 FROM next_of_kin_forms WHERE member_id = $1`, [memberId])).rowCount) throw new HttpError(409, 'This form has already been submitted. Only the administrator can change it now.', 'NOK_LOCKED');
  validateNok(input, m.full_name);
  await fillProfileGaps(c, m, input, actor);
  const form: NokForm = { ...input, declarationDate: todayEAT(), confirmed: true };
  await c.query(`INSERT INTO next_of_kin_forms (member_id, data_enc, submitted_by, submitted_via) VALUES ($1,$2,$3,$4)`, [memberId, encryptField(JSON.stringify(form)), actor.userId, via]);
  await c.query(`INSERT INTO next_of_kin_revisions (member_id, revision, data_enc, note, changed_by) VALUES ($1,1,$2,$3,$4)`, [memberId, encryptField(JSON.stringify(form)), via === 'member' ? 'Submitted by the member' : 'Submitted by the administrator on the member\'s behalf', actor.userId]);
  await c.query(`UPDATE members SET nok_submitted_at = now(), profile_completed_at = COALESCE(profile_completed_at, CASE WHEN national_id_enc IS NOT NULL AND phone IS NOT NULL THEN now() END), updated_at = now() WHERE id = $1`, [memberId]);
  await audit(c, actor, 'member.next_of_kin_submitted', 'member', memberId, { after: { via, beneficiaries: form.beneficiaries.length, guardian: Boolean(form.guardian) } });
  return { ok: true };
}

/** Administrator amendment of a submitted form. The previous version stays in the revision history. */
export async function amendNok(c: pg.PoolClient, memberId: string, raw: unknown, note: string, actor: Actor) {
  const input = nokSchema.parse(raw);
  if (note.trim().length < 3) throw new HttpError(400, 'Say why the form is being changed');
  const m = (await c.query(`SELECT * FROM members WHERE id = $1 FOR UPDATE`, [memberId])).rows[0];
  if (!m) throw new HttpError(404, 'Member not found');
  const cur = (await c.query(`SELECT revision FROM next_of_kin_forms WHERE member_id = $1 FOR UPDATE`, [memberId])).rows[0];
  if (!cur) throw new HttpError(404, 'No form has been submitted yet');
  validateNok(input, m.full_name);
  await fillProfileGaps(c, m, input, actor);
  const form: NokForm = { ...input, declarationDate: todayEAT(), confirmed: true };
  const rev = cur.revision + 1;
  await c.query(`UPDATE next_of_kin_forms SET data_enc = $2, revision = $3, updated_at = now(), updated_by = $4 WHERE member_id = $1`, [memberId, encryptField(JSON.stringify(form)), rev, actor.userId]);
  await c.query(`INSERT INTO next_of_kin_revisions (member_id, revision, data_enc, note, changed_by) VALUES ($1,$2,$3,$4,$5)`, [memberId, rev, encryptField(JSON.stringify(form)), note.trim(), actor.userId]);
  await audit(c, actor, 'member.next_of_kin_amended', 'member', memberId, { after: { revision: rev, note: note.trim() } });
  return { ok: true, revision: rev };
}

/** Section 1 uses the member's profile. Whatever the profile lacks (ID, phone, email, residence) is saved to it. */
async function fillProfileGaps(c: pg.PoolClient, m: any, input: NokInput, actor: Actor) {
  const d = input.memberDetails;
  const need: { nationalId?: string; phone?: string; email?: string; physicalAddress?: string } = {};
  if (!m.national_id_enc) { if (!d.nationalId || !/^[A-Za-z0-9]{6,12}$/.test(d.nationalId)) throw new HttpError(400, 'Enter your National ID / Passport number (Section 1)'); need.nationalId = d.nationalId; }
  if (!m.phone) { const p = d.phone ? normalizePhone(d.phone) : null; if (!p) throw new HttpError(400, 'Enter a valid primary phone number (Section 1)'); need.phone = p; }
  if (!m.email && d.email) need.email = d.email;
  if (!m.physical_address) need.physicalAddress = d.residence;
  if (Object.keys(need).length) await completeMemberProfile(c, m.id, need, actor);
}

// ---------------------------------------------------------------- the printable form
const GREEN = '#064e3b'; const MID = '#047857'; const TINT = '#ecfdf5'; const LINE = '#a7c4b5'; const INK = '#111827'; const MUTED = '#4b5563';

export async function nokPdf(db: pg.Pool | pg.PoolClient, memberId: string): Promise<Buffer> {
  const n = await getNok(db, memberId);
  if (!n.form) throw new HttpError(404, 'No next of kin form has been submitted for this member yet');
  const f = n.form; const m = n.member;
  const showPhone = (v: string | null) => (v ?? '').replace(/^\+?254(\d{9})$/, '0$1');
  const submitted = n.submittedAt ? dmyTimeEAT(n.submittedAt) : '';
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject);
    const L = 36; const W = pdf.page.width - 72; const bottom = () => pdf.page.height - 50;
    const need = (h: number) => { if (pdf.y + h > bottom()) pdf.addPage(); };

    // Letterhead
    pdf.image(LOGO, L, 30, { width: 62 });
    pdf.fillColor(GREEN).font('Helvetica-Bold').fontSize(19).text(config.groupName.toUpperCase(), L + 74, 36, { width: W - 74 });
    pdf.fillColor(MID).font('Helvetica-Oblique').fontSize(10).text(config.groupMotto, L + 74, pdf.y + 1);
    const blank = (v: string, w: number) => (v ? v : '_'.repeat(w));
    pdf.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(`Registration No.: ${blank(config.groupRegNo, 22)}   |   P.O. Box / Address: ${blank(config.groupAddress, 28)}   |   Tel: ${blank(config.groupTel, 18)}`, L + 74, pdf.y + 5, { width: W - 74 });
    pdf.moveTo(L, 100).lineTo(L + W, 100).lineWidth(1.6).strokeColor(MID).stroke();
    pdf.y = 108;
    pdf.rect(L, pdf.y, W, 24).fill(GREEN);
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11.5).text('MEMBER NEXT OF KIN & BENEFICIARY NOMINATION FORM', L, pdf.y + 7, { width: W, align: 'center' });
    pdf.y += 34;

    const section = (title: string, keep = 90) => { need(keep); pdf.rect(L, pdf.y, W, 20).fill(TINT); pdf.rect(L, pdf.y, 3, 20).fill(MID); pdf.fillColor(GREEN).font('Helvetica-Bold').fontSize(9.5).text(title, L + 10, pdf.y + 6, { width: W - 14 }); pdf.y += 24; };
    /** A row of labelled boxes. widths are fractions. */
    const row = (cells: { label: string; value: string }[], widths: number[], minH = 30) => {
      const hs = cells.map((c, i) => { pdf.font('Helvetica-Bold').fontSize(9.5); return pdf.heightOfString(c.value || ' ', { width: widths[i]! * W - 12 }); });
      const h = Math.max(minH, Math.max(...hs) + 20); need(h);
      let x = L; const y = pdf.y;
      cells.forEach((c, i) => {
        const w = widths[i]! * W;
        pdf.rect(x, y, w, h).lineWidth(0.6).strokeColor(LINE).stroke();
        pdf.fillColor(MUTED).font('Helvetica-Bold').fontSize(6.6).text(c.label.toUpperCase(), x + 6, y + 5, { width: w - 12, lineBreak: false });
        pdf.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(c.value, x + 6, y + 16, { width: w - 12 });
        x += w;
      });
      pdf.y = y + h;
    };

    section('SECTION 1: MEMBER DETAILS');
    row([{ label: 'Full legal name (as per National ID / Passport)', value: m.fullName }, { label: 'Membership / payroll no.', value: m.membershipNo }], [0.62, 0.38]);
    row([{ label: 'National ID / Passport number', value: m.nationalId ?? '' }, { label: 'Date of birth', value: dmy(f.memberDetails.dateOfBirth) }], [0.62, 0.38]);
    row([{ label: 'Primary phone number', value: showPhone(m.phone) }, { label: 'Email address (optional)', value: m.email ?? f.memberDetails.email ?? '' }], [0.62, 0.38]);
    row([{ label: 'Physical residence / county / sub-county', value: f.memberDetails.residence }], [1]);
    pdf.y += 10;

    section('SECTION 2: NOMINATED NEXT OF KIN & BENEFIT ALLOCATION');
    pdf.fillColor(MUTED).font('Helvetica').fontSize(8).text('I nominate the person(s) below to receive my accumulated savings, shares, and welfare benefits in the event of my death or permanent incapacitation. Total allocation must equal 100%.', L, pdf.y - 2, { width: W });
    pdf.y += 6;
    const cols = [0.24, 0.13, 0.17, 0.15, 0.19, 0.12]; const heads = ['Full legal name', 'Relationship', 'National ID / Birth cert no.', 'Date of birth', 'Phone number(s)', 'Share (%)'];
    const hdr = () => { const y = pdf.y; pdf.rect(L, y, W, 22).fill(TINT); let x = L; heads.forEach((t, i) => { pdf.fillColor(GREEN).font('Helvetica-Bold').fontSize(7.2).text(t, x + 5, y + 6, { width: cols[i]! * W - 8 }); x += cols[i]! * W; }); pdf.y = y + 22; };
    hdr();
    for (const b of f.beneficiaries) {
      const vals = [b.fullName, b.relationship, b.idNumber, dmy(b.dateOfBirth), b.phone, `${b.sharePct}%`];
      pdf.font('Helvetica').fontSize(8.8);
      const h = Math.max(26, Math.max(...vals.map((v, i) => pdf.heightOfString(v, { width: cols[i]! * W - 10 }))) + 12);
      if (pdf.y + h > bottom()) { pdf.addPage(); hdr(); }
      let x = L; const y = pdf.y;
      vals.forEach((v, i) => { const w = cols[i]! * W; pdf.rect(x, y, w, h).lineWidth(0.6).strokeColor(LINE).stroke(); pdf.fillColor(INK).font(i === 5 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.8).text(v, x + 5, y + 6, { width: w - 10 }); x += w; });
      pdf.y = y + h;
    }
    need(24);
    pdf.rect(L, pdf.y, W, 22).lineWidth(0.6).strokeColor(LINE).stroke();
    const ty = pdf.y + 7;
    pdf.fillColor(GREEN).font('Helvetica-Bold').fontSize(9).text('TOTAL ALLOCATION', L, ty, { width: W * 0.88 - 8, align: 'right', lineBreak: false });
    pdf.text(`${f.beneficiaries.reduce((a, b) => a + b.sharePct, 0)}%`, L + W * 0.88 + 5, ty, { width: W * 0.12 - 8, lineBreak: false });
    pdf.y += 30;
    row([{ label: 'Primary next of kin physical address / county', value: f.primaryAddress }, { label: 'Contingent (backup) next of kin name & phone', value: `${f.contingentName}, ${f.contingentPhone}` }], [0.5, 0.5]);
    pdf.y += 10;

    section('SECTION 3: APPOINTED GUARDIAN / TRUSTEE (COMPLETE ONLY IF ANY BENEFICIARY IS UNDER 18 YEARS)');
    if (f.guardian) {
      row([{ label: 'Guardian full legal name', value: f.guardian.fullName }, { label: 'National ID / Passport no.', value: f.guardian.idNumber }, { label: 'Relationship to minor', value: f.guardian.relationship }], [0.46, 0.27, 0.27]);
      row([{ label: 'Guardian phone number(s)', value: f.guardian.phone }, { label: 'Guardian physical address / county', value: f.guardian.address }], [0.5, 0.5]);
    } else row([{ label: 'Not applicable', value: 'No beneficiary is under 18 years of age.' }], [1], 28);
    pdf.y += 10;

    section('SECTION 4: MEMBER DECLARATION, DATA CONSENT & WITNESSING', 300);
    need(70);
    pdf.fillColor(INK).font('Helvetica-Bold').fontSize(8).text('Declaration & Data Protection Consent: ', L, pdf.y, { continued: true, width: W })
      .font('Helvetica').text('I hereby declare that the information provided above is true and accurate. In accordance with the Kenya Data Protection Act (2019), I confirm that I have informed my nominated Next of Kin / Guardian and consent to the Self-Help Group collecting, storing, and processing this personal data strictly for membership records and benefit administration. This nomination supersedes any previous Next of Kin form submitted by me.', { width: W });
    pdf.y += 8;
    row([{ label: 'Member signature (signed electronically)', value: f.signedName }, { label: 'Date', value: dmy(f.declarationDate) }], [0.62, 0.38]);
    row([{ label: 'Witness full name (must be 18+ years)', value: f.witness.fullName }, { label: 'Witness National ID no.', value: f.witness.idNumber }], [0.62, 0.38]);
    row([{ label: 'Witness phone number', value: f.witness.phone }, { label: 'Witness signature & date', value: '' }], [0.5, 0.5], 40);
    pdf.y += 10;

    section('SECTION 5: FOR OFFICIAL GROUP USE ONLY');
    row([{ label: 'Received & verified by (name & title)', value: '' }, { label: 'Official signature & date', value: '' }, { label: 'Official group stamp', value: '' }], [0.38, 0.32, 0.30], 52);
    pdf.y += 10;
    need(30);
    pdf.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8).text("Mandatory attachments: Please attach a clear photocopy of the Member's National ID/Passport and the Next of Kin's National ID (or Birth Certificate for minors).", L, pdf.y, { width: W, align: 'center' });

    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(range.start + i);
      const size = pdf.page.width * 0.66;
      pdf.save().opacity(0.07).image(LOGO, (pdf.page.width - size) / 2, (pdf.page.height - size) / 2, { width: size }).restore();
      pdf.page.margins.bottom = 0;
      pdf.font('Helvetica').fontSize(7).fillColor('#9ca3af').text(`${config.groupName}  |  ${m.membershipNo}  |  Submitted electronically ${submitted} (EAT), revision ${n.revision}  |  Page ${i + 1} of ${range.count}`, L, pdf.page.height - 26, { width: W, align: 'center', lineBreak: false });
    }
    pdf.end();
  });
}
