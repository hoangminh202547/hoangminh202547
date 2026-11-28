import type {
  AppTab,
  ModuleAccessFlags,
  ModulePermissions,
  NavGroupId,
  UserRole,
} from '../types';

export const SUPER_ADMIN_EMAIL = 'hoangminh202547@gmail.com';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailToKey(email: string): string {
  return normalizeEmail(email)
    .replace(/@/g, '_at_')
    .replace(/\./g, '_dot_')
    .replace(/[^a-z0-9_-]/g, '_');
}

export function normalizeRole(rawRole: unknown): UserRole {
  const val = String(rawRole || '').trim().toLowerCase();
  if (val === 'store_manager' || val === 'admin') return 'store_manager';
  if (val === 'supervisor' || val === 'manager') return 'supervisor';
  if (val === 'shift_lead') return 'shift_lead';
  return 'staff';
}

export const ROLE_LABELS: Record<UserRole, string> = {
  store_manager: 'Quản trị / Quản lý',
  supervisor: 'Giám sát',
  shift_lead: 'Trưởng ca',
  staff: 'Nhân viên',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  store_manager:
    'Toàn quyền quản trị hệ thống, cấu hình ca/ngày nghỉ DO, phân quyền, giám sát tài nguyên, quản lý Storage và dữ liệu toàn cửa hàng.',
  supervisor:
    'Xem & quản lý toàn bộ vận hành, hàng hóa, kiểm soát HSD, đổi trả, khuyến mãi, duyệt lịch làm và dọn tệp.',
  shift_lead:
    'Quản lý ca trực, duyệt chấm công/lịch làm, cập nhật hàng hóa, hạn sử dụng, đổi trả và khuyến mãi.',
  staff:
    'Xem tổng quan, đăng ký lịch làm, chấm công, cập nhật hồ sơ cá nhân, gửi ý kiến khách hàng, quét mã vạch và báo cáo HSD/đổi trả.',
};

export const FULL_MODULE_FLAGS: ModuleAccessFlags = {
  overview: true,
  schedule: true,
  attendance: true,
  staff: true,
  feedback: true,
  warehouse: true,
  scanner: true,
  expiry: true,
  returns: true,
  promotions: true,
  supabase: true,
  monitoring: true,
  storage: true,
  settings: true,
  access: true,
  activity: true,
};

export const ROLE_DEFAULT_MODULES: Record<UserRole, ModuleAccessFlags> = {
  store_manager: { ...FULL_MODULE_FLAGS },
  supervisor: {
    overview: true,
    schedule: true,
    attendance: true,
    staff: true,
    feedback: true,
    warehouse: true,
    scanner: true,
    expiry: true,
    returns: true,
    promotions: true,
    supabase: true,
    monitoring: true,
    storage: true,
    settings: false,
    access: false,
    activity: true,
  },
  shift_lead: {
    overview: true,
    schedule: true,
    attendance: true,
    staff: true,
    feedback: true,
    warehouse: true,
    scanner: true,
    expiry: true,
    returns: true,
    promotions: true,
    supabase: false,
    monitoring: false,
    storage: false,
    settings: false,
    access: false,
    activity: true,
  },
  staff: {
    overview: true,
    schedule: true,
    attendance: true,
    staff: true,
    feedback: true,
    warehouse: false,
    scanner: true,
    expiry: true,
    returns: true,
    promotions: true,
    supabase: false,
    monitoring: false,
    storage: false,
    settings: false,
    access: false,
    activity: false,
  },
};

