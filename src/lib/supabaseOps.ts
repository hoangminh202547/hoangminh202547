import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { useEffect } from 'react';
import { appCache } from './cache';
import { normalizeEmail } from './permissions';
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

// ============================================================================
// Scoped Realtime Hook (Subscribes ONLY when module is active, unsubscribes on leave)
// ============================================================================
export function useScopedRealtime(
  client: SupabaseClient | null,
  enabled: boolean,
  tables: string[],
  onChange: () => void
) {
  const tablesKey = tables.join(',');
  useEffect(() => {
    if (!client || !enabled || tables.length === 0) return;

    const channelName = `scoped-${tablesKey}-${Math.random().toString(36).slice(2, 7)}`;
    let channel: RealtimeChannel = client.channel(channelName);
    for (const table of tables) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        () => {
          onChange();
        }
      );
    }
    channel.subscribe();

    return () => {
      void client.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, tablesKey]);
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
      updated_by: normalizeEmail(actorEmail),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );
  if (error) return { error: error.message };
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
  if (error) return { error: error.message };
  appCache.invalidatePrefix('shifts:');
  return {};
}

export async function deleteShiftDefinition(
  client: SupabaseClient,
  id: string
): Promise<{ error?: string }> {
  recordClientDbOp();
  const { error } = await client.from('shift_definitions').delete().eq('id', id);
  if (error) return { error: error.message };
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
  email: string
): Promise<OverviewSummary> {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate()
  ).padStart(2, '0')}`;
  const in30Days = new Date(today);
  in30Days.setDate(in30Days.getDate() + 30);
  const thresholdStr = `${in30Days.getFullYear()}-${String(in30Days.getMonth() + 1).padStart(2, '0')}-${String(
    in30Days.getDate()
  ).padStart(2, '0')}`;
  const cleanEmail = normalizeEmail(email);

  recordClientDbOp(6);
  const [schedRes, attRes, myFbRes, teamFbRes, expRes, retRes, promoRes] = await Promise.all([
    client
      .from('work_schedules')
      .select('id,title,start_time,end_time,is_day_off,status')
      .eq('work_date', todayStr)
      .ilike('owner_email', cleanEmail)
      .neq('status', 'cancelled'),
    client
      .from('attendance_logs')
      .select('id,shift_name,check_in_at,status')
      .eq('work_date', todayStr)
      .ilike('owner_email', cleanEmail)
      .order('check_in_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from('customer_feedbacks')
      .select('id', { count: 'exact', head: true })
      .eq('feedback_date', todayStr)
      .ilike('owner_email', cleanEmail),
    client
      .from('customer_feedbacks')
      .select('id', { count: 'exact', head: true })
      .eq('feedback_date', todayStr),
    client
      .from('expiry_tracking')
      .select('id', { count: 'exact', head: true })
      .lte('exp_date', thresholdStr),
    client
      .from('return_records')
      .select('id', { count: 'exact', head: true })
      .eq('progress', 'processing'),
    client
      .from('promotions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active'),
  ]);

  return {
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
    myTodayFeedbackCount: myFbRes.count ?? 0,
    teamTodayFeedbackCount: teamFbRes.count ?? 0,
    expiringSoonCount: expRes.count ?? 0,
    processingReturnsCount: retRes.count ?? 0,
    activePromosCount: promoRes.count ?? 0,
  };
}

// ============================================================================
// Staff Profiles (Nhân sự)
// ============================================================================
export async function fetchUserProfiles(
  client: SupabaseClient
): Promise<UserProfileRecord[]> {
  recordClientDbOp();
  const { data, error } = await client
    .from('user_profiles')
    .select('id,email,display_name,avatar_url,avatar_path,birth_date,gender,phone,updated_at')
    .order('display_name', { ascending: true });

  if (error || !data) return [];
  return data.map((r) => ({
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
}

export async function updateMyProfileDetails(
  client: SupabaseClient,
  uid: string,
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
  recordClientDbOp();
  const payload: Record<string, unknown> = {
    id: uid,
    email: normalizeEmail(email),
    display_name: updates.displayName.trim().slice(0, 120),
    birth_date: updates.birthDate.trim(),
    gender: updates.gender.trim(),
    phone: updates.phone.trim().slice(0, 30),
    updated_at: new Date().toISOString(),
  };
  if (updates.avatarPath !== undefined) payload.avatar_path = updates.avatarPath;
  if (updates.avatarUrl !== undefined) payload.avatar_url = updates.avatarUrl;

  const { error } = await client.from('user_profiles').upsert(payload, { onConflict: 'id' });
  if (error) return { error: error.message };
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

  let q = client
    .from('attendance_logs')
    .select(
      'id,schedule_id,owner_id,owner_email,employee_name,shift_name,work_date,check_in_at,check_out_at,is_unscheduled,status,notes_history,created_at,updated_at',
      { count: 'exact' }
    )
    .order('work_date', { ascending: false })
    .order('check_in_at', { ascending: false })
    .range(from, to);

  if (params.datePrefix) {
    q = q.like('work_date', `${params.datePrefix}%`);
  }
  if (params.search.trim()) {
    const s = params.search.trim();
    q = q.or(`employee_name.ilike.%${s}%,owner_email.ilike.%${s}%,shift_name.ilike.%${s}%`);
  }

  const { data, count, error } = await q;
  if (error) return { rows: [], total: 0, error: error.message };
  return {
    rows: (data || []).map((r) => mapAttendance(r as Record<string, unknown>)),
    total: count ?? 0,
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
  }
): Promise<{ data?: AttendanceRecord; error?: string }> {
  recordClientDbOp();
  const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const notes: AttendanceNoteEntry[] = params.initialNote?.trim()
    ? [
        {
          id: `note-${Date.now()}`,
          type: 'note',
          content: params.initialNote.trim(),
          createdAt: new Date().toISOString(),
          createdBy: normalizeEmail(params.ownerEmail),
        },
      ]
    : [];

  const { data, error } = await client
    .from('attendance_logs')
    .insert({
      id,
      schedule_id: params.scheduleId,
      owner_id: params.ownerId,
      owner_email: normalizeEmail(params.ownerEmail),
      employee_name: params.employeeName.trim(),
      shift_name: params.shiftName.trim(),
      work_date: params.workDate,
      is_unscheduled: params.isUnscheduled,
      status: 'checked_in',
      notes_history: notes,
    })
    .select(
      'id,schedule_id,owner_id,owner_email,employee_name,shift_name,work_date,check_in_at,check_out_at,is_unscheduled,status,notes_history,created_at,updated_at'
    )
    .single();

  if (error || !data) return { error: error?.message || 'Không thể chấm công.' };
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
  }
): Promise<{ data?: AttendanceRecord; error?: string }> {
  recordClientDbOp();
  const nextNotes: AttendanceNoteEntry[] = [...record.notesHistory];
  if (params.noteContent.trim()) {
    nextNotes.push({
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      type: params.noteType,
      content: params.noteContent.trim(),
      createdAt: new Date().toISOString(),
      createdBy: normalizeEmail(params.actorEmail),
    });
  }

  const updates: Record<string, unknown> = {
    notes_history: nextNotes,
  };
  if (params.nextStatus) updates.status = params.nextStatus;
  if (params.markCheckout) {
    updates.check_out_at = new Date().toISOString();
    if (!params.nextStatus) updates.status = 'checked_out';
  }

  const { data, error } = await client
    .from('attendance_logs')
    .update(updates)
    .eq('id', record.id)
    .select(
      'id,schedule_id,owner_id,owner_email,employee_name,shift_name,work_date,check_in_at,check_out_at,is_unscheduled,status,notes_history,created_at,updated_at'
    )
    .single();

  if (error || !data) return { error: error?.message || 'Không thể cập nhật chấm công.' };
  return { data: mapAttendance(data as Record<string, unknown>) };
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
    ownerFilter?: string;
    categoryFilter?: 'ALL' | 'product' | 'service';
  }
): Promise<{ rows: CustomerFeedback[]; total: number; error?: string }> {
  recordClientDbOp();
  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;

  let q = client
    .from('customer_feedbacks')
    .select(
      'id,owner_id,owner_email,employee_name,feedback_date,category,product_name,content,image_path,image_thumb_path,created_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: true }) // Oldest -> Newest default per spec
    .range(from, to);

  if (params.datePrefix) {
    q = q.like('feedback_date', `${params.datePrefix}%`);
  }
  if (params.ownerFilter) {
    q = q.ilike('owner_email', params.ownerFilter);
  }
  if (params.categoryFilter && params.categoryFilter !== 'ALL') {
    q = q.eq('category', params.categoryFilter);
  }

  const { data, count, error } = await q;
  if (error) return { rows: [], total: 0, error: error.message };
  return {
    rows: (data || []).map((r) => mapFeedback(r as Record<string, unknown>)),
    total: count ?? 0,
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
  recordClientDbOp();
  const id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { data, error } = await client
    .from('customer_feedbacks')
    .insert({
      id,
      owner_id: params.ownerId,
      owner_email: normalizeEmail(params.ownerEmail),
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

  if (error || !data) return { error: error?.message || 'Không thể lưu ý kiến khách hàng.' };
  return { data: mapFeedback(data as Record<string, unknown>) };
}

export async function deleteCustomerFeedback(
  client: SupabaseClient,
  id: string
): Promise<{ error?: string }> {
  recordClientDbOp();
  const { error } = await client.from('customer_feedbacks').delete().eq('id', id);
  if (error) return { error: error.message };
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

  let q = client
    .from('product_catalog')
    .select('id,product_code,barcode,name,unit,price,supplier_name,updated_by,created_at,updated_at', {
      count: 'exact',
    })
    .order('product_code', { ascending: true })
    .range(from, to);

  if (params.search.trim()) {
    const s = params.search.trim();
    q = q.or(
      `product_code.ilike.%${s}%,barcode.ilike.%${s}%,name.ilike.%${s}%,supplier_name.ilike.%${s}%`
    );
  }

  const { data, count, error } = await q;
  if (error) return { rows: [], total: 0, error: error.message };
  return {
    rows: (data || []).map((r) => mapCatalog(r as Record<string, unknown>)),
    total: count ?? 0,
  };
}

export async function fetchAllCatalogForCache(
  client: SupabaseClient
): Promise<ProductCatalogItem[]> {
  const cached = appCache.get<ProductCatalogItem[]>('catalog:all');
  if (cached) return cached;

  recordClientDbOp();
  const { data, error } = await client
    .from('product_catalog')
    .select('id,product_code,barcode,name,unit,price,supplier_name,updated_by,created_at,updated_at')
    .order('product_code', { ascending: true })
    .limit(5000);

  if (error || !data) return [];
  const mapped = data.map((r) => mapCatalog(r as Record<string, unknown>));
  appCache.set('catalog:all', mapped, 180_000);
  return mapped;
}

export async function upsertCatalogItem(
  client: SupabaseClient,
  item: Omit<ProductCatalogItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<{ error?: string }> {
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
      updated_by: normalizeEmail(item.updatedBy),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'product_code' }
  );
  if (error) return { error: error.message };
  appCache.invalidatePrefix('catalog:');
  return {};
}

export async function batchDeleteCatalogWithCheck(
  client: SupabaseClient,
  items: ProductCatalogItem[]
): Promise<{ deleted: number; blockedCodes: string[]; error?: string }> {
  if (items.length === 0) return { deleted: 0, blockedCodes: [] };
  const codes = items.map((i) => i.productCode);

  recordClientDbOp(2);
  const [expRef, promoRef] = await Promise.all([
    client.from('expiry_tracking').select('product_code').in('product_code', codes),
    client.from('promotions').select('product_code').in('product_code', codes),
  ]);

  const inUseSet = new Set<string>([
    ...(expRef.data || []).map((r) => String(r.product_code)),
    ...(promoRef.data || []).map((r) => String(r.product_code)),
  ]);

  const deletableIds = items
    .filter((i) => !inUseSet.has(i.productCode))
    .map((i) => i.id);
  const blockedCodes = items
    .filter((i) => inUseSet.has(i.productCode))
    .map((i) => i.productCode);

  if (deletableIds.length > 0) {
    recordClientDbOp();
    const { error } = await client.from('product_catalog').delete().in('id', deletableIds);
    if (error) return { deleted: 0, blockedCodes, error: error.message };
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

  let q = client
    .from('supplier_policies')
    .select(
      'id,category,supplier_name,supplier_system_name,product_name,return_policy,warn_months_before,updated_by,created_at,updated_at',
      { count: 'exact' }
    )
    .order('supplier_system_name', { ascending: true })
    .range(from, to);

  if (params.search.trim()) {
    const s = params.search.trim();
    q = q.or(
      `supplier_system_name.ilike.%${s}%,supplier_name.ilike.%${s}%,product_name.ilike.%${s}%,category.ilike.%${s}%`
    );
  }

  const { data, count, error } = await q;
  if (error) return { rows: [], total: 0, error: error.message };
  return {
    rows: (data || []).map((r) => mapPolicy(r as Record<string, unknown>)),
    total: count ?? 0,
  };
}

export async function fetchAllPoliciesForCache(
  client: SupabaseClient
): Promise<SupplierPolicyItem[]> {
  const cached = appCache.get<SupplierPolicyItem[]>('policies:all');
  if (cached) return cached;

  recordClientDbOp();
  const { data, error } = await client
    .from('supplier_policies')
    .select(
      'id,category,supplier_name,supplier_system_name,product_name,return_policy,warn_months_before,updated_by,created_at,updated_at'
    )
    .order('supplier_system_name', { ascending: true })
    .limit(5000);

  if (error || !data) return [];
  const mapped = data.map((r) => mapPolicy(r as Record<string, unknown>));
  appCache.set('policies:all', mapped, 180_000);
  return mapped;
}

export async function upsertPolicyItem(
  client: SupabaseClient,
  item: Omit<SupplierPolicyItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<{ error?: string }> {
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
      updated_by: normalizeEmail(item.updatedBy),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) return { error: error.message };
  appCache.invalidatePrefix('policies:');
  return {};
}

export async function deletePoliciesBatch(
  client: SupabaseClient,
  ids: string[]
): Promise<{ error?: string }> {
  if (ids.length === 0) return {};
  recordClientDbOp();
  const { error } = await client.from('supplier_policies').delete().in('id', ids);
  if (error) return { error: error.message };
  appCache.invalidatePrefix('policies:');
  return {};
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

  let q = client
    .from('expiry_tracking')
    .select(
      'id,product_code,barcode,product_name,unit,supplier_system_name,return_policy,warn_months_before,mfg_date,exp_date,pt_code,note,updated_by,created_at,updated_at',
      { count: 'exact' }
    )
    .order('exp_date', { ascending: true })
    .range(from, to);

  if (params.ptFilter.trim()) {
    q = q.ilike('pt_code', `%${params.ptFilter.trim()}%`);
  }
  if (params.supplierFilter.trim()) {
    q = q.ilike('supplier_system_name', `%${params.supplierFilter.trim()}%`);
  }
  if (params.search.trim()) {
    const s = params.search.trim();
    q = q.or(
      `product_code.ilike.%${s}%,barcode.ilike.%${s}%,product_name.ilike.%${s}%,supplier_system_name.ilike.%${s}%,pt_code.ilike.%${s}%`
    );
  }

  const { data, count, error } = await q;
  if (error) return { rows: [], total: 0, error: error.message };
  return {
    rows: (data || []).map((r) => mapExpiry(r as Record<string, unknown>)),
    total: count ?? 0,
  };
}

export async function upsertExpiryItem(
  client: SupabaseClient,
  item: Omit<ExpiryTrackingItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<{ error?: string }> {
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
      updated_by: normalizeEmail(item.updatedBy),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) return { error: error.message };
  return {};
}

export async function deleteExpiryBatch(
  client: SupabaseClient,
  ids: string[]
): Promise<{ error?: string }> {
  if (ids.length === 0) return {};
  recordClientDbOp();
  const { error } = await client.from('expiry_tracking').delete().in('id', ids);
  if (error) return { error: error.message };
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

  let q = client
    .from('return_records')
    .select(
      'id,pt_code,supplier_system_name,product_summary,return_method,progress,reported_date,completed_date,last_update_note,updated_by,created_at,updated_at',
      { count: 'exact' }
    )
    .order('updated_at', { ascending: false })
    .range(from, to);

  if (params.supplierFilter.trim()) {
    q = q.ilike('supplier_system_name', `%${params.supplierFilter.trim()}%`);
  }
  if (params.itemFilter.trim()) {
    q = q.ilike('product_summary', `%${params.itemFilter.trim()}%`);
  }
  if (params.methodFilter.trim()) {
    q = q.ilike('return_method', `%${params.methodFilter.trim()}%`);
  }
  if (params.ptFilter.trim()) {
    q = q.ilike('pt_code', `%${params.ptFilter.trim()}%`);
  }

  const { data, count, error } = await q;
  if (error) return { rows: [], total: 0, error: error.message };
  return {
    rows: (data || []).map((r) => mapReturnRecord(r as Record<string, unknown>)),
    total: count ?? 0,
  };
}

export async function upsertReturnRecord(
  client: SupabaseClient,
  item: Omit<ReturnRecordItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<{ error?: string }> {
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
      updated_by: normalizeEmail(item.updatedBy),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) return { error: error.message };
  return {};
}

export async function deleteReturnRecords(
  client: SupabaseClient,
  ids: string[]
): Promise<{ error?: string }> {
  if (ids.length === 0) return {};
  recordClientDbOp();
  const { error } = await client.from('return_records').delete().in('id', ids);
  if (error) return { error: error.message };
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

  let q = client
    .from('promotions')
    .select(
      'id,product_code,barcode,product_name,has_b_badge,unit,exp_date,quantity,discount_rate,regular_price,promo_price,pt_code,status,updated_by,created_at,updated_at',
      { count: 'exact' }
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
  if (params.search.trim()) {
    const s = params.search.trim();
    q = q.or(
      `product_code.ilike.%${s}%,barcode.ilike.%${s}%,product_name.ilike.%${s}%,pt_code.ilike.%${s}%`
    );
  }

  const { data, count, error } = await q;
  if (error) return { rows: [], total: 0, error: error.message };
  return {
    rows: (data || []).map((r) => mapPromotion(r as Record<string, unknown>)),
    total: count ?? 0,
  };
}

export async function upsertPromotionItem(
  client: SupabaseClient,
  item: Omit<PromotionItem, 'id' | 'promoPrice' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<{ error?: string }> {
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
      updated_by: normalizeEmail(item.updatedBy),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) return { error: error.message };
  return {};
}

export async function deletePromotionsBatch(
  client: SupabaseClient,
  ids: string[]
): Promise<{ error?: string }> {
  if (ids.length === 0) return {};
  recordClientDbOp();
  const { error } = await client.from('promotions').delete().in('id', ids);
  if (error) return { error: error.message };
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
  uid: string,
  folder: 'avatars' | 'feedback',
  mainBlob: Blob,
  thumbBlob?: Blob
): Promise<{ path: string; thumbPath: string; error?: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ext = mainBlob.type.includes('webp') ? 'webp' : 'jpg';
  const mainPath = `${uid}/${folder}/${stamp}.${ext}`;

  recordClientDbOp();
  const { error: mainErr } = await client.storage
    .from(STORAGE_BUCKET)
    .upload(mainPath, mainBlob, {
      contentType: mainBlob.type || 'image/webp',
      cacheControl: '31536000',
      upsert: false,
    });

  if (mainErr) {
    return { path: '', thumbPath: '', error: mainErr.message };
  }

  let thumbPath = '';
  if (thumbBlob) {
    thumbPath = `${uid}/${folder}/${stamp}_thumb.${ext}`;
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
    client.from('user_profiles').select('avatar_path'),
    client.from('customer_feedbacks').select('image_path,image_thumb_path'),
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
  recordClientDbOp();
  const { error } = await client.storage.from(bucket).remove(paths);
  if (error) return { error: error.message };
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
    const timer = window.setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(
        `/api/supabase-usage${forceRefresh ? '?refresh=1' : ''}`,
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            'X-Supabase-Url': supabaseUrl,
            'X-Supabase-Anon-Key': anonKey,
          },
          cache: 'no-store',
          signal: controller.signal,
        }
      );
      const data = (await res.json()) as SupabaseUsageProxyResponse;
      if (data.available) {
        usageClientCache.set(cacheKey, { fetchedAt: Date.now(), data });
      }
      return data;
    } finally {
      window.clearTimeout(timer);
      usageInFlight.delete(cacheKey);
    }
  })();

  usageInFlight.set(cacheKey, reqPromise);
  return reqPromise;
}
