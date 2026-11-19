import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { get } from './api';
import { human, MONTHS } from './format';

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(path));
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try { setData(await get<T>(path)); setError(''); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [path]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load, ...deps]);
  return { data, error, loading, reload: load };
}

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-xl font-bold sm:text-2xl">{title}</h1>{subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}</div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
      {children}
    </div>
  );
}

export const Loading = () => <p className="py-8 text-center text-sm text-slate-500">Loading…</p>;
export const ErrorBox = ({ msg }: { msg: string }) => (msg ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{msg}</div> : null);
export const Notice = ({ msg }: { msg: string }) => (msg ? <div role="status" className="rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-900">{msg}</div> : null);

const TONES: Record<string, string> = {
  confirmed: 'green', paid: 'green', active: 'green', approved: 'green', present: 'green', closed: 'green', resolved: 'green', settled: 'green', matched: 'green', register_confirmed: 'green', completed: 'green',
  held: 'amber', pending: 'amber', overdue: 'red', unpaid: 'amber', unresolved: 'red', clarification: 'amber', submitted: 'amber', in_review: 'amber', outstanding: 'amber', investigating: 'amber', unmatched: 'amber', awaiting_approval: 'amber', discrepancies_found: 'red', in_progress: 'blue',
  failed: 'red', rejected: 'red', absent: 'red', suspended: 'red', reversed: 'slate', waived: 'slate', cancelled: 'slate', excused: 'blue', initiated: 'blue', scheduled: 'blue', material: 'red', minor: 'amber',
};
const TONE_CLASS: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-800', amber: 'bg-amber-100 text-amber-800', red: 'bg-red-100 text-red-800', blue: 'bg-sky-100 text-sky-800', slate: 'bg-slate-100 text-slate-600',
};
export const Badge = ({ value }: { value: string | null | undefined }) => (
  <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[TONES[value ?? ''] ?? 'slate']}`}>{human(value ?? '—')}</span>
);

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warn' | 'good' }) {
  return (
    <div className="card">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone === 'warn' ? 'text-red-600' : tone === 'good' ? 'text-brand-700' : ''}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export interface Column<T> { key: string; label: string; render?: (row: T) => ReactNode; align?: 'right' }
export function Table<T extends Record<string, any>>({ rows, columns, empty = 'Nothing to show.' }: { rows: T[]; columns: Column<T>[]; empty?: string }) {
  if (!rows.length) return <div className="card text-center text-sm text-slate-500">{empty}</div>;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>{columns.map((c) => <th key={c.key} className={`px-3 py-2 font-semibold ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <tr key={r.id ?? i} className="hover:bg-slate-50">
              {columns.map((c) => <td key={c.key} className={`px-3 py-2 align-top ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>{c.render ? c.render(r) : String(r[c.key] ?? '—')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`max-h-[92vh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl`}>
        <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-bold">{title}</h2><button onClick={onClose} className="text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">×</button></div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="label">{label}</span>{children}</label>;
}

/** Runs an async action with busy/error/success state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const run = async <T,>(fn: () => Promise<T>, success = 'Done.'): Promise<T | undefined> => {
    setBusy(true); setError(''); setOk('');
    try { const r = await fn(); setOk(success); return r; } catch (e) { setError((e as Error).message); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, ok, run, setError, setOk };
}

export function Tabs({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)} className={`whitespace-nowrap px-3 py-2 text-sm font-semibold ${value === k ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-500 hover:text-slate-800'}`}>{l}</button>
      ))}
    </div>
  );
}

export const GROUP_NAME = 'Friends Self Help Group';
export function Brand({ size = 40, to = '/', text = true, light = false }: { size?: number; to?: string; text?: boolean; light?: boolean }) {
  return (
    <a href={to} className="flex items-center gap-2" aria-label={GROUP_NAME}>
      <img src="/logo.png" alt="Friends Self Help Group logo" width={size} height={size} style={{ width: size, height: size }} />
      {text && <span className={`font-bold leading-tight ${light ? 'text-white' : 'text-brand-900'}`}>Friends Self Help Group<span className="block text-[11px] font-medium text-slate-500">Embu, Kenya</span></span>}
    </a>
  );
}

// ---- date entry: the month is chosen by name (16/October/2026), so day and month can never be mixed up.
const pad2 = (n: number | string) => String(n).padStart(2, '0');
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PickEvent = any;
const YEARS_BACK = 6; const YEARS_FWD = 6;

