import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { audit, type Actor } from '../lib/audit.js';
import { blindIndex, blindIndexAll, encryptField } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';

const phoneField = z
  .string()
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) ctx.addIssue({ code: 'custom', message: 'Enter a valid Kenyan mobile number (e.g. 0712345678)' });
    return n ?? '';
  });

export const registerMemberSchema = z.object({
  fullName: z.string().trim().min(3, 'Enter the full legal name').max(150),
  nationalId: z.string().trim().regex(/^[A-Za-z0-9]{6,12}$/, 'Enter a valid National ID number'),
  phone: phoneField,
  mpesaPhone: phoneField.optional(),
  email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  physicalAddress: z.string().max(300).optional(),
  nextOfKin: z.object({ name: z.string(), relationship: z.string().optional(), phone: z.string().optional() }).optional(),
  emergencyContact: z.object({ name: z.string(), phone: z.string().optional() }).optional(),
  registeredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type RegisterMemberInput = z.infer<typeof registerMemberSchema>;

function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

/**
 * Registers a member and creates their portal login (phone number + one-time temporary password).
 * Duplicate National IDs are rejected via a keyed hash with a UNIQUE constraint.
 */
export async function registerMember(client: pg.PoolClient, input: RegisterMemberInput, actor: Actor) {
  const idHash = blindIndex(input.nationalId);
  const dup = await client.query(`SELECT membership_no FROM members WHERE national_id_hash = ANY($1::text[])`, [blindIndexAll(input.nationalId)]);
  if (dup.rows[0]) {
    throw new HttpError(409, `A member with this National ID is already registered (${dup.rows[0].membership_no})`, 'DUPLICATE_NATIONAL_ID');
  }
  const { rows } = await client.query(
    `INSERT INTO members
       (membership_no, full_name, national_id_enc, national_id_hash, phone, mpesa_phone, email, physical_address,
        next_of_kin, emergency_contact, registered_on)
     VALUES ('MBR-' || lpad(nextval('membership_no_seq')::text, 4, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::date, CURRENT_DATE))
     RETURNING id, membership_no`,
    [
      input.fullName, encryptField(input.nationalId), idHash, input.phone, input.mpesaPhone ?? input.phone,
      input.email ?? null, input.physicalAddress ?? null,
      input.nextOfKin ? JSON.stringify(input.nextOfKin) : null,
      input.emergencyContact ? JSON.stringify(input.emergencyContact) : null,
      input.registeredOn ?? null,
    ],
  );
  const member = rows[0];
  const tempPassword = temporaryPassword();
  await client.query(
    `INSERT INTO users (email, phone, password_hash, role, member_id, must_change_password)
     VALUES ($1, $2, $3, 'member', $4, true)`,
    [input.email?.toLowerCase() ?? null, input.phone, await bcrypt.hash(tempPassword, 12), member.id],
  );
  await client.query(
    `INSERT INTO member_status_history (member_id, old_status, new_status, reason, changed_by) VALUES ($1, NULL, 'active', 'Registered', $2)`,
    [member.id, actor.userId],
  );
  await audit(client, actor, 'member.registered', 'member', member.id, { after: { membershipNo: member.membership_no, fullName: input.fullName } });
  return { id: member.id as string, membershipNo: member.membership_no as string, temporaryPassword: tempPassword };
}

export async function setMemberStatus(
  client: pg.PoolClient,
  memberId: string,
  status: 'active' | 'suspended' | 'withdrawn' | 'deceased',
  reason: string,
  actor: Actor,
) {
  const { rows } = await client.query(`SELECT status FROM members WHERE id = $1 FOR UPDATE`, [memberId]);
  if (!rows[0]) throw new HttpError(404, 'Member not found');
  const old = rows[0].status;
  if (old === status) return;
  await client.query(`UPDATE members SET status = $2, updated_at = now() WHERE id = $1`, [memberId, status]);
  await client.query(
    `INSERT INTO member_status_history (member_id, old_status, new_status, reason, changed_by) VALUES ($1,$2,$3,$4,$5)`,
    [memberId, old, status, reason, actor.userId],
  );
  // Login access follows membership status. Financial history is never touched.
  await client.query(`UPDATE users SET is_active = $2 WHERE member_id = $1`, [memberId, status === 'active' || status === 'suspended']);
  await audit(client, actor, 'member.status_changed', 'member', memberId, { reason, before: { status: old }, after: { status } });
}


// ---------------------------------------------------------------- "import as is, comply later"

export interface LenientMemberInput {
  fullName: string;
  nationalId?: string;
  phone?: string;
  mpesaPhone?: string;
  email?: string;
  physicalAddress?: string;
  nextOfKinName?: string;
  nextOfKinPhone?: string;
  registeredOn?: string;
}

/** Splits a raw row into the values we can accept and the problems found, without ever throwing on bad optional data. */
export async function assessLenientMember(db: pg.Pool | pg.PoolClient, input: LenientMemberInput, seenIds?: Set<string>) {
  const issues: string[] = [];
  const raw: Record<string, string> = {};
  const clean = (v?: string) => (v ?? '').trim();
  const out = { fullName: clean(input.fullName), nationalId: null as string | null, phone: null as string | null, mpesaPhone: null as string | null, email: null as string | null,
    physicalAddress: clean(input.physicalAddress) || null, nextOfKin: null as object | null, registeredOn: null as string | null };

  const id = clean(input.nationalId);
  if (!id) issues.push('National ID missing');
  else if (!/^[A-Za-z0-9]{6,12}$/.test(id)) { issues.push('National ID not in a valid format'); raw.nationalId = id; }
  else {
    const hash = blindIndex(id);
    const dup = (await db.query(`SELECT membership_no FROM members WHERE national_id_hash = ANY($1::text[])`, [blindIndexAll(id)])).rows[0];
    if (dup) { issues.push(`National ID already belongs to ${dup.membership_no}`); raw.nationalId = id; }
    else if (seenIds?.has(hash)) { issues.push('National ID repeated within the file'); raw.nationalId = id; }
    else { out.nationalId = id; seenIds?.add(hash); }
  }
  const ph = clean(input.phone);
  if (!ph) issues.push('Phone number missing');
  else { const n = normalizePhone(ph); if (n) out.phone = n; else { issues.push('Phone number not valid'); raw.phone = ph; } }
  const mp = clean(input.mpesaPhone);
  if (mp) { const n = normalizePhone(mp); if (n) out.mpesaPhone = n; else { issues.push('M-Pesa number not valid'); raw.mpesaPhone = mp; } }
  const em = clean(input.email);
  if (em) { if (z.string().email().safeParse(em).success) out.email = em; else { issues.push('Email not valid'); raw.email = em; } }
  const rd = clean(input.registeredOn);
  if (rd) { if (/^\d{4}-\d{2}-\d{2}$/.test(rd) && !Number.isNaN(Date.parse(rd))) out.registeredOn = rd; else { issues.push('Registration date not valid (today used)'); raw.registeredOn = rd; } }
  if (clean(input.nextOfKinName)) out.nextOfKin = { name: clean(input.nextOfKinName), phone: clean(input.nextOfKinPhone) || undefined };
  return { value: out, issues, raw };
}

/**
 * Registers a member with whatever is available. Missing or unacceptable details are recorded as pending compliance,
 * and can be completed later with completeMemberProfile. A portal login is created only when a phone or email exists.
 */
export async function registerMemberLenient(client: pg.PoolClient, input: LenientMemberInput, actor: Actor, seenIds?: Set<string>, imported = true) {
  const a = await assessLenientMember(client, input, seenIds);
  if (a.value.fullName.length < 2) throw new HttpError(400, 'A member name is required');
  const v = a.value;
  const { rows } = await client.query(
    `INSERT INTO members
       (membership_no, full_name, national_id_enc, national_id_hash, phone, mpesa_phone, email, physical_address, next_of_kin, registered_on, import_issues, imported_at)
     VALUES ('MBR-' || lpad(nextval('membership_no_seq')::text, 4, '0'), $1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::date, CURRENT_DATE), $10, $11)
     RETURNING id, membership_no`,
    [
      v.fullName, v.nationalId ? encryptField(v.nationalId) : null, v.nationalId ? blindIndex(v.nationalId) : null, v.phone, v.mpesaPhone ?? v.phone,
      v.email, v.physicalAddress, v.nextOfKin ? JSON.stringify(v.nextOfKin) : null, v.registeredOn,
      a.issues.length ? JSON.stringify({ issues: a.issues, raw: a.raw }) : null, imported ? new Date() : null,
    ],
  );
  const member = rows[0];
  let tempPassword: string | null = null;
  if (v.phone || v.email) {
    tempPassword = temporaryPassword();
    await client.query(
      `INSERT INTO users (email, phone, password_hash, role, member_id, must_change_password) VALUES ($1,$2,$3,'member',$4,true)`,
      [v.email?.toLowerCase() ?? null, v.phone, await bcrypt.hash(tempPassword, 12), member.id],
    );
  }
  await client.query(`INSERT INTO member_status_history (member_id, old_status, new_status, reason, changed_by) VALUES ($1, NULL, 'active', $2, $3)`,
    [member.id, imported ? 'Imported' : 'Registered', actor.userId]);
  await audit(client, actor, 'member.registered', 'member', member.id, { after: { membershipNo: member.membership_no, fullName: v.fullName, imported, pendingCompliance: a.issues } });
  return { id: member.id as string, membershipNo: member.membership_no as string, phone: v.phone, temporaryPassword: tempPassword, issues: a.issues };
}

const completeSchema = z.object({
  nationalId: z.string().trim().regex(/^[A-Za-z0-9]{6,12}$/, 'Enter a valid National ID number').optional(),
  phone: phoneField.optional(),
  mpesaPhone: phoneField.optional(),
  email: z.string().email().optional(),
  physicalAddress: z.string().max(300).optional(),
  nextOfKin: z.object({ name: z.string().min(2), relationship: z.string().optional(), phone: z.string().optional() }).optional(),
});
export const completeProfileSchema = completeSchema;

/** Supplies the details that were missing at import. Creates the portal login if the member has none yet. */
export async function completeMemberProfile(client: pg.PoolClient, memberId: string, input: z.infer<typeof completeSchema>, actor: Actor) {
  const m = (await client.query(`SELECT * FROM members WHERE id = $1 FOR UPDATE`, [memberId])).rows[0];
  if (!m) throw new HttpError(404, 'Member not found');
  if (input.nationalId) {
    if (m.national_id_enc) throw new HttpError(409, 'A National ID is already on file. Use the audited correction process to change it.');
    const hash = blindIndex(input.nationalId);
    const dup = (await client.query(`SELECT membership_no FROM members WHERE national_id_hash = ANY($1::text[])`, [blindIndexAll(input.nationalId)])).rows[0];
    if (dup) throw new HttpError(409, `This National ID is already registered (${dup.membership_no})`, 'DUPLICATE_NATIONAL_ID');
    await client.query(`UPDATE members SET national_id_enc = $2, national_id_hash = $3 WHERE id = $1`, [memberId, encryptField(input.nationalId), hash]);
  }
  await client.query(
    `UPDATE members SET phone = COALESCE($2, phone), mpesa_phone = COALESCE($3, $2, mpesa_phone), email = COALESCE($4, email),
            physical_address = COALESCE($5, physical_address), next_of_kin = COALESCE($6::jsonb, next_of_kin), updated_at = now() WHERE id = $1`,
    [memberId, input.phone ?? null, input.mpesaPhone ?? null, input.email ?? null, input.physicalAddress ?? null, input.nextOfKin ? JSON.stringify(input.nextOfKin) : null],
  );
  const after = (await client.query(`SELECT phone, email, profile_complete FROM members WHERE id = $1`, [memberId])).rows[0];
  let tempPassword: string | null = null;
  const user = (await client.query(`SELECT id FROM users WHERE member_id = $1`, [memberId])).rows[0];
  if (!user && (after.phone || after.email)) {
    tempPassword = temporaryPassword();
    await client.query(`INSERT INTO users (email, phone, password_hash, role, member_id, must_change_password) VALUES ($1,$2,$3,'member',$4,true)`,
      [after.email?.toLowerCase() ?? null, after.phone, await bcrypt.hash(tempPassword, 12), memberId]);
  } else if (user && input.phone) {
    await client.query(`UPDATE users SET phone = $2 WHERE id = $1 AND phone IS NULL`, [user.id, input.phone]);
  }
  if (after.profile_complete && !m.profile_completed_at) await client.query(`UPDATE members SET profile_completed_at = now() WHERE id = $1`, [memberId]);
  await audit(client, actor, 'member.profile_completed', 'member', memberId, { after: { fields: Object.keys(input), complete: after.profile_complete } });
  return { complete: after.profile_complete as boolean, temporaryPassword: tempPassword };
}

export function missingFields(m: { national_id_enc: unknown; phone: unknown; nok_submitted_at?: unknown }): string[] {
  const out: string[] = [];
  if (!m.national_id_enc) out.push('National ID');
  if (!m.phone) out.push('Phone number');
  if (!m.nok_submitted_at) out.push('Next of kin form');
  return out;
}
