import { useState } from 'react';
import { download, fileToUpload, post } from '../../api';
import { useAuth } from '../../auth';
import { dateFmt } from '../../format';
import { ErrorBox, Loading, Notice, Page, useAction, useApi } from '../../ui';

const colPx = (w: number) => Math.max(28, Math.round(w * 7 + 5));

export default function GroupSheet() {
  const { me } = useAuth();
  const canManage = me?.role === 'secretary' || me?.role === 'super_admin';
  const [ver, setVer] = useState('');
  const [tab, setTab] = useState(0);
  const { data, error, reload } = useApi<any>(`/admin/group-sheet${ver ? `?id=${ver}` : ''}`);
  const act = useAction();
  const [file, setFile] = useState<File | null>(null);
  if (error) return <ErrorBox msg={error} />;
  if (!data) return <Loading />;
  const doc = data.document; const sheet = data.sheets[Math.min(tab, data.sheets.length - 1)];
  const upload = async () => {
    const up = await fileToUpload(file!);
    if (!/\.xlsx$/i.test(file!.name)) { act.setError('Upload the Excel file (.xlsx).'); return; }
    const body = { title: 'Group sheet (Excel)', category: 'group_sheet', visibility: 'officials', documentDate: new Date().toISOString().slice(0, 10), supersedesId: doc?.status === 'current' ? doc.id : undefined, file: { ...up, mimeType: up.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } };
    if (await act.run(() => post('/admin/documents', body), 'Sheet saved.')) { setFile(null); setVer(''); setTab(0); reload(); }
  };
  return (
    <Page title="Group sheet" subtitle="The group's own Excel file, kept as an official record and shown exactly as it is: same cells, merged headings, colours and numbers. Uploading a new file keeps the old one as a previous version."
      actions={doc && <button className="btn-ghost" onClick={() => act.run(() => download(`/files/${doc.file_id}`, doc.file_name), '')}>Open in Excel (download)</button>}>
      <ErrorBox msg={act.error} /><Notice msg={act.ok} />
      {canManage && (
        <div className="card flex flex-wrap items-center gap-3">
          <input className="input max-w-sm" type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="btn-primary" disabled={!file || act.busy} onClick={upload}>{doc ? 'Upload updated sheet' : 'Upload the sheet'}</button>
        </div>
      )}
      {!doc ? <p className="py-8 text-center text-sm text-slate-500">No sheet uploaded yet.</p> : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span><b>{doc.file_name}</b> · version {doc.version} · saved {dateFmt(doc.document_date)}</span>
            {data.versions.length > 1 && (
              <select className="input max-w-[16rem]" value={doc.id} onChange={(e) => { setVer(e.target.value); setTab(0); }}>
                {data.versions.map((v: any) => <option key={v.id} value={v.id}>Version {v.version} · {dateFmt(v.document_date)}{v.status === 'current' ? ' (current)' : ''}</option>)}
              </select>
            )}
          </div>
          {data.sheets.length > 1 && <div className="flex gap-2">{data.sheets.map((s: any, i: number) => <button key={s.name} className={i === tab ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab(i)}>{s.name}</button>)}</div>}
          {sheet && (
            <div className="max-h-[72vh] overflow-auto rounded-xl border border-slate-300 bg-white">
              <table className="border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
                <colgroup><col style={{ width: 36 }} />{sheet.widths.map((w: number, i: number) => <col key={i} style={{ width: colPx(w) }} />)}</colgroup>
                <thead className="sticky top-0 z-10"><tr><th className="border border-slate-300 bg-slate-100" />{sheet.widths.map((_: number, i: number) => <th key={i} className="border border-slate-300 bg-slate-100 px-1 font-normal text-slate-500">{colName(i)}</th>)}</tr></thead>
                <tbody>
                  {sheet.rows.map((r: any, ri: number) => (
                    <tr key={ri} style={r.h ? { height: r.h * 1.33 } : undefined}>
                      <th className="sticky left-0 border border-slate-300 bg-slate-100 px-1 text-center font-normal text-slate-500">{ri + 1}</th>
                      {r.cells.map((c: any, ci: number) => c && (
                        <td key={ci} colSpan={c.cs} rowSpan={c.rs}
                          className={`overflow-hidden px-1 py-0.5 align-middle ${c.bd ? 'border border-slate-400' : 'border border-slate-200'}`}
                          style={{ fontWeight: c.b ? 700 : undefined, fontStyle: c.i ? 'italic' : undefined, color: c.c, background: c.bg, textAlign: c.al ?? (c.n ? 'right' : 'left'), whiteSpace: c.cs ? 'normal' : 'nowrap', textOverflow: 'ellipsis' }}>{c.t}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sheet?.truncated && <p className="text-xs text-amber-700">Only the first 1,000 rows and 120 columns are shown here. The downloaded file has everything.</p>}
          <p className="text-xs text-slate-500">This is a read-only view of the uploaded file. To edit, open it in Excel and upload the updated file here, or use the Member ledger for cell-by-cell edits with an audit trail.</p>
        </>
      )}
    </Page>
  );
}
function colName(i: number) { let n = i + 1, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
