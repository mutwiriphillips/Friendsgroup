import { useState } from 'react';
import { download, get, post } from '../../api';
import { useAuth } from '../../auth';
import { dateFmt, dateTimeFmt, human, kes } from '../../format';
import { ErrorBox, Field, Notice, Page, Table, useAction, useApi, DateInput, MonthInput } from '../../ui';

export function Reports() {
  const names = useApi<string[]>('/reports');
  const [name, setName] = useState('monthly_collections');
  const [f, setF] = useState<Record<string, string>>({});
  const [doc, setDoc] = useState<any>(null);
  const act = useAction();
  const qs = () => '?' + Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const cell = (c: any, v: any) => (v == null || v === '' ? '—' : c.type === 'money' ? kes(v) : c.type === 'date' ? dateFmt(v) : c.type === 'datetime' ? dateTimeFmt(v) : String(v));
  return (
    <Page title="Reports" subtitle="View on screen, or download as PDF or Excel. Every report generated is logged.">
      <div className="card space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Report"><select className="input" value={name} onChange={(e) => { setName(e.target.value); setDoc(null); }}>{(names.data ?? []).map((n) => <option key={n} value={n}>{human(n)}</option>)}</select></Field>
          <Field label="Month (YYYY-MM)"><MonthInput value={f.month ?? ''} onChange={(e) => setF({ ...f, month: e.target.value })} /></Field>
          <Field label="Financial year"><input className="input" placeholder="e.g. 2026" value={f.year ?? ''} onChange={(e) => setF({ ...f, year: e.target.value })} /></Field>
          <Field label="From"><DateInput value={f.from ?? ''} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="To"><DateInput value={f.to ?? ''} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Member ID (statements)"><input className="input" value={f.memberId ?? ''} onChange={(e) => setF({ ...f, memberId: e.target.value })} /></Field>
        </div>
        {name === 'group_statement' && (() => {
          const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const t = new Date(); const y = t.getFullYear(); const m = t.getMonth();
          const presets: [string, Date, Date][] = [
            ['This month', new Date(y, m, 1), new Date(y, m + 1, 0)], ['Last month', new Date(y, m - 1, 1), new Date(y, m, 0)],
            ['This quarter', new Date(y, m - (m % 3), 1), new Date(y, m - (m % 3) + 3, 0)], ['This year', new Date(y, 0, 1), new Date(y, 11, 31)], ['Last year', new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)],
          ];
          return (
            <div className="rounded-lg bg-brand-50 p-3 text-sm text-brand-900 space-y-2">
              <p><b>Group statement.</b> Choose the period with From and To (it covers this year so far if left empty). It lists every invoice, payment, allocation, fine, saving, withdrawal, income, expense and meeting in that period, not just totals.</p>
              <div className="flex flex-wrap gap-2">{presets.map(([l, a, b]) => <button key={l} type="button" className="btn-ghost" onClick={() => setF({ ...f, from: iso(a), to: iso(b) })}>{l}</button>)}</div>
            </div>
          );
        })()}
        {name === 'member_report' && <p className="text-xs text-slate-500">Individual statement: enter the member's ID. From and To are optional and limit invoices and payments to that period.</p>}
        <ErrorBox msg={act.error} />
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={act.busy} onClick={async () => setDoc(await act.run(() => get(`/reports/${name}${qs()}`), ''))}>View report</button>
          <button className="btn-ghost" onClick={() => act.run(() => download(`/reports/${name}${qs()}&format=pdf`, `${name}.pdf`), '')}>PDF</button>
          <button className="btn-ghost" onClick={() => act.run(() => download(`/reports/${name}${qs()}&format=xlsx`, `${name}.xlsx`), '')}>Excel</button>
          <button className="btn-ghost" onClick={() => act.run(() => download(`/reports/${name}${qs()}&format=csv`, `${name}.csv`), '')}>CSV</button>
        </div>
      </div>
      {doc && (
        <div className="space-y-4"><h2 className="text-lg font-bold">{doc.title}</h2>{doc.subtitle && <p className="text-sm text-slate-500">{doc.subtitle}</p>}
          {doc.sections.map((s: any, i: number) => (
            <div key={i} className="space-y-2">{s.heading && <h3 className="font-semibold">{s.heading}</h3>}
              {s.summary && <div className="flex flex-wrap gap-4 text-sm">{s.summary.map((x: any) => <div key={x.label}><span className="text-slate-500">{x.label}: </span><b>{x.money ? kes(x.value) : x.value}</b></div>)}</div>}
              <Table rows={s.rows} columns={s.columns.map((c: any) => ({ key: c.key, label: c.label, align: c.type === 'money' || c.type === 'number' ? 'right' : undefined, render: (r: any) => cell(c, r[c.key]) }))} />
            </div>))}
        </div>
      )}
    </Page>
  );
}

