import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, getToken, post, setToken } from './api';

export type Role = 'super_admin' | 'chairperson' | 'treasurer' | 'secretary' | 'member';
export interface Me { id: string; email: string | null; role: Role; member_id: string | null; must_change_password: boolean; full_name: string | null; membership_no: string | null; admin_managed?: boolean }
interface Ctx { me: Me | null; loading: boolean; login: (id: string, pw: string) => Promise<Me>; logout: () => void; refresh: () => Promise<void> }
const C = createContext<Ctx>(null as never);
export const useAuth = () => useContext(C);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const refresh = useCallback(async () => {
    if (!getToken()) { setMe(null); setLoading(false); return; }
    try { setMe(await get<Me>('/auth/me')); } catch { setToken(null); setMe(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const login = async (identifier: string, password: string) => {
    const r = await post<{ token: string }>('/auth/login', { identifier, password });
    setToken(r.token);
    const m = await get<Me>('/auth/me');
    setMe(m);
    return m;
  };
  const logout = () => { setToken(null); setMe(null); window.location.href = '/'; };
  return <C.Provider value={{ me, loading, login, logout, refresh }}>{children}</C.Provider>;
}

export const isOfficial = (r?: Role) => !!r && r !== 'member';
/** Mirrors the server's role map for showing/hiding nav only. The backend is the real gate. */
export const NAV_ACCESS: Record<string, Role[]> = {
  members: ['super_admin', 'chairperson', 'treasurer', 'secretary'],
  payments: ['super_admin', 'treasurer', 'chairperson'],
  fines: ['super_admin', 'chairperson', 'treasurer', 'secretary'],
  meetings: ['super_admin', 'chairperson', 'secretary'],
  withdrawals: ['super_admin', 'chairperson', 'treasurer', 'secretary'],
  money: ['super_admin', 'chairperson', 'treasurer'],
  reconciliation: ['super_admin', 'chairperson', 'treasurer'],
  ledger: ['super_admin', 'chairperson', 'treasurer', 'secretary'],
  records: ['super_admin', 'chairperson', 'treasurer', 'secretary'],
  reports: ['super_admin', 'chairperson', 'treasurer', 'secretary'],
  imports: ['super_admin', 'treasurer', 'secretary'],
  settings: ['super_admin', 'chairperson'],
  audit: ['super_admin', 'chairperson'],
};