function Parts({ day, month, year, onPart, showDay, max, min, back = YEARS_BACK, fwd = YEARS_FWD }: { day: string; month: string; year: string; onPart: (d: string, m: string, y: string) => void; showDay: boolean; max?: string; min?: string; back?: number; fwd?: number }) {
  const thisYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = thisYear + fwd; y >= thisYear - back; y--) years.push(y);
  const y = Number(year) || 0; const m = Number(month) || 0;
  const maxDay = y && m ? daysIn(y, m) : 31;
  const iso = day && month && year ? `${year}-${pad2(month)}-${pad2(day)}` : '';
  const bad = showDay && iso !== '' && ((max !== undefined && iso > max) || (min !== undefined && iso < min));
  const cls = `input ${bad ? '!border-red-400' : ''}`;
  return (
    <div className="flex gap-1.5">
      {showDay && <select className={`${cls} !w-[4.5rem] shrink-0`} aria-label="Day" value={day} onChange={(e) => onPart(e.target.value, month, year)}>
        <option value="">Day</option>{Array.from({ length: maxDay }, (_, i) => <option key={i + 1} value={pad2(i + 1)}>{i + 1}</option>)}
      </select>}
      <select className={`${cls} min-w-0 flex-1`} aria-label="Month" value={month} onChange={(e) => onPart(day, e.target.value, year)}>
        <option value="">Month</option>{MONTHS.map((n, i) => <option key={n} value={pad2(i + 1)}>{n}</option>)}
      </select>
      <select className={`${cls} !w-[5.5rem] shrink-0`} aria-label="Year" value={year} onChange={(e) => onPart(day, month, e.target.value)}>
        <option value="">Year</option>{years.map((yy) => <option key={yy} value={String(yy)}>{yy}</option>)}
      </select>
    </div>
  );
}

/** A date shown and chosen as day / month name / year, e.g. 16/October/2026. The value passed in and out is yyyy-mm-dd. */
/** `back` / `fwd` widen the years offered, e.g. back={100} fwd={0} for dates of birth. */
export function DateInput({ value, onChange, max, min, back, fwd }: { value: string; onChange: (e: PickEvent) => void; max?: string; min?: string; back?: number; fwd?: number }) {
  const [p, setP] = useState({ d: value.slice(8, 10), m: value.slice(5, 7), y: value.slice(0, 4) });
  useEffect(() => { if (value) setP({ d: value.slice(8, 10), m: value.slice(5, 7), y: value.slice(0, 4) }); else if (p.d && p.m && p.y) setP({ d: '', m: '', y: '' }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [value]);
  return <Parts day={p.d} month={p.m} year={p.y} showDay max={max} min={min} back={back} fwd={fwd} onPart={(d, m, y) => {
    const dd = d && m && y && Number(d) > daysIn(Number(y), Number(m)) ? pad2(daysIn(Number(y), Number(m))) : d;
    setP({ d: dd, m, y });
    const iso = dd && m && y ? `${y}-${pad2(m)}-${pad2(dd)}` : '';
    if (iso === '') { if (!d && !m && !y) onChange({ target: { value: '' } }); return; }
    if ((max !== undefined && iso > max) || (min !== undefined && iso < min)) return;
    onChange({ target: { value: iso } });
  }} />;
}

/** A month chosen by name, e.g. October 2026. The value passed in and out is yyyy-mm. */
export function MonthInput({ value, onChange }: { value: string; onChange: (e: PickEvent) => void }) {
  const [p, setP] = useState({ m: value.slice(5, 7), y: value.slice(0, 4) });
  useEffect(() => { if (value) setP({ m: value.slice(5, 7), y: value.slice(0, 4) }); }, [value]);
  return <Parts day="" month={p.m} year={p.y} showDay={false} onPart={(_d, m, y) => { setP({ m, y }); onChange({ target: { value: m && y ? `${y}-${pad2(m)}` : '' } }); }} />;
}

/** Date and time: day / month name / year and 24-hour hh:mm. The value passed in and out is yyyy-mm-ddThh:mm. */
export function DateTimeInput({ value, onChange }: { value: string; onChange: (e: PickEvent) => void }) {
  const d = value.slice(0, 10);
  const [time, setTime] = useState(value.slice(11, 16));
  useEffect(() => { setTime(value.slice(11, 16)); }, [value]);
  const push = (nd: string, nt: string) => onChange({ target: { value: nd && /^\d{2}:\d{2}$/.test(nt) ? `${nd}T${nt}` : '' } });
  return (
    <div className="space-y-1.5">
      <DateInput value={d} onChange={(e) => push(e.target.value, time)} />
      <input className="input w-28" inputMode="numeric" placeholder="hh:mm" maxLength={5} value={time}
        onChange={(e) => { const dg = e.target.value.replace(/[^\d]/g, '').slice(0, 4); const v = dg.length > 2 ? `${dg.slice(0, 2)}:${dg.slice(2)}` : dg; setTime(v); push(d, v); }} />
    </div>
  );
}
