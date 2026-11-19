import { useState } from 'react';
import { fileToUpload, openFile, post } from '../../api';
import { useAuth } from '../../auth';
import { dateFmt, human } from '../../format';
import { Badge, ErrorBox, Field, Modal, Notice, Page, Table, useAction, useApi, DateInput } from '../../ui';

const CATEGORIES: [string, string][] = [
  ['certificate_of_registration', 'Certificate of registration'], ['constitution', 'Constitution'], ['minutes', 'Minutes'], ['resolution', 'Resolutions'],
  ['financial_statement', 'Financial statements'], ['policy', 'Policies'], ['compliance', 'Compliance & returns'], ['legal', 'Legal'], ['correspondence', 'Correspondence'],
  ['membership', 'Membership records'], ['other', 'Other'],
];
const KEY_RECORDS = ['certificate_of_registration', 'constitution'];
const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = (d: string | null) => (d ? Math.ceil((new Date(d + 'T00:00:00+03:00').getTime() - Date.now()) / 864e5) : null);

function ExpiryTag({ d, status }: { d: string | null; status: string }) {
  const n = daysUntil(d);
  if (n === null || status !== 'current') return <>—</>;
  if (n < 0) return <span className="font-semibold text-red-600">Expired {dateFmt(d)}</span>;
  if (n <= 60) return <span className="font-semibold text-amber-700">Expires in {n} days</span>;
  return <>{dateFmt(d)}</>;
}

function UploadModal({ replacing, preset, onClose, onDone }: { replacing?: any; preset?: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    title: replacing?.title ?? '', category: replacing?.category ?? preset ?? 'minutes', visibility: replacing?.visibility ?? 'members',
    description: '', referenceNo: replacing?.reference_no ?? '', documentDate: today(), expiresOn: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const act = useAction();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={replacing ? `New version of “${replacing.title}”` : 'Add a record'} onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} />
        {replacing && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">Version {replacing.version} will be kept in the register as superseded. Nothing is ever deleted.</p>}
        <Field label="Title"><input className="input" value={f.title} onChange={set('title')} placeholder="e.g. Constitution (amended 2026)" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type"><select className="input" value={f.category} onChange={set('category')} disabled={!!replacing}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Who can see it"><select className="input" value={f.visibility} onChange={set('visibility')}><option value="members">All members</option><option value="officials">Officials only</option></select></Field>
          <Field label="Document date"><DateInput value={f.documentDate} onChange={set('documentDate')} /></Field>
          <Field label="Expiry / renewal date"><DateInput value={f.expiresOn} onChange={set('expiresOn')} /></Field>
        </div>
        <Field label="Reference number (optional)"><input className="input" value={f.referenceNo} onChange={set('referenceNo')} placeholder="e.g. certificate number, minute ref" /></Field>
        <Field label="Notes (optional)"><textarea className="input" rows={2} value={f.description} onChange={set('description')} /></Field>
        <Field label="File (PDF, Word, Excel or image, up to 8 MB)"><input className="input" type="file" accept="application/pdf,image/png,image/jpeg,image/webp,.docx,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <button className="btn-primary w-full" disabled={act.busy || !file || f.title.length < 3} onClick={async () => {
          const upload = await fileToUpload(file!);
          if (!upload.mimeType) { act.setError('This file type is not supported.'); return; }
          const body = { ...f, description: f.description || undefined, referenceNo: f.referenceNo || undefined, expiresOn: f.expiresOn || undefined, supersedesId: replacing?.id, file: upload };
          if (await act.run(() => post('/admin/documents', body), 'Saved.')) { onDone(); onClose(); }
        }}>{act.busy ? 'Uploading…' : 'Save to records'}</button>
      </div>
    </Modal>
  );
}

