import { useState } from 'react';
import { post, fileToUpload } from '../../api';
import { useAuth } from '../../auth';
import { dateFmt, human, kes } from '../../format';
import { Badge, ErrorBox, Field, Modal, Notice, Page, Table, Tabs, useAction, useApi, DateInput } from '../../ui';

export default function Money() {
  const { me } = useAuth();
  const [tab, setTab] = useState('exp');
  const inc = useApi<any[]>('/admin/income'); const exp = useApi<any[]>('/admin/expenditure');
  const act = useAction();
  const [add, setAdd] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState<any>({ category: 'administrative', amount: '', date: today, description: '', recipient: '', source: '', reference: '' });
  const [file, setFile] = useState<File | null>(null);
  const isChair = me?.role === 'chairperson' || me?.role === 'super_admin';
  const canRecord = me?.role === 'treasurer' || me?.role === 'super_admin';
  const submit = async () => {
    if (tab === 'exp') {
      const upload = file ? await fileToUpload(file) : undefined;
      await post('/admin/expenditure', { category: f.category, amountCents: Math.round(Number(f.amount) * 100), spentOn: f.date, description: f.description, recipient: f.recipient, file: upload });
    } else await post('/admin/income', { category: f.category, amountCents: Math.round(Number(f.amount) * 100), receivedOn: f.date, description: f.description, source: f.source || undefined, reference: f.reference || undefined });
  };
  const ask = async (label: string, fn: (v: string) => Promise<unknown>) => { const v = window.prompt(label); if (!v) return; await act.run(() => fn(v), 'Done.'); exp.reload(); inc.reload(); };
  return (
    <Page title="Income & expenditure" subtitle="Savings are never counted as income; expenditure needs approval before it is paid." actions={canRecord && <button className="btn-primary" onClick={() => { setF({ ...f, category: tab === 'exp' ? 'administrative' : 'other_income' }); setAdd(true); }}>{tab === 'exp' ? 'Request expenditure' : 'Record income'}</button>}>
      <Tabs value={tab} onChange={setTab} tabs={[['exp', 'Expenditure'], ['inc', 'Other income']]} />
      <ErrorBox msg={act.error} /><Notice msg={act.ok} />
      {tab === 'exp' ? (
        <Table rows={exp.data ?? []} columns={[{ key: 'reference', label: 'Ref' }, { key: 'spent_on', label: 'Date', render: (r) => dateFmt(r.spent_on) }, { key: 'category', label: 'Type', render: (r) => human(r.category) }, { key: 'description', label: 'Description' }, { key: 'recipient', label: 'Recipient' }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
          { key: 'x', label: '', render: (r) => (<div className="flex gap-2 whitespace-nowrap">
            {r.status === 'pending' && isChair && <><button className="text-brand-700 underline" onClick={async () => { await act.run(() => post(`/admin/expenditure/${r.id}/decide`, { approve: true }), 'Approved.'); exp.reload(); }}>Approve</button><button className="text-red-600 underline" onClick={() => ask('Reason for rejection', (n) => post(`/admin/expenditure/${r.id}/decide`, { approve: false, note: n }))}>Reject</button></>}
            {r.status === 'approved' && canRecord && <button className="text-brand-700 underline" onClick={() => ask('Payment reference', (n) => post(`/admin/expenditure/${r.id}/pay`, { paymentReference: n }))}>Mark paid</button>}
            {['approved', 'paid'].includes(r.status) && isChair && <button className="text-red-600 underline" onClick={() => ask('Reason for voiding', (n) => post(`/admin/expenditure/${r.id}/void`, { reason: n }))}>Void</button>}</div>) }]} />
      ) : (
        <Table rows={inc.data ?? []} columns={[{ key: 'received_on', label: 'Date', render: (r) => dateFmt(r.received_on) }, { key: 'category', label: 'Type', render: (r) => human(r.category) }, { key: 'description', label: 'Description' }, { key: 'source', label: 'Source' }, { key: 'amount_cents', label: 'Amount', align: 'right', render: (r) => kes(r.amount_cents) }, { key: 'status', label: '', render: (r) => (r.amount_cents < 0 ? <Badge value="reversed" /> : canRecord ? <button className="text-red-600 underline" onClick={() => ask('Reason for reversal', (n) => post(`/admin/income/${r.id}/reverse`, { reason: n }))}>Reverse</button> : null) }]} />
      )}
      {add && (
        <Modal title={tab === 'exp' ? 'Request expenditure' : 'Record income'} onClose={() => setAdd(false)}>
          <div className="space-y-3"><ErrorBox msg={act.error} />
            <Field label="Category"><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{(tab === 'exp' ? ['administrative', 'meeting', 'other'] : ['special_contribution', 'other_income', 'opening_balance']).map((c) => <option key={c} value={c}>{human(c)}</option>)}</select></Field>
            <Field label="Amount (KSh)"><input className="input" type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Date"><DateInput value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="Description"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            {tab === 'exp' ? <><Field label="Recipient"><input className="input" value={f.recipient} onChange={(e) => setF({ ...f, recipient: e.target.value })} /></Field><Field label="Receipt / supporting document"><input className="input" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field></> : <><Field label="Source"><input className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></Field><Field label="Reference"><input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field></>}
            <button className="btn-primary w-full" disabled={act.busy} onClick={async () => { if (await act.run(submit, 'Saved.')) { setAdd(false); exp.reload(); inc.reload(); } }}>Save</button></div>
        </Modal>
      )}
    </Page>
  );
}
