import { Router } from 'express';
import { pool } from '../db/pool.js';
import { actorOf, authenticate, requirePermission } from '../middleware/auth.js';
import { h, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { buildReport, REPORT_NAMES, toCsv, toPdf, toXlsx, type ReportFilters, type ReportName } from '../services/reports.js';

import { can } from '../lib/permissions.js';

/** Saves a generated export into the records register as an officials-only, dated record. */
async function archiveExport(name: string, title: string, filename: string, mime: string, data: Buffer, userId: string) {
  const f = await pool.query(`INSERT INTO stored_files (name, mime_type, size_bytes, data, uploaded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [filename, mime, data.length, data, userId]);
  const category = name === 'membership_register' ? 'membership' : 'other';
  await pool.query(
    `INSERT INTO documents (title, category, file_id, visibility, uploaded_by, description, document_date)
     VALUES ($1,$2,$3,'officials',$4,'Exported from the system and kept for the record', (now() AT TIME ZONE 'Africa/Nairobi')::date)`,
    [`${title} (${filename.split('.').pop()!.toUpperCase()}) ${new Date().toISOString().slice(0, 10)}`, category, f.rows[0].id, userId],
  );
}

export const reportsRouter = Router();
reportsRouter.use(authenticate);

reportsRouter.get('/', requirePermission('reports.read'), (_req, res) => res.json(REPORT_NAMES));

reportsRouter.get(
  '/:name',
  h(async (req, res) => {
    const name = String(req.params.name) as ReportName;
    if (!(REPORT_NAMES as readonly string[]).includes(name)) throw new HttpError(404, 'Unknown report');
    // The membership register can be exported by anyone who manages members; all other reports need reports.read.
    const allowed = can(req.user!.role, 'reports.read') || ((name === 'membership_register' || name === 'member_report') && can(req.user!.role, 'members.export'));
    if (!allowed) throw new HttpError(403, 'You do not have permission to run this report');
    const q = req.query as Record<string, string | undefined>;
    const filters: ReportFilters = { memberId: q.memberId, month: q.month, year: q.year, from: q.from, to: q.to, asOf: q.asOf, meetingId: q.meetingId, status: q.status };
    const doc = await buildReport(pool, name, filters);
    await audit(pool, actorOf(req), 'report.generated', 'report', name, { after: { ...filters, format: q.format ?? 'json' } });
    const stamp = new Date().toISOString().slice(0, 10);
    const FORMATS = {
      pdf: { mime: 'application/pdf', make: () => toPdf(doc) },
      xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', make: () => toXlsx(doc) },
      csv: { mime: 'text/csv; charset=utf-8', make: async () => toCsv(doc) },
    } as const;
    const fmt = FORMATS[q.format as keyof typeof FORMATS];
    if (!fmt) { res.json(doc); return; }
    const body = await fmt.make();
    const filename = `${name}-${stamp}.${q.format}`;
    // Optional: keep a dated copy in the records register (officials only), e.g. the membership register.
    if (q.archive === '1' && can(req.user!.role, 'documents.manage')) {
      await archiveExport(name, doc.title, filename, fmt.mime.split(';')[0]!, body, req.user!.id);
    }
    res.set({ 'Content-Type': fmt.mime, 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(body);
  }),
);
