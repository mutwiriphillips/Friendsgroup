import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { post } from '../api';
import { isOfficial, useAuth } from '../auth';
import { ErrorBox } from '../ui';

export default function ChangePassword() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      await post('/auth/change-password', { currentPassword: cur, newPassword: next });
      await post('/auth/consent', { version: '2026-01' });
      await refresh(); nav(isOfficial(me?.role) ? '/admin' : '/portal', { replace: true });
    } catch (e2) { setErr((e2 as Error).message); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-50 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <h1 className="text-lg font-bold">Set a new password</h1>
        <ErrorBox msg={err} />
        <label className="block"><span className="label">Current (temporary) password</span><input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
        <label className="block"><span className="label">New password (min 10 characters)</span><input className="input" type="password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required /></label>
        <p className="text-xs text-slate-500">By continuing you agree that the group may process your personal data to manage savings and meetings, as required by the Kenya Data Protection Act.</p>
        <button className="btn-primary w-full">Save and continue</button>
      </form>
    </div>
  );
}