export const ROLE_DEFAULT_PERMS: Record<UserRole, ModulePermissions> = {
  store_manager: {
    scopeAll: true,
    barcodeView: true,
    barcodeCreate: true,
    barcodeEdit: true,
    barcodeDelete: true,
    scheduleView: true,
    scheduleCreate: true,
    scheduleEdit: true,
    scheduleDelete: true,
    scheduleApprove: true,
    scheduleLevel: 'admin',
    allowExport: true,
    activityView: true,
    allowSupabase: true,
    modulePerms: { ...ROLE_DEFAULT_MODULES.store_manager },
  },
  supervisor: {
    scopeAll: true,
    barcodeView: true,
    barcodeCreate: true,
    barcodeEdit: true,
    barcodeDelete: true,
    scheduleView: true,
    scheduleCreate: true,
    scheduleEdit: true,
    scheduleDelete: true,
    scheduleApprove: true,
    scheduleLevel: 'manage',
    allowExport: true,
    activityView: true,
    allowSupabase: true,
    modulePerms: { ...ROLE_DEFAULT_MODULES.supervisor },
  },
  shift_lead: {
    scopeAll: true,
    barcodeView: true,
    barcodeCreate: true,
    barcodeEdit: true,
    barcodeDelete: false,
    scheduleView: true,
    scheduleCreate: true,
    scheduleEdit: true,
    scheduleDelete: false,
    scheduleApprove: true,
    scheduleLevel: 'edit',
    allowExport: true,
    activityView: true,
    allowSupabase: false,
    modulePerms: { ...ROLE_DEFAULT_MODULES.shift_lead },
  },
  staff: {
    scopeAll: false,
    barcodeView: true,
    barcodeCreate: true,
    barcodeEdit: true,
    barcodeDelete: false,
    scheduleView: true,
    scheduleCreate: true,
    scheduleEdit: true,
    scheduleDelete: false,
    scheduleApprove: false,
    scheduleLevel: 'view',
    allowExport: true,
    activityView: false,
    allowSupabase: false,
    modulePerms: { ...ROLE_DEFAULT_MODULES.staff },
  },
};

export const FULL_ADMIN_PERMISSIONS: ModulePermissions =
  ROLE_DEFAULT_PERMS.store_manager;

export const EMPTY_MODULE_PERMISSIONS: ModulePermissions = {
  scopeAll: false,
  barcodeView: false,
  barcodeCreate: false,
  barcodeEdit: false,
  barcodeDelete: false,
  scheduleView: false,
  scheduleCreate: false,
  scheduleEdit: false,
  scheduleDelete: false,
  scheduleApprove: false,
  scheduleLevel: 'view',
  allowExport: false,
  activityView: false,
  allowSupabase: false,
  modulePerms: {
    overview: false,
    schedule: false,
    attendance: false,
    staff: false,
    feedback: false,
    warehouse: false,
    scanner: false,
    expiry: false,
    returns: false,
    promotions: false,
    supabase: false,
    monitoring: false,
    storage: false,
    settings: false,
    access: false,
    activity: false,
  },
};

export interface NavItemDef {
  id: AppTab;
  group: NavGroupId;
  label: string;
  shortLabel: string;
}

export const NAV_GROUPS: Array<{ id: NavGroupId; label: string }> = [
  { id: 'ops', label: 'Vận hành' },
  { id: 'goods', label: 'Hàng hóa' },
  { id: 'system', label: 'Hệ thống & dữ liệu' },
];

