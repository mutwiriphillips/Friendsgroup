import { useEffect, useMemo, useState } from 'react';
import { download, post, put } from '../api';
import { dateFmt, dateTimeFmt } from '../format';
import { Badge, DateInput, ErrorBox, Field, Loading, Notice, useAction, useApi } from '../ui';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const ageOn = (dob: string) => { if (!dob) return 99; const a = new Date(dob), b = new Date(today()); let n = b.getFullYear() - a.getFullYear(); if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) n--; return n; };
const blankBen = () => ({ fullName: '', relationship: '', idNumber: '', dateOfBirth: '', phone: '', sharePct: 0 });
const blankGuardian = () => ({ fullName: '', idNumber: '', relationship: '', phone: '', address: '' });
const emptyForm = (m: any) => ({
  memberDetails: { nationalId: '', phone: '', email: '', dateOfBirth: '', residence: m?.address ?? '' },
  beneficiaries: [blankBen()], primaryAddress: '', contingentName: '', contingentPhone: '', guardian: null as any,
  witness: { fullName: '', idNumber: '', phone: '', isAdult: false }, signedName: '', confirmed: false,
});

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="card space-y-3"><h2 className="-mx-4 -mt-4 mb-1 rounded-t-xl border-l-4 border-brand-600 bg-brand-50 px-4 py-2 text-sm font-bold uppercase tracking-wide text-brand-900">{title}</h2>{children}</section>;
}
const showPhone = (v?: string | null) => (v ?? '').replace(/^\+?254(\d{9})$/, '0$1');
const Row = ({ label, value }: { label: string; value?: string | null }) => <div><div className="label">{label}</div><div className="font-medium">{value || '—'}</div></div>;

/** The completed form, as a read-only page. */
function ReadOnly({ n }: { n: any }) {
  const f = n.form; const m = n.member;
  return (
    <div className="space-y-4">
      <Box title="Section 1: Member details"><div className="grid gap-3 sm:grid-cols-2">
        <Row label="Full legal name" value={m.fullName} /><Row label="Membership no." value={m.membershipNo} /><Row label="National ID / Passport" value={m.nationalId} /><Row label="Date of birth" value={dateFmt(f.memberDetails.dateOfBirth)} />
        <Row label="Primary phone" value={showPhone(m.phone)} /><Row label="Email" value={m.email ?? f.memberDetails.email} /><div className="sm:col-span-2"><Row label="Physical residence / county / sub-county" value={f.memberDetails.residence} /></div></div></Box>
      <Box title="Section 2: Nominated next of kin & benefit allocation">
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-slate-500"><th className="pr-2">Name</th><th className="pr-2">Relationship</th><th className="pr-2">ID / Birth cert</th><th className="pr-2">Date of birth</th><th className="pr-2">Phone</th><th className="text-right">Share</th></tr></thead>
          <tbody>{f.beneficiaries.map((b: any, i: number) => <tr key={i} className="border-t border-slate-100"><td className="py-1 pr-2 font-medium">{b.fullName}</td><td className="pr-2">{b.relationship}</td><td className="pr-2">{b.idNumber}</td><td className="pr-2 whitespace-nowrap">{dateFmt(b.dateOfBirth)}</td><td className="pr-2">{b.phone}</td><td className="text-right font-semibold">{b.sharePct}%</td></tr>)}</tbody></table></div>
        <div className="text-right text-sm font-bold">Total allocation: {f.beneficiaries.reduce((a: number, b: any) => a + b.sharePct, 0)}%</div>
        <div className="grid gap-3 sm:grid-cols-2"><Row label="Primary next of kin physical address / county" value={f.primaryAddress} /><Row label="Contingent (backup) next of kin" value={`${f.contingentName}, ${f.contingentPhone}`} /></div></Box>
      <Box title="Section 3: Appointed guardian / trustee">{f.guardian ? <div className="grid gap-3 sm:grid-cols-2"><Row label="Guardian full legal name" value={f.guardian.fullName} /><Row label="National ID / Passport" value={f.guardian.idNumber} /><Row label="Relationship to minor" value={f.guardian.relationship} /><Row label="Phone number(s)" value={f.guardian.phone} /><div className="sm:col-span-2"><Row label="Physical address / county" value={f.guardian.address} /></div></div> : <p className="text-sm text-slate-500">Not applicable. No beneficiary is under 18 years of age.</p>}</Box>
      <Box title="Section 4: Declaration, data consent & witness"><div className="grid gap-3 sm:grid-cols-2">
        <Row label="Signed electronically by" value={f.signedName} /><Row label="Date" value={dateFmt(f.declarationDate)} /><Row label="Witness" value={f.witness.fullName} /><Row label="Witness National ID" value={f.witness.idNumber} /><Row label="Witness phone" value={f.witness.phone} /></div></Box>
    </div>
  );
}

