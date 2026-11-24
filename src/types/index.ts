import type { Timestamp } from 'firebase/firestore';

export type AppTab = 'scanner' | 'schedule' | 'access' | 'account';

export type UserRole = 'admin' | 'manager' | 'staff' | 'viewer';

export type ShiftType = 'morning' | 'afternoon' | 'evening' | 'full_day' | 'custom';

export type ScheduleStatus = 'registered' | 'confirmed' | 'completed' | 'cancelled';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export interface AuthorizedEmail {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  allowBarcode: boolean;
  allowSchedule: boolean;
  allowExport: boolean;
  allowSupabase: boolean;
  active: boolean;
  note: string;
  grantedBy: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface EffectivePermissions {
  authorized: boolean;
  isSuperAdmin: boolean;
  role: UserRole;
  allowBarcode: boolean;
  allowSchedule: boolean;
  allowExport: boolean;
  allowSupabase: boolean;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  updatedAt?: Timestamp | Date | null;
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
  syncedToSupabase: boolean;
  scannedAt: Timestamp | null;
  updatedAt: Timestamp | null;
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
  syncedToSupabase: boolean;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}
