import { useState } from 'react';
import { patch, post } from '../../api';
import { kes } from '../../format';
import { DateInput, DateTimeInput, ErrorBox, Field, Modal, MonthInput, useAction } from '../../ui';

const WHY = 'Why are you changing it? (required, kept in the audit trail)';
const Why = ({ v, set }: { v: string; set: (s: string) => void }) => <Field label={WHY}><input className="input" value={v} onChange={(e) => set(e.target.value)} placeholder="e.g. Typed the wrong date" /></Field>;

/** Correct a fine: date, month, wording, amount (the amount only while it is still unpaid). */
export function EditFineModal({ fine, onClose, onDone }: { fine: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ imposedOn: fine.imposed_on ?? '', period: (fine.period ?? '').slice(0, 7), reason: fine.reason ?? '', amount: String(Number(fine.amount_cents) / 100), note: '' });
  const act = useAction();
  const unpaid = fine.status === 'outstanding';
  return (
    <Modal title={`Correct fine ${fine.reference ?? ''}`} onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} />
        <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">Change what was recorded wrongly. The old value, the new value and your reason are kept in the audit trail. {unpaid ? '' : 'This fine is already paid, so only its date, month and wording can change.'}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date of the fine"><DateInput value={f.imposedOn} onChange={(e) => setF({ ...f, imposedOn: e.target.value })} /></Field>
          <Field label="Month it belongs to"><MonthInput value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} /></Field>
        </div>
        <Field label="Wording"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {unpaid && <Field label="Amount (KSh)"><input className="input" type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>}
        <Why v={f.note} set={(note) => setF({ ...f, note })} />
        <button className="btn-primary w-full" disabled={act.busy || f.note.trim().length < 3 || !f.imposedOn} onClick={async () => {
          const body: any = { note: f.note, imposedOn: f.imposedOn, reason: f.reason };
          if (f.period) body.period = f.period;
          if (unpaid && Number(f.amount) > 0) body.amountKsh = Number(f.amount);
          if (await act.run(() => patch(`/admin/fines/${fine.id}/correct`, body), 'Saved.')) { onDone(); onClose(); }
        }}>Save correction</button>
      </div>
    </Modal>
  );
}

/** Correct a contribution invoice that is not paid yet: month, due date, amount. */
export function EditInvoiceModal({ inv, onClose, onDone }: { inv: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ period: String(inv.month).slice(0, 7), dueDate: inv.dueDate ?? '', amount: String(inv.amountCents / 100), note: '' });
  const act = useAction();
  return (
    <Modal title={`Correct invoice: ${inv.label}`} onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} />
        <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">Only unpaid invoices can be changed. If the month is changed and you do not set a new due date, the same day of the new month is used.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Month"><MonthInput value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} /></Field>
          <Field label="Due date"><DateInput value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
        </div>
        <Field label="Amount (KSh)"><input className="input" type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Why v={f.note} set={(note) => setF({ ...f, note })} />
        <button className="btn-primary w-full" disabled={act.busy || f.note.trim().length < 3} onClick={async () => {
          const body: any = { note: f.note, amountKsh: Number(f.amount) };
          if (f.period !== String(inv.month).slice(0, 7)) body.period = f.period;
          if (f.dueDate && f.dueDate !== inv.dueDate) body.dueDate = f.dueDate;
          if (await act.run(() => patch(`/admin/obligations/${inv.id}/correct`, body), 'Saved.')) { onDone(); onClose(); }
        }}>Save correction</button>
      </div>
    </Modal>
  );
}

/** Correct the date or pasted message of a payment the administrator entered; or reverse it so it can be entered again correctly. */
export function EditPaymentModal({ pay, onClose, onDone }: { pay: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ paidOn: pay.paid_on ?? '', message: pay.transaction_message ?? '', note: '' });
  const act = useAction();
  return (
    <Modal title={`Payment ${pay.mpesa_code ?? ''} · ${kes(pay.amount_cents)}`} onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} />
        <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">Fix the date or the message here. To fix the <b>amount</b>, the member, or anything else about the money, reverse the payment (nothing is deleted: the invoices it cleared open up again) and record it again correctly.</p>
        <Field label="Date paid"><DateInput value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></Field>
        <Field label="Transaction message"><textarea className="input" rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
        <Why v={f.note} set={(note) => setF({ ...f, note })} />
        <div className="flex gap-2">
          <button className="btn-primary flex-1" disabled={act.busy || f.note.trim().length < 3 || !f.paidOn} onClick={async () => {
            if (await act.run(() => patch(`/admin/manual-payments/${pay.id}/correct`, { note: f.note, paidOn: f.paidOn, message: f.message }), 'Saved.')) { onDone(); onClose(); }
          }}>Save correction</button>
          <button className="btn-ghost !border-red-300 !text-red-700" disabled={act.busy || f.note.trim().length < 3} onClick={async () => {
            if (!window.confirm('Reverse this payment? The invoices it cleared will be unpaid again, and you can then record it correctly.')) return;
            if (await act.run(() => post(`/admin/manual-payments/${pay.id}/reverse`, { note: f.note }), 'Payment reversed.')) { onDone(); onClose(); }
          }}>Reverse payment</button>
        </div>
      </div>
    </Modal>
  );
}

/** Correct a meeting's title, date and time, venue or agenda. */
export function EditMeetingModal({ meeting, onClose, onDone }: { meeting: any; onClose: () => void; onDone: () => void }) {
  const local = new Date(new Date(meeting.scheduled_at).getTime() + 3 * 3600e3).toISOString().slice(0, 16);
  const [f, setF] = useState({ title: meeting.title ?? '', venue: meeting.venue ?? '', scheduledAt: local, agenda: meeting.agenda ?? '', note: '' });
  const act = useAction();
  return (
    <Modal title="Correct meeting" onClose={onClose}>
      <div className="space-y-3"><ErrorBox msg={act.error} />
        <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">Attendance and fines already recorded for this meeting are not changed.</p>
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Date and time (24-hour)"><DateTimeInput value={f.scheduledAt} onChange={(e) => setF({ ...f, scheduledAt: e.target.value })} /></Field>
        <Field label="Venue"><input className="input" value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} /></Field>
        <Field label="Agenda"><textarea className="input" rows={2} value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} /></Field>
        <Why v={f.note} set={(note) => setF({ ...f, note })} />
        <button className="btn-primary w-full" disabled={act.busy || f.note.trim().length < 3 || !f.scheduledAt} onClick={async () => {
          if (await act.run(() => patch(`/admin/meetings/${meeting.id}/correct`, { note: f.note, title: f.title, venue: f.venue, agenda: f.agenda, scheduledAt: `${f.scheduledAt}:00+03:00` }), 'Saved.')) { onDone(); onClose(); }
        }}>Save correction</button>
      </div>
    </Modal>
  );
}
