import type pg from 'pg';
import { config } from '../config.js';
import { dmy } from '../lib/dates.js';
import { pool, withTx, type Db } from '../db/pool.js';

/** In-app notification for a member's login, optionally mirrored to SMS. Never throws into money flows. */
export async function notifyMember(
  db: Db,
  memberId: string,
  kind: string,
  title: string,
  body: string,
  sms = false,
  dedupeKey: string | null = null,
): Promise<boolean> {
  // SAVEPOINTs need a single connection inside a transaction. A bare pool gets its own.
  if (db === pool) {
    try {
      return await withTx((c) => notifyInTx(c, memberId, kind, title, body, sms, dedupeKey));
    } catch (err) {
      console.error('notifyMember failed', err);
      return false;
    }
  }
  return notifyInTx(db as pg.PoolClient, memberId, kind, title, body, sms, dedupeKey);
}

async function notifyInTx(
  db: pg.PoolClient,
  memberId: string,
  kind: string,
  title: string,
  body: string,
  sms = false,
  dedupeKey: string | null = null,
): Promise<boolean> {
  try {
    const u = await db.query(`SELECT id FROM users WHERE member_id = $1`, [memberId]);
    if (!u.rows[0]) return false;
    // A savepoint keeps a duplicate-key skip from aborting the caller's transaction.
    await db.query('SAVEPOINT notify');
    try {
      const ins = await db.query(
        `INSERT INTO notifications (user_id, kind, title, body, dedupe_key) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
        [u.rows[0].id, kind, title, body, dedupeKey],
      );
      if (!ins.rows[0]) {
        await db.query('RELEASE SAVEPOINT notify');
        return false;
      }
      if (sms) {
        const m = await db.query(`SELECT mpesa_phone, phone, email FROM members WHERE id = $1`, [memberId]);
        const phone = m.rows[0]?.phone ?? m.rows[0]?.mpesa_phone;
        if (phone) await db.query(`INSERT INTO message_outbox (channel, recipient, body) VALUES ('sms',$1,$2)`, [phone, `${config.groupName}: ${body}`.slice(0, 300)]);
        if (m.rows[0]?.email) await db.query(`INSERT INTO message_outbox (channel, recipient, subject, body) VALUES ('email',$1,$2,$3)`, [m.rows[0].email, title, body]);
      }
      await db.query('RELEASE SAVEPOINT notify');
      return true;
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT notify');
      throw err;
    }
  } catch (err) {
    console.error('notifyMember failed', err);
    return false;
  }
}

/** Notify every active member (or a chosen list). */
export async function notifyMany(db: Db, memberIds: string[] | null, kind: string, title: string, body: string, sms: boolean, dedupePrefix?: string): Promise<number> {
  const { rows } = memberIds
    ? await db.query(`SELECT id FROM members WHERE id = ANY($1::uuid[])`, [memberIds])
    : await db.query(`SELECT id FROM members WHERE status IN ('active','suspended')`);
  let n = 0;
  for (const r of rows) if (await notifyMember(db, r.id, kind, title, body, sms, dedupePrefix ? `${dedupePrefix}:${r.id}` : null)) n++;
  return n;
}

/** Deliver queued SMS through Africa's Talking when configured; email stays queued until SMTP is wired. */
export async function sendOutbox(limit = 50): Promise<{ sent: number; failed: number }> {
  const { rows } = await pool.query(`SELECT * FROM message_outbox WHERE status = 'queued' ORDER BY id LIMIT $1`, [limit]);
  let sent = 0;
  let failed = 0;
  for (const msg of rows) {
    if (msg.channel === 'email' || !config.sms.apiKey || !config.sms.username) {
      await pool.query(`UPDATE message_outbox SET status = 'not_configured' WHERE id = $1`, [msg.id]);
      continue;
    }
    try {
      const res = await fetch('https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: { apiKey: config.sms.apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          username: config.sms.username,
          to: `+${msg.recipient}`,
          message: msg.body,
          ...(config.sms.senderId ? { from: config.sms.senderId } : {}),
        }),
      });
      if (!res.ok) throw new Error(`SMS gateway ${res.status}`);
      await pool.query(`UPDATE message_outbox SET status = 'sent', sent_at = now() WHERE id = $1`, [msg.id]);
      sent++;
    } catch (err) {
      await pool.query(`UPDATE message_outbox SET status = 'failed', error = $2 WHERE id = $1`, [msg.id, (err as Error).message]);
      failed++;
    }
  }
  return { sent, failed };
}

/** Contribution reminders and late alerts. Deduped per member and month, so safe to run repeatedly. */
export async function runReminders(db: pg.PoolClient | pg.Pool, today: string): Promise<number> {
  const daysBefore = Number((await db.query(`SELECT value FROM system_settings WHERE key = 'notification_reminder_days_before'`)).rows[0]?.value ?? 3);
  let sent = 0;
  const upcoming = await db.query(
    `SELECT o.member_id, o.period, o.due_date, o.amount_due_cents FROM monthly_obligations o
      WHERE o.status = 'unpaid' AND o.due_date >= $1::date AND o.due_date <= ($1::date + $2::int)`,
    [today, daysBefore],
  );
  for (const o of upcoming.rows) {
    const label = o.period.slice(0, 7);
    if (await notifyMember(db, o.member_id, 'reminder', 'Contribution due soon',
      `Your KSh ${o.amount_due_cents / 100} contribution for ${label} is due on ${dmy(String(o.due_date))}.`, true, `reminder:${label}`)) sent++;
  }
  const late = await db.query(
    `SELECT o.member_id, o.period, o.late_fine_cents FROM monthly_obligations o WHERE o.status = 'overdue' AND o.due_date < $1::date`,
    [today],
  );
  for (const o of late.rows) {
    const label = o.period.slice(0, 7);
    if (await notifyMember(db, o.member_id, 'late_alert', 'Contribution overdue',
      `Your contribution for ${label} is overdue. A late fine of KSh ${o.late_fine_cents / 100} applies and is paid separately.`, true, `late:${label}`)) sent++;
  }
  return sent;
}