export default function Records() {
  const { me } = useAuth();
  const canManage = me?.role === 'secretary' || me?.role === 'super_admin';
  const [category, setCategory] = useState(''); const [status, setStatus] = useState('current'); const [q, setQ] = useState('');
  const { data, error, reload } = useApi<any[]>(`/admin/documents?category=${category}&status=${status}&q=${encodeURIComponent(q)}`);
  const current = useApi<any[]>('/admin/documents?status=current');
  const [upload, setUpload] = useState<{ replacing?: any; preset?: string } | null>(null);
  const act = useAction();
  const archive = async (d: any) => { const reason = window.prompt('Reason for archiving this record?'); if (!reason) return; await act.run(() => post(`/admin/documents/${d.id}/archive`, { reason }), 'Archived.'); reload(); current.reload(); };
  const open = (d: any) => act.run(() => openFile(d.file_id), '');
  const refresh = () => { reload(); current.reload(); };
  return (
    <Page title="Records & documents" subtitle="The group's official record: registration, constitution, minutes and compliance documents. Records are versioned and never deleted."
      actions={canManage && <button className="btn-primary" onClick={() => setUpload({})}>Add a record</button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {KEY_RECORDS.map((k) => {
          const d = (current.data ?? []).find((x) => x.category === k);
          return (
            <div key={k} className="card">
              <div className="label">{CATEGORIES.find(([c]) => c === k)![1]}</div>
              {d ? (<><div className="font-semibold">{d.title} <span className="text-xs font-normal text-slate-500">v{d.version}</span></div>
                <div className="text-xs text-slate-500">{d.reference_no ? `Ref ${d.reference_no} · ` : ''}{dateFmt(d.document_date)} · Renewal: <ExpiryTag d={d.expires_on} status={d.status} /></div>
                <button className="mt-2 text-sm text-brand-700 underline" onClick={() => open(d)}>Open</button></>)
                : (<><div className="text-sm text-amber-700">Not on file yet.</div>{canManage && <button className="mt-2 text-sm text-brand-700 underline" onClick={() => setUpload({ preset: k })}>Upload now</button>}</>)}
            </div>
          );
        })}
      </div>
      <ErrorBox msg={error || act.error} /><Notice msg={act.ok} />
      <div className="flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Search title, reference or notes" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-[14rem]" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All types</option>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select className="input max-w-[11rem]" value={status} onChange={(e) => setStatus(e.target.value)}><option value="current">Current</option><option value="superseded">Superseded</option><option value="archived">Archived</option><option value="">All</option></select>
      </div>
      <Table rows={data ?? []} empty="No records match." columns={[
        { key: 'title', label: 'Record', render: (r) => <div><button className="text-left font-semibold text-brand-700 underline" onClick={() => open(r)}>{r.title}</button>{r.description && <div className="text-xs text-slate-500">{r.description}</div>}</div> },
        { key: 'category', label: 'Type', render: (r) => human(r.category) },
        { key: 'reference_no', label: 'Ref' },
        { key: 'document_date', label: 'Dated', render: (r) => dateFmt(r.document_date) },
        { key: 'version', label: 'Ver.', render: (r) => `v${r.version}` },
        { key: 'expires_on', label: 'Renewal', render: (r) => <ExpiryTag d={r.expires_on} status={r.status} /> },
        { key: 'visibility', label: 'Visible to', render: (r) => (r.visibility === 'members' ? 'Members' : 'Officials') },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'x', label: '', render: (r) => (canManage && r.status === 'current' ? <div className="flex gap-3 whitespace-nowrap"><button className="text-brand-700 underline" onClick={() => setUpload({ replacing: r })}>New version</button><button className="text-red-600 underline" onClick={() => archive(r)}>Archive</button></div> : r.archived_reason ? <span className="text-xs text-slate-500">{r.archived_reason}</span> : null) },
      ]} />
      {upload && <UploadModal replacing={upload.replacing} preset={upload.preset} onClose={() => setUpload(null)} onDone={refresh} />}
    </Page>
  );
}
