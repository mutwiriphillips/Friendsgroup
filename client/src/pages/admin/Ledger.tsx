import { useEffect, useMemo, useState } from 'react';
import { download, get, post } from '../../api';
import { useAuth } from '../../auth';
import { dateFmt, dateTimeFmt, kes, monthFmt } from '../../format';
import { ErrorBox, Field, Loading, Modal, Notice, Page, useAction, useApi, DateInput, MonthInput } from '../../ui';

type Sel = { member: any; kind: 'cont' | 'fine' | 'meeting'; period?: string; meetingId?: string; title: string; current: number; hint: string };

function CellModal({ sel, onClose, onDone }: { sel: Sel; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState(String(sel.current));
  const [reason, setReason] = useState('');
  const act = useAction();
  return (
    <Modal title="Change a ledger entry" onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} />
        <p className="text-sm"><b>{sel.member.name}</b> · {sel.title}</p>
        <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">{sel.hint} The old value stays in the ledger and audit trail; a correcting entry is added, nothing is overwritten.</p>
        <Field label="New value (KSh)"><input className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        <Field label="Reason for the change (required)"><textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Receipt shows 1,000; paid in cash at the meeting" /></Field>
        <button className="btn-primary w-full" disabled={act.busy || reason.trim().length < 3 || value === '' || Number.isNaN(Number(value))} onClick={async () => {
          const body = { memberId: sel.member.id, kind: sel.kind, period: sel.period, meetingId: sel.meetingId, value: Number(value), reason };
          if (await act.run(() => post('/admin/ledger-grid/cell', body), 'Saved.')) { onDone(); onClose(); }
        }}>Save change</button>
      </div>
    </Modal>
  );
}

const KIND_LABEL: Record<string, string> = { contribution: 'Contribution', late_fine: 'Late fine', meeting_fine: 'Missing-meeting fine', other_fine: 'Penalty' };

export function PaymentModal({ members, preset, onClose, onDone, onAllocate }: { members: any[]; preset?: string; onClose: () => void; onDone: () => void; onAllocate?: (memberId: string) => void }) {
  const managed = Boolean(useAuth().me?.admin_managed);
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const [f, setF] = useState({ memberId: preset ?? '', amount: '', paidOn: today, message: '', code: '' });
  const [owed, setOwed] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const act = useAction();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { setOwed(null); if (f.memberId) get(`/admin/members/${f.memberId}/invoices`).then(setOwed).catch(() => setOwed(null)); }, [f.memberId, done]);
  return (
    <Modal title="Post a payment" onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} />
        {done ? (
          <div className="space-y-3 text-sm">
            <Notice msg={`Posted ${kes(done.receivedCents)} for ${done.member}, M-Pesa code ${done.mpesaCode}. It has not been applied to any invoice yet.`} />
            <p className="text-xs text-slate-600">The money now waits on the member's account. Choose which invoices it pays.</p>
            {onAllocate && <button className="btn-primary w-full" onClick={() => onAllocate(f.memberId)}>Choose the invoices it pays</button>}
            <button className="btn-ghost w-full" onClick={onClose}>Do it later</button>
          </div>
        ) : <>
          <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">Only the administrator can post payments. Posting records the money against the member and pays nothing by itself: afterwards you choose which invoices it settles.</p>
          <Field label="Member"><select className="input" value={f.memberId} onChange={set('memberId')}><option value="">Choose a member…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
          {owed && <div className="rounded-lg border border-slate-200 p-2 text-xs">
            <div className="font-semibold">{!managed && <>Owes the group: <span className={owed.totalCents ? 'text-red-600' : 'text-green-700'}>{kes(owed.totalCents)}</span> <span className="font-normal text-slate-500">(contributions {kes(owed.contributionsCents)}, penalties {kes(owed.penaltiesCents)})</span></>}{owed.creditCents > 0 && <span className="ml-2 text-blue-700">Received, not yet allocated: {kes(owed.creditCents)}</span>}</div>
            {managed && owed.invoices.length > 0 && <div className="text-slate-500">Invoices you have raised:</div>}{owed.invoices.length > 0 && <ul className="mt-1 max-h-24 overflow-auto">{owed.invoices.map((i: any) => <li key={i.kind + i.id} className="flex justify-between"><span>{i.label}</span><span>{kes(i.amountCents)}</span></li>)}</ul>}
          </div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Amount paid (KSh)"><input className="input" type="number" value={f.amount} onChange={set('amount')} /></Field>
            <Field label="Date paid"><DateInput value={f.paidOn} max={today} onChange={set('paidOn')} /></Field>
          </div>
          <Field label="Transaction message"><textarea className="input" rows={3} value={f.message} onChange={set('message')} placeholder="e.g. SJK3L8XQ4P Confirmed. Ksh1,500.00 paid to …" /></Field>
          <Field label="M-Pesa code (only if it is not in the message)"><input className="input" value={f.code} onChange={set('code')} /></Field>
          <button className="btn-primary w-full" disabled={act.busy || !(Number(f.amount) > 0) || !f.memberId || f.message.trim().length < 10} onClick={async () => {
            const r = await act.run(() => post('/admin/manual-payments', { memberId: f.memberId, amountKsh: Number(f.amount), paidOn: f.paidOn, message: f.message, mpesaCode: f.code || undefined }));
            if (r) { setDone(r); onDone(); }
          }}>Post payment</button>
        </>}
      </div>
    </Modal>
  );
}

