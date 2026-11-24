export type AppTab = 'scanner' | 'schedule' | 'activity' | 'access' | 'account';

export type UserRole = 'store_manager' | 'supervisor' | 'shift_lead' | 'staff';

export type ShiftType = 'morning' | 'afternoon' | 'evening' | 'full_day' | 'custom';

export type ScheduleStatus = 'registered' | 'confirmed' | 'completed' | 'cancelled';

export type SyncState =
  | 'connecting'
  | 'connected'
  | 'syncing'
  | 'synced'
  | 'disconnected'
  | 'error';

export type DataBackendMode = 'supabase' | 'firebase';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export interface ModulePermissions {
  scopeAll: boolean;
  barcodeView: boolean;
  barcodeCreate: boolean;
  barcodeEdit: boolean;
  barcodeDelete: boolean;
  scheduleView: boolean;
  scheduleCreate: boolean;
  scheduleEdit: boolean;
  scheduleDelete: boolean;
  scheduleApprove: boolean;
  allowExport: boolean;
  activityView: boolean;
  allowSupabase: boolean;
}

export interface AuthorizedEmail extends ModulePermissions {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  note: string;
  grantedBy: string;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface EffectivePermissions extends ModulePermissions {
  authorized: boolean;
  isSuperAdmin: boolean;
  role: UserRole;
}

export interface AuthenticatedUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  provider: 'supabase' | 'firebase';
}

export interface BarcodeScan {
  id: string;
  ownerId: string;
  ownerEmail: string;
  code: string;
  format: string;
  sessionName: string;
  quantity: number;
  note: string;
  version: number;
  updatedBy: string;
  syncedToSupabase: boolean;
  scannedAt: string | null;
  updatedAt: string | null;
}

export interface WorkSchedule {
  id: string;
  ownerId: string;
  ownerEmail: string;
  employeeName: string;
  title: string;
  workDate: string; // YYYY-MM-DD
  shiftType: ShiftType;
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  location: string;
  status: ScheduleStatus;
  note: string;
  approvedBy: string;
  approvedAt: string | null;
  version: number;
  updatedBy: string;
  syncedToSupabase: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export type ActivityModule = 'barcode' | 'schedule' | 'access' | 'system' | 'export';

export type ActivityAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'approve'
  | 'cancel'
  | 'export'
  | 'sync'
  | 'migrate';

export interface ActivityLog {
  id: string;
  actorId: string;
  actorEmail: string;
  actorName: string;
  actorRole: UserRole;
  module: ActivityModule;
  action: ActivityAction;
  targetId: string;
  summary: string;
  changes: Record<string, unknown>;
  createdAt: string;
}

export interface EditConflict {
  entity: 'barcode_scans' | 'work_schedules' | 'user_access';
  recordId: string;
  title: string;
  expectedVersion: number;
  serverVersion: number;
  serverUpdatedBy: string;
  serverUpdatedAt: string | null;
  localSummary: string;
  serverSummary: string;
  onReloadLatest: () => void;
  onForceOverwrite: () => Promise<void>;
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}
