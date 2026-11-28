import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useRef } from 'react';
import { appCache } from './cache';
import { extractShortStaffName, normalizeEmail } from './permissions';
import {
  formatSupabaseReadError,
  formatSupabaseWriteError,
  isStatementTimeoutError,
  requireAuthenticatedSession,
} from './supabase';
import type {
  AttendanceNoteEntry,
  AttendanceRecord,
  CustomerFeedback,
  ExpiryTrackingItem,
  LeaveRulesConfig,
  ProductCatalogItem,
  PromotionItem,
  ReturnRecordItem,
  ShiftDefinition,
  StorageFileEntry,
  SupplierPolicyItem,
  UserProfileRecord,
} from '../types';

export const STORAGE_BUCKET = 'internal-media';

// ============================================================================
// Client Operation Telemetry Counter (Honest client-side op count, NOT Supabase server quota)
// ============================================================================
let clientDbOpsCount = 0;
const opsListeners = new Set<(count: number) => void>();

export function recordClientDbOp(delta = 1) {
  clientDbOpsCount += delta;
  opsListeners.forEach((fn) => fn(clientDbOpsCount));
}

export function getClientDbOpsCount(): number {
  return clientDbOpsCount;
}

export function subscribeClientDbOps(fn: (count: number) => void): () => void {
  opsListeners.add(fn);
  return () => opsListeners.delete(fn);
}

async function runPagedQueryWithTimeoutFallback<Row extends Record<string, unknown>>(
  buildQuery: (
    countMode: 'exact' | 'estimated' | undefined
  ) => PromiseLike<{
    data: unknown[] | null;
    count: number | null;
    error: { message?: string } | null;
  }>,
  page: number,
  pageSize: number,
  contextLabel: string
): Promise<{ rows: Row[]; total: number; error?: string }> {
  const from = (page - 1) * pageSize;
  let { data, count, error } = await buildQuery('exact');

  if (error && isStatementTimeoutError(error.message)) {
    recordClientDbOp();
    const est = await buildQuery('estimated');
    data = est.data;
    count = est.count;
    error = est.error;

    if (error && isStatementTimeoutError(error.message)) {
      recordClientDbOp();
      const plain = await buildQuery(undefined);
      data = plain.data;
      error = plain.error;
      if (!error) {
        const list = (data || []) as Row[];
        return {
          rows: list,
          total: list.length < pageSize ? from + list.length : from + list.length + pageSize,
        };
      }
    }
  }

  if (error) {
    return {
      rows: [],
      total: 0,
      error: formatSupabaseReadError(error.message, contextLabel),
    };
  }

  return {
    rows: (data || []) as Row[],
    total: count ?? 0,
  };
}

async function fetchAllRowsInChunks<Row extends Record<string, unknown>>(
  fetchRange: (
    from: number,
    to: number
  ) => PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>,
  maxRows = 5000,
  initialChunkSize = 1000
): Promise<{ rows: Row[]; error?: { message?: string } | null }> {
  const collected: Row[] = [];
  let chunkSize = initialChunkSize;
  let offset = 0;

  while (offset < maxRows) {
    const end = Math.min(maxRows - 1, offset + chunkSize - 1);
    const { data, error } = await fetchRange(offset, end);
    if (error) {
      if (isStatementTimeoutError(error.message) && chunkSize > 250) {
        chunkSize = 250;
        recordClientDbOp();
        continue;
      }
      return { rows: collected, error };
    }
    const batch = (data || []) as Row[];
    collected.push(...batch);
    if (batch.length < end - offset + 1) {
      break;
    }
    offset += batch.length;
    recordClientDbOp();
  }

  return { rows: collected, error: null };
}

async function runCountHeadWithFallback(
  buildHeadQuery: (
    countMode: 'exact' | 'estimated'
  ) => PromiseLike<{ count: number | null; error: { message?: string } | null }>
): Promise<number> {
  const res = await buildHeadQuery('exact');
  if (!res.error) return res.count ?? 0;
  if (isStatementTimeoutError(res.error.message)) {
    const est = await buildHeadQuery('estimated');
    if (!est.error) return est.count ?? 0;
  }
  return 0;
}

// ============================================================================
// Scoped Realtime Cache Invalidation + Hook (Debounced + Tab-Visibility Aware)
// ============================================================================
export function invalidateCacheForTable(table: string): void {
  switch (table) {
    case 'product_catalog':
      appCache.invalidatePrefix('catalog:');
      appCache.invalidatePrefix('overview:');
      break;
    case 'supplier_policies':
      appCache.invalidatePrefix('policies:');
      break;
    case 'shift_definitions':
      appCache.invalidatePrefix('shifts:');
      break;
    case 'system_settings':
      appCache.invalidatePrefix('settings:');
      break;
    case 'user_profiles':
      appCache.invalidatePrefix('profiles:');
      break;
    case 'work_schedules':
    case 'attendance_logs':
    case 'customer_feedbacks':
    case 'expiry_tracking':
    case 'return_records':
    case 'promotions':
      appCache.invalidatePrefix('overview:');
      break;
    default:
      break;
  }
}

export function useScopedRealtime(
  client: SupabaseClient | null,
  enabled: boolean,
  tables: string[],
  onChange: () => void,
  debounceMs = 450
) {
  const tablesKey = tables.join(',');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!client || !enabled || tables.length === 0) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingWhileHidden = false;

    const triggerRefresh = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        pendingWhileHidden = true;
        return;
      }
      pendingWhileHidden = false;
      onChangeRef.current();
    };

    const scheduleRefresh = (table: string) => {
      invalidateCacheForTable(table);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        triggerRefresh();
      }, debounceMs);
    };

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && pendingWhileHidden) {
        if (timer) clearTimeout(timer);
        timer = null;
        triggerRefresh();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    const channelName = `scoped-${tablesKey}-${Math.random().toString(36).slice(2, 7)}`;
    let channel: RealtimeChannel = client.channel(channelName);
    for (const table of tables) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        () => {
          scheduleRefresh(table);
        }
      );
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      void client.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, tablesKey, debounceMs]);
}

// ============================================================================
// Reference Settings & Shift Definitions (Cached with targeted invalidation)
// ============================================================================
export const DEFAULT_LEAVE_RULES: LeaveRulesConfig = {
  maxDoPerWeek: 2,
  weekdayMaxDo: 2,
  weekendMaxDo: 1,
  requireAdminOverride: true,
};

export async function fetchLeaveRules(client: SupabaseClient): Promise<LeaveRulesConfig> {
  const cached = appCache.get<LeaveRulesConfig>('settings:leave_rules');
  if (cached) return cached;

  recordClientDbOp();
  const { data, error } = await client
    .from('system_settings')
    .select('key,value')
    .eq('key', 'leave_rules')
    .maybeSingle();

  if (error || !data) return DEFAULT_LEAVE_RULES;
  const raw = (data.value || {}) as Record<string, unknown>;
  const parsed: LeaveRulesConfig = {
    maxDoPerWeek: Number(raw.max_do_per_week ?? 2),
    weekdayMaxDo: Number(raw.weekday_max_do ?? 2),
    weekendMaxDo: Number(raw.weekend_max_do ?? 1),
    requireAdminOverride: Boolean(raw.require_admin_override ?? true),
  };
  appCache.set('settings:leave_rules', parsed, 180_000);
  return parsed;
}

export async function saveLeaveRules(
  client: SupabaseClient,
  rules: LeaveRulesConfig,
  actorEmail: string
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const { error } = await client.from('system_settings').upsert(
    {
      key: 'leave_rules',
      value: {
        max_do_per_week: rules.maxDoPerWeek,
        weekday_max_do: rules.weekdayMaxDo,
        weekend_max_do: rules.weekendMaxDo,
        require_admin_override: rules.requireAdminOverride,
      },
      updated_by: authCheck.email || normalizeEmail(actorEmail),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'system_settings',
        'Không thể lưu cấu hình ngày nghỉ DO.'
      ),
    };
  }
  appCache.invalidatePrefix('settings:');
  return {};
}

export async function fetchShiftDefinitions(
  client: SupabaseClient
): Promise<ShiftDefinition[]> {
  const cached = appCache.get<ShiftDefinition[]>('shifts:all');
  if (cached) return cached;

  recordClientDbOp();
  const { data, error } = await client
    .from('shift_definitions')
    .select('id,code,name,start_time,end_time,is_day_off,sort_order,active,created_at,updated_at')
    .order('sort_order', { ascending: true });

  if (error || !data) return [];
  const mapped: ShiftDefinition[] = data.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    startTime: String(r.start_time),
    endTime: String(r.end_time),
    isDayOff: Boolean(r.is_day_off),
    sortOrder: Number(r.sort_order ?? 1),
    active: Boolean(r.active ?? true),
    createdAt: r.created_at ? String(r.created_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  }));
  appCache.set('shifts:all', mapped, 180_000);
  return mapped;
}

