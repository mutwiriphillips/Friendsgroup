import { useState } from 'react';
import { download, get, openFile, post, fileToUpload } from '../../api';
import { dateFmt, dateTimeFmt, human, kes, monthFmt } from '../../format';
import { NextOfKinPanel } from '../NextOfKin';
import { Avatar, MemberDocuments, useMyPhotoId } from '../MemberDocuments';
import { Badge, ErrorBox, Field, Loading, Modal, Notice, Page, Table, Tabs, useAction, useApi, DateTimeInput } from '../../ui';

export function Statements() {
  const [tab, setTab] = useState('savings');
  const paths: Record<string, string> = { savings: '/me/savings-ledger', fines: '/me/fine-ledger', months: '/me/obligations', payments: '/me/payments' };
  const { data, loading, error } = useApi<any[]>(paths[tab], [tab]);
  const [msg, setMsg] = useState('');
  const dl = async (fmt: 'pdf' | 'xlsx') => { try { await download(`/me/statement?format=${fmt}`, `my-statement.${fmt}`); } catch (e) { setMsg((e as Error).message); } };
  const [receipt, setReceipt] = useState<any>(null);
  return (
    <Page title="Statements" subtitle="Savings and fines are separate records" actions={<><button className="btn-ghost" onClick={() => dl('pdf')}>Download PDF</button><button className="btn-ghost" onClick={() => dl('xlsx')}>Download Excel</button></>}>
      <ErrorBox msg={msg || error} />
      <Tabs value={tab} onChange={setTab} tabs={[['savings', 'Savings ledger'], ['fines', 'Fines ledger'], ['months', 'Monthly contributions'], ['payments', 'Payments & receipts']]} />
      {loading ? <Loading /> : tab === 'savings' ? (
        <Table rows={data ?? []} columns={[{ key: 'occurred_at', label: 'Date', render: (r) => dateFmt(r.occurred_at) }, { key: 'type', label: 'Type', render: (r) => human(r.type) }, { key: 'reference', label: 'Reference' }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }, { key: 'balance_cents', label: 'Balance', align: 'right', render: (r) => kes(r.balance_cents) }]} />
      ) : tab === 'fines' ? (
        <Table rows={data ?? []} columns={[{ key: 'created_at', label: 'Date', render: (r) => dateFmt(r.created_at) }, { key: 'reference', label: 'Fine' }, { key: 'entry_type', label: 'Entry', render: (r) => human(r.entry_type) }, { key: 'note', label: 'Note' }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }]} />
      ) : tab === 'months' ? (
        <Table rows={data ?? []} columns={[{ key: 'period', label: 'Month', render: (r) => monthFmt(r.period) }, { key: 'due_date', label: 'Due', render: (r) => dateFmt(r.due_date) }, { key: 'amount_due_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_due_cents) }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'fine_reference', label: 'Late fine', render: (r) => (r.fine_reference ? `${r.fine_reference} (${kes(r.fine_cents)})` : '—') }]} />
      ) : (
        <Table rows={data ?? []} columns={[{ key: 'created_at', label: 'Date', render: (r) => dateTimeFmt(r.created_at) }, { key: 'purpose', label: 'For', render: (r) => human(r.purpose) }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'receipt_no', label: 'Receipt', render: (r) => (r.status === 'confirmed' ? <button className="text-brand-700 underline" onClick={async () => setReceipt(await get(`/me/payments/${r.id}/receipt`))}>{r.receipt_no}</button> : r.hold_reason ?? '—') }]} />
      )}
      {receipt && (
        <Modal title={`Receipt ${receipt.payment.receipt_no}`} onClose={() => setReceipt(null)}>
          <div className="space-y-2 text-sm">
            <div>{receipt.payment.full_name} · {receipt.payment.membership_no}</div>
            <div>M-Pesa code: <b>{receipt.payment.mpesa_receipt}</b></div>
            <div>Amount: <b>{kes(receipt.payment.amount_cents)}</b> ({human(receipt.payment.purpose)})</div>
            {receipt.allocations.map((a: any) => <div key={a.period}>Applied to {monthFmt(a.period)}: {kes(a.amount_cents)}</div>)}
            {receipt.fines.map((f: any) => <div key={f.reference}>Applied to fine {f.reference}: {kes(f.amount_cents)}</div>)}
          </div>
        </Modal>
      )}
    </Page>
  );
}

