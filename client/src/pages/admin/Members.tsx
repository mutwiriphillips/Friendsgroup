import { useState } from 'react';
import { download, get, patch, post } from '../../api';
import { useAuth } from '../../auth';
import { dateFmt, kes, monthFmt } from '../../format';
import { NextOfKinPanel } from '../NextOfKin';
import { Avatar, MemberDocuments } from '../MemberDocuments';
import { AllocateModal, PaymentModal, RaiseInvoiceModal } from './Ledger';
import { EditFineModal, EditInvoiceModal, EditPaymentModal } from './Corrections';
import { Badge, ErrorBox, Field, Modal, Notice, Page, Table, useAction, useApi, DateInput } from '../../ui';

function Register({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ fullName: '', nationalId: '', phone: '', mpesaPhone: '', email: '', registeredOn: new Date().toISOString().slice(0, 10) });
  const act = useAction();
  const [result, setResult] = useState<any>(null);
  const [later, setLater] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Register member" onClose={result ? () => { onDone(); onClose(); } : onClose}>
      {result ? (
        <div className="space-y-3 text-sm"><Notice msg={`Member ${result.membershipNo ?? ''} registered.`} />
          {result.issues?.length > 0 && <p className="rounded-lg bg-amber-50 p-2 text-amber-800">Pending compliance: {result.issues.join('; ')}. Complete the profile later from the member's page.</p>}
          {result.temporaryPassword ? <><p>Give the member this temporary password. It is shown only once; they must change it at first login.</p>
          <div className="rounded-lg bg-slate-100 p-3 text-center font-mono text-lg">{result.temporaryPassword}</div></> : <p>No portal login yet: it is created when a phone number or email is added.</p>}
          <button className="btn-primary w-full" onClick={() => { onDone(); onClose(); }}>Done</button></div>
      ) : (
        <div className="space-y-3"><ErrorBox msg={act.error} />
          <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900"><input type="checkbox" className="mt-0.5" checked={later} onChange={(e) => setLater(e.target.checked)} />Register with what I have and complete the rest later (only the name is required). The member is flagged as pending compliance.</label>
          <Field label="Full name"><input className="input" value={f.fullName} onChange={set('fullName')} /></Field>
          <Field label="National ID"><input className="input" value={f.nationalId} onChange={set('nationalId')} /></Field>
          <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} placeholder="07xx xxx xxx" /></Field>
          <Field label="M-Pesa phone (if different)"><input className="input" value={f.mpesaPhone} onChange={set('mpesaPhone')} /></Field>
          <Field label="Email (optional)"><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Registration date"><DateInput value={f.registeredOn} onChange={set('registeredOn')} /></Field>
          <button className="btn-primary w-full" disabled={act.busy} onClick={async () => { const r = await act.run(() => post('/members', { ...f, mpesaPhone: f.mpesaPhone || undefined, email: f.email || undefined, nationalId: f.nationalId || undefined, phone: f.phone || undefined, completeLater: later }), ''); if (r) setResult(r); }}>Register</button></div>
      )}
    </Modal>
  );
}