export async function saveShiftDefinition(
  client: SupabaseClient,
  shift: {
    id?: string;
    code: string;
    name: string;
    startTime: string;
    endTime: string;
    isDayOff: boolean;
    sortOrder: number;
    active: boolean;
  }
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const id = shift.id || `shift-${shift.code.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const { error } = await client.from('shift_definitions').upsert(
    {
      id,
      code: shift.code.trim().toUpperCase(),
      name: shift.name.trim(),
      start_time: shift.isDayOff ? '00:00' : shift.startTime,
      end_time: shift.isDayOff ? '00:00' : shift.endTime,
      is_day_off: shift.isDayOff,
      sort_order: shift.sortOrder,
      active: shift.active,
    },
    { onConflict: 'id' }
  );
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'shift_definitions',
        'Không thể lưu định nghĩa ca làm.'
      ),
    };
  }
  appCache.invalidatePrefix('shifts:');
  return {};
}

export async function deleteShiftDefinition(
  client: SupabaseClient,
  id: string
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const { error } = await client.from('shift_definitions').delete().eq('id', id);
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'shift_definitions',
        'Không thể xóa định nghĩa ca làm.'
      ),
    };
  }
  appCache.invalidatePrefix('shifts:');
  return {};
}

// ============================================================================
// Overview Lightweight Queries (Counts & Today Targeted Rows Only)
// ============================================================================
export interface OverviewSummary {
  todayDate: string;
  myTodaySchedules: Array<{ id: string; title: string; startTime: string; endTime: string; isDayOff: boolean; status: string }>;
  myTodayAttendance: { id: string; shiftName: string; checkInAt: string; status: string } | null;
  myTodayFeedbackCount: number;
  teamTodayFeedbackCount: number;
  expiringSoonCount: number;
  processingReturnsCount: number;
  activePromosCount: number;
}

export async function fetchOverviewSummary(
  client: SupabaseClient,
  email: string,
  forceRefresh = false
): Promise<OverviewSummary> {
  const cleanEmail = normalizeEmail(email);
  const cacheKey = `overview:${cleanEmail}`;
  if (!forceRefresh) {
    const cached = appCache.get<OverviewSummary>(cacheKey);
    if (cached) return cached;
  }

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate()
  ).padStart(2, '0')}`;
  const in30Days = new Date(today);
  in30Days.setDate(in30Days.getDate() + 30);
  const thresholdStr = `${in30Days.getFullYear()}-${String(in30Days.getMonth() + 1).padStart(2, '0')}-${String(
    in30Days.getDate()
  ).padStart(2, '0')}`;

  recordClientDbOp(7);
  const [schedRes, attRes, myFbCount, teamFbCount, expCount, retCount, promoCount] =
    await Promise.all([
      client
        .from('work_schedules')
        .select('id,title,start_time,end_time,is_day_off,status')
        .eq('work_date', todayStr)
        .ilike('owner_email', cleanEmail)
        .neq('status', 'cancelled')
        .limit(50),
      client
        .from('attendance_logs')
        .select('id,shift_name,check_in_at,status')
        .eq('work_date', todayStr)
        .ilike('owner_email', cleanEmail)
        .order('check_in_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      runCountHeadWithFallback((countMode) =>
        client
          .from('customer_feedbacks')
          .select('id', { count: countMode, head: true })
          .eq('feedback_date', todayStr)
          .ilike('owner_email', cleanEmail)
      ),
      runCountHeadWithFallback((countMode) =>
        client
          .from('customer_feedbacks')
          .select('id', { count: countMode, head: true })
          .eq('feedback_date', todayStr)
      ),
      runCountHeadWithFallback((countMode) =>
        client
          .from('expiry_tracking')
          .select('id', { count: countMode, head: true })
          .lte('exp_date', thresholdStr)
      ),
      runCountHeadWithFallback((countMode) =>
        client
          .from('return_records')
          .select('id', { count: countMode, head: true })
          .eq('progress', 'processing')
      ),
      runCountHeadWithFallback((countMode) =>
        client
          .from('promotions')
          .select('id', { count: countMode, head: true })
          .eq('status', 'active')
      ),
    ]);

  const summary: OverviewSummary = {
    todayDate: todayStr,
    myTodaySchedules: (schedRes.data || []).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      startTime: String(r.start_time),
      endTime: String(r.end_time),
      isDayOff: Boolean(r.is_day_off),
      status: String(r.status),
    })),
    myTodayAttendance: attRes.data
      ? {
          id: String(attRes.data.id),
          shiftName: String(attRes.data.shift_name),
          checkInAt: String(attRes.data.check_in_at),
          status: String(attRes.data.status),
        }
      : null,
    myTodayFeedbackCount: myFbCount,
    teamTodayFeedbackCount: teamFbCount,
    expiringSoonCount: expCount,
    processingReturnsCount: retCount,
    activePromosCount: promoCount,
  };
  appCache.set(cacheKey, summary, 20_000);
  return summary;
}

// ============================================================================
// Staff Profiles (Nhân sự)
// ============================================================================
export async function fetchUserProfiles(
  client: SupabaseClient,
  forceRefresh = false
): Promise<UserProfileRecord[]> {
  if (!forceRefresh) {
    const cached = appCache.get<UserProfileRecord[]>('profiles:all');
    if (cached) return cached;
  }

  recordClientDbOp();
  const { data, error } = await client
    .from('user_profiles')
    .select('id,email,display_name,avatar_url,avatar_path,birth_date,gender,phone,updated_at')
    .order('display_name', { ascending: true })
    .limit(500);

  if (error || !data) return [];
  const mapped = data.map((r) => ({
    id: String(r.id),
    email: normalizeEmail(String(r.email || '')),
    displayName: String(r.display_name || ''),
    avatarUrl: String(r.avatar_url || ''),
    avatarPath: String(r.avatar_path || ''),
    birthDate: String(r.birth_date || ''),
    gender: String(r.gender || ''),
    phone: String(r.phone || ''),
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  }));
  appCache.set('profiles:all', mapped, 60_000);
  return mapped;
}

export interface AuthorizedStaffOption {
  email: string;
  displayName: string;
  shortName: string;
  role?: string;
}

export async function fetchAuthorizedStaffOptions(
  client: SupabaseClient,
  fallbackMembers: Array<{ email: string; displayName: string; active: boolean; role?: string }> = []
): Promise<AuthorizedStaffOption[]> {
  const cached = appCache.get<AuthorizedStaffOption[]>('staff:short_options');
  if (cached && cached.length > 0) return cached;

  const byEmail = new Map<string, AuthorizedStaffOption>();
  const register = (emailRaw: string, nameRaw: string, role?: string) => {
    const email = normalizeEmail(emailRaw);
    const displayName = String(nameRaw || '').trim();
    const shortName = extractShortStaffName(displayName, email);
    if (!shortName) return;
    const key = email || shortName.toLowerCase();
    const prev = byEmail.get(key);
    if (!prev || (!prev.displayName && displayName)) {
      byEmail.set(key, {
        email,
        displayName: displayName || shortName,
        shortName,
        role,
      });
    }
  };

  try {
    recordClientDbOp();
    const { data, error } = await client.rpc('get_authorized_staff_directory');
    if (!error && Array.isArray(data) && data.length > 0) {
      for (const row of data as Array<Record<string, unknown>>) {
        register(
          String(row.email || ''),
          String(row.display_name || ''),
          String(row.role || '')
        );
      }
    }
  } catch {
    // RPC 007 not yet applied — fall back seamlessly to user_profiles + fallbackMembers
  }

  if (byEmail.size === 0) {
    const profiles = await fetchUserProfiles(client);
    for (const p of profiles) {
      register(p.email, p.displayName);
    }
  }

  for (const m of fallbackMembers) {
    if (m.active) {
      register(m.email, m.displayName, m.role);
    }
  }

  const list = Array.from(byEmail.values()).sort((a, b) =>
    a.shortName.localeCompare(b.shortName, 'vi')
  );
  if (list.length > 0) {
    appCache.set('staff:short_options', list, 60_000);
  }
  return list;
}