export function MemberMeetings() {
  const { data, loading, error, reload } = useApi<any>('/me/meetings');
  const [apology, setApology] = useState<any>(null);
  const [reason, setReason] = useState('');
  const act = useAction();
  if (loading && !data) return <Loading />;
  return (
    <Page title="Meetings & attendance">
      <ErrorBox msg={error} />
      <div className="grid grid-cols-3 gap-3 text-center">
        {[['Attended', data?.totals.attended], ['Excused', data?.totals.excused], ['Unexcused', data?.totals.unexcused]].map(([l, v]) => <div key={l as string} className="card"><div className="text-2xl font-bold">{v ?? 0}</div><div className="text-xs text-slate-500">{l}</div></div>)}
      </div>
      <Table rows={data?.meetings ?? []} columns={[
        { key: 'scheduled_at', label: 'When', render: (r) => dateTimeFmt(r.scheduled_at) }, { key: 'title', label: 'Meeting' }, { key: 'venue', label: 'Venue' },
        { key: 'my_status', label: 'My status', render: (r) => <Badge value={r.status === 'register_confirmed' || r.my_status !== 'pending' ? r.my_status : r.status} /> },
        { key: 'fine_reference', label: 'Fine', render: (r) => r.fine_reference ?? '—' },
        { key: 'a', label: '', render: (r) => (r.status === 'scheduled' && !r.apology_reason ? <button className="text-brand-700 underline" onClick={() => setApology(r)}>Send apology</button> : r.apology_reason ? <span className="text-xs text-slate-500">Apology {r.apology_reviewed ? 'reviewed' : 'sent'}</span> : null) },
      ]} />
      {apology && (
        <Modal title={`Apology: ${apology.title}`} onClose={() => setApology(null)}>
          <div className="space-y-3"><ErrorBox msg={act.error} />
            <Field label="Reason"><textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <button className="btn-primary w-full" disabled={act.busy} onClick={async () => { if (await act.run(() => post(`/me/meetings/${apology.id}/apology`, { reason }))) { setApology(null); setReason(''); reload(); } }}>Submit apology</button>
            <p className="text-xs text-slate-500">An officer reviews it. Excused absences carry no fine.</p></div>
        </Modal>
      )}
    </Page>
  );
}

export function MemberWithdrawals() {
  const { data, loading, error, reload } = useApi<any>('/me/withdrawals');
  const [amount, setAmount] = useState(''); const [reason, setReason] = useState('');
  const act = useAction();
  if (loading && !data) return <Loading />;
  return (
    <Page title="Withdrawals" subtitle={`Savings balance: ${kes(data?.balanceCents)}`}>
      <ErrorBox msg={error} />
      <div className="card space-y-3"><h2 className="font-bold">Request a withdrawal</h2>
        <ErrorBox msg={act.error} /><Notice msg={act.ok} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Amount (KSh)"><input className="input" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <div className="sm:col-span-2"><Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
        </div>
        <button className="btn-primary" disabled={act.busy || !amount} onClick={async () => { if (await act.run(() => post('/me/withdrawals', { amountCents: Math.round(Number(amount) * 100), reason }), 'Request submitted for approval.')) { setAmount(''); setReason(''); reload(); } }}>Submit request</button>
        <p className="text-xs text-slate-500">Withdrawals must be approved by officials. Outstanding fines may need to be cleared first. Only one request can be open at a time.</p>
      </div>
      <Table rows={data?.withdrawals ?? []} columns={[
        { key: 'reference', label: 'Reference' }, { key: 'created_at', label: 'Date', render: (r) => dateFmt(r.created_at) }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'approvals', label: 'Approvals', render: (r) => (r.approvals.length ? r.approvals.map((a: any) => `${human(a.role)}: ${a.decision}`).join(' · ') : 'Waiting for review') },
        { key: 'x', label: '', render: (r) => (['submitted', 'in_review'].includes(r.status) ? <button className="text-red-600 underline" onClick={async () => { await act.run(() => post(`/me/withdrawals/${r.id}/cancel`)); reload(); }}>Cancel</button> : null) },
      ]} />
    </Page>
  );
}

