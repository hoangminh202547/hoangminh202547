import {
  createClient,
  type RealtimeChannel,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';
import schemaSql from '../../supabase/schema.sql?raw';
import type {
  ActivityAction,
  ActivityLog,
  ActivityModule,
  AuthorizedEmail,
  BarcodeScan,
  ScheduleStatus,
  ShiftType,
  SupabaseConfig,
  UserRole,
  WorkSchedule,
} from '../types';
import { emailToKey, normalizeEmail, normalizeRole } from './permissions';

export const SUPABASE_SCHEMA_SQL = schemaSql;

/**
 * In-memory storage adapter for Supabase Auth so auth tokens stay strictly
 * in JS memory and are never persisted to localStorage or sessionStorage.
 */
class MemoryAuthStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

const sharedMemoryStorage = new MemoryAuthStorage();

let cachedClientKey = '';
let cachedClient: SupabaseClient | null = null;

export function getEnvSupabaseConfig(): SupabaseConfig {
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
  const anonKey =
    (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || '';
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

export function getSupabaseClient(
  config: SupabaseConfig
): SupabaseClient | null {
  if (!isValidSupabaseConfig(config)) return null;
  const key = `${config.url.trim()}::${config.anonKey.trim()}`;
  if (cachedClient && cachedClientKey === key) {
    return cachedClient;
  }
  cachedClientKey = key;
  cachedClient = createClient(config.url.trim(), config.anonKey.trim(), {
    auth: {
      storage: sharedMemoryStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });
  return cachedClient;
}

export function resetCachedSupabaseClient(): void {
  if (cachedClient) {
    void cachedClient.removeAllChannels();
  }
  cachedClient = null;
  cachedClientKey = '';
}

/**
 * Handles OAuth redirect callback if the current window is an OAuth popup
 * or top-level redirect returning with ?code= or #access_token=.
 */
export async function handleSupabaseOAuthRedirectIfPresent(
  client: SupabaseClient | null
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(
    window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  );

  const errorDesc =
    searchParams.get('error_description') ||
    hashParams.get('error_description') ||
    searchParams.get('error') ||
    hashParams.get('error');

  const code = searchParams.get('code');
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');

  if (!errorDesc && !code && !accessToken) {
    return false;
  }

  // If opened inside a popup, relay auth code or tokens back to the opener safely
  if (window.opener && window.opener !== window) {
    try {
      if (errorDesc) {
        window.opener.postMessage(
          { type: 'SUPABASE_OAUTH_RESULT', error: errorDesc },
          window.location.origin
        );
      } else if (accessToken && refreshToken) {
        window.opener.postMessage(
          {
            type: 'SUPABASE_OAUTH_RESULT',
            accessToken,
            refreshToken,
          },
          window.location.origin
        );
      } else if (code) {
        window.opener.postMessage(
          {
            type: 'SUPABASE_OAUTH_RESULT',
            code,
          },
          window.location.origin
        );
      }
    } finally {
      window.close();
    }
    return true;
  }

  // Direct top-level callback (e.g. mobile browser tab)
  if (client) {
    if (accessToken && refreshToken) {
      await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
    } else if (code) {
      await client.auth.exchangeCodeForSession(code);
    }
    const cleanUrl = `${window.location.origin}${window.location.pathname}`;
    window.history.replaceState({}, document.title, cleanUrl);
  }

  return true;
}

export async function signInWithSupabaseGooglePopup(
  client: SupabaseClient
): Promise<Session> {
  const redirectTo = `${window.location.origin}/auth/callback`;
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      queryParams: {
        prompt: 'select_account',
      },
    },
  });

  if (error || !data?.url) {
    throw new Error(error?.message || 'Không thể khởi tạo đăng nhập Google.');
  }

  const width = 520;
  const height = 640;
  const left = Math.max(0, (window.screen.width - width) / 2);
  const top = Math.max(0, (window.screen.height - height) / 2);

  const popup = window.open(
    data.url,
    'supabase_google_oauth',
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
  );

  if (!popup) {
    throw new Error(
      'Trình duyệt đã chặn cửa sổ bật lên (popup). Vui lòng cho phép popup để đăng nhập Gmail.'
    );
  }

  return new Promise<Session>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(closedCheck);
      window.clearTimeout(timeoutId);
    };

    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const payload = event.data as
        | {
            type?: string;
            code?: string;
            accessToken?: string;
            refreshToken?: string;
            error?: string;
          }
        | undefined;

      if (!payload || payload.type !== 'SUPABASE_OAUTH_RESULT') return;
      if (settled) return;
      settled = true;
      cleanup();

      if (payload.error) {
        reject(new Error(payload.error));
        return;
      }

      if (payload.code) {
        const { data: exchanged, error: exchangeErr } =
          await client.auth.exchangeCodeForSession(payload.code);
        if (exchangeErr || !exchanged.session) {
          reject(
            new Error(
              exchangeErr?.message || 'Không thể đổi mã xác thực Google lấy phiên Supabase.'
            )
          );
          return;
        }
        resolve(exchanged.session);
        return;
      }

      if (!payload.accessToken || !payload.refreshToken) {
        reject(new Error('Không nhận được phiên đăng nhập hợp lệ từ Google.'));
        return;
      }

      const { data: sessionData, error: sessionErr } =
        await client.auth.setSession({
          access_token: payload.accessToken,
          refresh_token: payload.refreshToken,
        });
      if (sessionErr || !sessionData.session) {
        reject(
          new Error(sessionErr?.message || 'Không thể thiết lập phiên Supabase.')
        );
        return;
      }
      resolve(sessionData.session);
    };

    const closedCheck = window.setInterval(() => {
      if (popup.closed && !settled) {
        settled = true;
        cleanup();
        reject(new Error('Cửa sổ đăng nhập đã bị đóng trước khi hoàn tất.'));
      }
    }, 500);

    const timeoutId = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        try {
          popup.close();
        } catch {
          // Ignore cross-origin close error
        }
        reject(new Error('Quá thời gian chờ xác thực Google (2 phút).'));
      }
    }, 120000);

    window.addEventListener('message', onMessage);
  });
}

