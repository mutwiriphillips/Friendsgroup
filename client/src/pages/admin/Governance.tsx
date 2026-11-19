import { useState } from 'react';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { dateFmt, dateTimeFmt, human, kes } from '../../format';
import { EditFineModal, EditMeetingModal } from './Corrections';
import { Badge, ErrorBox, Field, Modal, Notice, Page, Table, useAction, useApi, DateTimeInput } from '../../ui';

export function Fines() {
  const { me } = useAuth();
  const [status, setStatus] = useState('outstanding');
  const { data, reload, error } = useApi<any[]>(`/finance/fines?status=${status}`, [status]);
  const act = useAction();
  const [add, setAdd] = useState(false);
  const [fixFine, setFixFine] = useState<any>(null);
  const [q, setQ] = useState(''); const members = useApi<any[]>(q.length >= 2 ? `/members?q=${encodeURIComponent(q)}` : null, [q]);
  const [f, setF] = useState({ memberId: '', amount: '', reason: '' });
  const canWaive = me?.role === 'chairperson' || me?.role === 'super_admin';
  const resolve = async (id: string, kind: 'waiver' | 'reversal') => { const reason = window.prompt(`Reason for ${kind}?`); if (!reason) return; await act.run(() => post(`/finance/fines/${id}/resolve`, { kind, reason }), 'Recorded.'); reload(); };
  return (
    <Page title="Fines" subtitle="Late fines (KSh 200) and absence fines (KSh 5,000) are applied automatically" actions={<div className="flex gap-2">{me?.role === 'super_admin' && <button className="btn-ghost !border-red-300 !text-red-700" onClick={async () => { const note = window.prompt('This clears EVERY outstanding fine for ALL members so you can post them afresh (paid fines are kept). Nothing is deleted: each one stays in the audit trail. Reason?'); if (!note) return; await act.run(() => post('/admin/fines/clear', { note }), 'Outstanding fines cleared.'); reload(); }}>Clear all outstanding fines</button>}<button className="btn-primary" onClick={() => setAdd(true)}>Add other fine</button></div>}>
      <select className="input max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['outstanding', 'paid', 'waived', 'reversed'].map((s) => <option key={s}>{s}</option>)}</select>
      <ErrorBox msg={error || act.error} /><Notice msg={act.ok} />
      <Table rows={data ?? []} columns={[{ key: 'reference', label: 'Ref' }, { key: 'membership_no', label: 'Member', render: (r) => `${r.membership_no} · ${r.full_name}` }, { key: 'category', label: 'Type', render: (r) => human(r.category) }, { key: 'reason', label: 'Reason' }, { key: 'imposed_on', label: 'Date', render: (r) => dateFmt(r.imposed_on) }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'x', label: '', render: (r) => <span className="whitespace-nowrap">{canWaive && r.status === 'outstanding' && <button className="text-brand-700 underline" onClick={() => resolve(r.id, 'waiver')}>Waive</button>}{me?.role === 'super_admin' && r.status !== 'reversed' && <button className="ml-3 text-brand-700 underline" onClick={() => setFixFine(r)}>Edit</button>}</span> }]} />
      {fixFine && <EditFineModal fine={{ ...fixFine, imposed_on: String(fixFine.imposed_on).slice(0, 10), period: fixFine.period ? String(fixFine.period).slice(0, 10) : '' }} onClose={() => setFixFine(null)} onDone={reload} />}
      {add && (
        <Modal title="Add a fine" onClose={() => setAdd(false)}>
          <div className="space-y-3"><ErrorBox msg={act.error} />
            <Field label="Find member"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
            {members.data && <select className="input" size={Math.min(5, members.data.length || 1)} value={f.memberId} onChange={(e) => setF({ ...f, memberId: e.target.value })}>{members.data.map((m) => <option key={m.id} value={m.id}>{m.membership_no} · {m.full_name}</option>)}</select>}
            <Field label="Amount (KSh)"><input className="input" type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Reason"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
            <button className="btn-primary w-full" disabled={act.busy || !f.memberId} onClick={async () => { if (await act.run(() => post('/finance/fines', { memberId: f.memberId, amountCents: Math.round(Number(f.amount) * 100), reason: f.reason }))) { setAdd(false); reload(); } }}>Add fine</button></div>
        </Modal>
      )}
    </Page>
  );
}

