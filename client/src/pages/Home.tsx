import { Link } from 'react-router-dom';
import { Brand } from '../ui';

const features = [
  ['Two clear ledgers', 'Your savings and your fines are tracked separately. A fine never touches your savings, and a contribution never pays a fine by accident.'],
  ['Pay with M-Pesa', 'Get an M-Pesa prompt on your phone, enter your PIN, and your payment is recorded automatically with a receipt.'],
  ['Fair, automatic rules', 'KSh 1,500 each month, due by the 10th. Oldest months are cleared first, and every late fine is applied once, never twice.'],
  ['Full transparency', 'Every payment, fine, approval and correction is written to a permanent audit trail that cannot be edited or deleted.'],
  ['Official records, kept safe', 'Our certificate of registration, constitution, minutes and resolutions are stored in one place, versioned and never deleted.'],
  ['Monthly reconciliation', 'Treasurers match M-Pesa records to the books every month, and the chairperson signs off before the month is locked.'],
  ['Withdrawals with approval', 'Requests are reviewed and approved by officials before any money moves, and you can follow progress at every step.'],
];
const steps = [['Register', 'The secretary registers you and gives you a temporary password.'], ['Contribute', 'Pay KSh 1,500 monthly by the 10th through M-Pesa.'], ['Track', 'See balances, fines, meetings and receipts any time on your phone.']];

export default function Home() {
  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Brand size={52} />
        <Link to="/login" className="btn-primary">Member login</Link>
      </header>
      <section className="bg-gradient-to-b from-brand-50 to-white">
        <div className="mx-auto max-w-4xl px-4 py-14 text-center sm:py-24">
          <img src="/logo.png" alt="Friends Self Help Group, Embu, Kenya. For us and the society." className="mx-auto mb-6 h-40 w-40 sm:h-52 sm:w-52" />
          <h1 className="text-3xl font-extrabold leading-tight text-brand-900 sm:text-5xl">Save together. Know exactly where every shilling is.</h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-slate-600 sm:text-lg">Friends Self Help Group, Embu: for us and the society. A simple, secure home for our group's monthly savings, fines, meetings and withdrawals, with M-Pesa payments and a complete record anyone can trust.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/login" className="btn-primary px-6 py-3 text-base">Sign in to your account</Link>
            <a href="#how" className="btn-ghost px-6 py-3 text-base">How it works</a>
          </div>
          <dl className="mx-auto mt-12 grid max-w-2xl grid-cols-3 gap-4 text-center">
            {[['KSh 1,500', 'monthly contribution'], ['10th', 'payment deadline'], ['3', 'meetings a year']].map(([v, l]) => (
              <div key={l} className="rounded-xl border border-brand-100 bg-white p-3 shadow-sm"><dt className="text-xl font-bold text-brand-700 sm:text-2xl">{v}</dt><dd className="text-xs text-slate-500 sm:text-sm">{l}</dd></div>
            ))}
          </dl>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-center text-2xl font-bold">Built for trust</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(([t, d]) => <div key={t} className="card"><h3 className="font-bold text-brand-700">{t}</h3><p className="mt-2 text-sm text-slate-600">{d}</p></div>)}
        </div>
      </section>
      <section id="how" className="bg-slate-50 py-14">
        <div className="mx-auto max-w-4xl px-4">
          <h2 className="text-center text-2xl font-bold">How it works</h2>
          <ol className="mt-8 grid gap-4 sm:grid-cols-3">
            {steps.map(([t, d], i) => (
              <li key={t} className="card text-center"><div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 font-bold text-white">{i + 1}</div><h3 className="font-bold">{t}</h3><p className="mt-1 text-sm text-slate-600">{d}</p></li>
            ))}
          </ol>
        </div>
      </section>
      <section className="mx-auto max-w-4xl px-4 py-14">
        <h2 className="text-center text-2xl font-bold">Common questions</h2>
        <div className="mt-6 space-y-3">
          {[['When is the late fine charged?', 'If a month is not paid by the 10th, one KSh 200 fine is applied for that month. It is never repeated for the same month.'],
            ['Can I pay part of a month?', 'No. Contributions are KSh 1,500 per month, paid in full months. Pay several months at once if you like; the oldest is cleared first.'],
            ['What if I miss a meeting?', 'Send your apology before the meeting. Excused absences carry no fine; unexcused absences carry a KSh 5,000 fine.'],
            ['I paid but do not see it yet.', 'M-Pesa payments normally appear within a minute. If you paid by another route, submit the M-Pesa message in your portal and the treasurer will verify it.']].map(([q, a]) => (
            <details key={q} className="card"><summary className="cursor-pointer font-semibold">{q}</summary><p className="mt-2 text-sm text-slate-600">{a}</p></details>
          ))}
        </div>
      </section>
      <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-500">Friends Self Help Group, Embu, Kenya · Est. 2024 · Your personal data is handled in line with the Kenya Data Protection Act.</footer>
    </div>
  );
}
