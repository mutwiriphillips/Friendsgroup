import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../../api';
import { useAuth } from '../../auth';
import { dateFmt, kes } from '../../format';
import { Badge, ErrorBox, Field, Loading, Modal, Notice, Page, Stat, useAction, useApi } from '../../ui';

type Purpose = 'savings' | 'fine';

function PayModal({ purpose, onClose, onDone }: { purpose: Purpose; onClose: () => void; onDone: () => void }) {
  const [months, setMonths] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const fines = useApi<any[]>(purpose === 'fine' ? '/me/fines' : null);
  const open = (fines.data ?? []).filter((f) => f.status === 'outstanding' || f.status === 'unpaid');
  const body = purpose === 'savings' ? { purpose, months } : { purpose, fineIds: selected };
  const [plan, setPlan] = useState<any>(null);
  const prev = useAction();
  const pay = useAction();
  const [paymentId, setPaymentId] = useState('');
  const [status, setStatus] = useState<any>(null);
  const timer = useRef<number>();

  useEffect(() => {
    if (purpose === 'fine' && !selected.length) { setPlan(null); return; }
    void prev.run(async () => setPlan(await post('/me/pay/preview', body)), '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months, selected.join(',')]);

  useEffect(() => {
    if (!paymentId) return;
    const poll = async () => {
      try {
        const s = await post(`/me/payments/${paymentId}/check`);
        setStatus(s);
        if (s.status === 'initiated') timer.current = window.setTimeout(poll, 4000);
        else onDone();
      } catch { timer.current = window.setTimeout(poll, 6000); }
    };
    void poll();
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentId]);

  const send = async () => { const r = await pay.run(() => post('/me/pay', body), ''); if (r) setPaymentId(r.paymentId); };

  return (
    <Modal title={purpose === 'savings' ? 'Pay monthly savings' : 'Pay fines'} onClose={onClose}>
      {!paymentId ? (
        <div className="space-y-4">
          {purpose === 'savings' ? (
            <Field label="How many months?"><input className="input" type="number" min={1} max={36} value={months} onChange={(e) => setMonths(Math.max(1, Number(e.target.value) || 1))} /></Field>
          ) : (
            <div className="space-y-2">
              <span className="label">Select the fines to pay</span>
              {!open.length && <p className="text-sm text-slate-500">You have no outstanding fines.</p>}
              {open.map((f) => (
                <label key={f.id} className="flex items-center gap-2 rounded-lg border border-slate-200 p-2 text-sm">
                  <input type="checkbox" checked={selected.includes(f.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, f.id] : selected.filter((x) => x !== f.id))} />
                  <span className="flex-1">{f.reference} · {f.reason}</span><b>{kes(f.amount_cents)}</b>
                </label>
              ))}
            </div>
          )}
          <ErrorBox msg={prev.error} />
          {plan && (
            <div className="rounded-lg bg-brand-50 p-3 text-sm">
              <div className="font-semibold">{plan.description}</div>
              <div className="mt-1 text-2xl font-bold text-brand-700">{kes(plan.amountCents)}</div>
              <div className="text-xs text-slate-600">M-Pesa prompt will go to {plan.mpesaPhone}. Months are cleared oldest first.</div>
            </div>
          )}
          <ErrorBox msg={pay.error} />
          <button className="btn-primary w-full" disabled={!plan || pay.busy} onClick={send}>{pay.busy ? 'Sending…' : 'Send M-Pesa prompt'}</button>
        </div>
      ) : (
        <div className="space-y-3 text-center">
          {(!status || status.status === 'initiated') && <><p className="text-lg font-semibold">Check your phone</p><p className="text-sm text-slate-600">Enter your M-Pesa PIN to complete the payment. This page updates by itself.</p></>}
          {status?.status === 'confirmed' && <><p className="text-lg font-bold text-brand-700">Payment received</p><p className="text-sm">Receipt {status.receipt_no}</p></>}
          {status?.status === 'held' && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Your payment was received but needs review by the treasurer: {status.hold_reason}. Your money is safe.</p>}
          {status?.status === 'failed' && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">The payment did not complete: {status.result_desc}</p>}
          {status && status.status !== 'initiated' && <button className="btn-primary" onClick={onClose}>Close</button>}
        </div>
      )}
    </Modal>
  );
}

export default function MemberDashboard() {
  const managed = Boolean(useAuth().me?.hide_owed);
  const { data: s, loading, error, reload } = useApi<any>('/me/summary');
  const ob = useApi<any[]>('/me/obligations');
  const [pay, setPay] = useState<Purpose | null>(null);
  const nok = useApi<any>('/me/next-of-kin');
  if (loading && !s) return <Loading />;
  if (!s) return <ErrorBox msg={error} />;
  return (
    <Page title="My overview" subtitle={`As of ${dateFmt(s.asOf)}`}>
      {nok.data && !nok.data.submitted && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">Your profile is <b>non-compliant</b> until you fill in and submit your Next of Kin form. <Link to="/portal/profile" className="font-semibold underline">Complete it now</Link></div>
      )}
      {!managed && s.savings.outstandingMonths > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          You have {s.savings.outstandingMonths} unpaid month{s.savings.outstandingMonths > 1 ? 's' : ''} ({kes(s.savings.outstandingCents)}). Oldest due date: {dateFmt(s.payments.oldestOutstandingDueDate)}.
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-3">
          <h2 className="font-bold text-brand-700">Savings</h2>
          <div className="text-3xl font-extrabold">{kes(s.savings.balanceCents)}</div>
          <div className="grid grid-cols-2 gap-2 text-sm"><div><div className="label">This financial year</div>{kes(s.savings.currentYearCents)}</div>{!managed && <div><div className="label">Unpaid contributions</div>{kes(s.savings.outstandingCents)}</div>}</div>
          {managed ? <p className="text-xs text-slate-500">Your treasurer records which months each payment covers.</p> : <button className="btn-primary w-full" onClick={() => setPay('savings')}>Pay savings with M-Pesa</button>}
        </div>
        <div className="card space-y-3">
          <h2 className="font-bold text-amber-700">Fines</h2>
          {!managed && <div className={`text-3xl font-extrabold ${s.fines.outstandingCents > 0 ? 'text-red-600' : ''}`}>{kes(s.fines.outstandingCents)}</div>}
          <div className="grid grid-cols-3 gap-2 text-sm"><div><div className="label">Charged</div>{kes(s.fines.accruedCents)}</div><div><div className="label">Paid</div>{kes(s.fines.paidCents)}</div><div><div className="label">Waived</div>{kes(s.fines.waivedCents)}</div></div>
          {managed ? <p className="text-xs text-slate-500">Fines are decided and recorded by the administrators.</p> : <button className="btn-ghost w-full" disabled={s.fines.outstandingCents <= 0} onClick={() => setPay('fine')}>Pay fines with M-Pesa</button>}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Last payment" value={s.payments.last ? kes(s.payments.last.amount_cents) : '—'} hint={s.payments.last ? `${s.payments.last.receipt_no} · ${dateFmt(s.payments.last.confirmed_at)}` : 'No payments yet'} />
        <Stat label="Awaiting verification" value={s.payments.pendingVerification} hint="Payments being checked" />
        <Stat label="Expected to date" value={kes(s.savings.expectedCents)} />
      </div>
      <h2 className="font-bold">Monthly contributions</h2>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {(ob.data ?? []).slice(0, 12).map((o) => (
          <div key={o.id} className="card !p-3 text-center"><div className="text-xs text-slate-500">{o.period.slice(5, 7)}/{o.period.slice(0, 4)}</div><div className="mt-1"><Badge value={o.status} /></div></div>
        ))}
      </div>
      {pay && <PayModal purpose={pay} onClose={() => setPay(null)} onDone={() => { reload(); ob.reload(); }} />}
    </Page>
  );
}