const IMPORTS: Record<string, { label: string; cols: string; role: string[] }> = {
  members: { label: 'Members', cols: 'full_name (required). Optional: national_id, phone, mpesa_phone, email, physical_address, next_of_kin_name, next_of_kin_phone, registered_on', role: ['secretary', 'super_admin'] },
  historical_savings: { label: 'Historical savings', cols: 'membership_no, month (YYYY-MM), amount', role: ['treasurer', 'super_admin'] },
  previous_fines: { label: 'Previous fines', cols: 'membership_no, amount, date, reason [, paid]', role: ['treasurer', 'super_admin'] },
  opening_balances: { label: 'Opening balances', cols: 'membership_no, savings_balance [, fines_outstanding]', role: ['treasurer', 'super_admin'] },
  previous_attendance: { label: 'Previous attendance', cols: 'membership_no, meeting_date, status', role: ['secretary', 'super_admin'] },
};

export function Imports() {
  const { me } = useAuth();
  const kinds = Object.entries(IMPORTS).filter(([, v]) => v.role.includes(me!.role));
  const [kind, setKind] = useState(kinds[0]?.[0] ?? 'members');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [payload, setPayload] = useState<{ filename: string; dataBase64: string } | null>(null);
  const [strict, setStrict] = useState(false);
  const [result, setResult] = useState<any>(null);
  const act = useAction();
  const read = async () => {
    const buf = new Uint8Array(await file!.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const p = { filename: file!.name, dataBase64: btoa(bin) };
    setPayload(p); setResult(null); setPreview(await post(`/admin/imports/${kind}/preview`, { ...p, strict: kind === 'members' ? strict : undefined }));
  };
  return (
    <Page title="Historical data import" subtitle="Upload CSV or Excel, review every row, then confirm. Imported history is labelled and never counted as new contributions.">
      <div className="card space-y-3">
        <Field label="What are you importing?"><select className="input" value={kind} onChange={(e) => { setKind(e.target.value); setPreview(null); }}>{kinds.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <p className="text-xs text-slate-500">Required columns: {IMPORTS[kind]?.cols}</p>
        {kind === 'members' && (
          <label className="flex items-start gap-2 rounded-lg bg-brand-50 p-3 text-sm text-brand-900"><input type="checkbox" className="mt-1" checked={!strict} onChange={(e) => { setStrict(!e.target.checked); setPreview(null); }} />
            <span><b>Import as is, complete later.</b> Rows with a missing or invalid National ID or phone number are still imported and flagged as pending compliance. Original values are kept, and you complete each profile from the Members page. Untick to require every row to be complete.</span></label>
        )}
        <input type="file" accept=".csv,.xlsx" className="input" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setResult(null); }} />
        <ErrorBox msg={act.error} /><Notice msg={act.ok} />
        <button className="btn-primary" disabled={!file || act.busy} onClick={() => act.run(read, '')}>Preview</button>
      </div>
      {preview && (
        <div className="space-y-3">
          <div className="text-sm"><b>{preview.valid}</b> valid · <b className={preview.invalid ? 'text-red-600' : ''}>{preview.invalid}</b> with errors (of {preview.total})</div>
          <Table rows={preview.rows} columns={[{ key: 'line', label: 'Line' }, { key: 'data', label: 'Data', render: (r) => Object.values(r.data).join(' · ') }, { key: 'errors', label: 'Problems', render: (r) => <span className="text-red-600">{r.errors.join('; ')}</span> }, { key: 'warnings', label: 'Warnings', render: (r) => <span className="text-amber-700">{r.warnings.join('; ')}</span> }]} />
          <button className="btn-primary" disabled={act.busy || preview.invalid > 0} onClick={async () => { const r = await act.run(() => post(`/admin/imports/${kind}/commit`, { ...payload, strict: kind === 'members' ? strict : undefined }), 'Import committed.'); if (r) { setResult(r); setPreview(null); } }}>Confirm import of {preview.valid} rows{kind === 'members' && !strict && preview.rows.some((r: any) => r.warnings.length) ? ` (${preview.rows.filter((r: any) => r.warnings.length).length} pending compliance)` : ''}</button>
          {preview.invalid > 0 && <p className="text-xs text-slate-500">Fix the rows with problems in your file and upload again. Nothing is imported until all rows are valid.</p>}
        </div>
      )}
      {result && (
        <div className="space-y-3">
          <div className="card text-sm"><b>{result.imported}</b> imported.{result.pending?.length > 0 && <> <b>{result.pending.length}</b> are pending compliance and are listed under <i>Members &gt; Pending compliance only</i>.</>}</div>
          {result.credentials?.length > 0 && (
            <div className="card space-y-2"><h3 className="font-bold">Login details for new members</h3>
              <p className="text-xs text-amber-700">These temporary passwords are shown only now. Download the list and hand them over securely; members must change them at first login.</p>
              <button className="btn-ghost" onClick={() => {
                const rows = [['Member no.', 'Name', 'Phone', 'Temporary password'], ...result.credentials.map((c: any) => [c.membershipNo, c.name, c.phone, c.temporaryPassword])];
                const csv = rows.map((r) => r.map((v: string) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
                const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'new-member-logins.csv'; a.click();
              }}>Download logins (CSV)</button></div>
          )}
          {result.pending?.length > 0 && <Table rows={result.pending} columns={[{ key: 'membershipNo', label: 'Member' }, { key: 'name', label: 'Name' }, { key: 'missing', label: 'To complete' }]} />}
        </div>
      )}
    </Page>
  );
}
