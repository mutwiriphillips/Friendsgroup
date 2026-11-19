import { useState } from 'react';
import { download, post } from '../../api';
import { useAuth } from '../../auth';
import { dateTimeFmt, human, kes, monthFmt } from '../../format';
import { Badge, ErrorBox, Field, Loading, Notice, Page, Stat, Table, Tabs, useAction, useApi, MonthInput } from '../../ui';

const Row = ({ label, value, bold }: { label: string; value: number; bold?: boolean }) => (
  <div className={`flex justify-between border-b border-slate-100 py-1.5 text-sm ${bold ? 'font-bold' : ''}`}><span>{label}</span><span className="tabular-nums">{kes(value)}</span></div>
);

function Period({ month, onChange }: { month: string; onChange: () => void }) {
  const { me } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/admin/reconciliation/${month}`, [month]);
  const disc = useApi<any[]>('/admin/discrepancies?status=all');
  const act = useAction();
  const refresh = () => { reload(); disc.reload(); onChange(); };
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox msg={error} />;
  const s = data.frozen || data.summary; const p = data.period;
  const status = p?.status ?? 'pending';
  const role = me!.role;
  const canWork = role === 'treasurer' || role === 'super_admin';
  const canApprove = role === 'chairperson' || role === 'super_admin';
  const mine = (disc.data ?? []).filter((d) => d.period?.slice(0, 7) === month);
  const open = mine.filter((d) => ['unresolved', 'investigating'].includes(d.status));
  const run = (path: string, body: unknown, ok: string) => async () => { await act.run(() => post(path, body), ok); refresh(); };
  const note = (label: string) => window.prompt(label) ?? '';
  return (
    <div className="space-y-4">
      <ErrorBox msg={act.error} /><Notice msg={act.ok} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Status" value={<Badge value={status} />} />
        <Stat label="Evidence" value={human(s.evidenceLevel)} hint="Full = official statement matched" />
        <Stat label="Closing cash" value={kes(s.position.closingCashCents)} />
        <Stat label="Open discrepancies" value={open.length} tone={open.length ? 'warn' : 'good'} />
      </div>
      <div className="flex flex-wrap gap-2">
        {canWork && status !== 'closed' && <button className="btn-ghost" disabled={act.busy} onClick={run('/admin/reconciliation/generate', { month, historical: p?.is_historical ?? false }, 'Reconciliation refreshed.')}>Generate / refresh</button>}
        {canWork && ['in_progress', 'discrepancies_found'].includes(status) && <button className="btn-primary" onClick={run(`/admin/reconciliation/${month}/submit`, {}, 'Submitted for approval.')}>Submit for approval</button>}
        {canApprove && status === 'awaiting_approval' && <><button className="btn-primary" onClick={async () => { await act.run(() => post(`/admin/reconciliation/${month}/review`, { approve: true, note: note('Approval note (optional)') || undefined }), 'Approved. Month is locked.'); refresh(); }}>Approve & lock month</button><button className="btn-danger" onClick={async () => { const n = note('Reason for returning'); if (!n) return; await act.run(() => post(`/admin/reconciliation/${month}/review`, { approve: false, note: n }), 'Returned.'); refresh(); }}>Return</button></>}
        {status === 'closed' && (role === 'super_admin' || role === 'chairperson') && <button className="btn-ghost" onClick={async () => { const n = note('Reason for reopening (min 10 characters)'); if (!n) return; await act.run(() => post(`/admin/reconciliation/${month}/reopen`, { reason: n }), 'Reopened.'); refresh(); }}>Reopen</button>}
        <button className="btn-ghost" onClick={() => download(`/reports/reconciliation_statement?month=${month}&format=pdf`, `reconciliation-${month}.pdf`)}>PDF</button>
        <button className="btn-ghost" onClick={() => download(`/reports/reconciliation_statement?month=${month}&format=xlsx`, `reconciliation-${month}.xlsx`)}>Excel</button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card"><h3 className="mb-2 font-bold">Cash position</h3>
          <Row label="Opening cash" value={s.position.openingCashCents} /><Row label="+ Savings received" value={s.position.savingsReceiptsCents} /><Row label="+ Fines collected" value={s.position.fineCollectionsCents} /><Row label="+ Other income" value={s.position.otherIncomeCents} />
          <Row label="− Group expenditure" value={s.position.groupExpenditureCents} /><Row label="− Member withdrawals" value={s.position.memberWithdrawalsCents} /><Row label="Closing cash" value={s.position.closingCashCents} bold />
          <Row label="Total member savings (liability)" value={s.position.totalMemberSavingsCents} /></div>
        <div className="card"><h3 className="mb-2 font-bold">Contributions & fines</h3>
          <Row label="Expected this month" value={s.expected.expectedCents} /><Row label="Settled on time" value={s.expected.settledOnTime.cents} /><Row label="Settled late" value={s.expected.settledLate.cents} /><Row label="Outstanding" value={s.expected.outstanding.cents} bold />
          <Row label="Late fines accrued" value={s.fines.lateAccruedCents} /><Row label="Absence fines accrued" value={s.fines.absenceAccruedCents} /><Row label="Fines paid" value={s.fines.verifiedPaymentsCents} /><Row label="Fines outstanding" value={s.fines.outstandingCents} bold />
          <div className="mt-2 text-xs text-slate-500">Held/unmatched payments: {s.collections.pendingOrUnmatched.count} ({kes(s.collections.pendingOrUnmatched.cents)}) · Unverified submissions: {s.collections.pendingSubmissions.count}</div></div>
      </div>
      <h3 className="font-bold">Discrepancies</h3>
      <Table rows={mine} empty="No discrepancies recorded for this month." columns={[{ key: 'severity', label: 'Severity', render: (r) => <Badge value={r.severity} /> }, { key: 'code', label: 'Check', render: (r) => human(r.code) }, { key: 'description', label: 'What was found' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'resolution_note', label: 'Note' },
        { key: 'x', label: '', render: (r) => (canWork && ['unresolved', 'investigating'].includes(r.status) && status !== 'closed' ? <div className="flex gap-2 whitespace-nowrap"><button className="text-brand-700 underline" onClick={async () => { const n = note('Resolution note'); if (!n) return; await act.run(() => post(`/admin/discrepancies/${r.id}`, { status: 'resolved', note: n }), 'Updated.'); refresh(); }}>Resolve</button><button className="text-slate-600 underline" onClick={async () => { const n = note('Investigation note'); if (!n) return; await act.run(() => post(`/admin/discrepancies/${r.id}`, { status: 'investigating', note: n }), 'Updated.'); refresh(); }}>Investigate</button>{canApprove && <button className="text-amber-700 underline" onClick={async () => { const n = note('Reason to accept as exception'); if (!n) return; await act.run(() => post(`/admin/discrepancies/${r.id}`, { status: 'exception', note: n }), 'Exception recorded.'); refresh(); }}>Exception</button>}</div> : null) }]} />
      <h3 className="font-bold">Member schedule</h3>
      <Table rows={data.schedule} columns={[{ key: 'membership_no', label: 'No.' }, { key: 'full_name', label: 'Member' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'paid_cents', label: 'Paid', align: 'right', render: (r) => kes(r.paid_cents) }, { key: 'mpesa_receipt', label: 'M-Pesa code' }, { key: 'late_fine_cents', label: 'Late fine', align: 'right', render: (r) => (r.late_fine_cents ? kes(r.late_fine_cents) : '—') }, { key: 'savings_balance_cents', label: 'Savings', align: 'right', render: (r) => kes(r.savings_balance_cents) }]} />
      {p?.approved_at && <p className="text-xs text-slate-500">Approved {dateTimeFmt(p.approved_at)}{p.review_note ? ` · ${p.review_note}` : ''}</p>}
    </div>
  );
}

function Statement() {
  const lines = useApi<any[]>('/admin/reconciliation-lines/list?status=all');
  const [file, setFile] = useState<File | null>(null);
  const act = useAction();
  const upload = async () => {
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const r = await post('/admin/reconciliation/statement-import', { filename: file.name, dataBase64: btoa(bin) });
    lines.reload(); return r;
  };
  const match = async (l: any) => {
    const memberId = window.prompt('Member ID (UUID) for this payment — copy from the Members page URL/detail'); if (!memberId) return;
    const purpose = window.confirm('OK = savings, Cancel = fine') ? 'savings' : 'fine';
    const reason = window.prompt('Why are you matching this manually?'); if (!reason) return;
    await act.run(() => post(`/admin/reconciliation-lines/${l.id}/match`, { memberId, purpose, reason }), 'Matched.'); lines.reload();
  };
  return (
    <div className="space-y-3">
      <div className="card space-y-2"><p className="text-sm text-slate-600">Upload the official M-Pesa statement (CSV or Excel). Each incoming receipt is compared with recorded payments. Differences show up as discrepancies.</p>
        <ErrorBox msg={act.error} /><Notice msg={act.ok} />
        <div className="flex flex-wrap gap-2"><input type="file" accept=".csv,.xlsx" className="input max-w-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><button className="btn-primary" disabled={!file || act.busy} onClick={() => act.run(upload, 'Statement imported.')}>Import statement</button></div></div>
      <Table rows={lines.data ?? []} columns={[{ key: 'txn_time', label: 'Time', render: (r) => dateTimeFmt(r.txn_time) }, { key: 'receipt', label: 'Receipt' }, { key: 'phone', label: 'Phone' }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }, { key: 'match_status', label: 'Match', render: (r) => <Badge value={r.match_status} /> }, { key: 'x', label: '', render: (r) => (['unmatched', 'amount_mismatch'].includes(r.match_status) ? <button className="text-brand-700 underline" onClick={() => match(r)}>Match manually</button> : null) }]} />
    </div>
  );
}

export default function Reconciliation() {
  const list = useApi<any[]>('/admin/reconciliation');
  const now = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(now);
  const [tab, setTab] = useState('month');
  return (
    <Page title="Monthly reconciliation" subtitle="Match M-Pesa, the ledgers and cash each month. The chairperson approves, then the month is locked.">
      <Tabs value={tab} onChange={setTab} tabs={[['month', 'Month review'], ['statement', 'M-Pesa statement']]} />
      {tab === 'statement' ? <Statement /> : (
        <>
          <div className="flex flex-wrap items-center gap-3"><Field label="Month"><MonthInput value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
            <div className="flex flex-wrap gap-1 pt-5">{(list.data ?? []).slice(0, 8).map((r) => <button key={r.month} onClick={() => setMonth(r.month)} className="rounded-full border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100">{monthFmt(r.month)} · {human(r.status)}</button>)}</div></div>
          {month && <Period key={month} month={month} onChange={list.reload} />}
        </>
      )}
    </Page>
  );
}