function Register({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, reload, error } = useApi<any>(`/admin/meetings/${id}`);
  const act = useAction();
  const confirmed = data?.meeting.status === 'register_confirmed';
  const mark = async (memberId: string, status: string) => { await act.run(() => post(`/admin/meetings/${id}/attendance`, { entries: [{ memberId, status }] }), ''); reload(); };
  const markAll = async (status: string) => { await act.run(() => post(`/admin/meetings/${id}/attendance`, { entries: (data.attendance as any[]).filter((a) => a.status === 'pending').map((a) => ({ memberId: a.member_id, status })) }), ''); reload(); };
  return (
    <Modal title={data?.meeting.title ?? 'Register'} onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={error || act.error} /><Notice msg={act.ok} />
        {data && <>
          <div className="text-sm text-slate-600">{dateTimeFmt(data.meeting.scheduled_at)} · {data.meeting.venue} · <Badge value={data.meeting.status} /></div>
          {!confirmed && data.meeting.status !== 'cancelled' && <div className="flex flex-wrap gap-2"><button className="btn-ghost" onClick={() => markAll('present')}>Mark all pending present</button>
            <button className="btn-primary" onClick={async () => { await act.run(() => post(`/admin/meetings/${id}/confirm`), 'Register confirmed. Absence fines applied.'); reload(); }}>Confirm register</button></div>}
          <div className="divide-y rounded-lg border">{(data.attendance as any[]).map((a) => (
            <div key={a.member_id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
              <div><b>{a.membership_no}</b> {a.full_name}{a.apology_reason && <div className="text-xs text-slate-500">Apology: {a.apology_reason} {a.apology_reviewed ? '(reviewed)' : ''}</div>}{a.fine_reference && <div className="text-xs text-red-600">Fine {a.fine_reference}</div>}</div>
              {confirmed ? <Badge value={a.status} /> : (
                <div className="flex gap-1">{['present', 'absent', 'excused'].map((s) => <button key={s} onClick={() => mark(a.member_id, s)} className={`rounded px-2 py-1 text-xs ${a.status === s ? 'bg-brand-600 text-white' : 'border border-slate-300'}`}>{human(s)}</button>)}
                  {a.apology_reason && !a.apology_reviewed && <button className="rounded border border-amber-400 px-2 py-1 text-xs" onClick={async () => { await act.run(() => post(`/admin/meetings/${id}/apology-review`, { memberId: a.member_id, approve: true }), 'Apology approved.'); reload(); }}>Approve apology</button>}</div>
              )}
            </div>))}</div>
        </>}
      </div>
    </Modal>
  );
}

export function Meetings() {
  const { data, reload, error } = useApi<any[]>('/admin/meetings');
  const [add, setAdd] = useState(false); const [sel, setSel] = useState('');
  const [f, setF] = useState({ title: '', scheduledAt: '', venue: '', agenda: '' });
  const act = useAction();
  const { me } = useAuth();
  const [fixMeeting, setFixMeeting] = useState<any>(null);
  return (
    <Page title="Meetings & attendance" subtitle="Three meetings a year. Unexcused absence carries a KSh 5,000 fine once the register is confirmed." actions={<button className="btn-primary" onClick={() => setAdd(true)}>Schedule meeting</button>}>
      <ErrorBox msg={error} />
      <Table rows={data ?? []} columns={[{ key: 'scheduled_at', label: 'When', render: (r) => dateTimeFmt(r.scheduled_at) }, { key: 'title', label: 'Meeting', render: (r) => <button className="text-brand-700 underline" onClick={() => setSel(r.id)}>{r.title}</button> }, { key: 'venue', label: 'Venue' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'p', label: 'Present / Absent / Excused', render: (r) => `${r.present} / ${r.absent} / ${r.excused}` }, { key: 'edit', label: '', render: (r) => (me?.role === 'super_admin' ? <button className="text-brand-700 underline" onClick={() => setFixMeeting(r)}>Edit</button> : null) }]} />
      {fixMeeting && <EditMeetingModal meeting={fixMeeting} onClose={() => setFixMeeting(null)} onDone={reload} />}
      {add && (
        <Modal title="Schedule meeting" onClose={() => setAdd(false)}>
          <div className="space-y-3"><ErrorBox msg={act.error} />
            <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Date & time"><DateTimeInput value={f.scheduledAt} onChange={(e) => setF({ ...f, scheduledAt: e.target.value })} /></Field>
            <Field label="Venue"><input className="input" value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} /></Field>
            <Field label="Agenda"><textarea className="input" rows={3} value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} /></Field>
            <button className="btn-primary w-full" disabled={act.busy} onClick={async () => { if (await act.run(() => post('/admin/meetings', { title: f.title, venue: f.venue, agenda: f.agenda || undefined, scheduledAt: new Date(f.scheduledAt).toISOString() }))) { setAdd(false); reload(); } }}>Schedule</button></div>
        </Modal>
      )}
      {sel && <Register id={sel} onClose={() => { setSel(''); reload(); }} />}
    </Page>
  );
}