export async function updateMyProfileDetails(
  client: SupabaseClient,
  _uid: string,
  email: string,
  updates: {
    displayName: string;
    birthDate: string;
    gender: string;
    phone: string;
    avatarPath?: string;
    avatarUrl?: string;
  }
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  const actorEmail = authCheck.email || normalizeEmail(email);
  recordClientDbOp();
  const payload: Record<string, unknown> = {
    id: authCheck.userId,
    email: actorEmail,
    display_name: updates.displayName.trim().slice(0, 120),
    birth_date: updates.birthDate.trim(),
    gender: updates.gender.trim(),
    phone: updates.phone.trim().slice(0, 30),
    updated_at: new Date().toISOString(),
  };
  if (updates.avatarPath !== undefined) payload.avatar_path = updates.avatarPath;
  if (updates.avatarUrl !== undefined) payload.avatar_url = updates.avatarUrl;

  const { error } = await client.from('user_profiles').upsert(payload, { onConflict: 'id' });
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'user_profiles',
        'Không thể cập nhật hồ sơ cá nhân.'
      ),
    };
  }
  appCache.invalidatePrefix('profiles:');
  return {};
}

// ============================================================================
// Attendance (Chấm công)
// ============================================================================
function mapAttendance(r: Record<string, unknown>): AttendanceRecord {
  const rawNotes = Array.isArray(r.notes_history) ? r.notes_history : [];
  return {
    id: String(r.id),
    scheduleId: r.schedule_id ? String(r.schedule_id) : null,
    ownerId: String(r.owner_id || ''),
    ownerEmail: normalizeEmail(String(r.owner_email || '')),
    employeeName: String(r.employee_name || ''),
    shiftName: String(r.shift_name || ''),
    workDate: String(r.work_date || ''),
    checkInAt: String(r.check_in_at || ''),
    checkOutAt: r.check_out_at ? String(r.check_out_at) : null,
    isUnscheduled: Boolean(r.is_unscheduled),
    status: (String(r.status || 'checked_in') as AttendanceRecord['status']) || 'checked_in',
    notesHistory: rawNotes.map((item) => {
      const obj = (item || {}) as Record<string, unknown>;
      return {
        id: String(obj.id || ''),
        type: (String(obj.type || 'note') as AttendanceNoteEntry['type']) || 'note',
        content: String(obj.content || ''),
        createdAt: String(obj.createdAt || ''),
        createdBy: String(obj.createdBy || ''),
      };
    }),
    createdAt: r.created_at ? String(r.created_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

export async function fetchAttendancePage(
  client: SupabaseClient,
  params: {
    page: number;
    pageSize: number;
    search: string;
    datePrefix: string; // YYYY-MM-DD or YYYY-MM or YYYY or ''
  }
): Promise<{ rows: AttendanceRecord[]; total: number; error?: string }> {
  recordClientDbOp();
  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;
  const search = params.search.trim();

  const res = await runPagedQueryWithTimeoutFallback(
    (countMode) => {
      let q = client
        .from('attendance_logs')
        .select(
          'id,schedule_id,owner_id,owner_email,employee_name,shift_name,work_date,check_in_at,check_out_at,is_unscheduled,status,notes_history,created_at,updated_at',
          countMode ? { count: countMode } : undefined
        )
        .order('work_date', { ascending: false })
        .order('check_in_at', { ascending: false })
        .range(from, to);

      if (params.datePrefix) {
        q = q.like('work_date', `${params.datePrefix}%`);
      }
      if (search) {
        q = q.or(
          `employee_name.ilike.%${search}%,owner_email.ilike.%${search}%,shift_name.ilike.%${search}%`
        );
      }
      return q;
    },
    params.page,
    params.pageSize,
    'Chấm công'
  );

  if (res.error) return { rows: [], total: 0, error: res.error };
  return {
    rows: res.rows.map((r) => mapAttendance(r)),
    total: res.total,
  };
}

export async function createAttendanceCheckIn(
  client: SupabaseClient,
  params: {
    scheduleId: string | null;
    ownerId: string;
    ownerEmail: string;
    employeeName: string;
    shiftName: string;
    workDate: string;
    isUnscheduled: boolean;
    initialNote?: string;
    initialNoteType?: AttendanceNoteEntry['type'];
    initialStatus?: AttendanceRecord['status'];
  }
): Promise<{ data?: AttendanceRecord; error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  const actorEmail = authCheck.email || normalizeEmail(params.ownerEmail);
  recordClientDbOp();
  const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const nowIso = new Date().toISOString();
  const notes: AttendanceNoteEntry[] = params.initialNote?.trim()
    ? [
        {
          id: `note-${Date.now()}`,
          type: params.initialNoteType || 'note',
          content: params.initialNote.trim(),
          createdAt: nowIso,
          createdBy: actorEmail,
        },
      ]
    : [];

  const requestedStatus: AttendanceRecord['status'] = params.initialStatus || 'checked_in';
  let { data, error } = await client
    .from('attendance_logs')
    .insert({
      id,
      schedule_id: params.scheduleId,
      owner_id: authCheck.userId,
      owner_email: actorEmail,
      employee_name: params.employeeName.trim(),
      shift_name: params.shiftName.trim(),
      work_date: params.workDate,
      check_in_at: nowIso,
      is_unscheduled: params.isUnscheduled,
      status: requestedStatus,
      notes_history: notes,
    })
    .select(
      'id,schedule_id,owner_id,owner_email,employee_name,shift_name,work_date,check_in_at,check_out_at,is_unscheduled,status,notes_history,created_at,updated_at'
    )
    .single();

  if (
    error &&
    requestedStatus === 'clear_time' &&
    /status_check|violates check constraint/i.test(error.message)
  ) {
    const retry = await client
      .from('attendance_logs')
      .insert({
        id,
        schedule_id: params.scheduleId,
        owner_id: authCheck.userId,
        owner_email: actorEmail,
        employee_name: params.employeeName.trim(),
        shift_name: params.shiftName.trim(),
        work_date: params.workDate,
        check_in_at: nowIso,
        is_unscheduled: params.isUnscheduled,
        status: 'checked_in',
        notes_history: notes,
      })
      .select(
        'id,schedule_id,owner_id,owner_email,employee_name,shift_name,work_date,check_in_at,check_out_at,is_unscheduled,status,notes_history,created_at,updated_at'
      )
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error || !data) {
    return {
      error: formatSupabaseWriteError(
        error?.message,
        'attendance_logs',
        'Không thể chấm công.'
      ),
    };
  }
  return { data: mapAttendance(data as Record<string, unknown>) };
}

export async function appendAttendanceNoteOrCheckout(
  client: SupabaseClient,
  record: AttendanceRecord,
  params: {
    actorEmail: string;
    noteType: AttendanceNoteEntry['type'];
    noteContent: string;
    nextStatus?: AttendanceRecord['status'];
    markCheckout?: boolean;
    clearCheckout?: boolean;
  }
): Promise<{ data?: AttendanceRecord; error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  const actorEmail = authCheck.email || normalizeEmail(params.actorEmail);
  recordClientDbOp();
  const nextNotes: AttendanceNoteEntry[] = [...record.notesHistory];
  const nowIso = new Date().toISOString();
  if (params.noteContent.trim()) {
    nextNotes.push({
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      type: params.noteType,
      content: params.noteContent.trim(),
      createdAt: nowIso,
      createdBy: actorEmail,
    });
  }

  const updates: Record<string, unknown> = {
    notes_history: nextNotes,
  };
  if (params.nextStatus) updates.status = params.nextStatus;
  if (params.clearCheckout) {
    updates.check_out_at = null;
    if (!params.nextStatus) updates.status = 'clear_time';
  } else if (params.markCheckout) {
    updates.check_out_at = nowIso;
    if (!params.nextStatus) updates.status = 'checked_out';
  }

  let { data, error } = await client
    .from('attendance_logs')
    .update(updates)
    .eq('id', record.id)
    .select(
      'id,schedule_id,owner_id,owner_email,employee_name,shift_name,work_date,check_in_at,check_out_at,is_unscheduled,status,notes_history,created_at,updated_at'
    )
    .single();

  if (
    error &&
    updates.status === 'clear_time' &&
    /status_check|violates check constraint/i.test(error.message)
  ) {
    const fallbackUpdates = {
      ...updates,
      status: params.clearCheckout ? 'checked_in' : 'checked_out',
    };
    const retry = await client
      .from('attendance_logs')
      .update(fallbackUpdates)
      .eq('id', record.id)
      .select(
        'id,schedule_id,owner_id,owner_email,employee_name,shift_name,work_date,check_in_at,check_out_at,is_unscheduled,status,notes_history,created_at,updated_at'
      )
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error || !data) {
    return {
      error: formatSupabaseWriteError(
        error?.message,
        'attendance_logs',
        'Không thể cập nhật chấm công.'
      ),
    };
  }
  return { data: mapAttendance(data as Record<string, unknown>) };
}

export async function updateAttendanceRecord(
  client: SupabaseClient,
  record: AttendanceRecord,
  params: {
    actorEmail: string;
    employeeName: string;
    shiftName: string;
    workDate: string;
    checkInAt: string;
    checkOutAt: string | null;
    status: AttendanceRecord['status'];
    adjustmentNote?: string;
    noteType?: AttendanceNoteEntry['type'];
  }
): Promise<{ data?: AttendanceRecord; error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  const actorEmail = authCheck.email || normalizeEmail(params.actorEmail);
  recordClientDbOp();

  const nextNotes: AttendanceNoteEntry[] = [...record.notesHistory];
  if (params.adjustmentNote?.trim()) {
    nextNotes.push({
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      type: params.noteType || 'note',
      content: params.adjustmentNote.trim(),
      createdAt: new Date().toISOString(),
      createdBy: actorEmail,
    });
  }

  const updates: Record<string, unknown> = {
    employee_name: params.employeeName.trim() || record.employeeName,
    shift_name: params.shiftName.trim() || record.shiftName,
    work_date: params.workDate,
    check_in_at: params.checkInAt,
    check_out_at: params.checkOutAt,
    status: params.status,
    notes_history: nextNotes,
  };

  let { data, error } = await client
    .from('attendance_logs')
    .update(updates)
    .eq('id', record.id)
    .select(
      'id,schedule_id,owner_id,owner_email,employee_name,shift_name,work_date,check_in_at,check_out_at,is_unscheduled,status,notes_history,created_at,updated_at'
    )
    .single();

  if (
    error &&
    params.status === 'clear_time' &&
    /status_check|violates check constraint/i.test(error.message)
  ) {
    const retry = await client
      .from('attendance_logs')
      .update({
        ...updates,
        status: params.checkOutAt ? 'checked_out' : 'checked_in',
      })
      .eq('id', record.id)
      .select(
        'id,schedule_id,owner_id,owner_email,employee_name,shift_name,work_date,check_in_at,check_out_at,is_unscheduled,status,notes_history,created_at,updated_at'
      )
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error || !data) {
    return {
      error: formatSupabaseWriteError(
        error?.message,
        'attendance_logs',
        'Không thể điều chỉnh thông tin chấm công.'
      ),
    };
  }
  return { data: mapAttendance(data as Record<string, unknown>) };
}

export async function deleteAttendanceRecord(
  client: SupabaseClient,
  id: string
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const { error } = await client.from('attendance_logs').delete().eq('id', id);
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'attendance_logs',
        'Không thể xóa bản ghi chấm công.'
      ),
    };
  }
  return {};
}

