export type Role = 'super_admin' | 'chairperson' | 'treasurer' | 'secretary' | 'member';

export const PERMISSIONS = [
  // members
  'members.read', 'members.write', 'members.status',
  // savings & fines
  'savings.read_all', 'savings.adjust', 'obligations.generate',
  'fines.read_all', 'fines.create', 'fines.waive',
  // payments
  'payments.read_all', 'payments.verify', 'payments.reconcile',
  // meetings
  'meetings.manage', 'attendance.manage',
  // withdrawals
  'withdrawals.review', 'withdrawals.approve',
  // group finance
  'finance.read', 'finance.record', 'expenditure.approve', 'reports.read',
  // reconciliation
  'reconciliation.work', 'reconciliation.approve', 'reconciliation.reopen',
  // admin
  'settings.rules', 'users.manage', 'audit.read', 'mpesa.configure',
  'announcements.manage', 'documents.manage', 'documents.read', 'members.export',
  // spreadsheet-style ledger
  'ledger.read', 'ledger.edit',
  // administrator-only manual payment entry
  'payments.manual_entry', 'invoices.raise', 'records.correct',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

const chair: Permission[] = [
  'members.read', 'savings.read_all', 'fines.read_all', 'payments.read_all',
  'withdrawals.approve', 'withdrawals.review', 'fines.waive', 'finance.read', 'reports.read', 'expenditure.approve',
  'reconciliation.approve', 'reconciliation.reopen', 'audit.read', 'savings.adjust', 'documents.read', 'members.export', 'ledger.read', 'ledger.edit',
];

const treasurer: Permission[] = [
  'members.read', 'savings.read_all', 'fines.read_all', 'payments.read_all', 'payments.verify',
  'payments.reconcile', 'withdrawals.review', 'finance.read', 'finance.record', 'reports.read',
  'reconciliation.work', 'obligations.generate', 'fines.create', 'documents.read', 'members.export', 'ledger.read', 'ledger.edit',
];

const secretary: Permission[] = [
  'members.read', 'members.write', 'members.status', 'meetings.manage', 'attendance.manage',
  'announcements.manage', 'documents.manage', 'documents.read', 'members.export', 'fines.create', 'ledger.read',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  super_admin: ALL,
  chairperson: new Set(chair),
  treasurer: new Set(treasurer),
  secretary: new Set(secretary),
  member: new Set<Permission>(),
};

export function can(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(perm);
}
