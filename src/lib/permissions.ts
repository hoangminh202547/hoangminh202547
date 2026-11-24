import type { ModulePermissions, UserRole } from '../types';

export const SUPER_ADMIN_EMAIL = 'hoangminh202547@gmail.com';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Deterministic key matching Firestore & Supabase user_access ID format.
 */
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
  store_manager: 'Quản lý siêu thị',
  supervisor: 'Giám sát',
  shift_lead: 'Trưởng ca',
  staff: 'Nhân viên',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  store_manager:
    'Toàn quyền quản trị hệ thống, xem tất cả báo cáo, phê duyệt ca làm, quản lý phân quyền và cấu hình Supabase.',
  supervisor:
    'Xem dữ liệu toàn siêu thị, thêm/sửa/xóa kiểm kê mã vạch, phê duyệt lịch làm việc và theo dõi nhật ký hoạt động.',
  shift_lead:
    'Xem dữ liệu ca trực toàn đội, quét & chỉnh sửa mã vạch, xác nhận/hoàn thành lịch làm việc và xem nhật ký.',
  staff:
    'Quét mã vạch và đăng ký/sửa lịch làm việc trong phạm vi cá nhân được cấp phép; không tự duyệt ca hoặc sửa quyền.',
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
    allowExport: true,
    activityView: true,
    allowSupabase: true,
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
    allowExport: true,
    activityView: true,
    allowSupabase: true,
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
    allowExport: true,
    activityView: true,
    allowSupabase: false,
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
    allowExport: true,
    activityView: false,
    allowSupabase: false,
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
  allowExport: false,
  activityView: false,
  allowSupabase: false,
};