// ============================================================================
// Customer Feedbacks (Ý kiến khách hàng)
// ============================================================================
function mapFeedback(r: Record<string, unknown>): CustomerFeedback {
  return {
    id: String(r.id),
    ownerId: String(r.owner_id || ''),
    ownerEmail: normalizeEmail(String(r.owner_email || '')),
    employeeName: String(r.employee_name || ''),
    feedbackDate: String(r.feedback_date || ''),
    category: r.category === 'product' ? 'product' : 'service',
    productName: String(r.product_name || ''),
    content: String(r.content || ''),
    imagePath: String(r.image_path || ''),
    imageThumbPath: String(r.image_thumb_path || ''),
    createdAt: String(r.created_at || ''),
  };
}

export async function fetchFeedbackPage(
  client: SupabaseClient,
  params: {
    page: number;
    pageSize: number;
    datePrefix: string; // YYYY-MM-DD or YYYY-MM or ''
    dateFrom?: string;
    dateTo?: string;
    ownerFilter?: string;
    categoryFilter?: 'ALL' | 'product' | 'service';
  }
): Promise<{ rows: CustomerFeedback[]; total: number; error?: string }> {
  recordClientDbOp();
  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;

  const res = await runPagedQueryWithTimeoutFallback(
    (countMode) => {
      let q = client
        .from('customer_feedbacks')
        .select(
          'id,owner_id,owner_email,employee_name,feedback_date,category,product_name,content,image_path,image_thumb_path,created_at',
          countMode ? { count: countMode } : undefined
        )
        .order('created_at', { ascending: true })
        .range(from, to);

      if (params.dateFrom && params.dateTo) {
        q = q.gte('feedback_date', params.dateFrom).lte('feedback_date', params.dateTo);
      } else if (params.datePrefix) {
        q = q.like('feedback_date', `${params.datePrefix}%`);
      }
      if (params.ownerFilter) {
        q = q.ilike('owner_email', params.ownerFilter);
      }
      if (params.categoryFilter && params.categoryFilter !== 'ALL') {
        q = q.eq('category', params.categoryFilter);
      }
      return q;
    },
    params.page,
    params.pageSize,
    'Ý kiến khách hàng'
  );

  if (res.error) return { rows: [], total: 0, error: res.error };
  return {
    rows: res.rows.map((r) => mapFeedback(r)),
    total: res.total,
  };
}

export async function fetchAllFeedbackForExport(
  client: SupabaseClient,
  params: {
    datePrefix: string;
    dateFrom?: string;
    dateTo?: string;
    ownerFilter?: string;
    categoryFilter?: 'ALL' | 'product' | 'service';
  }
): Promise<{ rows: CustomerFeedback[]; error?: string }> {
  recordClientDbOp();
  const res = await fetchAllRowsInChunks(
    (from, to) => {
      let q = client
        .from('customer_feedbacks')
        .select(
          'id,owner_id,owner_email,employee_name,feedback_date,category,product_name,content,image_path,image_thumb_path,created_at'
        )
        .order('created_at', { ascending: true })
        .range(from, to);

      if (params.dateFrom && params.dateTo) {
        q = q.gte('feedback_date', params.dateFrom).lte('feedback_date', params.dateTo);
      } else if (params.datePrefix) {
        q = q.like('feedback_date', `${params.datePrefix}%`);
      }
      if (params.ownerFilter) {
        q = q.ilike('owner_email', params.ownerFilter);
      }
      if (params.categoryFilter && params.categoryFilter !== 'ALL') {
        q = q.eq('category', params.categoryFilter);
      }
      return q;
    },
    5000,
    500
  );

  if (res.error) {
    return {
      rows: [],
      error: formatSupabaseReadError(res.error.message, 'xuất Excel ý kiến khách hàng'),
    };
  }
  return {
    rows: res.rows.map((r) => mapFeedback(r)),
  };
}

export async function createCustomerFeedback(
  client: SupabaseClient,
  params: {
    ownerId: string;
    ownerEmail: string;
    employeeName: string;
    category: 'product' | 'service';
    productName: string;
    content: string;
    imagePath: string;
    imageThumbPath: string;
  }
): Promise<{ data?: CustomerFeedback; error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  const actorEmail = authCheck.email || normalizeEmail(params.ownerEmail);
  recordClientDbOp();
  const id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { data, error } = await client
    .from('customer_feedbacks')
    .insert({
      id,
      owner_id: authCheck.userId,
      owner_email: actorEmail,
      employee_name: params.employeeName.trim(),
      category: params.category,
      product_name: params.productName.trim(),
      content: params.content.trim(),
      image_path: params.imagePath,
      image_thumb_path: params.imageThumbPath,
    })
    .select(
      'id,owner_id,owner_email,employee_name,feedback_date,category,product_name,content,image_path,image_thumb_path,created_at'
    )
    .single();

  if (error || !data) {
    return {
      error: formatSupabaseWriteError(
        error?.message,
        'customer_feedbacks',
        'Không thể lưu ý kiến khách hàng.'
      ),
    };
  }
  return { data: mapFeedback(data as Record<string, unknown>) };
}

export async function deleteCustomerFeedback(
  client: SupabaseClient,
  id: string
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const { error } = await client.from('customer_feedbacks').delete().eq('id', id);
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'customer_feedbacks',
        'Không thể xóa ý kiến khách hàng.'
      ),
    };
  }
  return {};
}

