import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { h, HttpError } from '../lib/http.js';
import { can } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { actorOf } from '../middleware/auth.js';

export const filesRouter = Router();
filesRouter.use(authenticate);

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', DOCX, XLSX]);
const MAX_BYTES = 8 * 1024 * 1024;

export async function storeFile(input: { name: string; mimeType: string; dataBase64: string }, userId: string): Promise<string> {
  if (!ALLOWED.has(input.mimeType)) throw new HttpError(400, 'Only PDF, Word, Excel, PNG, JPEG and WebP files are accepted');
  const data = Buffer.from(input.dataBase64, 'base64');
  if (data.length === 0 || data.length > MAX_BYTES) throw new HttpError(400, 'Files must be between 1 byte and 8 MB');
  // Verify the content really is what it claims (magic numbers), not just the declared type.
  const head = data.subarray(0, 12);
  const ok =
    (input.mimeType === 'application/pdf' && head.subarray(0, 4).toString() === '%PDF') ||
    (input.mimeType === 'image/png' && head[0] === 0x89 && head.subarray(1, 4).toString() === 'PNG') ||
    (input.mimeType === 'image/jpeg' && head[0] === 0xff && head[1] === 0xd8) ||
    ((input.mimeType === DOCX || input.mimeType === XLSX) && head[0] === 0x50 && head[1] === 0x4b) ||
    (input.mimeType === 'image/webp' && head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP');
  if (!ok) throw new HttpError(400, 'The file content does not match its type');
  const { rows } = await pool.query(
    `INSERT INTO stored_files (name, mime_type, size_bytes, data, uploaded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.name.slice(0, 200), input.mimeType, data.length, data, userId],
  );
  return rows[0].id;
}

export const uploadSchema = z.object({ name: z.string().min(1), mimeType: z.string(), dataBase64: z.string().min(10) });

filesRouter.post(
  '/',
  h(async (req, res) => {
    const id = await storeFile(uploadSchema.parse(req.body), req.user!.id);
    res.status(201).json({ id });
  }),
);

filesRouter.get(
  '/:id',
  h(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM stored_files WHERE id = $1`, [req.params.id]);
    const f = rows[0];
    if (!f) throw new HttpError(404, 'File not found');
    const u = req.user!;
    let allowed = f.uploaded_by === u.id;
    if (!allowed && u.role !== 'member') {
      allowed = ['members.read', 'payments.verify', 'documents.manage', 'documents.read', 'finance.read'].some((p) => can(u.role, p as never));
    }
    if (!allowed && u.memberId) {
      const own = await pool.query(`SELECT 1 FROM members WHERE id = $1 AND $2 IN (photo_file_id, id_front_file_id, id_back_file_id)`, [u.memberId, f.id]);
      const doc = await pool.query(`SELECT 1 FROM documents WHERE file_id = $1 AND visibility = 'members'`, [f.id]);
      allowed = Boolean(own.rows[0] || doc.rows[0]);
    }
    if (!allowed) throw new HttpError(404, 'File not found');
    await audit(pool, actorOf(req), 'file.viewed', 'file', f.id);
    res.set({
      'Content-Type': f.mime_type,
      'Content-Disposition': `inline; filename="${String(f.name).replace(/[^\w.\- ]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=300',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    });
    res.send(f.data);
  }),
);
