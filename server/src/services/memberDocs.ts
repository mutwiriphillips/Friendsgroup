import type pg from 'pg';
import { HttpError } from '../lib/http.js';
import { audit, type Actor } from '../lib/audit.js';

export const DOC_KINDS = { photo: 'photo_file_id', id_front: 'id_front_file_id', id_back: 'id_back_file_id' } as const;
export type DocKind = keyof typeof DOC_KINDS;
export const docKind = (v: unknown): DocKind => { if (typeof v === 'string' && v in DOC_KINDS) return v as DocKind; throw new HttpError(400, 'Unknown document type'); };
export const LABELS: Record<DocKind, string> = { photo: 'Passport-style photo', id_front: 'ID card, front', id_back: 'ID card, back' };

export async function getDocs(db: pg.Pool | pg.PoolClient, memberId: string) {
  const r = (await db.query(`SELECT photo_file_id, id_front_file_id, id_back_file_id FROM members WHERE id = $1`, [memberId])).rows[0];
  if (!r) throw new HttpError(404, 'Member not found');
  return { photo: r.photo_file_id as string | null, id_front: r.id_front_file_id as string | null, id_back: r.id_back_file_id as string | null };
}

/** Members may add a missing item; replacing or removing one is for the administrator (`replace`). The old file stays stored for the audit trail. */
export async function setDoc(db: pg.Pool | pg.PoolClient, memberId: string, kind: DocKind, fileId: string | null, actor: Actor, replace: boolean) {
  const col = DOC_KINDS[kind];
  const cur = (await getDocs(db, memberId))[kind];
  if (cur && !replace) throw new HttpError(409, `${LABELS[kind]} is already uploaded. Ask the administrator if it needs to be replaced.`, 'DOC_LOCKED');
  await db.query(`UPDATE members SET ${col} = $2, updated_at = now() WHERE id = $1`, [memberId, fileId]);
  await audit(db, actor, fileId ? 'member.document_uploaded' : 'member.document_removed', 'member', memberId, { after: { kind, replaced: Boolean(cur) } });
}