// ============================================================================
// Mapping DB rows <-> App entities
// ============================================================================
export function mapBarcodeRow(r: Record<string, unknown>): BarcodeScan {
  return {
    id: String(r.id || ''),
    ownerId: String(r.owner_id || ''),
    ownerEmail: String(r.owner_email || ''),
    code: String(r.code || ''),
    format: String(r.format || 'BARCODE'),
    sessionName: String(r.session_name || 'Mặc định'),
    quantity: Number(r.quantity || 1),
    note: String(r.note || ''),
    version: Number(r.version || 1),
    updatedBy: String(r.updated_by || r.owner_email || ''),
    syncedToSupabase: true,
    scannedAt: r.scanned_at ? String(r.scanned_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

export function mapScheduleRow(r: Record<string, unknown>): WorkSchedule {
  return {
    id: String(r.id || ''),
    ownerId: String(r.owner_id || ''),
    ownerEmail: String(r.owner_email || ''),
    employeeName: String(r.employee_name || ''),
    title: String(r.title || ''),
    workDate: String(r.work_date || ''),
    shiftType: (String(r.shift_type || 'custom') as ShiftType) || 'custom',
    startTime: String(r.start_time || '08:00'),
    endTime: String(r.end_time || '17:00'),
    location: String(r.location || ''),
    status: (String(r.status || 'registered') as ScheduleStatus) || 'registered',
    note: String(r.note || ''),
    approvedBy: String(r.approved_by || ''),
    approvedAt: r.approved_at ? String(r.approved_at) : null,
    version: Number(r.version || 1),
    updatedBy: String(r.updated_by || r.owner_email || ''),
    syncedToSupabase: true,
    createdAt: r.created_at ? String(r.created_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

export function mapAccessRow(r: Record<string, unknown>): AuthorizedEmail {
  const role = normalizeRole(r.role);
  return {
    id: String(r.id || ''),
    email: normalizeEmail(String(r.email || '')),
    displayName: String(r.display_name || ''),
    role,
    active: Boolean(r.active),
    scopeAll: Boolean(
      r.scope_all ??
        (role === 'store_manager' ||
          role === 'supervisor' ||
          role === 'shift_lead')
    ),
    barcodeView: Boolean(r.barcode_view ?? true),
    barcodeCreate: Boolean(r.barcode_create ?? true),
    barcodeEdit: Boolean(r.barcode_edit ?? true),
    barcodeDelete: Boolean(r.barcode_delete ?? false),
    scheduleView: Boolean(r.schedule_view ?? true),
    scheduleCreate: Boolean(r.schedule_create ?? true),
    scheduleEdit: Boolean(r.schedule_edit ?? true),
    scheduleDelete: Boolean(r.schedule_delete ?? false),
    scheduleApprove: Boolean(r.schedule_approve ?? false),
    allowExport: Boolean(r.allow_export ?? true),
    activityView: Boolean(r.activity_view ?? false),
    allowSupabase: Boolean(r.allow_supabase ?? false),
    note: String(r.note || ''),
    grantedBy: String(r.granted_by || ''),
    version: Number(r.version || 1),
    createdAt: r.created_at ? String(r.created_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

export function mapActivityRow(r: Record<string, unknown>): ActivityLog {
  return {
    id: String(r.id || ''),
    actorId: String(r.actor_id || ''),
    actorEmail: String(r.actor_email || ''),
    actorName: String(r.actor_name || ''),
    actorRole: normalizeRole(r.actor_role),
    module: (String(r.module || 'system') as ActivityModule) || 'system',
    action: (String(r.action || 'update') as ActivityAction) || 'update',
    targetId: String(r.target_id || ''),
    summary: String(r.summary || ''),
    changes:
      r.changes && typeof r.changes === 'object'
        ? (r.changes as Record<string, unknown>)
        : {},
    createdAt: r.created_at ? String(r.created_at) : new Date().toISOString(),
  };
}

// ============================================================================
// Connection Diagnostics
// ============================================================================
export async function testSupabaseConnection(config: SupabaseConfig): Promise<{
  ok: boolean;
  message: string;
  tablesReady?: boolean;
}> {
  if (!isValidSupabaseConfig(config)) {
    return {
      ok: false,
      message: 'URL Supabase hoặc Anon Key không hợp lệ.',
    };
  }
  try {
    const client = getSupabaseClient(config);
    if (!client) {
      return { ok: false, message: 'Không thể khởi tạo Supabase client.' };
    }

    const [scanRes, schedRes, accessRes, logRes] = await Promise.all([
      client.from('barcode_scans').select('id', { count: 'exact', head: true }),
      client.from('work_schedules').select('id', { count: 'exact', head: true }),
      client.from('user_access').select('id', { count: 'exact', head: true }),
      client.from('activity_logs').select('id', { count: 'exact', head: true }),
    ]);

    const firstError =
      scanRes.error || schedRes.error || accessRes.error || logRes.error;

    if (firstError) {
      const msg = firstError.message || 'Lỗi truy vấn bảng';
      if (
        msg.includes('does not exist') ||
        msg.includes('schema cache') ||
        msg.includes('42P01')
      ) {
        return {
          ok: false,
          tablesReady: false,
          message:
            'Đã kết nối tới Supabase nhưng thiếu bảng (barcode_scans, work_schedules, user_access, activity_logs). Hãy chạy script SQL bên dưới trong SQL Editor.',
        };
      }
      if (msg.includes('permission denied') || msg.includes('RLS')) {
        return {
          ok: true,
          tablesReady: true,
          message:
            'Đã kết nối Supabase và bật RLS bảo mật. Đăng nhập tài khoản qua Supabase Auth để truy xuất dữ liệu theo phân quyền.',
        };
      }
      return { ok: false, message: `Lỗi Supabase: ${msg}` };
    }

    return {
      ok: true,
      tablesReady: true,
      message: `Kết nối thành công · Đã sẵn sàng 4 bảng đồng bộ (${scanRes.count ?? 0} mã vạch · ${schedRes.count ?? 0} ca làm · ${accessRes.count ?? 0} phân quyền · ${logRes.count ?? 0} nhật ký).`,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'Không thể kết nối tới Supabase.',
    };
  }
}

// ============================================================================
// Optimistic-Locking CRUD Operations
// ============================================================================
export type OptimisticUpdateResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'conflict'; serverRecord: T | null }
  | { status: 'error'; error: string };

export async function upsertUserProfile(
  client: SupabaseClient,
  params: { uid: string; email: string; displayName: string; photoURL?: string }
): Promise<void> {
  await client.from('user_profiles').upsert(
    {
      id: params.uid,
      email: normalizeEmail(params.email),
      display_name: params.displayName.slice(0, 120),
      avatar_url: (params.photoURL || '').slice(0, 500),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
}

export async function fetchMyAccessFromSupabase(
  client: SupabaseClient,
  email: string
): Promise<{ access: AuthorizedEmail | null; error?: string }> {
  const { data, error } = await client
    .from('user_access')
    .select('*')
    .eq('email', normalizeEmail(email))
    .maybeSingle();

  if (error) return { access: null, error: error.message };
  if (!data) return { access: null };
  return { access: mapAccessRow(data as Record<string, unknown>) };
}

export async function fetchAllSyncedData(
  client: SupabaseClient,
  options: { isStoreManager: boolean; allowActivity: boolean }
): Promise<{
  scans: BarcodeScan[];
  schedules: WorkSchedule[];
  members: AuthorizedEmail[];
  logs: ActivityLog[];
  error?: string;
}> {
  const [scanRes, schedRes, accessRes, logRes] = await Promise.all([
    client
      .from('barcode_scans')
      .select('*')
      .order('updated_at', { ascending: false }),
    client
      .from('work_schedules')
      .select('*')
      .order('work_date', { ascending: true })
      .order('start_time', { ascending: true }),
    options.isStoreManager
      ? client
          .from('user_access')
          .select('*')
          .order('email', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    options.allowActivity
      ? client
          .from('activity_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const err = scanRes.error || schedRes.error || accessRes.error || logRes.error;
  if (err) {
    return {
      scans: [],
      schedules: [],
      members: [],
      logs: [],
      error: err.message,
    };
  }

  return {
    scans: (scanRes.data || []).map((r) =>
      mapBarcodeRow(r as Record<string, unknown>)
    ),
    schedules: (schedRes.data || []).map((r) =>
      mapScheduleRow(r as Record<string, unknown>)
    ),
    members: (accessRes.data || []).map((r) =>
      mapAccessRow(r as Record<string, unknown>)
    ),
    logs: (logRes.data || []).map((r) =>
      mapActivityRow(r as Record<string, unknown>)
    ),
  };
}

export async function createBarcodeScanInSupabase(
  client: SupabaseClient,
  params: {
    id: string;
    ownerId: string;
    ownerEmail: string;
    code: string;
    format: string;
    sessionName: string;
    quantity: number;
    note: string;
  }
): Promise<{ data?: BarcodeScan; error?: string }> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('barcode_scans')
    .insert({
      id: params.id,
      owner_id: params.ownerId,
      owner_email: normalizeEmail(params.ownerEmail),
      code: params.code,
      format: params.format,
      session_name: params.sessionName,
      quantity: params.quantity,
      note: params.note,
      version: 1,
      updated_by: normalizeEmail(params.ownerEmail),
      scanned_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error || !data) {
    return { error: error?.message || 'Không thể lưu mã vạch lên Supabase.' };
  }
  return { data: mapBarcodeRow(data as Record<string, unknown>) };
}

export async function updateBarcodeScanWithVersion(
  client: SupabaseClient,
  params: {
    id: string;
    expectedVersion: number;
    actorEmail: string;
    updates: Partial<{ quantity: number; note: string; sessionName: string }>;
  }
): Promise<OptimisticUpdateResult<BarcodeScan>> {
  const dbUpdates: Record<string, unknown> = {
    version: params.expectedVersion + 1,
    updated_by: normalizeEmail(params.actorEmail),
    updated_at: new Date().toISOString(),
  };
  if (params.updates.quantity !== undefined) {
    dbUpdates.quantity = params.updates.quantity;
  }
  if (params.updates.note !== undefined) {
    dbUpdates.note = params.updates.note;
  }
  if (params.updates.sessionName !== undefined) {
    dbUpdates.session_name = params.updates.sessionName;
  }

  const { data, error } = await client
    .from('barcode_scans')
    .update(dbUpdates)
    .eq('id', params.id)
    .eq('version', params.expectedVersion)
    .select()
    .maybeSingle();

  if (error) {
    return { status: 'error', error: error.message };
  }

  if (!data) {
    const latestRes = await client
      .from('barcode_scans')
      .select('*')
      .eq('id', params.id)
      .maybeSingle();
    return {
      status: 'conflict',
      serverRecord: latestRes.data
        ? mapBarcodeRow(latestRes.data as Record<string, unknown>)
        : null,
    };
  }

  return {
    status: 'ok',
    data: mapBarcodeRow(data as Record<string, unknown>),
  };
}

export async function deleteBarcodeScansInSupabase(
  client: SupabaseClient,
  ids: string[]
): Promise<{ error?: string }> {
  if (ids.length === 0) return {};
  const { error } = await client.from('barcode_scans').delete().in('id', ids);
  if (error) return { error: error.message };
  return {};
}

export async function createWorkScheduleInSupabase(
  client: SupabaseClient,
  params: {
    id: string;
    ownerId: string;
    ownerEmail: string;
    employeeName: string;
    title: string;
    workDate: string;
    shiftType: ShiftType;
    startTime: string;
    endTime: string;
    location: string;
    note: string;
  }
): Promise<{ data?: WorkSchedule; error?: string }> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('work_schedules')
    .insert({
      id: params.id,
      owner_id: params.ownerId,
      owner_email: normalizeEmail(params.ownerEmail),
      employee_name: params.employeeName,
      title: params.title,
      work_date: params.workDate,
      shift_type: params.shiftType,
      start_time: params.startTime,
      end_time: params.endTime,
      location: params.location,
      status: 'registered',
      note: params.note,
      approved_by: '',
      approved_at: null,
      version: 1,
      updated_by: normalizeEmail(params.ownerEmail),
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error || !data) {
    return {
      error: error?.message || 'Không thể đăng ký lịch làm việc trên Supabase.',
    };
  }
  return { data: mapScheduleRow(data as Record<string, unknown>) };
}

export async function updateWorkScheduleWithVersion(
  client: SupabaseClient,
  params: {
    id: string;
    expectedVersion: number;
    actorEmail: string;
    updates: Partial<{
      employeeName: string;
      title: string;
      workDate: string;
      shiftType: ShiftType;
      startTime: string;
      endTime: string;
      location: string;
      status: ScheduleStatus;
      note: string;
    }>;
  }
): Promise<OptimisticUpdateResult<WorkSchedule>> {
  const now = new Date().toISOString();
  const dbUpdates: Record<string, unknown> = {
    version: params.expectedVersion + 1,
    updated_by: normalizeEmail(params.actorEmail),
    updated_at: now,
  };

  if (params.updates.employeeName !== undefined) {
    dbUpdates.employee_name = params.updates.employeeName;
  }
  if (params.updates.title !== undefined) dbUpdates.title = params.updates.title;
  if (params.updates.workDate !== undefined) {
    dbUpdates.work_date = params.updates.workDate;
  }
  if (params.updates.shiftType !== undefined) {
    dbUpdates.shift_type = params.updates.shiftType;
  }
  if (params.updates.startTime !== undefined) {
    dbUpdates.start_time = params.updates.startTime;
  }
  if (params.updates.endTime !== undefined) {
    dbUpdates.end_time = params.updates.endTime;
  }
  if (params.updates.location !== undefined) {
    dbUpdates.location = params.updates.location;
  }
  if (params.updates.note !== undefined) dbUpdates.note = params.updates.note;
  if (params.updates.status !== undefined) {
    dbUpdates.status = params.updates.status;
    if (
      params.updates.status === 'confirmed' ||
      params.updates.status === 'completed'
    ) {
      dbUpdates.approved_by = normalizeEmail(params.actorEmail);
      dbUpdates.approved_at = now;
    }
  }

  const { data, error } = await client
    .from('work_schedules')
    .update(dbUpdates)
    .eq('id', params.id)
    .eq('version', params.expectedVersion)
    .select()
    .maybeSingle();

  if (error) {
    return { status: 'error', error: error.message };
  }

  if (!data) {
    const latestRes = await client
      .from('work_schedules')
      .select('*')
      .eq('id', params.id)
      .maybeSingle();
    return {
      status: 'conflict',
      serverRecord: latestRes.data
        ? mapScheduleRow(latestRes.data as Record<string, unknown>)
        : null,
    };
  }

  return {
    status: 'ok',
    data: mapScheduleRow(data as Record<string, unknown>),
  };
}

export async function deleteWorkScheduleInSupabase(
  client: SupabaseClient,
  id: string
): Promise<{ error?: string }> {
  const { error } = await client.from('work_schedules').delete().eq('id', id);
  if (error) return { error: error.message };
  return {};
}

export async function saveUserAccessInSupabase(
  client: SupabaseClient,
  params: {
    email: string;
    displayName: string;
    role: UserRole;
    active: boolean;
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
    note: string;
    grantedBy: string;
    expectedVersion?: number;
    isEdit: boolean;
  }
): Promise<OptimisticUpdateResult<AuthorizedEmail>> {
  const cleanEmail = normalizeEmail(params.email);
  const id = emailToKey(cleanEmail);
  const now = new Date().toISOString();

  const payload = {
    email: cleanEmail,
    display_name: params.displayName.slice(0, 120),
    role: params.role,
    active: params.active,
    scope_all: params.scopeAll,
    barcode_view: params.barcodeView,
    barcode_create: params.barcodeCreate,
    barcode_edit: params.barcodeEdit,
    barcode_delete: params.barcodeDelete,
    schedule_view: params.scheduleView,
    schedule_create: params.scheduleCreate,
    schedule_edit: params.scheduleEdit,
    schedule_delete: params.scheduleDelete,
    schedule_approve: params.scheduleApprove,
    allow_export: params.allowExport,
    activity_view: params.activityView,
    allow_supabase: params.allowSupabase,
    note: params.note.slice(0, 300),
    granted_by: normalizeEmail(params.grantedBy),
    updated_at: now,
  };

  if (params.isEdit && params.expectedVersion !== undefined) {
    const { data, error } = await client
      .from('user_access')
      .update({
        ...payload,
        version: params.expectedVersion + 1,
      })
      .eq('id', id)
      .eq('version', params.expectedVersion)
      .select()
      .maybeSingle();

    if (error) return { status: 'error', error: error.message };
    if (!data) {
      const latest = await client
        .from('user_access')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      return {
        status: 'conflict',
        serverRecord: latest.data
          ? mapAccessRow(latest.data as Record<string, unknown>)
          : null,
      };
    }
    return {
      status: 'ok',
      data: mapAccessRow(data as Record<string, unknown>),
    };
  }

  const { data, error } = await client
    .from('user_access')
    .upsert(
      {
        id,
        ...payload,
        version: 1,
        created_at: now,
      },
      { onConflict: 'email' }
    )
    .select()
    .single();

  if (error || !data) {
    return {
      status: 'error',
      error: error?.message || 'Không thể lưu phân quyền trên Supabase.',
    };
  }
  return {
    status: 'ok',
    data: mapAccessRow(data as Record<string, unknown>),
  };
}

export async function deleteUserAccessInSupabase(
  client: SupabaseClient,
  id: string
): Promise<{ error?: string }> {
  const { error } = await client.from('user_access').delete().eq('id', id);
  if (error) return { error: error.message };
  return {};
}

export async function appendActivityLog(
  client: SupabaseClient,
  params: {
    actorId: string;
    actorEmail: string;
    actorName: string;
    actorRole: UserRole;
    module: ActivityModule;
    action: ActivityAction;
    targetId: string;
    summary: string;
    changes?: Record<string, unknown>;
  }
): Promise<ActivityLog | null> {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const row = {
    id,
    actor_id: params.actorId,
    actor_email: normalizeEmail(params.actorEmail),
    actor_name: params.actorName.slice(0, 120),
    actor_role: params.actorRole,
    module: params.module,
    action: params.action,
    target_id: params.targetId,
    summary: params.summary.slice(0, 300),
    changes: params.changes || {},
    created_at: new Date().toISOString(),
  };

  const { data, error } = await client
    .from('activity_logs')
    .insert(row)
    .select()
    .maybeSingle();

  if (error) {
    console.warn('Activity log insert warning:', error.message);
    return null;
  }
  return data ? mapActivityRow(data as Record<string, unknown>) : null;
}

// ============================================================================
// Realtime Subscription Manager (Deduplicated single channel + Broadcast)
// ============================================================================
export interface RealtimeHandlers {
  onBarcodeChange: (
    eventType: 'INSERT' | 'UPDATE' | 'DELETE',
    newRow: BarcodeScan | null,
    oldId: string | null
  ) => void;
  onScheduleChange: (
    eventType: 'INSERT' | 'UPDATE' | 'DELETE',
    newRow: WorkSchedule | null,
    oldId: string | null
  ) => void;
  onAccessChange: (
    eventType: 'INSERT' | 'UPDATE' | 'DELETE',
    newRow: AuthorizedEmail | null,
    oldId: string | null
  ) => void;
  onActivityInsert: (row: ActivityLog) => void;
  onBroadcastEvent?: (payload: {
    event: string;
    senderEmail?: string;
    message?: string;
  }) => void;
  onChannelStatus: (
    status: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'
  ) => void;
}

export interface RealtimeSubscriptionHandle {
  broadcast: (event: string, payload: Record<string, unknown>) => void;
  unsubscribe: () => Promise<void>;
}

export function createRealtimeSyncSession(
  client: SupabaseClient,
  handlers: RealtimeHandlers
): RealtimeSubscriptionHandle {
  // Single Postgres Changes channel for all 4 operational tables
  const dbChannel: RealtimeChannel = client
    .channel('tpcn-db-realtime-sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'barcode_scans' },
      (payload) => {
        const type = payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE';
        const newRow =
          payload.new && Object.keys(payload.new).length > 0
            ? mapBarcodeRow(payload.new as Record<string, unknown>)
            : null;
        const oldId =
          payload.old && 'id' in payload.old
            ? String((payload.old as Record<string, unknown>).id || '')
            : null;
        handlers.onBarcodeChange(type, newRow, oldId);
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'work_schedules' },
      (payload) => {
        const type = payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE';
        const newRow =
          payload.new && Object.keys(payload.new).length > 0
            ? mapScheduleRow(payload.new as Record<string, unknown>)
            : null;
        const oldId =
          payload.old && 'id' in payload.old
            ? String((payload.old as Record<string, unknown>).id || '')
            : null;
        handlers.onScheduleChange(type, newRow, oldId);
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'user_access' },
      (payload) => {
        const type = payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE';
        const newRow =
          payload.new && Object.keys(payload.new).length > 0
            ? mapAccessRow(payload.new as Record<string, unknown>)
            : null;
        const oldId =
          payload.old && 'id' in payload.old
            ? String((payload.old as Record<string, unknown>).id || '')
            : null;
        handlers.onAccessChange(type, newRow, oldId);
      }
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'activity_logs' },
      (payload) => {
        if (payload.new && Object.keys(payload.new).length > 0) {
          handlers.onActivityInsert(
            mapActivityRow(payload.new as Record<string, unknown>)
          );
        }
      }
    )
    .subscribe((status) => {
      if (
        status === 'SUBSCRIBED' ||
        status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT' ||
        status === 'CLOSED'
      ) {
        handlers.onChannelStatus(status);
      }
    });

  // Broadcast channel for instant team coordination alerts (e.g. RBAC changes / force sync)
  const broadcastChannel: RealtimeChannel = client
    .channel('tpcn-collab-broadcast', {
      config: { broadcast: { self: false, ack: false } },
    })
    .on('broadcast', { event: 'sync-signal' }, ({ payload }) => {
      if (handlers.onBroadcastEvent && payload) {
        handlers.onBroadcastEvent(
          payload as { event: string; senderEmail?: string; message?: string }
        );
      }
    })
    .subscribe();

  return {
    broadcast: (event: string, payload: Record<string, unknown>) => {
      void broadcastChannel.send({
        type: 'broadcast',
        event: 'sync-signal',
        payload: { event, ...payload },
      });
    },
    unsubscribe: async () => {
      await Promise.all([
        client.removeChannel(dbChannel),
        client.removeChannel(broadcastChannel),
      ]);
    },
  };
}

// ============================================================================
// Migration Helpers (Zero Data Loss from existing Firestore records)
// ============================================================================
export async function pushBarcodeScansToSupabase(
  config: SupabaseConfig,
  scans: BarcodeScan[]
): Promise<{ syncedIds: string[]; error?: string }> {
  if (scans.length === 0) return { syncedIds: [] };
  const client = getSupabaseClient(config);
  if (!client) return { syncedIds: [], error: 'Cấu hình Supabase chưa hợp lệ.' };

  const rows = scans.map((s) => ({
    id: s.id,
    owner_id: s.ownerId,
    owner_email: normalizeEmail(s.ownerEmail),
    code: s.code,
    format: s.format,
    session_name: s.sessionName,
    quantity: s.quantity,
    note: s.note || '',
    version: s.version || 1,
    updated_by: normalizeEmail(s.updatedBy || s.ownerEmail),
    scanned_at: s.scannedAt || new Date().toISOString(),
    updated_at: s.updatedAt || new Date().toISOString(),
  }));

  const { error } = await client
    .from('barcode_scans')
    .upsert(rows, { onConflict: 'id' });
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
  const client = getSupabaseClient(config);
  if (!client) return { syncedIds: [], error: 'Cấu hình Supabase chưa hợp lệ.' };

  const rows = schedules.map((w) => ({
    id: w.id,
    owner_id: w.ownerId,
    owner_email: normalizeEmail(w.ownerEmail),
    employee_name: w.employeeName,
    title: w.title,
    work_date: w.workDate,
    shift_type: w.shiftType,
    start_time: w.startTime,
    end_time: w.endTime,
    location: w.location || '',
    status: w.status,
    note: w.note || '',
    approved_by: w.approvedBy || '',
    approved_at: w.approvedAt || null,
    version: w.version || 1,
    updated_by: normalizeEmail(w.updatedBy || w.ownerEmail),
    created_at: w.createdAt || new Date().toISOString(),
    updated_at: w.updatedAt || new Date().toISOString(),
  }));

  const { error } = await client
    .from('work_schedules')
    .upsert(rows, { onConflict: 'id' });
  if (error) {
    return { syncedIds: [], error: error.message };
  }
  return { syncedIds: schedules.map((w) => w.id) };
}
