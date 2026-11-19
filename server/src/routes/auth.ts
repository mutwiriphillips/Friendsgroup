import { Router } from 'express';
import { isAdminManaged } from '../services/obligations.js';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate, actorOf, signToken } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { h, HttpError } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';

export const authRouter = Router();

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false });

const loginSchema = z.object({ identifier: z.string().min(3), password: z.string().min(1) });

authRouter.post(
  '/login',
  loginLimiter,
  h(async (req, res) => {
    const { identifier, password } = loginSchema.parse(req.body);
    const id = identifier.trim();
    const phone = normalizePhone(id);
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE lower(email) = lower($1) OR ($2::text IS NOT NULL AND phone = $2)`,
      [id, phone],
    );
    const user = rows[0];
    const log = (ok: boolean) =>
      pool.query(`INSERT INTO login_activity (user_id, identifier, success, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`, [
        user?.id ?? null, id, ok, req.ip, req.get('user-agent') ?? null,
      ]);

    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      await log(false);
      throw new HttpError(423, 'Account temporarily locked after repeated failed attempts. Try again later.');
    }
    // Compare against a dummy hash when the user is unknown to keep timing similar.
    const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok || !user.is_active) {
      await log(false);
      if (user) {
        const attempts = user.failed_attempts + 1;
        await pool.query(
          `UPDATE users SET failed_attempts = $2::int,
                  locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE locked_until END
            WHERE id = $1`,
          [user.id, attempts, MAX_ATTEMPTS, LOCK_MINUTES],
        );
      }
      throw new HttpError(401, 'Invalid credentials');
    }
    await pool.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    await log(true);
    res.json({
      token: signToken({ id: user.id, role: user.role }),
      user: { id: user.id, role: user.role, memberId: user.member_id, mustChangePassword: user.must_change_password },
    });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.role, u.member_id, u.must_change_password, u.consent_version,
              m.full_name, m.membership_no
         FROM users u LEFT JOIN members m ON m.id = u.member_id WHERE u.id = $1`,
      [req.user!.id],
    );
    res.json({ ...rows[0], admin_managed: await isAdminManaged(pool) });
  }),
);

const changeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'Use at least 10 characters').max(128),
});

authRouter.post(
  '/change-password',
  authenticate,
  h(async (req, res) => {
    const { currentPassword, newPassword } = changeSchema.parse(req.body);
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user!.id]);
    if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      throw new HttpError(400, 'Current password is incorrect');
    }
    await pool.query(`UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1`, [
      req.user!.id,
      await bcrypt.hash(newPassword, 12),
    ]);
    await audit(pool, actorOf(req), 'auth.password_changed', 'user', req.user!.id);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/consent',
  authenticate,
  h(async (req, res) => {
    const version = z.object({ version: z.string() }).parse(req.body).version;
    await pool.query(`UPDATE users SET consent_version = $2, consent_at = now() WHERE id = $1`, [req.user!.id, version]);
    await audit(pool, actorOf(req), 'auth.consent_recorded', 'user', req.user!.id, { after: { version } });
    res.json({ ok: true });
  }),
);