// ============================================================================
// Warehouse Catalog & Supplier Policies (Kho dữ liệu)
// ============================================================================
function mapCatalog(r: Record<string, unknown>): ProductCatalogItem {
  return {
    id: String(r.id),
    productCode: String(r.product_code),
    barcode: String(r.barcode || ''),
    name: String(r.name),
    unit: String(r.unit || ''),
    price: Number(r.price || 0),
    supplierName: String(r.supplier_name || ''),
    updatedBy: String(r.updated_by || ''),
    createdAt: r.created_at ? String(r.created_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

export async function fetchCatalogPage(
  client: SupabaseClient,
  params: { page: number; pageSize: number; search: string }
): Promise<{ rows: ProductCatalogItem[]; total: number; error?: string }> {
  recordClientDbOp();
  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;
  const search = params.search.trim();

  const res = await runPagedQueryWithTimeoutFallback(
    (countMode) => {
      let q = client
        .from('product_catalog')
        .select(
          'id,product_code,barcode,name,unit,price,supplier_name,updated_by,created_at,updated_at',
          countMode ? { count: countMode } : undefined
        )
        .order('product_code', { ascending: true })
        .range(from, to);

      if (search) {
        q = q.or(
          `product_code.ilike.%${search}%,barcode.ilike.%${search}%,name.ilike.%${search}%,supplier_name.ilike.%${search}%`
        );
      }
      return q;
    },
    params.page,
    params.pageSize,
    'Danh mục hàng'
  );

  if (res.error) return { rows: [], total: 0, error: res.error };
  return {
    rows: res.rows.map((r) => mapCatalog(r)),
    total: res.total,
  };
}

export async function fetchAllCatalogForCache(
  client: SupabaseClient
): Promise<ProductCatalogItem[]> {
  const cached = appCache.get<ProductCatalogItem[]>('catalog:all');
  if (cached) return cached;

  recordClientDbOp();
  const res = await fetchAllRowsInChunks(
    (from, to) =>
      client
        .from('product_catalog')
        .select('id,product_code,barcode,name,unit,price,supplier_name,updated_by,created_at,updated_at')
        .order('product_code', { ascending: true })
        .range(from, to),
    5000,
    1000
  );

  if (res.error || res.rows.length === 0) return [];
  const mapped = res.rows.map((r) => mapCatalog(r));
  appCache.set('catalog:all', mapped, 180_000);
  return mapped;
}

export async function upsertCatalogItem(
  client: SupabaseClient,
  item: Omit<ProductCatalogItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const id = item.id || `cat-${item.productCode.trim().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const { error } = await client.from('product_catalog').upsert(
    {
      id,
      product_code: item.productCode.trim(),
      barcode: item.barcode.trim(),
      name: item.name.trim(),
      unit: item.unit.trim(),
      price: item.price,
      supplier_name: item.supplierName.trim(),
      updated_by: authCheck.email || normalizeEmail(item.updatedBy),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'product_code' }
  );
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'product_catalog',
        'Không thể lưu danh mục hàng hóa.'
      ),
    };
  }
  appCache.invalidatePrefix('catalog:');
  return {};
}

export async function batchDeleteCatalogWithCheck(
  client: SupabaseClient,
  items: ProductCatalogItem[]
): Promise<{ deleted: number; blockedCodes: string[]; error?: string }> {
  if (items.length === 0) return { deleted: 0, blockedCodes: [] };
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { deleted: 0, blockedCodes: [], error: authCheck.error };

  const codes = items.map((i) => i.productCode);

  const inUseSet = new Set<string>();
  for (let i = 0; i < codes.length; i += 100) {
    const codeChunk = codes.slice(i, i + 100);
    recordClientDbOp(2);
    const [expRef, promoRef] = await Promise.all([
      client.from('expiry_tracking').select('product_code').in('product_code', codeChunk),
      client.from('promotions').select('product_code').in('product_code', codeChunk),
    ]);
    for (const r of expRef.data || []) inUseSet.add(String(r.product_code));
    for (const r of promoRef.data || []) inUseSet.add(String(r.product_code));
  }

  const deletableIds = items
    .filter((i) => !inUseSet.has(i.productCode))
    .map((i) => i.id);
  const blockedCodes = items
    .filter((i) => inUseSet.has(i.productCode))
    .map((i) => i.productCode);

  if (deletableIds.length > 0) {
    for (let i = 0; i < deletableIds.length; i += 100) {
      const idChunk = deletableIds.slice(i, i + 100);
      recordClientDbOp();
      const { error } = await client.from('product_catalog').delete().in('id', idChunk);
      if (error) {
        return {
          deleted: 0,
          blockedCodes,
          error: formatSupabaseWriteError(
            error.message,
            'product_catalog',
            'Không thể xóa danh mục hàng.'
          ),
        };
      }
    }
    appCache.invalidatePrefix('catalog:');
  }
  return { deleted: deletableIds.length, blockedCodes };
}

function mapPolicy(r: Record<string, unknown>): SupplierPolicyItem {
  return {
    id: String(r.id),
    category: String(r.category || ''),
    supplierName: String(r.supplier_name || ''),
    supplierSystemName: String(r.supplier_system_name || ''),
    productName: String(r.product_name || ''),
    returnPolicy: String(r.return_policy || ''),
    warnMonthsBefore: Number(r.warn_months_before || 0),
    updatedBy: String(r.updated_by || ''),
    createdAt: r.created_at ? String(r.created_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

export async function fetchPoliciesPage(
  client: SupabaseClient,
  params: { page: number; pageSize: number; search: string }
): Promise<{ rows: SupplierPolicyItem[]; total: number; error?: string }> {
  recordClientDbOp();
  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;
  const search = params.search.trim();

  const res = await runPagedQueryWithTimeoutFallback(
    (countMode) => {
      let q = client
        .from('supplier_policies')
        .select(
          'id,category,supplier_name,supplier_system_name,product_name,return_policy,warn_months_before,updated_by,created_at,updated_at',
          countMode ? { count: countMode } : undefined
        )
        .order('supplier_system_name', { ascending: true })
        .range(from, to);

      if (search) {
        q = q.or(
          `supplier_system_name.ilike.%${search}%,supplier_name.ilike.%${search}%,product_name.ilike.%${search}%,category.ilike.%${search}%`
        );
      }
      return q;
    },
    params.page,
    params.pageSize,
    'Chính sách đổi trả NCC'
  );

  if (res.error) return { rows: [], total: 0, error: res.error };
  return {
    rows: res.rows.map((r) => mapPolicy(r)),
    total: res.total,
  };
}

export async function fetchAllPoliciesForCache(
  client: SupabaseClient
): Promise<SupplierPolicyItem[]> {
  const cached = appCache.get<SupplierPolicyItem[]>('policies:all');
  if (cached) return cached;

  recordClientDbOp();
  const res = await fetchAllRowsInChunks(
    (from, to) =>
      client
        .from('supplier_policies')
        .select(
          'id,category,supplier_name,supplier_system_name,product_name,return_policy,warn_months_before,updated_by,created_at,updated_at'
        )
        .order('supplier_system_name', { ascending: true })
        .range(from, to),
    5000,
    1000
  );

  if (res.error || res.rows.length === 0) return [];
  const mapped = res.rows.map((r) => mapPolicy(r));
  appCache.set('policies:all', mapped, 180_000);
  return mapped;
}

export async function upsertPolicyItem(
  client: SupabaseClient,
  item: Omit<SupplierPolicyItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const id =
    item.id ||
    `pol-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { error } = await client.from('supplier_policies').upsert(
    {
      id,
      category: item.category.trim(),
      supplier_name: item.supplierName.trim(),
      supplier_system_name: item.supplierSystemName.trim(),
      product_name: item.productName.trim(),
      return_policy: item.returnPolicy.trim(),
      warn_months_before: Math.max(0, Math.round(item.warnMonthsBefore || 0)),
      updated_by: authCheck.email || normalizeEmail(item.updatedBy),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'supplier_policies',
        'Không thể lưu chính sách đổi trả NCC.'
      ),
    };
  }
  appCache.invalidatePrefix('policies:');
  return {};
}

export async function deletePoliciesBatch(
  client: SupabaseClient,
  ids: string[]
): Promise<{ error?: string }> {
  if (ids.length === 0) return {};
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  for (let i = 0; i < ids.length; i += 100) {
    recordClientDbOp();
    const { error } = await client
      .from('supplier_policies')
      .delete()
      .in('id', ids.slice(i, i + 100));
    if (error) {
      return {
        error: formatSupabaseWriteError(
          error.message,
          'supplier_policies',
          'Không thể xóa chính sách đổi trả NCC.'
        ),
      };
    }
  }
  appCache.invalidatePrefix('policies:');
  return {};
}

export interface WarehouseUpdateEntry {
  id: string;
  source: 'catalog' | 'policy';
  codeOrSystem: string;
  title: string;
  detail: string;
  updatedBy: string;
  createdAt: string | null;
  updatedAt: string | null;
  isNew: boolean;
}

export async function fetchRecentWarehouseUpdates(
  client: SupabaseClient,
  limitPerTable = 15
): Promise<WarehouseUpdateEntry[]> {
  recordClientDbOp(2);
  const [catRes, polRes] = await Promise.all([
    client
      .from('product_catalog')
      .select('id,product_code,name,unit,price,supplier_name,updated_by,created_at,updated_at')
      .order('updated_at', { ascending: false })
      .limit(limitPerTable),
    client
      .from('supplier_policies')
      .select('id,category,supplier_name,supplier_system_name,product_name,return_policy,updated_by,created_at,updated_at')
      .order('updated_at', { ascending: false })
      .limit(limitPerTable),
  ]);

  const entries: WarehouseUpdateEntry[] = [];
  const checkIsNew = (createdAt: unknown, updatedAt: unknown): boolean => {
    const c = createdAt ? new Date(String(createdAt)).getTime() : 0;
    const u = updatedAt ? new Date(String(updatedAt)).getTime() : 0;
    if (!c || !u) return true;
    return Math.abs(u - c) <= 5000;
  };

  for (const r of (catRes.data || []) as Record<string, unknown>[]) {
    const price = Number(r.price || 0);
    entries.push({
      id: `cat_${String(r.id)}`,
      source: 'catalog',
      codeOrSystem: String(r.product_code || ''),
      title: String(r.name || ''),
      detail: `${r.unit ? `ĐVT: ${String(r.unit)} · ` : ''}Giá: ${price.toLocaleString('vi-VN')}đ${r.supplier_name ? ` · ${String(r.supplier_name)}` : ''}`,
      updatedBy: String(r.updated_by || ''),
      createdAt: r.created_at ? String(r.created_at) : null,
      updatedAt: r.updated_at ? String(r.updated_at) : null,
      isNew: checkIsNew(r.created_at, r.updated_at),
    });
  }

  for (const r of (polRes.data || []) as Record<string, unknown>[]) {
    entries.push({
      id: `pol_${String(r.id)}`,
      source: 'policy',
      codeOrSystem: String(r.supplier_system_name || ''),
      title: String(r.product_name || r.supplier_name || 'Chính sách đổi trả'),
      detail: `${r.category ? `[${String(r.category)}] ` : ''}${String(r.return_policy || 'Chưa ghi quy định')}`,
      updatedBy: String(r.updated_by || ''),
      createdAt: r.created_at ? String(r.created_at) : null,
      updatedAt: r.updated_at ? String(r.updated_at) : null,
      isNew: checkIsNew(r.created_at, r.updated_at),
    });
  }

  return entries
    .sort((a, b) => {
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    })
    .slice(0, 25);
}

// ============================================================================
// Expiry Tracking (Kiểm soát hạn sử dụng)
// ============================================================================
function mapExpiry(r: Record<string, unknown>): ExpiryTrackingItem {
  return {
    id: String(r.id),
    productCode: String(r.product_code),
    barcode: String(r.barcode || ''),
    productName: String(r.product_name || ''),
    unit: String(r.unit || ''),
    supplierSystemName: String(r.supplier_system_name || ''),
    returnPolicy: String(r.return_policy || ''),
    warnMonthsBefore: Number(r.warn_months_before || 0),
    mfgDate: String(r.mfg_date || ''),
    expDate: String(r.exp_date || ''),
    ptCode: String(r.pt_code || ''),
    note: String(r.note || ''),
    updatedBy: String(r.updated_by || ''),
    createdAt: r.created_at ? String(r.created_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

export async function fetchExpiryPage(
  client: SupabaseClient,
  params: {
    page: number;
    pageSize: number;
    search: string;
    ptFilter: string;
    supplierFilter: string;
  }
): Promise<{ rows: ExpiryTrackingItem[]; total: number; error?: string }> {
  recordClientDbOp();
  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;
  const ptFilter = params.ptFilter.trim();
  const supplierFilter = params.supplierFilter.trim();
  const search = params.search.trim();

  const res = await runPagedQueryWithTimeoutFallback(
    (countMode) => {
      let q = client
        .from('expiry_tracking')
        .select(
          'id,product_code,barcode,product_name,unit,supplier_system_name,return_policy,warn_months_before,mfg_date,exp_date,pt_code,note,updated_by,created_at,updated_at',
          countMode ? { count: countMode } : undefined
        )
        .order('exp_date', { ascending: true })
        .range(from, to);

      if (ptFilter) {
        q = q.ilike('pt_code', `%${ptFilter}%`);
      }
      if (supplierFilter) {
        q = q.ilike('supplier_system_name', `%${supplierFilter}%`);
      }
      if (search) {
        q = q.or(
          `product_code.ilike.%${search}%,barcode.ilike.%${search}%,product_name.ilike.%${search}%,supplier_system_name.ilike.%${search}%,pt_code.ilike.%${search}%`
        );
      }
      return q;
    },
    params.page,
    params.pageSize,
    'Kiểm soát HSD'
  );

  if (res.error) return { rows: [], total: 0, error: res.error };
  return {
    rows: res.rows.map((r) => mapExpiry(r)),
    total: res.total,
  };
}

export async function upsertExpiryItem(
  client: SupabaseClient,
  item: Omit<ExpiryTrackingItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const id = item.id || `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { error } = await client.from('expiry_tracking').upsert(
    {
      id,
      product_code: item.productCode.trim(),
      barcode: item.barcode.trim(),
      product_name: item.productName.trim(),
      unit: item.unit.trim(),
      supplier_system_name: item.supplierSystemName.trim(),
      return_policy: item.returnPolicy.trim(),
      warn_months_before: item.warnMonthsBefore || 0,
      mfg_date: item.mfgDate.trim(),
      exp_date: item.expDate.trim(),
      pt_code: item.ptCode.trim(),
      note: item.note.trim(),
      updated_by: authCheck.email || normalizeEmail(item.updatedBy),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'expiry_tracking',
        'Không thể lưu thông tin hạn sử dụng.'
      ),
    };
  }
  return {};
}

export async function deleteExpiryBatch(
  client: SupabaseClient,
  ids: string[]
): Promise<{ error?: string }> {
  if (ids.length === 0) return {};
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  for (let i = 0; i < ids.length; i += 100) {
    recordClientDbOp();
    const { error } = await client
      .from('expiry_tracking')
      .delete()
      .in('id', ids.slice(i, i + 100));
    if (error) {
      return {
        error: formatSupabaseWriteError(
          error.message,
          'expiry_tracking',
          'Không thể xóa bản ghi hạn sử dụng.'
        ),
      };
    }
  }
  return {};
}

// ============================================================================
// Goods Return Records (Đổi trả hàng hóa)
// ============================================================================
function mapReturnRecord(r: Record<string, unknown>): ReturnRecordItem {
  return {
    id: String(r.id),
    ptCode: String(r.pt_code || ''),
    supplierSystemName: String(r.supplier_system_name || ''),
    productSummary: String(r.product_summary || ''),
    returnMethod: String(r.return_method || ''),
    progress: r.progress === 'completed' ? 'completed' : 'processing',
    reportedDate: String(r.reported_date || ''),
    completedDate: String(r.completed_date || ''),
    lastUpdateNote: String(r.last_update_note || ''),
    updatedBy: String(r.updated_by || ''),
    createdAt: r.created_at ? String(r.created_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

export async function fetchReturnsPage(
  client: SupabaseClient,
  params: {
    page: number;
    pageSize: number;
    supplierFilter: string;
    itemFilter: string;
    methodFilter: string;
    ptFilter: string;
  }
): Promise<{ rows: ReturnRecordItem[]; total: number; error?: string }> {
  recordClientDbOp();
  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;
  const supplierFilter = params.supplierFilter.trim();
  const itemFilter = params.itemFilter.trim();
  const methodFilter = params.methodFilter.trim();
  const ptFilter = params.ptFilter.trim();

  const res = await runPagedQueryWithTimeoutFallback(
    (countMode) => {
      let q = client
        .from('return_records')
        .select(
          'id,pt_code,supplier_system_name,product_summary,return_method,progress,reported_date,completed_date,last_update_note,updated_by,created_at,updated_at',
          countMode ? { count: countMode } : undefined
        )
        .order('updated_at', { ascending: false })
        .range(from, to);

      if (supplierFilter) {
        q = q.ilike('supplier_system_name', `%${supplierFilter}%`);
      }
      if (itemFilter) {
        q = q.ilike('product_summary', `%${itemFilter}%`);
      }
      if (methodFilter) {
        q = q.ilike('return_method', `%${methodFilter}%`);
      }
      if (ptFilter) {
        q = q.ilike('pt_code', `%${ptFilter}%`);
      }
      return q;
    },
    params.page,
    params.pageSize,
    'Đổi trả hàng hóa'
  );

  if (res.error) return { rows: [], total: 0, error: res.error };
  return {
    rows: res.rows.map((r) => mapReturnRecord(r)),
    total: res.total,
  };
}

export async function upsertReturnRecord(
  client: SupabaseClient,
  item: Omit<ReturnRecordItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const id = item.id || `ret-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { error } = await client.from('return_records').upsert(
    {
      id,
      pt_code: item.ptCode.trim(),
      supplier_system_name: item.supplierSystemName.trim(),
      product_summary: item.productSummary.trim(),
      return_method: item.returnMethod.trim(),
      progress: item.progress,
      reported_date: item.reportedDate.trim(),
      completed_date: item.progress === 'completed' ? item.completedDate.trim() : '',
      last_update_note: item.lastUpdateNote.trim(),
      updated_by: authCheck.email || normalizeEmail(item.updatedBy),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'return_records',
        'Không thể lưu hồ sơ đổi trả hàng hóa.'
      ),
    };
  }
  return {};
}

export async function deleteReturnRecords(
  client: SupabaseClient,
  ids: string[]
): Promise<{ error?: string }> {
  if (ids.length === 0) return {};
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  for (let i = 0; i < ids.length; i += 100) {
    recordClientDbOp();
    const { error } = await client
      .from('return_records')
      .delete()
      .in('id', ids.slice(i, i + 100));
    if (error) {
      return {
        error: formatSupabaseWriteError(
          error.message,
          'return_records',
          'Không thể xóa hồ sơ đổi trả hàng hóa.'
        ),
      };
    }
  }
  return {};
}

// ============================================================================
// Promotions (Chương trình khuyến mãi)
// ============================================================================
function mapPromotion(r: Record<string, unknown>): PromotionItem {
  const regularPrice = Number(r.regular_price || 0);
  const discountRate = Number(r.discount_rate || 0);
  const computed = Math.round(regularPrice * (1 - discountRate / 100));
  return {
    id: String(r.id),
    productCode: String(r.product_code),
    barcode: String(r.barcode || ''),
    productName: String(r.product_name || ''),
    hasBBadge: Boolean(r.has_b_badge),
    unit: String(r.unit || ''),
    expDate: String(r.exp_date || ''),
    quantity: Number(r.quantity || 0),
    discountRate,
    regularPrice,
    promoPrice: r.promo_price !== undefined ? Number(r.promo_price) : computed,
    ptCode: String(r.pt_code || ''),
    status: (String(r.status || 'active') as PromotionItem['status']) || 'active',
    updatedBy: String(r.updated_by || ''),
    createdAt: r.created_at ? String(r.created_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

export async function fetchPromotionsPage(
  client: SupabaseClient,
  params: {
    page: number;
    pageSize: number;
    search: string;
    statusFilter: 'ALL' | 'active' | 'scheduled' | 'ended';
    onlyBBadge: 'ALL' | 'YES' | 'NO';
  }
): Promise<{ rows: PromotionItem[]; total: number; error?: string }> {
  recordClientDbOp();
  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;
  const search = params.search.trim();

  const res = await runPagedQueryWithTimeoutFallback(
    (countMode) => {
      let q = client
        .from('promotions')
        .select(
          'id,product_code,barcode,product_name,has_b_badge,unit,exp_date,quantity,discount_rate,regular_price,promo_price,pt_code,status,updated_by,created_at,updated_at',
          countMode ? { count: countMode } : undefined
        )
        .order('exp_date', { ascending: true })
        .range(from, to);

      if (params.statusFilter !== 'ALL') {
        q = q.eq('status', params.statusFilter);
      }
      if (params.onlyBBadge === 'YES') {
        q = q.eq('has_b_badge', true);
      } else if (params.onlyBBadge === 'NO') {
        q = q.eq('has_b_badge', false);
      }
      if (search) {
        q = q.or(
          `product_code.ilike.%${search}%,barcode.ilike.%${search}%,product_name.ilike.%${search}%,pt_code.ilike.%${search}%`
        );
      }
      return q;
    },
    params.page,
    params.pageSize,
    'Chương trình khuyến mãi'
  );

  if (res.error) return { rows: [], total: 0, error: res.error };
  return {
    rows: res.rows.map((r) => mapPromotion(r)),
    total: res.total,
  };
}

export async function upsertPromotionItem(
  client: SupabaseClient,
  item: Omit<PromotionItem, 'id' | 'promoPrice' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<{ error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const id = item.id || `promo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { error } = await client.from('promotions').upsert(
    {
      id,
      product_code: item.productCode.trim(),
      barcode: item.barcode.trim(),
      product_name: item.productName.trim(),
      has_b_badge: item.hasBBadge,
      unit: item.unit.trim(),
      exp_date: item.expDate.trim(),
      quantity: Math.max(0, Math.round(item.quantity)),
      discount_rate: Math.max(0, Math.min(100, Number(item.discountRate))),
      regular_price: Math.max(0, Number(item.regularPrice)),
      pt_code: item.ptCode.trim(),
      status: item.status,
      updated_by: authCheck.email || normalizeEmail(item.updatedBy),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'promotions',
        'Không thể lưu chương trình khuyến mãi.'
      ),
    };
  }
  return {};
}

export async function deletePromotionsBatch(
  client: SupabaseClient,
  ids: string[]
): Promise<{ error?: string }> {
  if (ids.length === 0) return {};
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  for (let i = 0; i < ids.length; i += 100) {
    recordClientDbOp();
    const { error } = await client
      .from('promotions')
      .delete()
      .in('id', ids.slice(i, i + 100));
    if (error) {
      return {
        error: formatSupabaseWriteError(
          error.message,
          'promotions',
          'Không thể xóa chương trình khuyến mãi.'
        ),
      };
    }
  }
  return {};
}

// ============================================================================
// Storage Manager & Compressed Media Upload (Metadata only, zero full-file fetch)
// ============================================================================
function classifyMimeCategory(name: string, mime: string): StorageFileEntry['category'] {
  const lower = `${name} ${mime}`.toLowerCase();
  if (lower.includes('image/') || /\.(webp|png|jpe?g|gif)$/.test(lower)) return 'image';
  if (lower.includes('pdf') || /\.pdf$/.test(lower)) return 'pdf';
  if (lower.includes('spreadsheet') || lower.includes('excel') || /\.(xlsx?|csv)$/.test(lower)) {
    return 'excel';
  }
  return 'other';
}

export async function uploadMediaPairToStorage(
  client: SupabaseClient,
  _uid: string,
  folder: 'avatars' | 'feedback',
  mainBlob: Blob,
  thumbBlob?: Blob
): Promise<{ path: string; thumbPath: string; error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { path: '', thumbPath: '', error: authCheck.error };

  const ownerFolder = authCheck.userId;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ext = mainBlob.type.includes('webp') ? 'webp' : 'jpg';
  const mainPath = `${ownerFolder}/${folder}/${stamp}.${ext}`;

  recordClientDbOp();
  const { error: mainErr } = await client.storage
    .from(STORAGE_BUCKET)
    .upload(mainPath, mainBlob, {
      contentType: mainBlob.type || 'image/webp',
      cacheControl: '31536000',
      upsert: false,
    });

  if (mainErr) {
    return {
      path: '',
      thumbPath: '',
      error: formatSupabaseWriteError(
        mainErr.message,
        'storage.objects',
        'Không thể tải tệp lên Storage.'
      ),
    };
  }

  let thumbPath = '';
  if (thumbBlob) {
    thumbPath = `${ownerFolder}/${folder}/${stamp}_thumb.${ext}`;
    recordClientDbOp();
    const { error: thumbErr } = await client.storage
      .from(STORAGE_BUCKET)
      .upload(thumbPath, thumbBlob, {
        contentType: thumbBlob.type || 'image/webp',
        cacheControl: '31536000',
        upsert: false,
      });
    if (thumbErr) {
      thumbPath = mainPath;
    }
  }

  return { path: mainPath, thumbPath };
}

export async function createSignedMediaUrl(
  client: SupabaseClient,
  path: string
): Promise<string | null> {
  if (!path) return null;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const cached = appCache.get<string>(`signed:${path}`);
  if (cached) return cached;

  recordClientDbOp();
  const { data, error } = await client.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(path, 3600);

  if (error || !data?.signedUrl) return null;
  appCache.set(`signed:${path}`, data.signedUrl, 45 * 60 * 1000);
  return data.signedUrl;
}

export async function listAllStorageObjectsRecursive(
  client: SupabaseClient,
  bucket = STORAGE_BUCKET
): Promise<{ files: StorageFileEntry[]; error?: string }> {
  const collected: StorageFileEntry[] = [];

  async function walk(prefix: string) {
    recordClientDbOp();
    const { data, error } = await client.storage.from(bucket).list(prefix, {
      limit: 200,
      sortBy: { column: 'created_at', order: 'desc' },
    });
    if (error) {
      throw new Error(error.message);
    }
    for (const item of data || []) {
      const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (!item.id) {
        // Folder entry
        await walk(fullPath);
      } else {
        const meta = (item.metadata || {}) as Record<string, unknown>;
        const mime = String(meta.mimetype || '');
        const sizeBytes = Number(meta.size || 0);
        collected.push({
          id: String(item.id),
          bucket,
          name: item.name,
          path: fullPath,
          sizeBytes,
          mimeType: mime,
          createdAt: item.created_at ? String(item.created_at) : null,
          updatedAt: item.updated_at ? String(item.updated_at) : null,
          ownerFolder: fullPath.split('/')[0] || '',
          category: classifyMimeCategory(item.name, mime),
        });
      }
    }
  }

  try {
    await walk('');
    return { files: collected };
  } catch (err) {
    return {
      files: [],
      error: err instanceof Error ? err.message : 'Không thể liệt kê tệp trong Storage.',
    };
  }
}

export async function getReferencedStoragePaths(
  client: SupabaseClient
): Promise<Set<string>> {
  recordClientDbOp(2);
  const [profilesRes, fbRes] = await Promise.all([
    client.from('user_profiles').select('avatar_path').neq('avatar_path', '').limit(2000),
    client
      .from('customer_feedbacks')
      .select('image_path,image_thumb_path')
      .or('image_path.neq.,image_thumb_path.neq.')
      .limit(5000),
  ]);
  const refs = new Set<string>();
  for (const p of profilesRes.data || []) {
    if (p.avatar_path) refs.add(String(p.avatar_path));
  }
  for (const f of fbRes.data || []) {
    if (f.image_path) refs.add(String(f.image_path));
    if (f.image_thumb_path) refs.add(String(f.image_thumb_path));
  }
  return refs;
}

export async function deleteStorageFiles(
  client: SupabaseClient,
  bucket: string,
  paths: string[]
): Promise<{ error?: string }> {
  if (paths.length === 0) return {};
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  recordClientDbOp();
  const { error } = await client.storage.from(bucket).remove(paths);
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'storage.objects',
        'Không thể xóa tệp trong Storage.'
      ),
    };
  }
  for (const p of paths) {
    appCache.invalidatePrefix(`signed:${p}`);
  }
  return {};
}

// ============================================================================
// Real Supabase Usage Proxy Client Call (/api/supabase-usage)
// ============================================================================
export type ResourceSeverity =
  | 'normal'
  | 'watch'
  | 'warning'
  | 'critical'
  | 'info'
  | 'unavailable';

export interface SupabaseResourceMetric {
  id:
    | 'database_size'
    | 'database_connections'
    | 'api_requests'
    | 'storage_size'
    | 'realtime'
    | 'auth'
    | 'egress';
  name: string;
  supported: boolean;
  currentValue: number | null;
  currentFormatted: string;
  limitValue: number | null;
  limitFormatted: string | null;
  usagePercent: number | null;
  severity: ResourceSeverity;
  statusLabel: string;
  detailNote: string;
  sourceLabel: string;
  updatedAt: string | null;
}

export interface SupabaseResourceAlert {
  id: string;
  resourceId: SupabaseResourceMetric['id'];
  resourceName: string;
  severity: 'watch' | 'warning' | 'critical';
  title: string;
  currentFormatted: string;
  limitFormatted: string | null;
  usagePercent: number | null;
  recordedAt: string;
  recommendation: string;
}

export interface SupabaseUsageProxyResponse {
  available: boolean;
  reason?: string;
  message?: string;
  httpStatus?: number;
  projectRef?: string | null;
  projectName?: string | null;
  region?: string | null;
  projectStatus?: string | null;
  plan?: string | null;
  cached?: boolean;
  detailCached?: boolean;
  cacheTtlSeconds?: number;
  detailCacheTtlSeconds?: number;
  refreshCooldownSec?: number;
  fetchedAt?: string;
  detailFetchedAt?: string | null;
  resources?: SupabaseResourceMetric[];
  alerts?: SupabaseResourceAlert[];
}

const USAGE_CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;
const usageClientCache = new Map<
  string,
  { fetchedAt: number; data: SupabaseUsageProxyResponse }
>();
const usageInFlight = new Map<string, Promise<SupabaseUsageProxyResponse>>();

function safeParseJsonObject(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapProxyHttpFailure(status: number): SupabaseUsageProxyResponse {
  if (status === 401) {
    return {
      available: false,
      reason: 'unauthorized',
      httpStatus: 401,
      message:
        'Phiên đăng nhập hoặc token giám sát không hợp lệ / đã hết hạn (HTTP 401).',
    };
  }
  if (status === 403) {
    return {
      available: false,
      reason: 'forbidden',
      httpStatus: 403,
      message:
        'Tài khoản hoặc token thiếu quyền truy cập giám sát tài nguyên (HTTP 403).',
    };
  }
  if (status === 429) {
    return {
      available: false,
      reason: 'rate_limited',
      httpStatus: 429,
      message:
        'API giám sát đang bị giới hạn tần suất yêu cầu (HTTP 429). Vui lòng thử lại sau ít phút.',
    };
  }
  if (status >= 500) {
    return {
      available: false,
      reason: 'vercel_server_error',
      httpStatus: status,
      message: `Lỗi máy chủ API trên Vercel hoặc dịch vụ trung gian (HTTP ${status}). Hãy kiểm tra Vercel Functions Log và Redeploy bản mới nhất.`,
    };
  }
  return {
    available: false,
    reason: 'invalid_response',
    httpStatus: status,
    message: `API giám sát trả về phản hồi không đúng định dạng JSON (HTTP ${status}).`,
  };
}

export async function fetchSupabaseUsageMetrics(
  supabaseUrl: string,
  anonKey: string,
  jwt: string,
  forceRefresh = false
): Promise<SupabaseUsageProxyResponse> {
  const cacheKey = supabaseUrl.trim().toLowerCase();
  const cached = usageClientCache.get(cacheKey);
  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < USAGE_CLIENT_CACHE_TTL_MS
  ) {
    return { ...cached.data, cached: true };
  }

  const inflight = usageInFlight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const reqPromise = (async (): Promise<SupabaseUsageProxyResponse> => {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(
        `/api/supabase-usage${forceRefresh ? '?refresh=1' : ''}`,
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            'X-Supabase-Url': supabaseUrl,
            'X-Supabase-Anon-Key': anonKey,
            Accept: 'application/json',
          },
          cache: 'no-store',
          signal: controller.signal,
        }
      );

      const rawText = await res.text();
      const parsed = safeParseJsonObject(rawText);

      if (!parsed) {
        return mapProxyHttpFailure(res.status || 502);
      }

      const data = parsed as unknown as SupabaseUsageProxyResponse;
      if (!res.ok) {
        const fallback = mapProxyHttpFailure(res.status);
        return {
          ...fallback,
          ...data,
          available: false,
          httpStatus: res.status,
          message:
            typeof data.message === 'string' && data.message.trim()
              ? data.message
              : fallback.message,
        };
      }

      if (data.available) {
        usageClientCache.set(cacheKey, { fetchedAt: Date.now(), data });
      }
      return data;
    } catch (err) {
      return {
        available: false,
        reason: 'network_error',
        message:
          err instanceof Error && err.name === 'AbortError'
            ? 'Hết thời gian chờ phản hồi từ máy chủ giám sát (12 giây).'
            : 'Không thể kết nối tới API giám sát tài nguyên (/api/supabase-usage).',
      };
    } finally {
      globalThis.clearTimeout(timer);
      usageInFlight.delete(cacheKey);
    }
  })();

  usageInFlight.set(cacheKey, reqPromise);
  return reqPromise;
}
