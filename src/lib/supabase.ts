import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BarcodeScan, SupabaseConfig, WorkSchedule } from '../types';

export const SUPABASE_SCHEMA_SQL = `-- Chạy đoạn SQL này trong Supabase SQL Editor để tạo bảng đồng bộ
CREATE TABLE IF NOT EXISTS public.barcode_scans (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  code TEXT NOT NULL,
  format TEXT NOT NULL,
  session_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '',
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.work_schedules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  title TEXT NOT NULL,
  work_date TEXT NOT NULL,
  shift_type TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  location TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registered',
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bật Row Level Security (RLS)
ALTER TABLE public.barcode_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_schedules ENABLE ROW LEVEL SECURITY;

-- Policy cho phép ứng dụng đồng bộ theo owner_email (tuỳ chỉnh thêm theo nhu cầu bảo mật của bạn)
CREATE POLICY "Allow app sync barcode_scans"
  ON public.barcode_scans FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow app sync work_schedules"
  ON public.work_schedules FOR ALL
  USING (true)
  WITH CHECK (true);
`;

export function getEnvSupabaseConfig(): SupabaseConfig {
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || '';
  return { url: url.trim(), anonKey: anonKey.trim() };
}

export function isValidSupabaseConfig(config: SupabaseConfig): boolean {
  if (!config.url || !config.anonKey) return false;
  try {
    const parsed = new URL(config.url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function createSupabaseClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url.trim(), config.anonKey.trim(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function testSupabaseConnection(config: SupabaseConfig): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!isValidSupabaseConfig(config)) {
    return {
      ok: false,
      message: 'URL Supabase hoặc Anon Key không hợp lệ.',
    };
  }
  try {
    const client = createSupabaseClient(config);
    const [scanRes, schedRes] = await Promise.all([
      client.from('barcode_scans').select('id', { count: 'exact', head: true }),
      client.from('work_schedules').select('id', { count: 'exact', head: true }),
    ]);

    if (scanRes.error || schedRes.error) {
      const errMsg = scanRes.error?.message || schedRes.error?.message || 'Lỗi truy vấn bảng';
      if (errMsg.includes('does not exist') || errMsg.includes('schema cache')) {
        return {
          ok: false,
          message:
            'Đã kết nối tới Supabase nhưng chưa có bảng barcode_scans / work_schedules. Hãy sao chép và chạy đoạn SQL khởi tạo bên dưới.',
        };
      }
      return { ok: false, message: `Lỗi Supabase: ${errMsg}` };
    }

    return {
      ok: true,
      message: `Kết nối thành công (${scanRes.count ?? 0} mã vạch · ${schedRes.count ?? 0} lịch làm việc trên Supabase).`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Không thể kết nối tới Supabase.',
    };
  }
}

export async function pushBarcodeScansToSupabase(
  config: SupabaseConfig,
  scans: BarcodeScan[]
): Promise<{ syncedIds: string[]; error?: string }> {
  if (scans.length === 0) return { syncedIds: [] };
  const client = createSupabaseClient(config);
  const rows = scans.map((s) => ({
    id: s.id,
    owner_id: s.ownerId,
    owner_email: s.ownerEmail,
    code: s.code,
    format: s.format,
    session_name: s.sessionName,
    quantity: s.quantity,
    note: s.note || '',
    scanned_at: s.scannedAt ? s.scannedAt.toDate().toISOString() : new Date().toISOString(),
    updated_at: s.updatedAt ? s.updatedAt.toDate().toISOString() : new Date().toISOString(),
  }));

  const { error } = await client.from('barcode_scans').upsert(rows, { onConflict: 'id' });
  if (error) {
    return { syncedIds: [], error: error.message };
  }
  return { syncedIds: scans.map((s) => s.id) };
}

export async function pushSchedulesToSupabase(
  config: SupabaseConfig,
  schedules: WorkSchedule[]
): Promise<{ syncedIds: string[]; error?: string }> {
  if (schedules.length === 0) return { syncedIds: [] };
  const client = createSupabaseClient(config);
  const rows = schedules.map((w) => ({
    id: w.id,
    owner_id: w.ownerId,
    owner_email: w.ownerEmail,
    employee_name: w.employeeName,
    title: w.title,
    work_date: w.workDate,
    shift_type: w.shiftType,
    start_time: w.startTime,
    end_time: w.endTime,
    location: w.location || '',
    status: w.status,
    note: w.note || '',
    created_at: w.createdAt ? w.createdAt.toDate().toISOString() : new Date().toISOString(),
    updated_at: w.updatedAt ? w.updatedAt.toDate().toISOString() : new Date().toISOString(),
  }));

  const { error } = await client.from('work_schedules').upsert(rows, { onConflict: 'id' });
  if (error) {
    return { syncedIds: [], error: error.message };
  }
  return { syncedIds: schedules.map((w) => w.id) };
}

export interface SupabasePulledScan {
  id: string;
  code: string;
  format: string;
  sessionName: string;
  quantity: number;
  note: string;
}

export interface SupabasePulledSchedule {
  id: string;
  employeeName: string;
  title: string;
  workDate: string;
  shiftType: string;
  startTime: string;
  endTime: string;
  location: string;
  status: string;
  note: string;
}

export async function pullFromSupabase(
  config: SupabaseConfig,
  ownerEmail: string
): Promise<{
  scans: SupabasePulledScan[];
  schedules: SupabasePulledSchedule[];
  error?: string;
}> {
  const client = createSupabaseClient(config);
  const [scanRes, schedRes] = await Promise.all([
    client.from('barcode_scans').select('*').eq('owner_email', ownerEmail),
    client.from('work_schedules').select('*').eq('owner_email', ownerEmail),
  ]);

  if (scanRes.error) {
    return { scans: [], schedules: [], error: scanRes.error.message };
  }
  if (schedRes.error) {
    return { scans: [], schedules: [], error: schedRes.error.message };
  }

  const scans: SupabasePulledScan[] = (scanRes.data || []).map((r: Record<string, unknown>) => ({
    id: String(r.id || ''),
    code: String(r.code || ''),
    format: String(r.format || 'MANUAL'),
    sessionName: String(r.session_name || 'Mặc định'),
    quantity: Number(r.quantity || 1),
    note: String(r.note || ''),
  }));

  const schedules: SupabasePulledSchedule[] = (schedRes.data || []).map(
    (r: Record<string, unknown>) => ({
      id: String(r.id || ''),
      employeeName: String(r.employee_name || ''),
      title: String(r.title || ''),
      workDate: String(r.work_date || ''),
      shiftType: String(r.shift_type || 'custom'),
      startTime: String(r.start_time || '08:00'),
      endTime: String(r.end_time || '17:00'),
      location: String(r.location || ''),
      status: String(r.status || 'registered'),
      note: String(r.note || ''),
    })
  );

  return { scans, schedules };
}
