import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth, isOfficial } from './auth';
import { Loading } from './ui';
import Home from './pages/Home';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import { MemberLayout, AdminLayout } from './layouts';
import MemberDashboard from './pages/member/Dashboard';
import { NextOfKinPage } from './pages/member/Others';
import { Statements, MemberMeetings, MemberWithdrawals, MemberInbox } from './pages/member/Others';
import AdminDashboard from './pages/admin/Dashboard';
import Members from './pages/admin/Members';
import Payments from './pages/admin/Payments';
import { Fines, Meetings, Withdrawals } from './pages/admin/Governance';
import Money from './pages/admin/Money';
import Reconciliation from './pages/admin/Reconciliation';
import { Reports, Imports } from './pages/admin/ReportsImports';
import GroupSheet from './pages/admin/GroupSheet';
import MemberPayments from './pages/admin/MemberPayments';
import Ledger from './pages/admin/Ledger';
import Records from './pages/admin/Records';
import { Settings, Audit } from './pages/admin/Settings';

function Guard({ kind, children }: { kind: 'member' | 'admin'; children: JSX.Element }) {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.must_change_password) return <Navigate to="/change-password" replace />;
  if (kind === 'member' && isOfficial(me.role)) return <Navigate to="/admin" replace />;
  if (kind === 'admin' && !isOfficial(me.role)) return <Navigate to="/portal" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<ChangePassword />} />
      <Route path="/portal" element={<Guard kind="member"><MemberLayout /></Guard>}>
        <Route index element={<MemberDashboard />} />
        <Route path="profile" element={<NextOfKinPage />} />
        <Route path="statements" element={<Statements />} />
        <Route path="meetings" element={<MemberMeetings />} />
        <Route path="withdrawals" element={<MemberWithdrawals />} />
        <Route path="inbox" element={<MemberInbox />} />
      </Route>
      <Route path="/admin" element={<Guard kind="admin"><AdminLayout /></Guard>}>
        <Route index element={<AdminDashboard />} />
        <Route path="members" element={<Members />} />
        <Route path="payments" element={<Payments />} />
        <Route path="fines" element={<Fines />} />
        <Route path="meetings" element={<Meetings />} />
        <Route path="withdrawals" element={<Withdrawals />} />
        <Route path="money" element={<Money />} />
        <Route path="reconciliation" element={<Reconciliation />} />
        <Route path="records" element={<Records />} />
        <Route path="ledger" element={<Ledger />} />
        <Route path="member-payments" element={<MemberPayments />} />
        <Route path="group-sheet" element={<GroupSheet />} />
        <Route path="reports" element={<Reports />} />
        <Route path="imports" element={<Imports />} />
        <Route path="settings" element={<Settings />} />
        <Route path="audit" element={<Audit />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
