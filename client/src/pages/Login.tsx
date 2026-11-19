import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth, isOfficial } from '../auth';
import { ErrorBox } from '../ui';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const me = await login(id, pw);
      nav(me.must_change_password ? '/change-password' : isOfficial(me.role) ? '/admin' : '/portal', { replace: true });
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-50 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <div className="text-center"><div className="flex justify-center"><Link to="/"><img src="/logo.png" alt="Friends Self Help Group" className="mx-auto h-28 w-28" /></Link></div><h1 className="mt-1 text-lg font-bold text-brand-900">Friends Self Help Group</h1><p className="text-sm text-slate-500">Sign in with your phone number (members) or email (officials)</p></div>
        <ErrorBox msg={err} />
        <label className="block"><span className="label">Phone or email</span><input className="input" value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" required /></label>
        <label className="block"><span className="label">Password</span><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required /></label>
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-center text-xs text-slate-500">Forgot your password? Ask the secretary to reset it.</p>
      </form>
    </div>
  );
}
