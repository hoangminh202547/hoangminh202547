export type AppTab =
  | 'overview'
  | 'schedule'
  | 'attendance'
  | 'staff'
  | 'feedback'
  | 'warehouse'
  | 'scanner'
  | 'expiry'
  | 'returns'
  | 'promotions'
  | 'supabase'
  | 'monitoring'
  | 'storage'
  | 'settings'
  | 'access'
  | 'activity';

export type NavGroupId = 'ops' | 'goods' | 'system';

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

export interface ModuleAccessFlags {
  overview: boolean;
  schedule: boolean;
  attendance: boolean;
  staff: boolean;
  feedback: boolean;
  warehouse: boolean;
  scanner: boolean;
  expiry: boolean;
  returns: boolean;
  promotions: boolean;
  supabase: boolean;
  monitoring: boolean;
  storage: boolean;
  settings: boolean;
  access: boolean;
  activity: boolean;
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
  modulePerms?: Partial<ModuleAccessFlags>;
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
  modules: ModuleAccessFlags;
}

export interface AuthenticatedUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  provider: 'supabase' | 'firebase';
}

export interface UserProfileRecord {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  avatarPath: string;
  birthDate: string;
  gender: string;
  phone: string;
  updatedAt: string | null;
}

export interface LeaveRulesConfig {
  maxDoPerWeek: number;
  weekdayMaxDo: number;
  weekendMaxDo: number;
  requireAdminOverride: boolean;
}

export interface ShiftDefinition {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  isDayOff: boolean;
  sortOrder: number;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
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
  shiftId?: string | null;
  isDayOff?: boolean;
  overrideApproved?: boolean;
  overrideReason?: string;
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

export interface AttendanceNoteEntry {
  id: string;
  type: 'overtime' | 'early_leave' | 'incident' | 'note';
  content: string;
  createdAt: string;
  createdBy: string;
}

export interface AttendanceRecord {
  id: string;
  scheduleId: string | null;
  ownerId: string;
  ownerEmail: string;
  employeeName: string;
  shiftName: string;
  workDate: string;
  checkInAt: string;
  checkOutAt: string | null;
  isUnscheduled: boolean;
  status: 'checked_in' | 'checked_out' | 'early_leave' | 'overtime';
  notesHistory: AttendanceNoteEntry[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CustomerFeedback {
  id: string;
  ownerId: string;
  ownerEmail: string;
  employeeName: string;
  feedbackDate: string;
  category: 'product' | 'service';
  productName: string;
  content: string;
  imagePath: string;
  imageThumbPath: string;
  createdAt: string;
}

export interface ProductCatalogItem {
  id: string;
  productCode: string;
  barcode: string;
  name: string;
  unit: string;
  price: number;
  supplierName: string;
  updatedBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SupplierPolicyItem {
  id: string;
  category: string;
  supplierName: string;
  supplierSystemName: string;
  productName: string;
  returnPolicy: string;
  warnMonthsBefore: number;
  updatedBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ExpiryTrackingItem {
  id: string;
  productCode: string;
  barcode: string;
  productName: string;
  unit: string;
  supplierSystemName: string;
  returnPolicy: string;
  warnMonthsBefore: number;
  mfgDate: string;
  expDate: string;
  ptCode: string;
  note: string;
  updatedBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReturnRecordItem {
  id: string;
  ptCode: string;
  supplierSystemName: string;
  productSummary: string;
  returnMethod: string;
  progress: 'processing' | 'completed';
  reportedDate: string;
  completedDate: string;
  lastUpdateNote: string;
  updatedBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PromotionItem {
  id: string;
  productCode: string;
  barcode: string;
  productName: string;
  hasBBadge: boolean;
  unit: string;
  expDate: string;
  quantity: number;
  discountRate: number;
  regularPrice: number;
  promoPrice: number;
  ptCode: string;
  status: 'active' | 'scheduled' | 'ended';
  updatedBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface StorageFileEntry {
  id: string;
  bucket: string;
  name: string;
  path: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string | null;
  updatedAt: string | null;
  ownerFolder: string;
  category: 'image' | 'pdf' | 'excel' | 'other';
}

export type ActivityModule =
  | 'barcode'
  | 'schedule'
  | 'attendance'
  | 'staff'
  | 'feedback'
  | 'warehouse'
  | 'expiry'
  | 'returns'
  | 'promotions'
  | 'storage'
  | 'access'
  | 'system'
  | 'export';

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

export interface UiPreferences {
  defaultPageSize: 20 | 50 | 100;
  compactSidebar: boolean;
  autoResetPromoIdle: boolean;
}
