import { useState } from 'react';
import { get, post, openFile } from '../../api';
import { useAuth } from '../../auth';
import { dateTimeFmt, human, kes } from '../../format';
import { Badge, ErrorBox, Field, Modal, Notice, Page, Table, Tabs, useAction, useApi, DateTimeInput } from '../../ui';

function ManualPayment({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState(''); const members = useApi<any[]>(q.length >= 2 ? `/members?q=${encodeURIComponent(q)}` : null, [q]);
  const [memberId, setMemberId] = useState(''); const [purpose, setPurpose] = useState('savings'); const [amount, setAmount] = useState(''); const [code, setCode] = useState(''); const [paidAt, setPaidAt] = useState('');
  const [fineIds, setFineIds] = useState<string[]>([]);
  const fines = useApi<any[]>(memberId && purpose === 'fine' ? `/finance/fines?status=outstanding` : null, [memberId, purpose]);
  const act = useAction();
  const memberFines = (fines.data ?? []).filter((f) => f.member_id === memberId);
  return (
    <Modal title="Record a verified payment" onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} /><Notice msg={act.ok} />
        <p className="text-xs text-slate-500">Only record a payment after checking the code in the official M-Pesa statement. Amounts must be whole months (KSh 1,500 each) for savings.</p>
        <Field label="Find member"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or number" /></Field>
        {members.data && <select className="input" size={Math.min(5, members.data.length || 1)} value={memberId} onChange={(e) => setMemberId(e.target.value)}>{members.data.map((m) => <option key={m.id} value={m.id}>{m.membership_no} · {m.full_name}</option>)}</select>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="For"><select className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)}><option value="savings">Savings</option><option value="fine">Fines</option></select></Field>
          <Field label="Amount (KSh)"><input className="input" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="M-Pesa code"><input className="input uppercase" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Field label="Paid at"><DateTimeInput value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></Field>
        </div>
        {purpose === 'fine' && memberFines.map((f) => <label key={f.id} className="flex gap-2 text-sm"><input type="checkbox" checked={fineIds.includes(f.id)} onChange={(e) => setFineIds(e.target.checked ? [...fineIds, f.id] : fineIds.filter((x) => x !== f.id))} />{f.reference} · {kes(f.amount_cents)}</label>)}
        <button className="btn-primary w-full" disabled={act.busy || !memberId} onClick={async () => { const r = await act.run(() => post('/finance/payments/manual', { memberId, purpose, amountCents: Math.round(Number(amount) * 100), mpesaReceipt: code, paidAt: paidAt ? new Date(paidAt).toISOString() : undefined, fineIds: purpose === 'fine' ? fineIds : undefined }), 'Recorded.'); if (r) { onDone(); if (r.outcome === 'held') act.setError('Held for review: amount did not match whole months or selected fines.'); } }}>Record payment</button>
      </div>
    </Modal>
  );
}