export const NAV_ITEMS: NavItemDef[] = [
  // Group 1: Vận hành
  { id: 'overview', group: 'ops', label: 'Tổng quan', shortLabel: 'Tổng quan' },
  { id: 'schedule', group: 'ops', label: 'Lịch làm việc', shortLabel: 'Lịch làm' },
  { id: 'attendance', group: 'ops', label: 'Chấm công', shortLabel: 'Chấm công' },
  { id: 'staff', group: 'ops', label: 'Nhân sự', shortLabel: 'Nhân sự' },
  { id: 'feedback', group: 'ops', label: 'Ý kiến khách hàng', shortLabel: 'Ý kiến KH' },
  // Group 2: Hàng hóa
  { id: 'warehouse', group: 'goods', label: 'Kho dữ liệu', shortLabel: 'Kho dữ liệu' },
  { id: 'scanner', group: 'goods', label: 'Quét mã vạch', shortLabel: 'Quét mã' },
  { id: 'expiry', group: 'goods', label: 'Kiểm soát hạn sử dụng', shortLabel: 'Hạn SD' },
  { id: 'returns', group: 'goods', label: 'Đổi trả hàng hóa', shortLabel: 'Đổi trả' },
  { id: 'promotions', group: 'goods', label: 'Chương trình khuyến mãi', shortLabel: 'Khuyến mãi' },
  // Group 3: Hệ thống & dữ liệu
  { id: 'supabase', group: 'system', label: 'Quản lý Supabase', shortLabel: 'Supabase' },
  { id: 'monitoring', group: 'system', label: 'Giám sát tài nguyên', shortLabel: 'Tài nguyên' },
  { id: 'storage', group: 'system', label: 'Quản lý Storage', shortLabel: 'Storage' },
  { id: 'settings', group: 'system', label: 'Cấu hình', shortLabel: 'Cấu hình' },
  { id: 'access', group: 'system', label: 'Phân quyền', shortLabel: 'Phân quyền' },
  { id: 'activity', group: 'system', label: 'Nhật ký hoạt động', shortLabel: 'Nhật ký' },
];

export function resolveModuleAccessFlags(
  role: UserRole,
  override?: Partial<ModuleAccessFlags>,
  legacyFlags?: Partial<ModulePermissions>
): ModuleAccessFlags {
  const base = { ...ROLE_DEFAULT_MODULES[role] };
  if (override) {
    for (const k of Object.keys(base) as Array<keyof ModuleAccessFlags>) {
      if (typeof override[k] === 'boolean') {
        base[k] = Boolean(override[k]);
      }
    }
  }
  // Respect explicit legacy permission switches if present
  if (legacyFlags) {
    if (legacyFlags.barcodeView === false) base.scanner = false;
    if (legacyFlags.scheduleView === false) base.schedule = false;
    if (legacyFlags.activityView !== undefined) {
      base.activity = Boolean(legacyFlags.activityView);
    }
    if (legacyFlags.allowSupabase !== undefined) {
      base.supabase = Boolean(legacyFlags.allowSupabase);
      if (!legacyFlags.allowSupabase && role !== 'store_manager') {
        base.monitoring = false;
      }
    }
  }
  return base;
}

export const ACTIVITY_LOG_RETENTION_DAYS = 60;

export function getActivityLogCutoffIso(nowMs = Date.now()): string {
  return new Date(nowMs - ACTIVITY_LOG_RETENTION_DAYS * 86_400_000).toISOString();
}

export function filterLogsLast60Days<T extends { createdAt: string }>(logs: T[]): T[] {
  const cutoffMs = Date.now() - ACTIVITY_LOG_RETENTION_DAYS * 86_400_000;
  return logs.filter((log) => {
    if (!log.createdAt) return false;
    const ts = new Date(log.createdAt).getTime();
    return Number.isFinite(ts) && ts >= cutoffMs;
  });
}

export function extractShortStaffName(
  displayName?: string | null,
  email?: string | null
): string {
  const cleanName = String(displayName || '').trim().replace(/\s+/g, ' ');
  if (cleanName) {
    const parts = cleanName.split(' ').filter(Boolean);
    if (parts.length >= 2) {
      return parts.slice(-2).join(' ');
    }
    return parts[0];
  }
  const cleanEmail = String(email || '').trim();
  if (cleanEmail.includes('@')) {
    return cleanEmail.split('@')[0];
  }
  return cleanEmail;
}

export function extractNoticeMonthsFromPolicy(
  returnPolicy?: string | null,
  fallbackMonths = 0
): number {
  const text = String(returnPolicy || '').trim();
  if (text) {
    const match = /(\d+)\s*tháng/i.exec(text);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 36) {
        return Math.round(parsed);
      }
    }
  }
  const fb = Number(fallbackMonths || 0);
  return Number.isFinite(fb) && fb > 0 ? Math.min(36, Math.round(fb)) : 0;
}

