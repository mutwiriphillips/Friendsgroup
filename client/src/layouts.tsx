import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { NAV_ACCESS, useAuth } from './auth';
import { human } from './format';
import { Brand } from './ui';
import { MemberHeaderIdentity } from './pages/MemberDocuments';

function Shell({ links, title }: { links: [string, string][]; title: string }) {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = (
    <nav className="flex flex-col gap-1 p-3">
      {links.map(([to, label]) => (
        <NavLink key={to} to={to} end={to === '/admin' || to === '/portal'} onClick={() => setOpen(false)}
          className={({ isActive }) => `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}>{label}</NavLink>
      ))}
    </nav>
  );
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white lg:block">
        <div className="border-b border-slate-200 p-3"><Brand size={44} to={title === 'Group Admin' ? '/admin' : '/portal'} /><div className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div></div>{nav}
      </aside>
      <div className="flex-1">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center gap-3 lg:hidden"><Brand size={34} text={false} to="/" /><button className="rounded-lg border border-slate-300 px-3 py-1 text-sm" onClick={() => setOpen(!open)} aria-label="Menu">☰ Menu</button></div>
          {me?.member_id
            ? <MemberHeaderIdentity name={me.full_name ?? ''} extra={` · ${human(me.role)}${me.membership_no ? ` · ${me.membership_no}` : ''}`} />
            : <span className="hidden text-sm text-slate-500 lg:block">{me?.full_name ?? me?.email} · {human(me?.role ?? '')}{me?.membership_no ? ` · ${me.membership_no}` : ''}</span>}
          <button className="btn-ghost" onClick={logout}>Sign out</button>
        </header>
        {open && <div className="border-b border-slate-200 bg-white lg:hidden">{nav}</div>}
        <main className="mx-auto max-w-6xl p-4 sm:p-6"><Outlet /></main>
      </div>
    </div>
  );
}

export const MemberLayout = () => (
  <Shell title="My Savings" links={[['/portal', 'Overview'], ['/portal/profile', 'My profile & next of kin'], ['/portal/statements', 'Statements'], ['/portal/meetings', 'Meetings'], ['/portal/withdrawals', 'Withdrawals'], ['/portal/inbox', 'Inbox & documents']]} />
);

export function AdminLayout() {
  const { me } = useAuth();
  const all: [string, string, string | null][] = [
    ['/admin', 'Dashboard', null], ['/admin/members', 'Members', 'members'], ['/admin/member-payments', 'Member payments', 'ledger'], ['/admin/fines', 'Fines', 'fines'],
    ['/admin/meetings', 'Meetings', 'meetings'], ['/admin/withdrawals', 'Withdrawals', 'withdrawals'], ['/admin/money', 'Income & expenses', 'money'],
    ['/admin/reconciliation', 'Reconciliation', 'reconciliation'], ['/admin/records', 'Records & documents', 'records'], ['/admin/reports', 'Reports', 'reports'], ['/admin/imports', 'Data import', 'imports'],
    ['/admin/settings', 'Settings', 'settings'], ['/admin/audit', 'Audit trail', 'audit'],
  ];
  const links = all.filter(([, , k]) => !k || NAV_ACCESS[k]?.includes(me!.role)).map(([to, l]) => [to, l] as [string, string]);
  return <Shell title="Group Admin" links={links} />;
}