function Submissions() {
  const [status, setStatus] = useState('pending');
  const { data, reload, error } = useApi<any[]>(`/admin/submissions?status=${status}`, [status]);
  const act = useAction();
  const [sel, setSel] = useState<any>(null); const [note, setNote] = useState(''); const [verified, setVerified] = useState(false);
  const review = async (action: string) => { if (await act.run(() => post(`/admin/submissions/${sel.id}/review`, { action, note: note || undefined, verifiedAgainstOfficialRecords: verified }), 'Done.')) { setSel(null); setNote(''); setVerified(false); reload(); } };
  return (
    <div className="space-y-3">
      <select className="input max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value)}>{['pending', 'clarification', 'approved', 'rejected'].map((s) => <option key={s} value={s}>{human(s)}</option>)}</select>
      <ErrorBox msg={error} />
      <Table rows={data ?? []} columns={[{ key: 'created_at', label: 'Submitted', render: (r) => dateTimeFmt(r.created_at) }, { key: 'membership_no', label: 'Member', render: (r) => `${r.membership_no} · ${r.full_name}` }, { key: 'mpesa_code', label: 'Code' }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }, { key: 'dup', label: 'Flags', render: (r) => (r.already_recorded ? <Badge value="held" /> : '—') }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'x', label: '', render: (r) => <button className="text-brand-700 underline" onClick={() => setSel(r)}>Review</button> }]} />
      {sel && (
        <Modal title={`Verify ${sel.mpesa_code}`} onClose={() => setSel(null)}>
          <div className="space-y-3 text-sm"><ErrorBox msg={act.error} />
            <div>{sel.full_name} claims <b>{kes(sel.amount_cents)}</b> for {sel.purpose} from {sel.phone}, paid {dateTimeFmt(sel.paid_at)}.</div>
            {sel.already_recorded && <div className="rounded bg-amber-50 p-2 text-amber-800">This M-Pesa code is already recorded. Approving will be refused.</div>}
            {sel.message_text && <pre className="whitespace-pre-wrap rounded bg-slate-100 p-2 text-xs">{sel.message_text}</pre>}
            {sel.screenshot_id && <button className="text-brand-700 underline" onClick={() => openFile(sel.screenshot_id)}>View screenshot</button>}
            {(sel.history ?? []).map((h: any, i: number) => <div key={i} className="text-xs text-slate-500">{dateTimeFmt(h.at)} · {human(h.event)} {h.note ? `· ${h.note}` : ''}</div>)}
            <label className="flex gap-2"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />I checked this code, amount and phone in the official M-Pesa statement</label>
            <Field label="Note to member"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <div className="flex flex-wrap gap-2"><button className="btn-primary" disabled={act.busy || !verified} onClick={() => review('approve')}>Approve & record</button><button className="btn-ghost" onClick={() => review('clarify')}>Ask for clarification</button><button className="btn-danger" onClick={() => review('reject')}>Reject</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function Payments() {
  const { me } = useAuth();
  const [tab, setTab] = useState('all'); const [status, setStatus] = useState('');
  const pay = useApi<any[]>(`/finance/payments?status=${status}`, [tab]);
  const [rec, setRec] = useState(false);
  const act = useAction();
  const canVerify = me?.role === 'treasurer' || me?.role === 'super_admin';
  const reverse = async (id: string) => { const reason = window.prompt('Reason for reversing this payment?'); if (!reason) return; await act.run(() => post(`/finance/payments/${id}/reverse`, { reason }), 'Payment reversed.'); pay.reload(); };
  void get;
  return (
    <Page title="Payments" actions={canVerify && <button className="btn-primary" onClick={() => setRec(true)}>Record verified payment</button>}>
      <Tabs value={tab} onChange={setTab} tabs={[['all', 'All payments'], ['proofs', 'Member submissions']]} />
      <ErrorBox msg={act.error || pay.error} /><Notice msg={act.ok} />
      {tab === 'proofs' ? <Submissions /> : (
        <>
          <select className="input max-w-[12rem]" value={status} onChange={(e) => { setStatus(e.target.value); setTimeout(pay.reload, 0); }}><option value="">All</option>{['confirmed', 'held', 'initiated', 'failed', 'reversed'].map((s) => <option key={s}>{s}</option>)}</select>
          <Table rows={pay.data ?? []} columns={[{ key: 'created_at', label: 'Date', render: (r) => dateTimeFmt(r.created_at) }, { key: 'membership_no', label: 'Member', render: (r) => (r.membership_no ? `${r.membership_no} · ${r.full_name}` : 'Unmatched') }, { key: 'purpose', label: 'For', render: (r) => human(r.purpose) }, { key: 'channel', label: 'Channel', render: (r) => human(r.channel) }, { key: 'mpesa_receipt', label: 'M-Pesa code' }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'hold_reason', label: 'Note' }, { key: 'x', label: '', render: (r) => (r.status === 'confirmed' && (me?.role === 'treasurer' || me?.role === 'super_admin') ? <button className="text-red-600 underline" onClick={() => reverse(r.id)}>Reverse</button> : null) }]} />
        </>
      )}
      {rec && <ManualPayment onClose={() => setRec(false)} onDone={pay.reload} />}
    </Page>
  );
}
