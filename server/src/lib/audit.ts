import type { Db } from '../db/pool.js';

export interface Actor {
  userId: string | null;
  role: string | null;
  ip?: string | null;
}

export const SYSTEM_ACTOR: Actor = { userId: null, role: 'system' };

export async function audit(
  db: Db,
  actor: Actor,
  action: string,
  entityType: string | null,
  entityId: string | null,
  opts: { reason?: string | null; before?: unknown; after?: unknown } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (user_id, user_role, action, entity_type, entity_id, reason, before, after, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      actor.userId,
      actor.role,
      action,
      entityType,
      entityId,
      opts.reason ?? null,
      opts.before === undefined ? null : JSON.stringify(opts.before),
      opts.after === undefined ? null : JSON.stringify(opts.after),
      actor.ip ?? null,
    ],
  );
}
