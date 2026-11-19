import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { can, type Permission, type Role } from '../lib/permissions.js';
import type { Actor } from '../lib/audit.js';

export interface AuthUser {
  id: string;
  role: Role;
  memberId: string | null;
  mustChangePassword: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function signToken(user: { id: string; role: Role }): string {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '8h', issuer: 'savings-system' });
}

/** Verifies the token AND re-reads the user, so deactivation / role changes apply immediately. */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const payload = jwt.verify(header.slice(7), config.jwtSecret, { issuer: 'savings-system' }) as { sub: string };
    const { rows } = await pool.query(
      `SELECT id, role, member_id, is_active, must_change_password FROM users WHERE id = $1`,
      [payload.sub],
    );
    const u = rows[0];
    if (!u || !u.is_active) {
      res.status(401).json({ error: 'Account is not active' });
      return;
    }
    req.user = { id: u.id, role: u.role, memberId: u.member_id, mustChangePassword: u.must_change_password };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/** Backend permission gate. UI hiding is cosmetic; this is the real control. */
export function requirePermission(...perms: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!perms.some((p) => can(user.role, p))) {
      res.status(403).json({ error: 'You do not have permission to perform this action' });
      return;
    }
    next();
  };
}

/** Members only ever see their own records. */
export function requireMember(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.memberId) {
    res.status(403).json({ error: 'This action is only available to members' });
    return;
  }
  next();
}

export function actorOf(req: Request): Actor {
  return { userId: req.user?.id ?? null, role: req.user?.role ?? null, ip: req.ip ?? null };
}