/** The administrator approves which invoices a received payment pays. Nothing is allocated automatically. */
export function AllocateModal({ members, preset, onClose, onDone }: { members: any[]; preset?: string; onClose: () => void; onDone: () => void }) {
  const managed = Boolean(useAuth().me?.admin_managed);
  const [memberId, setMemberId] = useState(preset ?? '');
  const [payId, setPayId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [advance, setAdvance] = useState(0);
  const [note, setNote] = useState('');
  const [info, setInfo] = useState<any>(null);
  const [owed, setOwed] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const [tick, setTick] = useState(0);
  const act = useAction();
  useEffect(() => {
    setInfo(null); setOwed(null); setPicked(new Set()); setAdvance(0);
    if (!memberId) return;
    get(`/admin/members/${memberId}/credit`).then((i: any) => { setInfo(i); setPayId((cur) => (i.payments.some((p: any) => p.id === cur) ? cur : i.payments[0]?.id ?? '')); }).catch(() => setInfo(null));
    get(`/admin/members/${memberId}/invoices`).then(setOwed).catch(() => setOwed(null));
  }, [memberId, tick]);
  const body = () => ({ memberId, manualPaymentId: payId, contributionIds: (owed?.invoices ?? []).filter((i: any) => picked.has(i.id) && i.kind === 'contribution').map((i: any) => i.id), fineIds: (owed?.invoices ?? []).filter((i: any) => picked.has(i.id) && i.kind !== 'contribution').map((i: any) => i.id), advanceMonths: advance, note: note || undefined });
  useEffect(() => {
    setPlan(null);
    if (!memberId || !payId || (picked.size === 0 && advance === 0)) return;
    const t = setTimeout(() => post('/admin/allocations/preview', body()).then(setPlan).catch(() => setPlan(null)), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId, payId, picked, advance]);
  const held = info?.payments?.find((p: any) => p.id === payId);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Modal title="Choose the invoices a payment pays" onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} />
        <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">Money you post is not applied automatically. Tick the invoices this payment should settle (whole invoices only). Whatever is not used stays on the payment for later.</p>
        <Field label="Member"><select className="input" value={memberId} onChange={(e) => { setMemberId(e.target.value); setDone(null); }}><option value="">Choose a member…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        {done && <Notice msg={`Approved ${kes(done.contributionCents + done.penaltyCents)} for ${done.member}. Left on that payment: ${kes(done.paymentLeftCents)}.`} />}
        {info && info.payments.length === 0 && <p className="text-xs text-slate-500">This member has no received money waiting to be allocated. Post a payment first.</p>}
        {info && info.payments.length > 0 && owed && <>
          <Field label="Payment to use">
            <select className="input" value={payId} onChange={(e) => setPayId(e.target.value)}>
              {info.payments.map((p: any) => <option key={p.id} value={p.id}>{p.mpesaCode} · paid {dateFmt(p.paidOn)} · {kes(p.balanceCents)} left</option>)}
            </select>
          </Field>
          <div className="rounded-lg border border-slate-200 p-2 text-xs">
            <div className="mb-1 font-semibold">{managed ? 'Invoices you have raised (oldest first)' : 'Invoices the member owes (oldest first)'}</div>
            {owed.invoices.length === 0 && <div className="text-slate-500">{managed ? 'No invoices have been raised for this member.' : 'Nothing is owed right now.'}</div>}
            <ul className="max-h-48 overflow-auto">{owed.invoices.map((i: any) => (
              <li key={i.kind + i.id} className="border-t border-slate-100 first:border-0">
                <label className="flex cursor-pointer items-center justify-between gap-2 py-1"><span className="flex items-center gap-2"><input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />{i.label}{i.upcoming && <span className="text-slate-400"> (not due yet)</span>}</span><span>{kes(i.amountCents)}</span></label>
              </li>))}</ul>
          </div>
          <Field label="Also pay future months in advance (how many)"><input className="input" type="number" min={0} max={36} value={advance} onChange={(e) => setAdvance(Math.max(0, Math.min(36, Math.floor(Number(e.target.value) || 0))))} /></Field>
          {plan && <div className={`rounded-lg border p-2 text-xs ${plan.enough ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
            {plan.plan.future.map((x: any) => <div key={x.period} className="flex justify-between"><span>Contribution paid in advance: {monthFmt(x.period)}</span><span>{kes(x.amountCents)}</span></div>)}
            <div className="flex justify-between font-semibold"><span>Chosen invoices total</span><span>{kes(plan.totalCents)}</span></div>
            <div className="flex justify-between"><span>Left on this payment</span><span>{kes(plan.balanceCents - plan.totalCents)}</span></div>
            {!plan.enough && plan.totalCents > plan.balanceCents && <div className="font-semibold text-amber-800">That is more than this payment has left.</div>}
          </div>}
          <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Skip January as agreed" /></Field>
          <button className="btn-primary w-full" disabled={act.busy || !plan || !plan.enough} onClick={async () => {
            const r = await act.run(() => post('/admin/allocations', body()));
            if (r) { setDone(r); setNote(''); setTick((t) => t + 1); onDone(); }
          }}>Approve and post</button>
        </>}
        {info && info.entries.length > 0 && <div className="rounded-lg border border-slate-200 p-2 text-xs">
          <div className="mb-1 font-semibold">Money history</div>
          <ul className="max-h-36 overflow-auto">{info.entries.map((e: any) => (
            <li key={e.id} className="flex items-start justify-between gap-2 border-t border-slate-100 py-0.5 first:border-0">
              <span>{dateTimeFmt(e.created_at)} · {e.entry_type === 'received' || e.entry_type === 'overpayment' ? `Received${e.mpesa_code ? ` (${e.mpesa_code})` : ''}` : e.entry_type === 'applied' ? `Allocated${e.note ? `: ${e.note}` : ''}` : e.note ?? e.entry_type}</span>
              <span className="whitespace-nowrap"><span className={e.amount_cents < 0 ? 'text-red-600' : 'text-green-700'}>{kes(e.amount_cents)}</span>{e.undoable && <button className="ml-2 text-red-700 underline" onClick={async () => { const why = window.prompt('Undo this allocation (the invoices open again). Reason?'); if (!why) return; if (await act.run(() => post(`/admin/allocations/${e.id}/undo`, { note: why }))) { setTick((t) => t + 1); onDone(); } }}>Undo</button>}</span>
            </li>))}</ul>
        </div>}
      </div>
    </Modal>
  );
}

export function RaiseInvoiceModal({ members, preset, onClose, onDone }: { members: any[]; preset?: string; onClose: () => void; onDone: () => void }) {
  const managed = Boolean(useAuth().me?.admin_managed);
  const opts = useApi<any>('/admin/invoice-options');
  const thisMonth = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);
  const [f, setF] = useState({ memberId: preset ?? '', kind: 'contribution', month: thisMonth, amount: '', meetingId: '', all: false, lateFine: true, note: '' });
  const [res, setRes] = useState<any>(null);
  const act = useAction();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const def = opts.data ? (f.kind === 'contribution' ? opts.data.monthlyCents : f.kind === 'late_fine' ? opts.data.lateFineCents : opts.data.absenceFineCents) / 100 : 0;
  return (
    <Modal title="Raise an invoice" onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} />
        {res ? <Notice msg={res.created > 1 ? `Invoice raised for ${res.created} members.` : (managed ? 'Invoice raised.' : 'Invoice raised. It now shows as owed.')} /> : <>
          <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">An invoice records what a member owes the group. It stays owed until a payment clears it. Leave the amount blank to use the group rules.</p>
          <Field label="Invoice type"><select className="input" value={f.kind} onChange={set('kind')}><option value="contribution">Monthly contribution</option><option value="late_fine">Late payment fine</option><option value="meeting_fine">Missing-meeting fine</option></select></Field>
          {f.kind === 'contribution' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.all} onChange={(e) => setF({ ...f, all: e.target.checked })} />Raise for all active members</label>}
          {!(f.kind === 'contribution' && f.all) && <Field label="Member"><select className="input" value={f.memberId} onChange={set('memberId')}><option value="">Choose a member…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>}
          {f.kind !== 'meeting_fine'
            ? <Field label="Month"><MonthInput value={f.month} onChange={set('month')} /></Field>
            : <Field label="Meeting missed"><select className="input" value={f.meetingId} onChange={set('meetingId')}><option value="">Choose a meeting…</option>{(opts.data?.meetings ?? []).map((m: any) => <option key={m.id} value={m.id}>{m.date} · {m.title}</option>)}</select></Field>}
          <Field label={`Amount (KSh), default ${def.toLocaleString()}`}><input className="input" type="number" value={f.amount} onChange={set('amount')} placeholder={String(def)} /></Field>
          {f.kind === 'contribution' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.lateFine} onChange={(e) => setF({ ...f, lateFine: e.target.checked })} />Charge the late fine automatically if unpaid after the deadline (untick for past months, then raise late fines yourself)</label>}
          <Field label="Note (optional)"><input className="input" value={f.note} onChange={set('note')} /></Field>
          <button className="btn-primary w-full" disabled={act.busy || (!(f.kind === 'contribution' && f.all) && !f.memberId) || (f.kind === 'meeting_fine' ? !f.meetingId : !f.month)} onClick={async () => {
            const body: any = { kind: f.kind, memberId: f.all && f.kind === 'contribution' ? undefined : f.memberId, allMembers: f.kind === 'contribution' && f.all ? true : undefined, period: f.kind === 'meeting_fine' ? undefined : f.month, meetingId: f.kind === 'meeting_fine' ? f.meetingId : undefined, amountKsh: f.amount ? Number(f.amount) : undefined, lateFineApplies: f.kind === 'contribution' ? f.lateFine : undefined, note: f.note || undefined };
            const r = await act.run(() => post('/admin/invoices', body)); if (r) { setRes(r); onDone(); }
          }}>Raise invoice</button>
        </>}
      </div>
    </Modal>
  );
}

function LoadSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [payload, setPayload] = useState<any>(null);
  const [pv, setPv] = useState<any>(null);
  const [res, setRes] = useState<any>(null);
  const act = useAction();
  return (
    <Modal title="Load the group's sheet" onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} />
        {!res && <>
          <p className="text-xs text-slate-600">Upload the members-by-months Excel sheet. Members are imported as is (pending compliance), contributions and fines go into the ledgers as historical records. In the Fine columns and meeting penalties, positive numbers are treated as paid and negative as unpaid.</p>
          <input className="input" type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPv(null); }} />
          <button className="btn-ghost w-full" disabled={!file || act.busy} onClick={async () => {
            const buf = new Uint8Array(await file!.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            const p = { filename: file!.name, dataBase64: btoa(bin) }; setPayload(p);
            const r = await act.run(() => post('/admin/ledger-grid/import/preview', p)); if (r) setPv(r);
          }}>Check the file</button>
        </>}
        {pv && !res && <div className="space-y-2 text-sm">
          <p><b>{pv.members.total}</b> members ({pv.members.newMembers} new). Months {monthFmt(pv.months.from)} to {monthFmt(pv.months.to)}.</p>
          <p>Contributions: <b>{pv.contributions.count}</b> entries, {kes(pv.contributions.totalCents)}. Late fines: {pv.lateFines.paid} paid ({kes(pv.lateFines.paidCents)}), {pv.lateFines.unpaid} unpaid ({kes(pv.lateFines.unpaidCents)}).</p>
          <ul className="list-disc pl-5">{pv.meetings.map((m: any) => <li key={m.idx}>{dateFmt(m.date)} · {m.venue}: {m.paid} paid ({kes(m.paidCents)}), {m.unpaid} unpaid ({kes(m.unpaidCents)})</li>)}</ul>
          {pv.expenses.length > 0 && <p>Expenses: {pv.expenses.map((e: any) => `${e.description} ${kes(e.cents)}`).join('; ')}</p>}
          <p>Arrears in the sheet: <b>{pv.arrears.sheet === null ? 'not stated' : kes(pv.arrears.sheet)}</b> · from the rows: <b>{kes(pv.arrears.calculated)}</b></p>
          {pv.warnings.length > 0 && <div className="max-h-32 overflow-auto rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"><b>Please check:</b><ul className="list-disc pl-4">{pv.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></div>}
          {pv.errors.length > 0 ? <ErrorBox msg={pv.errors.join(' ')} /> :
            <button className="btn-primary w-full" disabled={act.busy} onClick={async () => { const r = await act.run(() => post('/admin/ledger-grid/import/commit', payload)); if (r) { setRes(r); onDone(); } }}>Load into the ledger</button>}
        </div>}
        {res && <Notice msg={`Loaded: ${res.newMembers} new members, ${res.entries} ledger entries, ${res.meetings} meetings, ${res.expenses} expense(s). Complete each member's ID and phone from the Members page.`} />}
      </div>
    </Modal>
  );
}

export default function Ledger() {
  const [n, setN] = useState(0);
  const { data, error } = useApi<any>('/admin/ledger-grid', [n]);
  const [sel, setSel] = useState<Sel | null>(null);
  const [load, setLoad] = useState(false);
  const [q, setQ] = useState('');
  const { me } = useAuth();
  const isAdmin = me?.role === 'super_admin';
  const [pay, setPay] = useState<string | null>(null);
  const manual = useApi<any[]>(isAdmin ? '/admin/manual-payments' : null, [n]);
  const act = useAction();
  const rows = useMemo(() => (data?.rows ?? []).filter((r: any) => r.name.toLowerCase().includes(q.toLowerCase())), [data, q]);
  if (error) return <ErrorBox msg={error} />;
  if (!data) return <Loading />;
  const hasFine = (p: string) => data.rows.some((r: any) => r.fine[p]);
  const th = 'border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold whitespace-nowrap';
  const td = 'border border-slate-100 px-2 py-1 text-right text-xs tabular-nums whitespace-nowrap';
  const canEdit = data.canEdit as boolean;
  const cell = (s: Sel, content: React.ReactNode, cls = '', key?: string) => (
    <td key={key} className={`${td} ${cls} ${canEdit ? 'cursor-pointer hover:bg-brand-50' : ''}`} onClick={() => canEdit && setSel(s)} title={canEdit ? 'Click to change' : undefined}>{content}</td>
  );
  const fineView = (f?: { cents: number; paid: boolean }) => (f ? <span className={f.paid ? 'text-slate-700' : 'font-semibold text-red-600'}>{f.paid ? '' : '−'}{f.cents / 100}</span> : '');
  const total = (fn: (r: any) => number) => data.rows.reduce((a: number, r: any) => a + fn(r), 0);
  return (
    <Page title="Member ledger" subtitle="Every member and month, as in the group's sheet. Click any cell to change it; each change needs a reason and is kept in the audit trail."
      actions={<div className="flex gap-2">
        {isAdmin && <button className="btn-primary" onClick={() => setPay('')}>Post a payment</button>}
        {canEdit && <button className="btn-ghost" onClick={() => setLoad(true)}>Load Excel sheet</button>}
        <button className="btn-ghost" disabled={act.busy} onClick={() => act.run(() => download('/admin/ledger-grid/export', 'member-ledger.xlsx'))}>Export Excel</button>
      </div>}>
      <ErrorBox msg={act.error} />
      <input className="input mb-3 max-w-xs" placeholder="Find a member…" value={q} onChange={(e) => setQ(e.target.value)} />
      {data.rows.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">The ledger is empty. {canEdit ? 'Use “Load Excel sheet” to bring in the group’s sheet.' : ''}</p> : (
        <div className="max-h-[70vh] overflow-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full border-collapse">
            <thead className="sticky top-0 z-20">
              <tr>
                <th rowSpan={2} className={`${th} sticky left-0 z-30 text-left`}>Member</th>
                {data.months.map((p: string) => <th key={p} colSpan={hasFine(p) ? 2 : 1} className={`${th} text-center`}>{monthFmt(p)}</th>)}
                {data.meetings.length > 0 && <th colSpan={data.meetings.length} className={`${th} text-center`}>Meeting absence penalty</th>}
                <th rowSpan={2} className={th}>Savings</th><th rowSpan={2} className={th}>Fines paid</th><th rowSpan={2} className={th}>Arrears</th>{isAdmin && <th rowSpan={2} className={th}>Payment</th>}
              </tr>
              <tr>
                {data.months.map((p: string) => hasFine(p)
                  ? [<th key={p + 'c'} className={th}>Cont</th>, <th key={p + 'f'} className={th}>Fine</th>]
                  : <th key={p + 'c'} className={th}>Cont</th>)}
                {data.meetings.map((m: any) => <th key={m.id} className={`${th} font-normal`} title={m.title}>{dateFmt(m.date)}<br />{m.venue}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="sticky left-0 z-10 border border-slate-100 bg-white px-2 py-1 text-xs font-medium whitespace-nowrap">{r.name}{!r.profileComplete && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">pending</span>}</td>
                  {data.months.map((p: string) => {
                    const live = r.live[p] !== undefined; const hist = r.cont[p];
                    const c = hist !== undefined ? hist : live ? r.live[p] : undefined;
                    return [
                      live ? <td key={p + 'c'} className={`${td} bg-slate-50 text-slate-500`} title="Live payment system">{c > 0 ? c / 100 : ""}</td>
                        : cell({ member: r, kind: 'cont', period: p, title: `Contribution, ${monthFmt(p)}`, current: (c ?? 0) / 100, hint: 'Enter the amount paid for the month (0 clears it).' }, c ? c / 100 : '', c !== undefined && c !== 150000 && c !== 0 ? 'bg-amber-50' : '', p + 'c'),
                      ...(hasFine(p) ? [cell({ member: r, kind: 'fine', period: p, title: `Late fine, ${monthFmt(p)}`, current: r.fine[p] ? (r.fine[p].paid ? 1 : -1) * r.fine[p].cents / 100 : 0, hint: 'Positive = fine paid, negative = fine unpaid, 0 = no fine.' }, fineView(r.fine[p]), '', p + 'f')] : []),
                    ];
                  })}
                  {data.meetings.map((m: any) => cell({ member: r, kind: 'meeting', meetingId: m.id, title: `Absence penalty, ${m.venue} ${dateFmt(m.date)}`, current: r.meet[m.id] ? (r.meet[m.id].paid ? 1 : -1) * r.meet[m.id].cents / 100 : 0, hint: 'Positive = penalty paid, negative = unpaid, 0 = no penalty.' }, fineView(r.meet[m.id]), '', m.id))}
                  <td className={`${td} font-semibold`}>{kes(r.totals.contributionsCents)}</td>
                  <td className={td}>{kes(r.totals.finesPaidCents)}</td>
                  <td className={`${td} ${r.totals.arrearsCents ? 'font-semibold text-red-600' : ''}`}>{r.totals.arrearsCents ? `−${kes(r.totals.arrearsCents)}` : '—'}</td>
                  {isAdmin && <td className={td}><button className="font-semibold text-brand-700 underline" onClick={() => setPay(r.id)}>Record</button></td>}
                </tr>
              ))}
              <tr className="sticky bottom-0 bg-slate-100 font-semibold">
                <td className="sticky left-0 border border-slate-200 bg-slate-100 px-2 py-1 text-xs">Total</td>
                {data.months.map((p: string) => [
                  <td key={p + 'c'} className={td}>{total((r) => (r.cont[p] ?? r.live[p] ?? 0)) / 100 || ''}</td>,
                  ...(hasFine(p) ? [<td key={p + 'f'} className={td}>{total((r) => r.fine[p]?.cents ?? 0) / 100 || ''}</td>] : []),
                ])}
                {data.meetings.map((m: any) => <td key={m.id} className={td}>{total((r) => r.meet[m.id]?.cents ?? 0) / 100 || ''}</td>)}
                <td className={td}>{kes(total((r) => r.totals.contributionsCents))}</td><td className={td}>{kes(total((r) => r.totals.finesPaidCents))}</td><td className={`${td} text-red-600`}>−{kes(total((r) => r.totals.arrearsCents))}</td>{isAdmin && <td className={td} />}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {data.expenses.length > 0 && <div className="mt-4 text-sm"><h3 className="font-semibold">Expenses from the sheet</h3><ul className="list-disc pl-5">{data.expenses.map((e: any) => <li key={e.reference}>{e.description}: {kes(e.amount_cents)} ({monthFmt(e.spent_on)})</li>)}</ul></div>}
      <p className="mt-3 text-xs text-slate-500">Fine cells: red with a minus sign = unpaid, plain = paid. Amber contribution cells differ from the usual KSh 1,500 — check them against the receipts. Grey cells belong to the live payment system and cannot be edited here.</p>
      {isAdmin && (manual.data ?? []).length > 0 && (
        <div className="mt-6"><h3 className="mb-2 font-semibold">Payments entered by hand</h3>
          <div className="overflow-auto rounded-xl border border-slate-200 bg-white"><table className="min-w-full text-xs"><thead><tr className="bg-slate-50 text-left"><th className="p-2">Entered</th><th className="p-2">Member</th><th className="p-2">Paid on</th><th className="p-2 text-right">Amount</th><th className="p-2">Cleared</th><th className="p-2">M-Pesa code</th><th className="p-2">Message</th></tr></thead>
            <tbody>{manual.data!.map((p) => <tr key={p.id} className="border-t border-slate-100"><td className="p-2 whitespace-nowrap">{dateTimeFmt(p.created_at)}</td><td className="p-2">{p.full_name}</td><td className="p-2 whitespace-nowrap">{p.paid_on ?? '—'}</td><td className="p-2 text-right">{kes(p.amount_cents)}</td><td className="p-2">{(p.allocation?.cleared ?? []).map((c: any) => c.label).concat((p.allocation?.inAdvance ?? []).map((c: any) => `In advance ${monthFmt(c.period)}`)).join('; ')}</td><td className="p-2 font-mono">{p.mpesa_code}</td><td className="p-2">{p.transaction_message}</td></tr>)}</tbody></table></div></div>
      )}
      {pay !== null && isAdmin && <PaymentModal members={data.rows} preset={pay || undefined} onClose={() => setPay(null)} onDone={() => setN((x) => x + 1)} />}
      {sel && <CellModal sel={sel} onClose={() => setSel(null)} onDone={() => setN((x) => x + 1)} />}
      {load && <LoadSheet onClose={() => setLoad(false)} onDone={() => setN((x) => x + 1)} />}
    </Page>
  );
}