export function Detail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { me } = useAuth();
  const { data: m, reload } = useApi<any>(`/members/${id}`);
  const act = useAction();
  const [edit, setEdit] = useState<any>(null);
  const [cp, setCp] = useState<any>(null);
  const [issued, setIssued] = useState('');
  const ov = useApi<any>(`/members/${id}/overview`);
  const [nokOpen, setNokOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [invOpen, setInvOpen] = useState(false);
  const [credOpen, setCredOpen] = useState(false);
  const [fixFine, setFixFine] = useState<any>(null);
  const [fixInv, setFixInv] = useState<any>(null);
  const [fixPay, setFixPay] = useState<any>(null);
  const [tab, setTab] = useState<'owed' | 'invoices' | 'months' | 'penalties' | 'manual'>(me?.hide_owed ? 'invoices' : 'owed');
  const isAdmin = me?.role === 'super_admin';
  if (!m) return <Modal title="Member" onClose={onClose}><p className="text-sm">Loading…</p></Modal>;
  const canWrite = me?.role === 'secretary' || me?.role === 'super_admin';
  const canStatus = me?.role === 'chairperson' || me?.role === 'super_admin' || me?.role === 'secretary';
  const setStatus = async (status: string) => {
    const reason = window.prompt(`Reason for changing status to ${status}?`);
    if (!reason) return;
    await act.run(() => post(`/members/${id}/status`, { status, reason }), 'Status updated.'); reload(); onChange();
  };
  return (
    <Modal title={`${m.membership_no} · ${m.full_name}`} onClose={onClose}>
      <div className="space-y-3 text-sm"><ErrorBox msg={act.error} /><Notice msg={act.ok} />
        <div className="flex items-center gap-3"><Avatar fileId={m.photo_file_id} name={m.full_name} size={72} /><div><div className="text-lg font-bold">{m.full_name}</div><div className="text-slate-500">{m.membership_no}</div></div></div>
        <div className="grid grid-cols-2 gap-2">
          <div><div className="label">Status</div><Badge value={m.status} /></div><div><div className="label">Registered</div>{dateFmt(m.registered_on)}</div>
          <div><div className="label">Phone</div>{m.phone}</div><div><div className="label">M-Pesa</div>{m.mpesa_phone}</div>
          <div><div className="label">National ID</div>{m.nationalId ?? <span className="text-amber-700">Not on file</span>}</div><div><div className="label">Email</div>{m.email ?? '—'}</div>
          <div><div className="label">Savings</div><b>{kes(m.summary.savings.balanceCents)}</b></div>{!me?.hide_owed && <div><div className="label">Fines owed</div><b>{kes(m.summary.fines.outstandingCents)}</b></div>}
        </div>
        <p className="text-xs text-slate-400">Viewing the National ID is recorded in the audit trail.</p>
        {ov.data && (() => { const t = ov.data.totals; return (
          <div className="space-y-3 rounded-xl border border-slate-200 p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg bg-brand-50 p-2"><div className="label">Total contributions</div><b className="text-base">{kes(t.contributionsCents)}</b><div className="text-[11px] text-slate-500">{t.monthsPaid} months paid</div></div>
              <div className="rounded-lg bg-amber-50 p-2"><div className="label">Penalties accrued</div><b className="text-base">{kes(t.penaltiesAccruedCents)}</b><div className="text-[11px] text-slate-500">Paid {kes(t.penaltiesPaidCents)}</div></div>
              {!me?.hide_owed && <div className="rounded-lg bg-red-50 p-2"><div className="label">Penalties outstanding</div><b className="text-base text-red-700">{kes(t.penaltiesOutstandingCents)}</b></div>}
              {ov.data.owed.creditCents > 0 && <div className="rounded-lg bg-blue-50 p-2"><div className="label">Received, not yet allocated</div><b className="text-base text-blue-700">{kes(ov.data.owed.creditCents)}</b>{isAdmin && <div><button className="text-[11px] text-blue-700 underline" onClick={() => setCredOpen(true)}>Choose invoices</button></div>}</div>}
              <div className="rounded-lg bg-slate-50 p-2"><div className="label">Savings balance</div><b className="text-base">{kes(t.balanceCents)}</b>{t.withdrawnCents > 0 && <div className="text-[11px] text-slate-500">Withdrawn {kes(t.withdrawnCents)}</div>}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold">Individual report:</span>
              {(['pdf', 'xlsx', 'csv'] as const).map((f) => <button key={f} className="btn-ghost !px-3 !py-1" onClick={() => act.run(() => download(`/reports/member_report?memberId=${id}&format=${f}`, `member-report-${m.membership_no}.${f}`), '')}>{f === 'xlsx' ? 'Excel' : f.toUpperCase()}</button>)}
              {isAdmin && <><button className="btn-ghost ml-auto !px-3 !py-1" onClick={() => setInvOpen(true)}>Raise invoice</button><button className="btn-primary !px-3 !py-1" onClick={() => setPayOpen(true)}>Post a payment</button></>}
            </div>
            <div className="flex gap-3 border-b text-xs">{([...(me?.hide_owed ? [] : [['owed', `Owed (${ov.data.owed.invoices.length})`] as const]), ['invoices', `Invoices posted (${ov.data.invoices.length})`], ['months', 'Contributions by month'], ['penalties', `Penalties (${ov.data.penalties.length})`], ['manual', `Entered by hand (${ov.data.manual.length})`]] as const).map(([k, l]) => <button key={k} className={`pb-1 ${tab === k ? 'border-b-2 border-brand-600 font-semibold' : 'text-slate-500'}`} onClick={() => setTab(k)}>{l}</button>)}</div>
            <div className="max-h-56 overflow-auto text-xs">
              {tab === 'owed' && (ov.data.owed.invoices.length ? <><table className="w-full"><tbody>{ov.data.owed.invoices.map((r: any) => <tr key={r.kind + r.id} className="border-b border-slate-100"><td className="py-1">{r.label}</td><td className="text-slate-500">{r.kind === 'contribution' ? (r.upcoming ? 'upcoming' : 'contribution') : r.kind === 'late_fine' ? 'late fine' : r.kind === 'meeting_fine' ? 'meeting fine' : 'penalty'}</td><td className="text-right font-semibold">{kes(r.amountCents)}</td>{isAdmin && <td className="pl-2 text-right"><button className="text-brand-700 underline" onClick={() => r.kind === 'contribution' ? setFixInv(r) : setFixFine({ ...(ov.data.penalties.find((p: any) => p.id === r.id) ?? {}), id: r.id })}>Edit</button></td>}</tr>)}</tbody></table><div className="mt-2 text-right font-semibold">Owes the group now: {kes(ov.data.owed.totalCents)}</div></> : <p className="text-green-700">Nothing owed. All invoices are cleared.</p>)}
              {tab === 'invoices' && (ov.data.invoices.length ? <table className="w-full"><thead><tr className="text-left text-slate-500"><th className="py-1">Month</th><th>Invoice</th><th className="text-right">Amount</th><th className="pl-3">Status</th><th className="pl-3">Paid on</th></tr></thead><tbody>{ov.data.invoices.map((r: any) => <tr key={r.kind + r.id} className="border-b border-slate-100"><td className="py-1 whitespace-nowrap">{monthFmt(r.month)}</td><td>{r.label}</td><td className="text-right">{kes(r.amount_cents)}</td><td className={`pl-3 ${r.status === 'unpaid' ? 'font-semibold text-red-600' : 'text-slate-600'}`}>{r.status}</td><td className="pl-3 whitespace-nowrap">{r.paid_at ? dateFmt(r.paid_at) : '—'}</td></tr>)}</tbody></table> : <p className="text-slate-500">No invoices posted yet.</p>)}
              {tab === 'months' && (ov.data.months.length ? <table className="w-full"><tbody>{ov.data.months.map((r: any) => <tr key={r.period} className="border-b border-slate-100"><td className="py-1">{monthFmt(r.period)}</td><td className="text-right">{kes(r.amount_cents)}</td><td className="pl-3 font-mono text-slate-500">{r.reference ?? ''}</td></tr>)}</tbody></table> : <p className="text-slate-500">No contributions recorded yet.</p>)}
              {tab === 'penalties' && isAdmin && ov.data.penalties.some((r: any) => r.status === 'outstanding') && <div className="mb-1 text-right"><button className="text-red-700 underline" onClick={async () => { const note = window.prompt('Clear all of this member\'s outstanding fines so you can post them afresh. Reason?'); if (!note) return; await act.run(() => post('/admin/fines/clear', { memberId: id, note }), 'Outstanding fines cleared.'); ov.reload(); reload(); onChange(); }}>Clear outstanding fines</button></div>}
              {tab === 'penalties' && (ov.data.penalties.length ? <table className="w-full"><tbody>{ov.data.penalties.map((r: any) => <tr key={r.reference} className="border-b border-slate-100"><td className="py-1">{dateFmt(r.imposed_on)}</td><td>{r.reason}</td><td className="text-right">{kes(r.amount_cents)}</td><td className={`pl-3 ${r.status === 'outstanding' ? 'font-semibold text-red-600' : 'text-slate-500'}`}>{r.status}</td>{isAdmin && <td className="pl-2 text-right"><button className="text-brand-700 underline" onClick={() => setFixFine(r)}>Edit</button></td>}</tr>)}</tbody></table> : <p className="text-slate-500">No penalties.</p>)}
              {tab === 'manual' && (ov.data.manual.length ? <table className="w-full"><tbody>{ov.data.manual.map((r: any) => <tr key={r.id} className={`border-b border-slate-100 align-top ${r.reversed_at ? 'text-slate-400 line-through' : ''}`}><td className="py-1 whitespace-nowrap">{dateFmt(r.paid_on)}</td><td className="text-right">{kes(r.amount_cents)}</td><td className="pl-3 font-mono">{r.mpesa_code}</td><td className="pl-3 text-slate-600">{r.transaction_message}</td>{isAdmin && <td className="pl-2 text-right no-underline">{r.reversed_at ? <span className="text-[11px] italic">reversed</span> : <button className="text-brand-700 underline" onClick={() => setFixPay(r)}>Edit</button>}</td>}</tr>)}</tbody></table> : <p className="text-slate-500">No payments entered by hand.</p>)}
            </div>
          </div>); })()}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
          <span><b>Next of Kin form:</b> {m.missing_nok ? <span className="font-semibold text-red-700">not submitted</span> : <span className="font-semibold text-emerald-700">submitted</span>}</span>
          <button className="btn-ghost" onClick={() => setNokOpen(true)}>{m.missing_nok ? 'Open form' : 'View, amend or download'}</button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
          <span><b>Photo and ID card:</b> {[m.photo_file_id, m.id_front_file_id, m.id_back_file_id].filter(Boolean).length} of 3 uploaded</span>
          <button className="btn-ghost" onClick={() => setDocsOpen(true)}>View or upload</button>
        </div>
        {docsOpen && <Modal wide title={`Photo and ID: ${m.full_name}`} onClose={() => { setDocsOpen(false); reload(); onChange(); }}><MemberDocuments mode="admin" memberId={id} /></Modal>}
        {nokOpen && <Modal wide title={`Next of Kin form: ${m.full_name}`} onClose={() => { setNokOpen(false); reload(); onChange(); }}><NextOfKinPanel mode="admin" memberId={id} /></Modal>}
        {invOpen && <RaiseInvoiceModal members={[{ id, name: m.full_name }]} preset={id} onClose={() => setInvOpen(false)} onDone={() => { ov.reload(); reload(); onChange(); }} />}
        {fixFine && <EditFineModal fine={fixFine} onClose={() => setFixFine(null)} onDone={() => { ov.reload(); reload(); onChange(); }} />}
        {fixInv && <EditInvoiceModal inv={fixInv} onClose={() => setFixInv(null)} onDone={() => { ov.reload(); reload(); onChange(); }} />}
        {fixPay && <EditPaymentModal pay={fixPay} onClose={() => setFixPay(null)} onDone={() => { ov.reload(); reload(); onChange(); }} />}
        {credOpen && <AllocateModal members={[{ id, name: m.full_name }]} preset={id} onClose={() => setCredOpen(false)} onDone={() => { ov.reload(); reload(); onChange(); }} />}
        {payOpen && <PaymentModal onAllocate={() => { setPayOpen(false); setCredOpen(true); }} members={[{ id, name: m.full_name }]} preset={id} onClose={() => setPayOpen(false)} onDone={() => { ov.reload(); reload(); onChange(); }} />}
        {!m.profile_complete && (
          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <div className="font-semibold text-amber-900">Non-compliant: {[m.missing_national_id && 'National ID', m.missing_phone && 'phone number', m.missing_nok && 'Next of Kin form'].filter(Boolean).join(', ')} missing</div>
            {m.import_issues?.issues?.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-900">{m.import_issues.issues.map((i: string) => <li key={i}>{i}</li>)}</ul>}
            {m.import_issues?.raw && Object.keys(m.import_issues.raw).length > 0 && <div className="text-xs text-slate-600">As supplied: {Object.entries(m.import_issues.raw).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>}
            <p className="text-xs text-amber-900">Until complete, this member cannot request withdrawals.</p>
            {!cp && canWrite && (m.missing_national_id || m.missing_phone) && <button className="btn-primary" onClick={() => setCp({ nationalId: '', phone: '', email: '', physicalAddress: '' })}>Complete profile</button>}
            {cp && <div className="space-y-2">
              {m.missing_national_id && <Field label="National ID"><input className="input" value={cp.nationalId} onChange={(e) => setCp({ ...cp, nationalId: e.target.value })} /></Field>}
              {m.missing_phone && <Field label="Phone"><input className="input" value={cp.phone} onChange={(e) => setCp({ ...cp, phone: e.target.value })} /></Field>}
              <Field label="Email (optional)"><input className="input" value={cp.email} onChange={(e) => setCp({ ...cp, email: e.target.value })} /></Field>
              <Field label="Address (optional)"><input className="input" value={cp.physicalAddress} onChange={(e) => setCp({ ...cp, physicalAddress: e.target.value })} /></Field>
              <button className="btn-primary" disabled={act.busy} onClick={async () => {
                const body = Object.fromEntries(Object.entries(cp).filter(([, v]) => v));
                const r = await act.run(() => post(`/members/${id}/complete-profile`, body), 'Details saved.');
                if (r) { setCp(null); if (r.temporaryPassword) setIssued(r.temporaryPassword); reload(); onChange(); }
              }}>Save details</button></div>}
          </div>
        )}
        {issued && <div className="rounded-lg bg-slate-100 p-3 text-center text-xs">A portal login was created. Temporary password (shown once): <b className="font-mono text-base">{issued}</b></div>}
        {canWrite && !edit && <button className="btn-ghost" onClick={() => setEdit({ fullName: m.full_name, phone: m.phone, mpesaPhone: m.mpesa_phone, email: m.email ?? '', registeredOn: m.registered_on ?? '' })}>Edit details</button>}
        {edit && <div className="space-y-2">{(['fullName', 'phone', 'mpesaPhone', 'email'] as const).map((k) => <Field key={k} label={k}><input className="input" value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>)}<Field label="Registration date"><DateInput value={edit.registeredOn} onChange={(e) => setEdit({ ...edit, registeredOn: e.target.value })} /></Field>
          <button className="btn-primary" onClick={async () => { await act.run(() => patch(`/members/${id}`, { ...edit, email: edit.email || null, registeredOn: edit.registeredOn || undefined }), 'Saved.'); setEdit(null); reload(); onChange(); }}>Save</button></div>}
        {canStatus && <div className="flex flex-wrap gap-2 border-t pt-3">{['active', 'suspended', 'withdrawn', 'deceased'].filter((s) => s !== m.status).map((s) => <button key={s} className="btn-ghost" onClick={() => setStatus(s)}>Mark {s}</button>)}</div>}
      </div>
    </Modal>
  );
}

export default function Members() {
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [incomplete, setIncomplete] = useState(false);
  const { data, loading, error, reload } = useApi<any[]>(`/members?q=${encodeURIComponent(q)}&status=${status}&incomplete=${incomplete ? 1 : 0}`);
  const { me } = useAuth();
  const [reg, setReg] = useState(false); const [sel, setSel] = useState('');
  void get;
  const [msg, setMsg] = useState('');
  // Secretary and super admin also keep a dated copy of each export in Records & documents.
  const exp = async (fmt: 'csv' | 'xlsx') => {
    setMsg('');
    try {
      const keep = me?.role === 'secretary' || me?.role === 'super_admin' ? '&archive=1' : '';
      await download(`/reports/membership_register?format=${fmt}&status=${status}${keep}`, `membership-register.${fmt}`);
      setMsg(keep ? 'Exported, and a dated copy was saved in Records & documents.' : 'Exported.');
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <Page title="Members" actions={<>
      <button className="btn-ghost" onClick={() => exp('csv')}>Export CSV</button><button className="btn-ghost" onClick={() => exp('xlsx')}>Export Excel</button>
      {(me?.role === 'secretary' || me?.role === 'super_admin') && <button className="btn-primary" onClick={() => setReg(true)}>Register member</button>}</>}>
      <div className="flex flex-wrap gap-2"><input className="input max-w-xs" placeholder="Search name, number or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-[10rem]" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['active', 'suspended', 'withdrawn', 'deceased'].map((s) => <option key={s}>{s}</option>)}</select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={incomplete} onChange={(e) => setIncomplete(e.target.checked)} />Pending compliance only</label></div>
      <ErrorBox msg={error} />{msg && <p className="text-sm text-slate-600">{msg}</p>}
      {loading && !data ? <p className="text-sm">Loading…</p> : (
        <Table rows={data ?? []} columns={[{ key: 'membership_no', label: 'No.' }, { key: 'full_name', label: 'Name', render: (r) => <button className="text-brand-700 underline" onClick={() => setSel(r.id)}>{r.full_name}</button> }, { key: 'phone', label: 'Phone', render: (r) => r.phone ?? <span className="text-amber-700">Missing</span> }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'profile_complete', label: 'Profile', render: (r) => (r.profile_complete ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">Compliant</span> : <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">Non-compliant</span>) }, { key: 'savings_cents', label: 'Savings', align: 'right', render: (r) => kes(r.savings_cents) }, { key: 'fines_outstanding_cents', label: 'Fines owed', align: 'right', render: (r) => kes(r.fines_outstanding_cents) }]} />
      )}
      {reg && <Register onClose={() => setReg(false)} onDone={reload} />}
      {sel && <Detail id={sel} onClose={() => setSel('')} onChange={reload} />}
    </Page>
  );
}