/** The fill-in form with a review-and-confirm step before submission. */
function Editor({ n, initial, onSave, onCancel, amend }: { n: any; initial?: any; onSave: (body: any) => Promise<boolean>; onCancel?: () => void; amend?: boolean }) {
  const m = n.member;
  const [f, setF] = useState<any>(() => initial ? { ...initial, memberDetails: { nationalId: '', phone: '', email: initial.memberDetails.email ?? '', dateOfBirth: initial.memberDetails.dateOfBirth, residence: initial.memberDetails.residence }, confirmed: false, signedName: '' } : emptyForm(m));
  const [note, setNote] = useState('');
  const [review, setReview] = useState(false);
  const [err, setErr] = useState('');
  const act = useAction();
  const total = f.beneficiaries.reduce((a: number, b: any) => a + (Number(b.sharePct) || 0), 0);
  const minor = f.beneficiaries.some((b: any) => b.dateOfBirth && ageOn(b.dateOfBirth) < 18);
  useEffect(() => { if (minor && !f.guardian) setF((p: any) => ({ ...p, guardian: blankGuardian() })); if (!minor && f.guardian) setF((p: any) => ({ ...p, guardian: null })); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [minor]);
  const set = (path: string[], v: any) => setF((p: any) => { const c = structuredClone(p); let o = c; path.slice(0, -1).forEach((k) => { o = o[k]; }); o[path[path.length - 1]!] = v; return c; });
  const ben = (i: number, k: string, v: any) => set(['beneficiaries', String(i), k], v);
  const inp = (path: string[], label: string, extra: Record<string, any> = {}) => { let v: any = f; path.forEach((k) => { v = v[k]; }); return <Field label={label}><input className="input" value={v ?? ''} onChange={(e) => set(path, e.target.value)} {...extra} /></Field>; };
  const issues = useMemo(() => {
    const out: string[] = []; const d = f.memberDetails;
    if (!m.nationalId && !/^[A-Za-z0-9]{6,12}$/.test(d.nationalId)) out.push('Section 1: National ID / Passport number');
    if (!m.phone && d.phone.trim().length < 9) out.push('Section 1: primary phone number');
    if (!d.dateOfBirth) out.push('Section 1: date of birth'); else if (ageOn(d.dateOfBirth) < 18) out.push('Section 1: members must be 18 or older');
    if (d.residence.trim().length < 2) out.push('Section 1: physical residence / county / sub-county');
    f.beneficiaries.forEach((b: any, i: number) => { const bad = ['fullName', 'relationship', 'idNumber', 'phone'].some((k) => String(b[k]).trim().length < 2) || !b.dateOfBirth || !(Number(b.sharePct) > 0); if (bad) out.push(`Section 2: complete every detail for beneficiary ${i + 1}`); });
    if (total !== 100) out.push(`Section 2: shares must add up to 100% (now ${total}%)`);
    if (f.primaryAddress.trim().length < 2) out.push('Section 2: primary next of kin address / county');
    if (f.contingentName.trim().length < 2 || f.contingentPhone.trim().length < 9) out.push('Section 2: contingent (backup) next of kin name and phone');
    if (minor && (!f.guardian || Object.values(f.guardian).some((v) => String(v).trim().length < 2))) out.push('Section 3: complete every guardian detail');
    const w = f.witness; if ([w.fullName, w.idNumber, w.phone].some((v: string) => v.trim().length < 2)) out.push('Section 4: witness name, ID and phone');
    if (!w.isAdult) out.push('Section 4: confirm the witness is 18 or older');
    return out;
  }, [f, total, minor, m]);
  const payload = () => { const { confirmed, ...rest } = f; return { ...rest, confirmed: true, memberDetails: { ...f.memberDetails, nationalId: f.memberDetails.nationalId || undefined, phone: f.memberDetails.phone || undefined, email: f.memberDetails.email || undefined } }; };

  if (review) return (
    <div className="space-y-4">
      <Notice msg="Check every detail below. Once you submit, the form is locked: you will only be able to view it, and only the administrator can change it." />
      <ReadOnly n={{ member: { ...m, nationalId: m.nationalId ?? f.memberDetails.nationalId, phone: m.phone ?? f.memberDetails.phone }, form: { ...f, declarationDate: today() } }} />
      <div className="card space-y-3">
        <Field label={`Sign by typing your full name exactly as registered: ${m.fullName}`}><input className="input" value={f.signedName} onChange={(e) => set(['signedName'], e.target.value)} /></Field>
        {amend && <Field label="Reason for the change (kept in the history)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={f.confirmed} onChange={(e) => set(['confirmed'], e.target.checked)} />
          <span><b>I confirm that these details are correct.</b> I declare that the information is true and accurate. In accordance with the Kenya Data Protection Act (2019), I have informed my nominated Next of Kin / Guardian and consent to the Group collecting, storing and processing this personal data strictly for membership records and benefit administration. This nomination supersedes any previous Next of Kin form submitted by me.</span></label>
        <ErrorBox msg={err || act.error} />
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={() => { setReview(false); setErr(''); }}>Back to edit</button>
          <button className="btn-primary" disabled={act.busy || !f.confirmed || !f.signedName.trim()} onClick={async () => {
            setErr('');
            const ok = await act.run(() => onSave(amend ? { ...payload(), note } : payload()), '');
            if (ok === false) setErr('Not saved.');
          }}>{amend ? 'Save changes' : 'Confirm and submit'}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <Box title="Section 1: Member details">
        <div className="grid gap-3 sm:grid-cols-2">
          <Row label="Full legal name" value={m.fullName} /><Row label="Membership no." value={m.membershipNo} />
          {m.nationalId ? <Row label="National ID / Passport" value={m.nationalId} /> : inp(['memberDetails', 'nationalId'], 'National ID / Passport number')}
          <Field label="Date of birth"><DateInput value={f.memberDetails.dateOfBirth} max={today()} back={100} fwd={0} onChange={(e) => set(['memberDetails', 'dateOfBirth'], e.target.value)} /></Field>
          {m.phone ? <Row label="Primary phone" value={showPhone(m.phone)} /> : inp(['memberDetails', 'phone'], 'Primary phone number', { placeholder: '0712345678' })}
          {m.email ? <Row label="Email" value={m.email} /> : inp(['memberDetails', 'email'], 'Email address (optional)')}
          <div className="sm:col-span-2">{inp(['memberDetails', 'residence'], 'Physical residence / county / sub-county')}</div>
        </div>
      </Box>
      <Box title="Section 2: Nominated next of kin & benefit allocation">
        <p className="text-sm text-slate-600">I nominate the person(s) below to receive my accumulated savings, shares and welfare benefits in the event of my death or permanent incapacitation. The total allocation must equal 100%.</p>
        {f.beneficiaries.map((b: any, i: number) => (
          <div key={i} className="space-y-2 rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between"><b className="text-sm">Beneficiary {i + 1}</b>{f.beneficiaries.length > 1 && <button className="text-xs text-red-700 underline" onClick={() => set(['beneficiaries'], f.beneficiaries.filter((_: any, k: number) => k !== i))}>Remove</button>}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Full legal name"><input className="input" value={b.fullName} onChange={(e) => ben(i, 'fullName', e.target.value)} /></Field>
              <Field label="Relationship"><input className="input" value={b.relationship} onChange={(e) => ben(i, 'relationship', e.target.value)} placeholder="e.g. Spouse, Son" /></Field>
              <Field label="National ID / Birth certificate no."><input className="input" value={b.idNumber} onChange={(e) => ben(i, 'idNumber', e.target.value)} /></Field>
              <Field label="Date of birth"><DateInput value={b.dateOfBirth} max={today()} back={100} fwd={0} onChange={(e) => ben(i, 'dateOfBirth', e.target.value)} /></Field>
              <Field label="Phone number(s)"><input className="input" value={b.phone} onChange={(e) => ben(i, 'phone', e.target.value)} placeholder="0712345678, 0722333444" /></Field>
              <Field label="Share (%)"><input className="input" type="number" min={1} max={100} value={b.sharePct || ''} onChange={(e) => ben(i, 'sharePct', Math.round(Number(e.target.value)) || 0)} /></Field>
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between"><button className="btn-ghost" disabled={f.beneficiaries.length >= 5} onClick={() => set(['beneficiaries'], [...f.beneficiaries, blankBen()])}>Add another beneficiary</button>
          <div className={`text-sm font-bold ${total === 100 ? 'text-brand-700' : 'text-red-600'}`}>Total allocation: {total}%</div></div>
        <div className="grid gap-3 sm:grid-cols-2">{inp(['primaryAddress'], 'Primary next of kin physical address / county')}{inp(['contingentName'], 'Contingent (backup) next of kin name')}{inp(['contingentPhone'], 'Contingent next of kin phone', { placeholder: '0712345678' })}</div>
      </Box>
      <Box title="Section 3: Appointed guardian / trustee">
        {minor && f.guardian ? (<><p className="text-sm text-amber-800">A beneficiary is under 18, so please complete this section.</p>
          <div className="grid gap-3 sm:grid-cols-2">{inp(['guardian', 'fullName'], 'Guardian full legal name')}{inp(['guardian', 'idNumber'], 'National ID / Passport no.')}{inp(['guardian', 'relationship'], 'Relationship to minor')}{inp(['guardian', 'phone'], 'Guardian phone number(s)')}<div className="sm:col-span-2">{inp(['guardian', 'address'], 'Guardian physical address / county')}</div></div></>)
          : <p className="text-sm text-slate-500">Not needed. This section appears only if a beneficiary is under 18 years of age.</p>}
      </Box>
      <Box title="Section 4: Witness">
        <p className="text-sm text-slate-600">The witness must be 18 or older. The witness also signs the printed copy.</p>
        <div className="grid gap-3 sm:grid-cols-2">{inp(['witness', 'fullName'], 'Witness full name')}{inp(['witness', 'idNumber'], 'Witness National ID no.')}{inp(['witness', 'phone'], 'Witness phone number')}</div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.witness.isAdult} onChange={(e) => set(['witness', 'isAdult'], e.target.checked)} /> The witness is 18 years or older</label>
      </Box>
      {issues.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><b>Still needed before you can review:</b><ul className="mt-1 list-disc pl-5">{issues.map((i) => <li key={i}>{i}</li>)}</ul></div>}
      <div className="flex flex-wrap gap-2">{onCancel && <button className="btn-ghost" onClick={onCancel}>Cancel</button>}<button className="btn-primary" disabled={issues.length > 0} onClick={() => setReview(true)}>Review details</button></div>
    </div>
  );
}

/** Used by the member portal (mode "member") and by administrators inside a member's profile (mode "admin"). */
export function NextOfKinPanel({ mode, memberId }: { mode: 'member' | 'admin'; memberId?: string }) {
  const base = mode === 'member' ? '/me/next-of-kin' : `/members/${memberId}/next-of-kin`;
  const { data: n, loading, error, reload } = useApi<any>(base);
  const [amending, setAmending] = useState(false);
  const act = useAction();
  const { me } = useAuth();
  const isSuper = me?.role === 'super_admin';
  if (loading && !n) return <Loading />;
  if (!n) return <ErrorBox msg={error} />;
  const save = (via: 'new' | 'amend') => async (body: any) => {
    if (via === 'amend') await put(base, body); else await post(base, body);
    setAmending(false); await reload(); return true;
  };
  if (!n.submitted) return (
    <div className="space-y-3">
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><b>Next of Kin form not submitted.</b> {mode === 'member' ? 'Your profile shows as non-compliant until you fill in and submit this form.' : 'This member shows as non-compliant until the form is submitted. You can fill it in on their behalf.'}</div>
      {mode === 'member' || isSuper ? <Editor n={n} onSave={save('new')} /> : <p className="text-sm text-slate-500">Only the administrator can submit this form for a member.</p>}
    </div>
  );
  if (amending) return <Editor n={n} initial={n.form} amend onSave={save('amend')} onCancel={() => setAmending(false)} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
        <span><Badge value="submitted" /> <b>Submitted {dateTimeFmt(n.submittedAt)}</b>{n.revision > 1 ? ` · revision ${n.revision}` : ''}. {mode === 'member' ? 'This form is now read-only. Only the administrator can change it.' : 'Locked to the member. Only the administrator can amend it.'}</span>
        {mode === 'admin' && <span className="flex gap-2"><button className="btn-ghost" onClick={() => act.run(() => download(`/members/${memberId}/next-of-kin/pdf`, `next-of-kin-${n.member.membershipNo}.pdf`), '')}>Download PDF</button>
          <AdminOnly><button className="btn-ghost" onClick={() => setAmending(true)}>Amend form</button></AdminOnly></span>}
      </div>
      <ErrorBox msg={act.error} />
      <ReadOnly n={n} />
      {mode === 'admin' && n.history?.length > 0 && <div className="card text-sm"><h3 className="mb-1 font-semibold">History</h3>{n.history.map((h: any) => <div key={h.revision} className="border-t border-slate-100 py-1">Revision {h.revision} · {dateTimeFmt(h.changed_at)} · {h.changed_by ?? 'system'} · <span className="text-slate-600">{h.note}</span></div>)}</div>}
    </div>
  );
}

import { useAuth } from '../auth';
function AdminOnly({ children }: { children: React.ReactNode }) { const { me } = useAuth(); return me?.role === 'super_admin' ? <>{children}</> : null; }
