import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { NAV_ACCESS, useAuth } from '../../auth';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dateTimeFmt, human, kes } from '../../format';
import { Badge, ErrorBox, Loading, Page, Stat, useApi } from '../../ui';

const SERVICES: { label: string; to: string; key: string | null; words: string }[] = [
  { label: 'Members: register, edit, profiles', to: '/admin/members', key: 'members', words: 'member register new add edit profile national id phone complete compliance registration date statement' },
  { label: 'Member payments: post a payment, allocate to invoices', to: '/admin/member-payments', key: 'ledger', words: 'payment post mpesa code allocate invoice invoices credit overpayment balance received reverse correct' },
  { label: 'Raise an invoice (contribution or fine)', to: '/admin/member-payments', key: 'ledger', words: 'invoice raise contribution monthly late fine post' },
  { label: 'Fines: impose, waive, clear, correct dates', to: '/admin/fines', key: 'fines', words: 'fine fines penalty penalties waive clear absent absence late correct date' },
  { label: 'Meetings and attendance', to: '/admin/meetings', key: 'meetings', words: 'meeting meetings attendance present absent excused venue agenda minutes' },
  { label: 'Withdrawals', to: '/admin/withdrawals', key: 'withdrawals', words: 'withdraw withdrawal payout request approve savings' },
  { label: 'Income and expenses', to: '/admin/money', key: 'money', words: 'income expense expenses expenditure spend cost money receipts recipient' },
  { label: 'Reconciliation', to: '/admin/reconciliation', key: 'reconciliation', words: 'reconcile reconciliation discrepancy bank mpesa statement month close' },
  { label: 'Records and documents', to: '/admin/records', key: 'records', words: 'record records document documents file upload certificate licence expiry constitution minutes' },
  { label: 'Reports: statements, group statement, collections', to: '/admin/reports', key: 'reports', words: 'report reports statement group statement member statement individual period pdf excel csv download collections outstanding register attendance income financial position' },
  { label: 'Data import', to: '/admin/imports', key: 'imports', words: 'import upload csv excel historical savings opening balances members previous fines attendance' },
  { label: 'Settings: rules, contribution amount, users', to: '/admin/settings', key: 'settings', words: 'settings rules contribution amount deadline fine amount users staff roles password financial year reset' },
  { label: 'Audit trail', to: '/admin/audit', key: 'audit', words: 'audit trail log history who changed activity' },
];

function ServiceSearch() {
  const { me } = useAuth(); const nav = useNavigate();
  const [q, setQ] = useState(''); const [hi, setHi] = useState(0);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = terms.length ? SERVICES.filter((x) => (!x.key || NAV_ACCESS[x.key]?.includes(me!.role)) && terms.every((t) => `${x.label} ${x.words}`.toLowerCase().includes(t))) : [];
  const go = (to: string) => { setQ(''); nav(to); };
  return (
    <div className="relative">
      <input className="input w-full" placeholder="Search for a service, e.g. fines, post a payment, group statement, withdrawals" value={q} aria-label="Search services"
        onChange={(e) => { setQ(e.target.value); setHi(0); }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(hi + 1, hits.length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(hi - 1, 0)); } else if (e.key === 'Enter' && hits[hi]) go(hits[hi].to); else if (e.key === 'Escape') setQ(''); }} />
      {terms.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          {hits.length ? hits.map((h, i) => (
            <li key={h.label}><button type="button" className={`w-full px-3 py-2 text-left text-sm ${i === hi ? 'bg-brand-50 text-brand-900' : 'hover:bg-slate-50'}`} onMouseEnter={() => setHi(i)} onClick={() => go(h.to)}>{h.label}</button></li>
          )) : <li className="px-3 py-2 text-sm text-slate-500">Nothing matches "{q}". Try another word, like payment, fine or report.</li>}
        </ul>
      )}
    </div>
  );
}

export default function AdminDashboard() {
  const { data: d, loading, error } = useApi<any>('/admin/dashboard');
  if (loading && !d) return <Loading />;
  if (!d) return <ErrorBox msg={error} />;
  const trend = (d.trend ?? []).map((t: any) => ({ month: t.month, Expected: Number(t.expected) / 100, Collected: Number(t.collected) / 100 }));
  return (
    <Page title="Dashboard" subtitle={`Today: ${d.today}`}>
      <ServiceSearch />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active members" value={d.members.active} hint={`${d.members.total} registered`} />
        {d.members.incomplete > 0 && <Link to="/admin/members"><Stat label="Members pending compliance" value={d.members.incomplete} hint="Missing details or Next of Kin form" tone="warn" /></Link>}
        {d.month && <Stat label="Savings received this month" value={kes(d.month.position.savingsReceiptsCents)} />}
        {d.recon && <Link to="/admin/reconciliation"><Stat label="This month's reconciliation" value={<Badge value={d.recon.status} />} hint="Open reconciliation" /></Link>}
        {d.discrepancies && <Stat label="Open discrepancies" value={d.discrepancies.open} hint={`${d.discrepancies.material} material`} tone={d.discrepancies.material > 0 ? 'warn' : undefined} />}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {d.queues && <><Link to="/admin/payments"><Stat label="Payment proofs to verify" value={d.queues.submissions} /></Link><Link to="/admin/payments"><Stat label="Held payments" value={d.queues.held_payments} tone={d.queues.held_payments ? 'warn' : undefined} /></Link></>}
        {d.withdrawals && <Link to="/admin/withdrawals"><Stat label="Withdrawals" value={`${d.withdrawals.to_review} to review`} hint={`${d.withdrawals.to_pay} to pay out`} /></Link>}
        {d.expenditure && <Link to="/admin/money"><Stat label="Expenditure" value={`${d.expenditure.pending} pending`} hint={`${d.expenditure.to_pay} approved, unpaid`} /></Link>}
        {d.records && <Link to="/admin/records"><Stat label="Records & documents" value={d.records.current_total} hint={d.records.expired ? `${d.records.expired} expired` : d.records.expiring_soon ? `${d.records.expiring_soon} renewing within 60 days` : 'All up to date'} tone={d.records.expired ? 'warn' : undefined} /></Link>}
        {d.nextMeeting && <Link to="/admin/meetings"><Stat label="Next meeting" value={d.nextMeeting.title} hint={`${dateTimeFmt(d.nextMeeting.scheduled_at)} · ${d.nextMeeting.venue}`} /></Link>}
      </div>
      {trend.length > 0 && (
        <div className="card"><h2 className="mb-3 font-bold">Contributions: expected vs collected (KSh)</h2>
          <div className="h-64"><ResponsiveContainer><BarChart data={trend}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="month" /><YAxis /><Tooltip formatter={(v: number) => `KSh ${v.toLocaleString()}`} /><Legend /><Bar dataKey="Expected" fill="#94a3b8" /><Bar dataKey="Collected" fill="#059669" /></BarChart></ResponsiveContainer></div>
        </div>
      )}
      <p className="text-xs text-slate-400">Signed in role: {human(d.role ?? '')}</p>
    </Page>
  );
}
