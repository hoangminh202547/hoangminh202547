import type { UserRole } from '../types';

export const SUPER_ADMIN_EMAIL = 'hoangminh202547@gmail.com';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Deterministic key matching Firestore Rules `emailToKey(email)` exactly.
 */
export function emailToKey(email: string): string {
  return normalizeEmail(email)
    .replace(/@/g, '_at_')
    .replace(/\./g, '_dot_')
    .replace(/[^a-z0-9_-]/g, '_');
}

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Quản trị viên',
  manager: 'Quản lý',
  staff: 'Nhân viên',
  viewer: 'Chỉ xem',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: 'Toàn quyền sử dụng, quản lý dữ liệu nhóm và phân quyền email khác.',
  manager: 'Xem toàn bộ dữ liệu nhóm, xác nhận/duyệt lịch làm việc và xuất báo cáo.',
  staff: 'Quét mã vạch và đăng ký/quản lý lịch làm việc cá nhân.',
  viewer: 'Chỉ xem danh sách mã vạch, lịch làm việc và xuất báo cáo Excel.',
};

export const ROLE_DEFAULT_PERMS: Record<
  UserRole,
  {
    allowBarcode: boolean;
    allowSchedule: boolean;
    allowExport: boolean;
    allowSupabase: boolean;
  }
> = {
  admin: {
    allowBarcode: true,
    allowSchedule: true,
    allowExport: true,
    allowSupabase: true,
  },
  manager: {
    allowBarcode: true,
    allowSchedule: true,
    allowExport: true,
    allowSupabase: true,
  },
  staff: {
    allowBarcode: true,
    allowSchedule: true,
    allowExport: true,
    allowSupabase: false,
  },
  viewer: {
    allowBarcode: true,
    allowSchedule: true,
    allowExport: true,
    allowSupabase: false,
  },
};