export function MemberInbox() {
  const [tab, setTab] = useState('notes');
  const notes = useApi<any[]>('/me/notifications');
  const docs = useApi<any[]>('/me/documents');
  const subs = useApi<any[]>('/me/submissions');
  const act = useAction();
  const [f, setF] = useState({ mpesaCode: '', amount: '', phone: '', paidAt: '', purpose: 'savings', messageText: '' });
  const [shot, setShot] = useState<File | null>(null);
  const submit = async () => {
    let screenshotId: string | undefined;
    if (shot) screenshotId = (await post('/files', await fileToUpload(shot))).id;
    await post('/me/submissions', { mpesaCode: f.mpesaCode.toUpperCase(), amountCents: Math.round(Number(f.amount) * 100), phone: f.phone, paidAt: new Date(f.paidAt).toISOString(), purpose: f.purpose, messageText: f.messageText || undefined, screenshotId });
    subs.reload();
  };
  return (
    <Page title="Inbox & documents" actions={<button className="btn-ghost" onClick={async () => { await post('/me/notifications/read'); notes.reload(); }}>Mark all read</button>}>
      <Tabs value={tab} onChange={setTab} tabs={[['notes', 'Notifications'], ['docs', 'Group documents'], ['proof', 'I paid another way']]} />
      {tab === 'notes' && <div className="space-y-2">{(notes.data ?? []).map((n) => <div key={n.id} className={`card ${n.read_at ? '' : 'border-brand-500'}`}><div className="font-semibold">{n.title}</div><div className="text-sm text-slate-600">{n.body}</div><div className="mt-1 text-xs text-slate-400">{dateTimeFmt(n.created_at)}</div></div>)}{!notes.data?.length && <div className="card text-center text-sm text-slate-500">No notifications.</div>}</div>}
      {tab === 'docs' && <Table rows={docs.data ?? []} columns={[{ key: 'title', label: 'Document', render: (r) => <div>{r.title}{r.description && <div className="text-xs text-slate-500">{r.description}</div>}</div> }, { key: 'category', label: 'Type', render: (r) => human(r.category) }, { key: 'document_date', label: 'Dated', render: (r) => dateFmt(r.document_date ?? r.created_at) }, { key: 'o', label: '', render: (r) => <button className="text-brand-700 underline" onClick={() => openFile(r.file_id)}>Open</button> }]} />}
      {tab === 'proof' && (
        <div className="space-y-4">
          <div className="card space-y-3"><p className="text-sm text-slate-600">Paid by Paybill, to the till or by another route? Enter the details from your M-Pesa message. The treasurer will verify it against the official records before it counts.</p>
            <ErrorBox msg={act.error} /><Notice msg={act.ok} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="M-Pesa code"><input className="input uppercase" value={f.mpesaCode} onChange={(e) => setF({ ...f, mpesaCode: e.target.value })} /></Field>
              <Field label="Amount (KSh)"><input className="input" type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
              <Field label="Phone you paid from"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
              <Field label="Date & time paid"><DateTimeInput value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} /></Field>
              <Field label="Paying for"><select className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}><option value="savings">Monthly savings</option><option value="fine">Fines</option></select></Field>
              <Field label="Screenshot (optional)"><input className="input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setShot(e.target.files?.[0] ?? null)} /></Field>
            </div>
            <Field label="Paste the M-Pesa message (optional)"><textarea className="input" rows={2} value={f.messageText} onChange={(e) => setF({ ...f, messageText: e.target.value })} /></Field>
            <button className="btn-primary" disabled={act.busy} onClick={() => act.run(submit, 'Submitted for verification.')}>Submit for verification</button>
          </div>
          <Table rows={subs.data ?? []} columns={[{ key: 'mpesa_code', label: 'Code' }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'review_note', label: 'Note' }]} />
        </div>
      )}
    </Page>
  );
}

export function NextOfKinPage() {
  const { data: n } = useApi<any>('/me/next-of-kin');
  const photo = useMyPhotoId();
  return (
    <Page title="My profile & next of kin" subtitle="Upload your photo and ID, and submit your Next of Kin form. The profile is compliant once the form is submitted">
      {n && <div className="card flex flex-wrap items-center justify-between gap-3 text-sm"><span className="flex items-center gap-3"><Avatar fileId={photo} name={n.member.fullName} size={64} /><span><b className="text-lg">{n.member.fullName}</b><br />{n.member.membershipNo}</span></span><span>Profile status: {n.submitted ? <Badge value="completed" /> : <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">Non-compliant</span>}</span></div>}
      <MemberDocuments mode="member" />
      <NextOfKinPanel mode="member" />
    </Page>
  );
}
