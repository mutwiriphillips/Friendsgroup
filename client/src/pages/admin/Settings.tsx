import { useState } from 'react';
import { fileToUpload, post, put } from '../../api';
import { useAuth } from '../../auth';
import { dateFmt, dateTimeFmt, human, kes } from '../../format';
import { Badge, ErrorBox, Field, Notice, Page, Table, Tabs, useAction, useApi, DateInput } from '../../ui';

/** Switch for the late-payment and absence fines the system applies on its own. Fines raised by hand always still work. */
function AutoFines() {
  const settings = useApi<{ key: string; value: any }[]>('/admin/settings');
  const { me } = useAuth();
  const act = useAction();
  const [resume, setResume] = useState<any>(null);
  const v = settings.data?.find((x) => x.key === 'auto_fines')?.value ?? { enabled: true, from: null };
  const canEdit = me?.role === 'super_admin';
  const save = (value: any, reason: string) => act.run(async () => { await put('/admin/settings/auto_fines', { value, reason }); setResume(null); await settings.reload(); return true; }, 'Saved.');
  return (
    <div className={`card space-y-2 ${v.enabled ? '' : 'border-amber-300 bg-amber-50'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><b>Automatic fines: {v.enabled ? <span className="text-emerald-700">ON{v.from ? ` (for contributions due and meetings held from ${dateFmt(v.from)})` : ''}</span> : <span className="text-amber-800">SUSPENDED</span>}</b>
          <p className="text-sm text-slate-600">{v.enabled ? 'Late-payment fines and unexcused-absence fines are applied by the system.' : 'The system does not add late-payment or absence fines on its own. Contributions still show as overdue. You can still raise any fine by hand.'}</p></div>
        {canEdit && v.enabled && <button className="btn-ghost" disabled={act.busy} onClick={() => { const r = window.prompt('Reason for suspending automatic fines?'); if (r && r.trim().length >= 3) void save({ enabled: false, from: null }, r.trim()); }}>Suspend automatic fines</button>}
        {canEdit && !v.enabled && !resume && <button className="btn-primary" onClick={() => setResume({ from: new Date().toISOString().slice(0, 10), reason: '' })}>Turn automatic fines back on</button>}
      </div>
      <ErrorBox msg={act.error} /><Notice msg={act.ok} />
      {resume && (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-white p-3">
          <p className="text-sm">Choose the first date the rules apply. Only contributions due, and meetings held, <b>on or after</b> this date are fined automatically. Anything earlier is never fined retroactively.</p>
          <Field label="Automatic fines apply from"><DateInput value={resume.from} onChange={(e) => setResume({ ...resume, from: e.target.value })} /></Field>
          <Field label="Reason (recorded in the audit trail)"><input className="input" value={resume.reason} onChange={(e) => setResume({ ...resume, reason: e.target.value })} /></Field>
          <div className="flex gap-2"><button className="btn-ghost" onClick={() => setResume(null)}>Cancel</button><button className="btn-primary" disabled={act.busy || resume.reason.trim().length < 3} onClick={() => save({ enabled: true, from: resume.from }, resume.reason.trim())}>Turn on</button></div>
        </div>
      )}
    </div>
  );
}

/** Administrator-managed accounts: the system shows no amounts owed and never splits a deposit by itself. */
function AdminManaged() {
  const settings = useApi<{ key: string; value: any }[]>('/admin/settings');
  const { me } = useAuth();
  const act = useAction();
  const on = Boolean(settings.data?.find((x) => x.key === 'admin_managed')?.value?.enabled);
  const canEdit = me?.role === 'super_admin';
  const hide = Boolean(settings.data?.find((x) => x.key === 'hide_owed')?.value?.enabled);
  const toggleHide = () => { const r = window.prompt(hide ? 'Reason for showing amounts owed?' : 'Reason for hiding amounts owed?'); if (r && r.trim().length >= 3) void act.run(async () => { await put('/admin/settings/hide_owed', { value: { enabled: !hide }, reason: r.trim() }); await settings.reload(); window.location.reload(); return true; }, 'Saved.'); };
  const toggle = () => { const r = window.prompt(on ? 'Reason for switching administrator-managed accounts OFF?' : 'Reason for switching administrator-managed accounts ON?'); if (r && r.trim().length >= 3) void act.run(async () => { await put('/admin/settings/admin_managed', { value: { enabled: !on }, reason: r.trim() }); await settings.reload(); window.location.reload(); return true; }, 'Saved.'); };
  return (
    <div className={`card space-y-2 ${on ? 'border-brand-300 bg-brand-50' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><b>Administrator-managed accounts: {on ? <span className="text-emerald-700">ON</span> : <span className="text-slate-600">OFF</span>}</b>
          <p className="text-sm text-slate-600">{on ? 'The administrator decides what each member owes. Amounts owed are not shown, deposits are not split automatically, and no automatic overdue marking, fines or reminders run. A month\'s contribution falls due on the deadline day of the following month.' : 'The system works out what is owed and applies deposits automatically.'}</p></div>
        {canEdit && <button className="btn-ghost" disabled={act.busy} onClick={toggle}>{on ? 'Switch off' : 'Switch on'}</button>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-2">
        <div><b>Amounts owed: {hide ? <span className="text-slate-600">HIDDEN</span> : <span className="text-emerald-700">SHOWN</span>}</b>
          <p className="text-sm text-slate-600">{hide ? 'Unpaid months and amounts owed are hidden on the member portal and the admin screens.' : 'Unpaid months and amounts owed (from the invoices the administrator has raised) are shown to members and officials.'}</p></div>
        {canEdit && <button className="btn-ghost" disabled={act.busy} onClick={toggleHide}>{hide ? 'Show amounts owed' : 'Hide amounts owed'}</button>}
      </div>
      <ErrorBox msg={act.error} /><Notice msg={act.ok} />
    </div>
  );
}

function Rules() {
  const rules = useApi<any[]>('/admin/rules');
  const { me } = useAuth();
  const cur = rules.data?.[0];
  const [f, setF] = useState<any>(null);
  const act = useAction();
  const canEdit = me?.role === 'super_admin';
  const start = () => setF({ effectiveFrom: new Date(Date.now() + 32 * 864e5).toISOString().slice(0, 8) + '01', monthly: cur.monthly_amount_cents / 100, deadline: cur.deadline_day, late: cur.late_fine_cents / 100, absence: cur.absence_fine_cents / 100, meetings: cur.meetings_per_year, reason: '' });
  return (
    <div className="space-y-3">
      <AdminManaged />
      <AutoFines />
      {cur && <div className="grid gap-3 sm:grid-cols-5">{[['Monthly', kes(cur.monthly_amount_cents)], ['Deadline', `${cur.deadline_day}th`], ['Late fine', kes(cur.late_fine_cents)], ['Absence fine', kes(cur.absence_fine_cents)], ['Meetings / year', cur.meetings_per_year]].map(([l, v]) => <div key={l as string} className="card"><div className="label">{l}</div><div className="text-lg font-bold">{v}</div></div>)}</div>}
      <p className="text-xs text-slate-500">Changes apply from a future month only. Past obligations, fines and receipts keep the rules in force when they were created.</p>
      {canEdit && !f && cur && <button className="btn-ghost" onClick={start}>Propose a rule change</button>}
      {f && (
        <div className="card space-y-3"><ErrorBox msg={act.error} /><Notice msg={act.ok} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Effective from (1st of month)"><DateInput value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
            <Field label="Monthly (KSh)"><input className="input" type="number" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} /></Field>
            <Field label="Deadline day"><input className="input" type="number" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></Field>
            <Field label="Late fine (KSh)"><input className="input" type="number" value={f.late} onChange={(e) => setF({ ...f, late: e.target.value })} /></Field>
            <Field label="Absence fine (KSh)"><input className="input" type="number" value={f.absence} onChange={(e) => setF({ ...f, absence: e.target.value })} /></Field>
            <Field label="Meetings / year"><input className="input" type="number" value={f.meetings} onChange={(e) => setF({ ...f, meetings: e.target.value })} /></Field>
          </div>
          <Field label="Reason (recorded in audit trail)"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <button className="btn-primary" disabled={act.busy} onClick={async () => { if (await act.run(() => post('/admin/rules', { effectiveFrom: f.effectiveFrom, monthlyAmountCents: Math.round(f.monthly * 100), deadlineDay: Number(f.deadline), lateFineCents: Math.round(f.late * 100), absenceFineCents: Math.round(f.absence * 100), meetingsPerYear: Number(f.meetings), reason: f.reason }), 'Rule change saved.')) { setF(null); rules.reload(); } }}>Save rule change</button></div>
      )}
      <h3 className="font-bold">History</h3>
      <Table rows={rules.data ?? []} columns={[{ key: 'effective_from', label: 'Effective', render: (r) => dateFmt(r.effective_from) }, { key: 'monthly_amount_cents', label: 'Monthly', align: 'right', render: (r) => kes(r.monthly_amount_cents) }, { key: 'deadline_day', label: 'Deadline' }, { key: 'late_fine_cents', label: 'Late', align: 'right', render: (r) => kes(r.late_fine_cents) }, { key: 'absence_fine_cents', label: 'Absence', align: 'right', render: (r) => kes(r.absence_fine_cents) }, { key: 'reason', label: 'Reason' }]} />
    </div>
  );
}

function Users() {
  const users = useApi<any[]>('/admin/users');
  const act = useAction();
  const [f, setF] = useState({ email: '', role: 'secretary' });
  const [temp, setTemp] = useState('');
  const reset = async (id: string) => { const r = await act.run(() => post(`/admin/users/${id}/reset-password`), 'Password reset.'); if (r) setTemp(r.temporaryPassword); };
  return (
    <div className="space-y-3"><ErrorBox msg={act.error} />{temp && <div className="rounded-lg bg-amber-50 p-3 text-sm">Temporary password (shown once): <b className="font-mono">{temp}</b></div>}
      <div className="card flex flex-wrap items-end gap-3"><Field label="Email"><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role"><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{['chairperson', 'treasurer', 'secretary', 'super_admin'].map((r) => <option key={r} value={r}>{human(r)}</option>)}</select></Field>
        <button className="btn-primary" disabled={act.busy} onClick={async () => { const r = await act.run(() => post('/admin/users', f), 'Official added.'); if (r) { setTemp(r.temporaryPassword); users.reload(); } }}>Add official</button></div>
      <Table rows={users.data ?? []} columns={[{ key: 'email', label: 'Email' }, { key: 'role', label: 'Role', render: (r) => human(r.role) }, { key: 'is_active', label: 'Active', render: (r) => <Badge value={r.is_active ? 'active' : 'suspended'} /> }, { key: 'last_login', label: 'Last login', render: (r) => dateTimeFmt(r.last_login) },
        { key: 'x', label: '', render: (r) => (<div className="flex gap-3 whitespace-nowrap"><button className="text-brand-700 underline" onClick={() => reset(r.id)}>Reset password</button><button className="text-red-600 underline" onClick={async () => { const reason = window.prompt(r.is_active ? 'Reason for deactivating?' : 'Reason for reactivating?'); if (!reason) return; await act.run(() => post(`/admin/users/${r.id}/active`, { active: !r.is_active, reason }), 'Updated.'); users.reload(); }}>{r.is_active ? 'Deactivate' : 'Activate'}</button></div>) }]} />
    </div>
  );
}

function Communications() {
  const act = useAction(); const [f, setF] = useState({ title: '', body: '', sms: false });
  return (
    <div className="space-y-4"><ErrorBox msg={act.error} /><Notice msg={act.ok} />
      <div className="card space-y-3"><h3 className="font-bold">Announcement to all members</h3>
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Message"><textarea className="input" rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={f.sms} onChange={(e) => setF({ ...f, sms: e.target.checked })} />Also send by SMS</label>
        <button className="btn-primary" disabled={act.busy} onClick={async () => { const r = await act.run(() => post('/admin/announcements', f), 'Sent.'); if (r) setF({ title: '', body: '', sms: false }); }}>Send announcement</button></div>
      <p className="text-sm text-slate-600">Looking for the constitution, certificate of registration or minutes? They now live under <a className="text-brand-700 underline" href="/admin/records">Records &amp; documents</a>.</p>
    </div>
  );
}

function System() {
  const { data: mp } = useApi<any>('/admin/mpesa/status');
  const years = useApi<any[]>('/admin/financial-years');
  const act = useAction(); const [y, setY] = useState({ label: '', startDate: '', endDate: '' });
  return (
    <div className="space-y-4"><ErrorBox msg={act.error} /><Notice msg={act.ok} />
      <div className="card space-y-2 text-sm"><h3 className="font-bold">M-Pesa connection</h3>
        {mp ? <><div>Status: <Badge value={mp.configured ? 'active' : 'pending'} /> {mp.configured ? `(${mp.environment})` : 'Not configured: add Daraja credentials in the server environment.'}</div>
          <div>HTTPS public URL: {mp.httpsBaseUrl ? 'yes' : 'No — M-Pesa callbacks need https'}</div>
          {mp.configured && <button className="btn-ghost" onClick={() => act.run(() => post('/admin/mpesa/register-c2b'), 'Paybill URLs registered with Safaricom.')}>Register Paybill (C2B) URLs</button>}</> : <p>Only the super admin can see this.</p>}</div>
      <div className="card space-y-3"><h3 className="font-bold">Financial years</h3>
        <div className="grid gap-3 sm:grid-cols-4"><Field label="Label"><input className="input" value={y.label} onChange={(e) => setY({ ...y, label: e.target.value })} placeholder="2027" /></Field><Field label="Start"><DateInput value={y.startDate} onChange={(e) => setY({ ...y, startDate: e.target.value })} /></Field><Field label="End"><DateInput value={y.endDate} onChange={(e) => setY({ ...y, endDate: e.target.value })} /></Field>
          <div className="pt-5"><button className="btn-primary" onClick={async () => { await act.run(() => post('/admin/financial-years', y), 'Added.'); years.reload(); }}>Add year</button></div></div>
        <Table rows={years.data ?? []} columns={[{ key: 'label', label: 'Year' }, { key: 'start_date', label: 'Start', render: (r) => dateFmt(r.start_date) }, { key: 'end_date', label: 'End', render: (r) => dateFmt(r.end_date) }, { key: 'is_current', label: 'Current', render: (r) => (r.is_current ? 'Yes' : '') }]} /></div>
      <div className="card space-y-2"><h3 className="font-bold">Generate this month's obligations</h3><p className="text-xs text-slate-500">This also runs automatically every day; running it again is safe.</p>
        <button className="btn-ghost" onClick={() => act.run(() => post('/finance/obligations/generate', { period: new Date().toISOString().slice(0, 7) }), 'Obligations are up to date.')}>Run now</button></div>
    </div>
  );
}

export function Settings() {
  const { me } = useAuth();
  const [tab, setTab] = useState('rules');
  const tabs: [string, string][] = [['rules', 'Group rules'], ['comms', 'Announcements & documents']];
  if (me?.role === 'super_admin') tabs.push(['users', 'Officials'], ['system', 'System & M-Pesa']);
  void put;
  return (
    <Page title="Settings">
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'rules' ? <Rules /> : tab === 'comms' ? <Communications /> : tab === 'users' ? <Users /> : <System />}
    </Page>
  );
}

export function Audit() {
  const [action, setAction] = useState('');
  const { data, error } = useApi<any[]>(`/admin/audit?limit=200&action=${encodeURIComponent(action)}`, [action]);
  const logins = useApi<any[]>('/admin/logins');
  const [tab, setTab] = useState('audit');
  return (
    <Page title="Audit trail" subtitle="Permanent and append-only. Entries cannot be edited or deleted.">
      <Tabs value={tab} onChange={setTab} tabs={[['audit', 'Actions'], ['logins', 'Sign-ins']]} />
      <ErrorBox msg={error} />
      {tab === 'audit' ? (
        <>
          <input className="input max-w-xs" placeholder="Filter by action, e.g. payment" value={action} onChange={(e) => setAction(e.target.value)} />
          <Table rows={data ?? []} columns={[{ key: 'at', label: 'When', render: (r) => dateTimeFmt(r.at) }, { key: 'user_email', label: 'Who', render: (r) => r.user_email ?? human(r.user_role ?? 'system') }, { key: 'action', label: 'Action' }, { key: 'entity_type', label: 'Record', render: (r) => `${r.entity_type} ${String(r.entity_id ?? '').slice(0, 8)}` }, { key: 'reason', label: 'Reason' }]} />
        </>
      ) : (
        <Table rows={logins.data ?? []} columns={[{ key: 'at', label: 'When', render: (r) => dateTimeFmt(r.at) }, { key: 'identifier', label: 'Identifier' }, { key: 'success', label: 'Result', render: (r) => <Badge value={r.success ? 'confirmed' : 'failed'} /> }, { key: 'ip', label: 'IP' }]} />
      )}
    </Page>
  );
}