export function Withdrawals() {
  const { me } = useAuth();
  const [status, setStatus] = useState('');
  const { data, reload, error } = useApi<any[]>(`/admin/withdrawals?status=${status}`, [status]);
  const act = useAction();
  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    const reason = decision === 'rejected' ? window.prompt('Reason for rejecting?') : window.prompt('Note (optional)') ?? '';
    if (decision === 'rejected' && !reason) return;
    await act.run(() => post(`/admin/withdrawals/${id}/decide`, { decision, reason: reason || undefined }), 'Decision recorded.'); reload();
  };
  const payout = async (id: string) => { const ref = window.prompt('M-Pesa / bank reference of the payout'); if (!ref) return; await act.run(() => post(`/admin/withdrawals/${id}/pay`, { payoutReference: ref }), 'Payout recorded.'); reload(); };
  const canPay = me?.role === 'treasurer' || me?.role === 'super_admin';
  return (
    <Page title="Withdrawals" subtitle="Approved in sequence by officials; the savings ledger only changes when the payout is recorded.">
      <select className="input max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['submitted', 'in_review', 'approved', 'paid', 'rejected', 'cancelled'].map((s) => <option key={s} value={s}>{human(s)}</option>)}</select>
      <ErrorBox msg={error || act.error} /><Notice msg={act.ok} />
      <Table rows={data ?? []} columns={[{ key: 'reference', label: 'Ref' }, { key: 'm', label: 'Member', render: (r) => `${r.membership_no} · ${r.full_name}` }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }, { key: 'bal', label: 'Balance / fines', render: (r) => `${kes(r.current_balance_cents)} / ${kes(r.fines_outstanding_cents)}` }, { key: 'reason', label: 'Reason' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'ap', label: 'Approvals', render: (r) => r.approvals.map((a: any) => `${human(a.role)}: ${a.decision}`).join(', ') || '—' },
        { key: 'x', label: '', render: (r) => (<div className="flex gap-2 whitespace-nowrap">{['submitted', 'in_review'].includes(r.status) && <><button className="text-brand-700 underline" onClick={() => decide(r.id, 'approved')}>Approve</button><button className="text-red-600 underline" onClick={() => decide(r.id, 'rejected')}>Reject</button></>}{r.status === 'approved' && canPay && <button className="text-brand-700 underline" onClick={() => payout(r.id)}>Record payout</button>}</div>) }]} />
    </Page>
  );
}
