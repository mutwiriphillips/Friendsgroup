import { useMemo, useState } from 'react';
import { useAuth } from '../../auth';
import { kes } from '../../format';
import { ErrorBox, Loading, Page, useApi } from '../../ui';
import { AllocateModal, PaymentModal, RaiseInvoiceModal } from './Ledger';
import { Detail } from './Members';

export default function MemberPayments() {
  const { me } = useAuth();
  const isAdmin = me?.role === 'super_admin';
  const [n, setN] = useState(0);
  const { data, error } = useApi<any[]>('/members/finance-summary', [n]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [pay, setPay] = useState<string | null>(null);
  const [inv, setInv] = useState<string | null>(null);
  const [cred, setCred] = useState<string | null>(null);
  const rows = useMemo(() => (data ?? []).filter((r) => `${r.full_name} ${r.membership_no}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  if (error) return <ErrorBox msg={error} />;
  if (!data) return <Loading />;
  const managed = Boolean(me?.admin_managed);
  const owedOf = (r: any) => Number(r.owed_contributions_cents) + Number(r.penalties_outstanding_cents);
  const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k]), 0);
  return (
    <Page title="Member payments" subtitle="Every member's contributions and penalties in one place. Open a member to see their full financial report and download it."
      actions={isAdmin && <div className="flex gap-2"><button className="btn-ghost" onClick={() => setInv('')}>Raise invoice</button><button className="btn-ghost" onClick={() => setCred('')}>Allocate payments</button><button className="btn-primary" onClick={() => setPay('')}>Post a payment</button></div>}>
      <input className="input max-w-xs" placeholder="Find a member…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead><tr className="bg-slate-50 text-left text-xs">
            <th className="p-2">Member</th><th className="p-2 text-right">Total contributions</th><th className="p-2 text-right">Months paid</th>
            {!managed && <><th className="p-2 text-right">Contributions owed</th><th className="p-2 text-right">Penalties owed</th><th className="p-2 text-right">Total owed</th></>}<th className="p-2 text-right">Awaiting allocation</th><th className="p-2" />
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer border-t border-slate-100 hover:bg-brand-50" onClick={() => setOpen(r.id)}>
                <td className="p-2"><div className="font-medium">{r.full_name}</div><div className="text-xs text-slate-500">{r.membership_no}{!r.profile_complete && ' · pending compliance'}</div></td>
                <td className="p-2 text-right font-semibold">{kes(r.contributions_cents)}</td>
                <td className="p-2 text-right">{r.months_paid}</td>
                {!managed && <>
                <td className={`p-2 text-right ${Number(r.owed_contributions_cents) > 0 ? 'text-red-600' : ''}`}>{kes(r.owed_contributions_cents)}</td>
                <td className={`p-2 text-right ${Number(r.penalties_outstanding_cents) > 0 ? 'text-red-600' : ''}`}>{kes(r.penalties_outstanding_cents)}</td>
                <td className={`p-2 text-right font-semibold ${owedOf(r) > 0 ? 'text-red-600' : ''}`}>{kes(owedOf(r))}</td>
                </>}
                <td className={`p-2 text-right whitespace-nowrap ${Number(r.credit_cents) > 0 ? 'font-semibold text-blue-700' : 'text-slate-400'}`}>{kes(r.credit_cents)}</td>
                <td className="p-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <button className="text-brand-700 underline" onClick={() => setOpen(r.id)}>Financial report</button>
                  {isAdmin && <><button className="ml-3 text-brand-700 underline" onClick={() => setInv(r.id)}>Invoice</button>{Number(r.credit_cents) > 0 && <button className="ml-3 font-semibold text-blue-700 underline" onClick={() => setCred(r.id)}>Allocate payment</button>}<button className="ml-3 font-semibold text-brand-700 underline" onClick={() => setPay(r.id)}>Post payment</button></>}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
              <td className="p-2">Total ({rows.length} members)</td><td className="p-2 text-right">{kes(sum('contributions_cents'))}</td><td className="p-2" />
              {!managed && <><td className="p-2 text-right">{kes(sum('owed_contributions_cents'))}</td><td className="p-2 text-right">{kes(sum('penalties_outstanding_cents'))}</td><td className="p-2 text-right text-red-600">{kes(sum('owed_contributions_cents') + sum('penalties_outstanding_cents'))}</td></>}<td className="p-2 text-right text-blue-700">{kes(sum('credit_cents'))}</td><td className="p-2" />
            </tr>
          </tbody>
        </table>
      </div>
      {open && <Detail id={open} onClose={() => setOpen(null)} onChange={() => setN((x) => x + 1)} />}
      {inv !== null && isAdmin && <RaiseInvoiceModal members={data.map((r) => ({ id: r.id, name: r.full_name }))} preset={inv || undefined} onClose={() => setInv(null)} onDone={() => setN((x) => x + 1)} />}
      {cred !== null && isAdmin && <AllocateModal members={data.map((r) => ({ id: r.id, name: r.full_name }))} preset={cred || undefined} onClose={() => setCred(null)} onDone={() => setN((x) => x + 1)} />}
      {pay !== null && isAdmin && <PaymentModal onAllocate={(id) => { setPay(null); setCred(id); }} members={data.map((r) => ({ id: r.id, name: r.full_name }))} preset={pay || undefined} onClose={() => setPay(null)} onDone={() => setN((x) => x + 1)} />}
    </Page>
  );
}
