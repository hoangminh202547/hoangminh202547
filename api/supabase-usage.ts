const SUPER_ADMIN_EMAIL = 'hoangminh202547@gmail.com';
const OVERVIEW_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DETAIL_CACHE_TTL_MS = 12 * 60 * 1000; // 12 minutes
const MANUAL_REFRESH_COOLDOWN_MS = 30 * 1000; // 30 seconds
const UPSTREAM_TIMEOUT_MS = 8000;

type ResourceSeverity =
  | 'normal'
  | 'watch'
  | 'warning'
  | 'critical'
  | 'info'
  | 'unavailable';

interface SupabaseResourceMetric {
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

interface SupabaseResourceAlert {
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

interface SupabaseUsageResponsePayload {
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

interface DetailSnapshot {
  fetchedAt: number;
  ok: boolean;
  errorNote: string | null;
  dbSizeBytes: number | null;
  dbConnectionsActive: number | null;
  dbConnectionsMax: number | null;
  storageBytes: number | null;
  storageObjectsCount: number | null;
  authUsersTotal: number | null;
}

interface OverviewCacheEntry {
  fetchedAt: number;
  projectRef: string;
  payload: SupabaseUsageResponsePayload;
}

const overviewCache = new Map<string, OverviewCacheEntry>();
const detailCache = new Map<string, DetailSnapshot>();
const inFlightRequests = new Map<string, Promise<SupabaseUsageResponsePayload>>();

function cleanEnv(val: string | undefined): string {
  return (val || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function normalizeUrl(raw: string): string {
  return cleanEnv(raw).replace(/\/+$/, '');
}

function isValidSupabaseProjectUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return (
      u.protocol === 'https:' &&
      /^[a-z0-9-]{8,40}\.supabase\.co$/i.test(u.hostname) &&
      (u.pathname === '/' || u.pathname === '')
    );
  } catch {
    return false;
  }
}

function extractProjectRef(supabaseUrl: string): string {
  try {
    const u = new URL(supabaseUrl);
    const match = u.hostname.match(/^([a-z0-9-]{8,40})\.supabase\.co$/i);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

function safeParseJson(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('vi-VN').format(Math.round(n));
}

function evaluateThreshold(percent: number | null): {
  severity: ResourceSeverity;
  label: string;
} {
  if (percent === null || !Number.isFinite(percent)) {
    return { severity: 'info', label: 'Đang theo dõi' };
  }
  if (percent >= 95) {
    return { severity: 'critical', label: 'Nguy hiểm (>= 95%)' };
  }
  if (percent >= 85) {
    return { severity: 'warning', label: 'Cảnh báo (85%–94%)' };
  }
  if (percent >= 70) {
    return { severity: 'watch', label: 'Theo dõi (70%–84%)' };
  }
  return { severity: 'normal', label: 'Bình thường (< 70%)' };
}

interface SafeUpstreamResult {
  ok: boolean;
  status: number;
  data: unknown;
  isJson: boolean;
}

async function fetchWithTimeoutRetry(
  url: string,
  init: RequestInit,
  maxRetries = 1
): Promise<SafeUpstreamResult> {
  let lastStatus = 0;
  let lastData: unknown = null;
  let lastIsJson = false;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      lastStatus = res.status;

      const rawText = await res.text();
      const parsed = safeParseJson(rawText);
      lastData = parsed;
      lastIsJson = parsed !== null;

      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          data: parsed,
          isJson: parsed !== null,
        };
      }

      if (res.status < 500 && res.status !== 429) {
        return {
          ok: false,
          status: res.status,
          data: parsed,
          isJson: parsed !== null,
        };
      }
    } catch {
      clearTimeout(timer);
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  return {
    ok: false,
    status: lastStatus,
    data: lastData,
    isJson: lastIsJson,
  };
}

function mapManagementError(status: number, data: unknown): {
  reason: string;
  message: string;
} {
  if (status === 401) {
    return {
      reason: 'invalid_token',
      message:
        'SUPABASE_ACCESS_TOKEN không hợp lệ hoặc đã hết hạn (HTTP 401). Hãy tạo lại Personal Access Token và cập nhật trên Vercel.',
    };
  }
  if (status === 403) {
    let missingScopes = '';
    if (data && typeof data === 'object') {
      const mp = (data as { missing_permissions?: unknown }).missing_permissions;
      if (Array.isArray(mp) && mp.length > 0) {
        const clean = mp
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 4);
        if (clean.length > 0) {
          missingScopes = ` (thiếu quyền: ${clean.join(', ')})`;
        }
      }
    }
    return {
      reason: 'insufficient_token_scope',
      message: `SUPABASE_ACCESS_TOKEN thiếu quyền truy cập dự án hoặc Analytics Read${missingScopes} (HTTP 403).`,
    };
  }
  if (status === 429) {
    return {
      reason: 'rate_limited',
      message:
        'Supabase Management API đang giới hạn tần suất yêu cầu (HTTP 429). Vui lòng chờ 1–2 phút rồi thử lại.',
    };
  }
  if (status >= 500) {
    return {
      reason: 'upstream_server_error',
      message: `Máy chủ Supabase Management API hoặc dịch vụ trung gian đang gặp sự cố (HTTP ${status}).`,
    };
  }
  if (status === 0) {
    return {
      reason: 'upstream_timeout',
      message:
        'Hết thời gian chờ kết nối tới Supabase Management API (timeout).',
    };
  }
  return {
    reason: 'management_api_error',
    message: `Supabase Management API không trả về dữ liệu hợp lệ (HTTP ${status}).`,
  };
}

async function verifyCallerAuthorization(
  supabaseUrl: string,
  anonKey: string,
  jwt: string
): Promise<
  { ok: true; email: string } | { ok: false; status: number; message: string }
> {
  if (!isValidSupabaseProjectUrl(supabaseUrl)) {
    return {
      ok: false,
      status: 400,
      message: 'Supabase Project URL không hợp lệ.',
    };
  }

  try {
    const userRes = await fetchWithTimeoutRetry(
      `${supabaseUrl}/auth/v1/user`,
      {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${jwt}`,
        },
      },
      0
    );

    if (!userRes.ok || !userRes.data || typeof userRes.data !== 'object') {
      return {
        ok: false,
        status: 401,
        message: 'Phiên đăng nhập Supabase không hợp lệ hoặc đã hết hạn.',
      };
    }

    const userJson = userRes.data as { email?: string };
    const email = String(userJson.email || '').trim().toLowerCase();
    if (!email) {
      return {
        ok: false,
        status: 401,
        message: 'Không xác định được email người dùng từ phiên đăng nhập.',
      };
    }

    if (email === SUPER_ADMIN_EMAIL) {
      return { ok: true, email };
    }

    const accessUrl = `${supabaseUrl}/rest/v1/user_access?select=role,active,allow_supabase&email=eq.${encodeURIComponent(
      email
    )}&limit=1`;
    const accessRes = await fetchWithTimeoutRetry(
      accessUrl,
      {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${jwt}`,
        },
      },
      0
    );

    if (!accessRes.ok || !Array.isArray(accessRes.data)) {
      return {
        ok: false,
        status: 403,
        message: 'Không thể xác minh quyền truy cập màn hình giám sát.',
      };
    }

    const rows = accessRes.data as Array<{
      role?: string;
      active?: boolean;
      allow_supabase?: boolean;
    }>;
    const row = rows[0];
    if (
      !row ||
      !row.active ||
      (row.role !== 'store_manager' && !row.allow_supabase)
    ) {
      return {
        ok: false,
        status: 403,
        message:
          'Chỉ Quản lý hoặc tài khoản được cấp quyền hệ thống mới được xem giám sát tài nguyên.',
      };
    }
    return { ok: true, email };
  } catch {
    return {
      ok: false,
      status: 500,
      message: 'Lỗi xác thực quyền truy cập trên máy chủ.',
    };
  }
}

interface ParsedApiCounts {
  totalRequests: number | null;
  restRequests: number | null;
  authRequests: number | null;
  realtimeRequests: number | null;
  storageRequests: number | null;
  spikeInfo: {
    latest: number;
    baselineAvg: number;
    timestamp: string;
  } | null;
}

function parseApiAnalytics(
  apiCountsRaw: unknown,
  apiRequestsRaw: unknown
): ParsedApiCounts {
  let restRequests = 0;
  let authRequests = 0;
  let realtimeRequests = 0;
  let storageRequests = 0;
  let hasBreakdown = false;

  const bucketTotals: Array<{ count: number; timestamp: string }> = [];

  if (apiCountsRaw && typeof apiCountsRaw === 'object') {
    const result = (apiCountsRaw as { result?: unknown }).result;
    if (Array.isArray(result)) {
      for (const row of result) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const rest = Number(r.total_rest_requests ?? NaN);
        const auth = Number(r.total_auth_requests ?? NaN);
        const rt = Number(r.total_realtime_requests ?? NaN);
        const st = Number(r.total_storage_requests ?? NaN);
        let rowSum = 0;
        let rowHasVal = false;
        if (Number.isFinite(rest)) {
          restRequests += rest;
          rowSum += rest;
          hasBreakdown = true;
          rowHasVal = true;
        }
        if (Number.isFinite(auth)) {
          authRequests += auth;
          rowSum += auth;
          hasBreakdown = true;
          rowHasVal = true;
        }
        if (Number.isFinite(rt)) {
          realtimeRequests += rt;
          rowSum += rt;
          hasBreakdown = true;
          rowHasVal = true;
        }
        if (Number.isFinite(st)) {
          storageRequests += st;
          rowSum += st;
          hasBreakdown = true;
          rowHasVal = true;
        }
        if (rowHasVal) {
          bucketTotals.push({
            count: rowSum,
            timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
          });
        }
      }
    }
  }

  let aggregateFromReqEndpoint: number | null = null;
  const reqBuckets: Array<{ count: number; timestamp: string }> = [];
  if (apiRequestsRaw && typeof apiRequestsRaw === 'object') {
    const result = (apiRequestsRaw as { result?: unknown }).result;
    if (Array.isArray(result)) {
      let sum = 0;
      let found = false;
      for (const row of result) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const val = Number(
          r.count ?? r.total ?? r.total_rest_requests ?? r.api_requests ?? NaN
        );
        if (Number.isFinite(val)) {
          sum += val;
          found = true;
          reqBuckets.push({
            count: val,
            timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
          });
        }
      }
      if (found) aggregateFromReqEndpoint = sum;
    }
  }

  const totalRequests = hasBreakdown
    ? restRequests + authRequests + realtimeRequests + storageRequests
    : aggregateFromReqEndpoint;

  let spikeInfo: ParsedApiCounts['spikeInfo'] = null;
  const series = bucketTotals.length >= 3 ? bucketTotals : reqBuckets;
  if (series.length >= 3) {
    const sorted = [...series].sort((a, b) =>
      a.timestamp && b.timestamp ? a.timestamp.localeCompare(b.timestamp) : 0
    );
    const latest = sorted[sorted.length - 1];
    const prior = sorted.slice(0, -1);
    const avg =
      prior.reduce((acc, item) => acc + item.count, 0) /
      Math.max(1, prior.length);
    if (latest.count >= 50 && avg > 0 && latest.count >= avg * 2.5) {
      spikeInfo = {
        latest: latest.count,
        baselineAvg: Math.round(avg),
        timestamp: latest.timestamp || new Date().toISOString(),
      };
    }
  }

  return {
    totalRequests,
    restRequests: hasBreakdown ? restRequests : null,
    authRequests: hasBreakdown ? authRequests : null,
    realtimeRequests: hasBreakdown ? realtimeRequests : null,
    storageRequests: hasBreakdown ? storageRequests : null,
    spikeInfo,
  };
}

async function fetchDetailSnapshot(
  projectRef: string,
  accessToken: string,
  forceRefresh: boolean
): Promise<DetailSnapshot> {
  const existing = detailCache.get(projectRef);
  if (
    !forceRefresh &&
    existing &&
    Date.now() - existing.fetchedAt < DETAIL_CACHE_TTL_MS
  ) {
    return existing;
  }

  const sql = [
    'SELECT',
    '  pg_database_size(current_database())::bigint AS db_size_bytes,',
    "  (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS db_connections_active,",
    "  (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS db_connections_max,",
    "  COALESCE((SELECT sum(CASE WHEN (metadata->>'size') ~ '^[0-9]+$' THEN (metadata->>'size')::bigint ELSE 0 END)::bigint FROM storage.objects), 0) AS storage_bytes,",
    '  COALESCE((SELECT count(*)::int FROM storage.objects), 0) AS storage_objects_count,',
    '  COALESCE((SELECT count(*)::int FROM auth.users), 0) AS auth_users_total',
  ].join('\n');

  const reqInit: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  };

  // Prefer official least-privilege read-only endpoint; fallback once on 404
  let res = await fetchWithTimeoutRetry(
    `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query/read-only`,
    reqInit,
    1
  );
  if (!res.ok && res.status === 404) {
    res = await fetchWithTimeoutRetry(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`,
      reqInit,
      1
    );
  }

  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) {
    const note =
      res.status === 401
        ? 'Token không hợp lệ hoặc hết hạn.'
        : res.status === 403
          ? 'Token thiếu quyền Database Read để đọc dung lượng DB/Storage.'
          : res.status === 429
            ? 'API đang giới hạn yêu cầu (HTTP 429).'
            : `Endpoint database query không khả dụng (HTTP ${res.status || 'timeout'}).`;
    const snap: DetailSnapshot = {
      fetchedAt: Date.now(),
      ok: false,
      errorNote: note,
      dbSizeBytes: null,
      dbConnectionsActive: null,
      dbConnectionsMax: null,
      storageBytes: null,
      storageObjectsCount: null,
      authUsersTotal: null,
    };
    if (res.status === 401 || res.status === 403) {
      detailCache.set(projectRef, snap);
    }
    return snap;
  }

  const row = res.data[0] as Record<string, unknown>;
  const toNumOrNull = (val: unknown): number | null => {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  };

  const snap: DetailSnapshot = {
    fetchedAt: Date.now(),
    ok: true,
    errorNote: null,
    dbSizeBytes: toNumOrNull(row.db_size_bytes),
    dbConnectionsActive: toNumOrNull(row.db_connections_active),
    dbConnectionsMax: toNumOrNull(row.db_connections_max),
    storageBytes: toNumOrNull(row.storage_bytes),
    storageObjectsCount: toNumOrNull(row.storage_objects_count),
    authUsersTotal: toNumOrNull(row.auth_users_total),
  };
  detailCache.set(projectRef, snap);
  return snap;
}

function getVerifiedPlanQuotas(plan: string | null): {
  dbBytesLimit: number | null;
  storageBytesLimit: number | null;
} {
  if (!plan) return { dbBytesLimit: null, storageBytesLimit: null };
  const p = plan.toLowerCase();
  if (p === 'free') {
    return {
      dbBytesLimit: 500 * 1024 * 1024,
      storageBytesLimit: 1 * 1024 * 1024 * 1024,
    };
  }
  if (p === 'pro') {
    return {
      dbBytesLimit: 8 * 1024 * 1024 * 1024,
      storageBytesLimit: 100 * 1024 * 1024 * 1024,
    };
  }
  return { dbBytesLimit: null, storageBytesLimit: null };
}

function buildAlerts(
  metrics: SupabaseResourceMetric[],
  spikeInfo: ParsedApiCounts['spikeInfo'],
  recordedAt: string
): SupabaseResourceAlert[] {
  const alerts: SupabaseResourceAlert[] = [];
  const recommendations: Record<SupabaseResourceMetric['id'], string> = {
    database_size:
      'Kiểm tra nhật ký hoạt động cũ, xóa dữ liệu tạm không cần thiết hoặc cân nhắc nâng gói dung lượng Database.',
    database_connections:
      'Kiểm tra các phiên kết nối treo, giảm truy vấn song song hoặc bật Transaction Pooler.',
    api_requests:
      'Kiểm tra các màn hình gọi lại dữ liệu liên tục và tăng thời gian cache ở ứng dụng.',
    storage_size:
      'Dọn dẹp ảnh/tệp trùng lặp hoặc nén ảnh trước khi tải lên bucket internal-media.',
    realtime:
      'Kiểm tra các kênh Realtime đang mở và đảm bảo đóng subscription khi chuyển tab.',
    auth: 'Kiểm tra lưu lượng đăng nhập bất thường hoặc giới hạn gửi OTP.',
    egress: 'Kiểm tra băng thông tải ảnh/xuất báo cáo trên Supabase Dashboard.',
  };

  for (const m of metrics) {
    if (
      m.severity === 'watch' ||
      m.severity === 'warning' ||
      m.severity === 'critical'
    ) {
      alerts.push({
        id: `quota-${m.id}`,
        resourceId: m.id,
        resourceName: m.name,
        severity: m.severity,
        title:
          m.severity === 'critical'
            ? `${m.name} ở mức NGUY HIỂM (${m.usagePercent}%)`
            : m.severity === 'warning'
              ? `${m.name} sắp đạt giới hạn (${m.usagePercent}%)`
              : `${m.name} đang tăng cao (${m.usagePercent}%)`,
        currentFormatted: m.currentFormatted,
        limitFormatted: m.limitFormatted,
        usagePercent: m.usagePercent,
        recordedAt: m.updatedAt || recordedAt,
        recommendation: recommendations[m.id],
      });
    }
  }

  if (spikeInfo) {
    alerts.push({
      id: 'spike-api-requests',
      resourceId: 'api_requests',
      resourceName: 'API Requests',
      severity: 'watch',
      title: 'Phát hiện lưu lượng API Requests tăng đột biến',
      currentFormatted: `${formatNumber(spikeInfo.latest)} lượt/khung giờ`,
      limitFormatted: `Trung bình trước đó: ${formatNumber(spikeInfo.baselineAvg)} lượt`,
      usagePercent: null,
      recordedAt: spikeInfo.timestamp || recordedAt,
      recommendation:
        'Kiểm tra thao tác đồng bộ hàng loạt, import Excel hoặc trình duyệt mở nhiều tab cùng lúc.',
    });
  }

  return alerts;
}

async function processUsageRequest(params: {
  jwt: string;
  supabaseUrlRaw: string;
  anonKeyRaw: string;
  forceRefresh: boolean;
}): Promise<{ status: number; body: SupabaseUsageResponsePayload }> {
  const jwt = params.jwt.trim();
  const supabaseUrl = normalizeUrl(params.supabaseUrlRaw);
  const anonKey = cleanEnv(params.anonKeyRaw);

  if (!jwt || !supabaseUrl || !anonKey) {
    return {
      status: 401,
      body: {
        available: false,
        reason: 'missing_auth',
        httpStatus: 401,
        message:
          'Cần đăng nhập phiên Supabase Auth hợp lệ để xem giám sát tài nguyên.',
      },
    };
  }

  const authCheck = await verifyCallerAuthorization(supabaseUrl, anonKey, jwt);
  if (!authCheck.ok) {
    return {
      status: authCheck.status,
      body: {
        available: false,
        reason: authCheck.status === 401 ? 'session_expired' : 'forbidden',
        httpStatus: authCheck.status,
        message: authCheck.message,
      },
    };
  }

  const accessToken = cleanEnv(process.env.SUPABASE_ACCESS_TOKEN);
  const envProjectRef = cleanEnv(process.env.SUPABASE_PROJECT_REF).toLowerCase();
  const urlProjectRef = extractProjectRef(supabaseUrl);

  if (envProjectRef && urlProjectRef && envProjectRef !== urlProjectRef) {
    return {
      status: 403,
      body: {
        available: false,
        reason: 'project_mismatch',
        httpStatus: 403,
        projectRef: envProjectRef,
        message: `Project hiện tại (${urlProjectRef}) không khớp với SUPABASE_PROJECT_REF (${envProjectRef}) trên máy chủ.`,
      },
    };
  }

  const projectRef = envProjectRef || urlProjectRef;
  if (!accessToken || !projectRef) {
    return {
      status: 200,
      body: {
        available: false,
        reason: !accessToken ? 'missing_token' : 'missing_project_ref',
        projectRef: projectRef || null,
        message: !accessToken
          ? 'Chưa cấu hình biến môi trường server SUPABASE_ACCESS_TOKEN. Chưa thể đọc số liệu thực tế từ Supabase Management API.'
          : 'Không xác định được SUPABASE_PROJECT_REF.',
      },
    };
  }

  const cachedOverview = overviewCache.get(projectRef);
  const now = Date.now();

  if (cachedOverview) {
    const ageMs = now - cachedOverview.fetchedAt;
    if (!params.forceRefresh && ageMs < OVERVIEW_CACHE_TTL_MS) {
      return {
        status: 200,
        body: {
          ...cachedOverview.payload,
          cached: true,
          fetchedAt: new Date(cachedOverview.fetchedAt).toISOString(),
        },
      };
    }
    if (params.forceRefresh && ageMs < MANUAL_REFRESH_COOLDOWN_MS) {
      const waitSec = Math.ceil((MANUAL_REFRESH_COOLDOWN_MS - ageMs) / 1000);
      return {
        status: 200,
        body: {
          ...cachedOverview.payload,
          cached: true,
          refreshCooldownSec: waitSec,
          fetchedAt: new Date(cachedOverview.fetchedAt).toISOString(),
        },
      };
    }
  }

  const existingFlight = inFlightRequests.get(projectRef);
  if (existingFlight) {
    const sharedPayload = await existingFlight;
    return { status: 200, body: sharedPayload };
  }

  const fetchPromise = (async (): Promise<SupabaseUsageResponsePayload> => {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
    const baseApi = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}`;

    const [projectMeta, orgsRes, apiCounts, apiRequests, detailSnap] =
      await Promise.all([
        fetchWithTimeoutRetry(baseApi, { headers }, 1),
        fetchWithTimeoutRetry(
          'https://api.supabase.com/v1/organizations',
          { headers },
          0
        ),
        fetchWithTimeoutRetry(
          `${baseApi}/analytics/endpoints/usage.api-counts`,
          { headers },
          1
        ),
        fetchWithTimeoutRetry(
          `${baseApi}/analytics/endpoints/usage.api-requests-count`,
          { headers },
          1
        ),
        fetchDetailSnapshot(projectRef, accessToken, params.forceRefresh),
      ]);

    if (!projectMeta.ok && !apiCounts.ok && !apiRequests.ok && !detailSnap.ok) {
      const primaryFailure = [projectMeta, apiCounts, apiRequests].find(
        (r) => !r.ok && r.status > 0
      );
      const statusCode = primaryFailure?.status ?? 0;
      const mapped = mapManagementError(statusCode, primaryFailure?.data ?? null);
      return {
        available: false,
        reason: mapped.reason,
        httpStatus: statusCode || 502,
        projectRef,
        message: mapped.message,
      };
    }

    const metaObj =
      projectMeta.ok && projectMeta.data && typeof projectMeta.data === 'object'
        ? (projectMeta.data as Record<string, unknown>)
        : null;
    const projectName =
      metaObj && typeof metaObj.name === 'string' ? metaObj.name : projectRef;
    const region =
      metaObj && typeof metaObj.region === 'string' ? metaObj.region : null;
    const projectStatus =
      metaObj && typeof metaObj.status === 'string' ? metaObj.status : null;
    const orgId =
      metaObj && typeof metaObj.organization_id === 'string'
        ? metaObj.organization_id
        : null;

    let plan: string | null = null;
    if (orgsRes.ok && Array.isArray(orgsRes.data)) {
      const orgs = orgsRes.data as Array<Record<string, unknown>>;
      const matched =
        (orgId
          ? orgs.find((o) => o.id === orgId || o.slug === orgId)
          : orgs[0]) || null;
      if (matched && typeof matched.plan === 'string') {
        plan = matched.plan;
      }
    }

    const quotas = getVerifiedPlanQuotas(plan);
    const analytics = parseApiAnalytics(
      apiCounts.ok ? apiCounts.data : null,
      apiRequests.ok ? apiRequests.data : null
    );

    const overviewIso = new Date().toISOString();
    const detailIso = detailSnap.ok
      ? new Date(detailSnap.fetchedAt).toISOString()
      : null;

    const analyticsUnavailableReason =
      !apiCounts.ok && apiCounts.status
        ? mapManagementError(apiCounts.status, apiCounts.data).message
        : 'Management API không trả về chuỗi số liệu Analytics.';

    const resources: SupabaseResourceMetric[] = [];

    if (detailSnap.ok && detailSnap.dbSizeBytes !== null) {
      const pct =
        quotas.dbBytesLimit !== null
          ? Math.round((detailSnap.dbSizeBytes / quotas.dbBytesLimit) * 1000) /
            10
          : null;
      const evalState = evaluateThreshold(pct);
      resources.push({
        id: 'database_size',
        name: 'Dung lượng Database',
        supported: true,
        currentValue: detailSnap.dbSizeBytes,
        currentFormatted: formatBytes(detailSnap.dbSizeBytes),
        limitValue: quotas.dbBytesLimit,
        limitFormatted:
          quotas.dbBytesLimit !== null ? formatBytes(quotas.dbBytesLimit) : null,
        usagePercent: pct,
        severity: evalState.severity,
        statusLabel: evalState.label,
        detailNote:
          quotas.dbBytesLimit !== null
            ? `Gói ${plan?.toUpperCase()} giới hạn ${formatBytes(quotas.dbBytesLimit)} dữ liệu Postgres.`
            : 'Chưa xác định giới hạn gói từ API nên không tính % sử dụng.',
        sourceLabel: 'Postgres Catalog (cache 12 phút)',
        updatedAt: detailIso,
      });
    } else {
      resources.push({
        id: 'database_size',
        name: 'Dung lượng Database',
        supported: false,
        currentValue: null,
        currentFormatted: 'Chưa có dữ liệu',
        limitValue: quotas.dbBytesLimit,
        limitFormatted:
          quotas.dbBytesLimit !== null ? formatBytes(quotas.dbBytesLimit) : null,
        usagePercent: null,
        severity: 'unavailable',
        statusLabel: 'Không khả dụng',
        detailNote:
          detailSnap.errorNote || 'API không trả về dung lượng Database.',
        sourceLabel: 'Management API',
        updatedAt: null,
      });
    }

    if (
      detailSnap.ok &&
      detailSnap.dbConnectionsActive !== null &&
      detailSnap.dbConnectionsMax !== null &&
      detailSnap.dbConnectionsMax > 0
    ) {
      const pct =
        Math.round(
          (detailSnap.dbConnectionsActive / detailSnap.dbConnectionsMax) * 1000
        ) / 10;
      const evalState = evaluateThreshold(pct);
      resources.push({
        id: 'database_connections',
        name: 'Kết nối Database',
        supported: true,
        currentValue: detailSnap.dbConnectionsActive,
        currentFormatted: `${formatNumber(detailSnap.dbConnectionsActive)} kết nối`,
        limitValue: detailSnap.dbConnectionsMax,
        limitFormatted: `${formatNumber(detailSnap.dbConnectionsMax)} tối đa`,
        usagePercent: pct,
        severity: evalState.severity,
        statusLabel: evalState.label,
        detailNote:
          'Đo từ pg_stat_activity so với max_connections của Postgres.',
        sourceLabel: 'Postgres Catalog (cache 12 phút)',
        updatedAt: detailIso,
      });
    } else {
      resources.push({
        id: 'database_connections',
        name: 'Kết nối Database',
        supported: false,
        currentValue: null,
        currentFormatted: 'Chưa có dữ liệu',
        limitValue: null,
        limitFormatted: null,
        usagePercent: null,
        severity: 'unavailable',
        statusLabel: 'Không khả dụng',
        detailNote:
          detailSnap.errorNote || 'API không trả về số kết nối hiện tại.',
        sourceLabel: 'Management API',
        updatedAt: null,
      });
    }

    if (analytics.totalRequests !== null) {
      const breakdownParts: string[] = [];
      if (analytics.restRequests !== null) {
        breakdownParts.push(`REST: ${formatNumber(analytics.restRequests)}`);
      }
      if (analytics.authRequests !== null) {
        breakdownParts.push(`Auth: ${formatNumber(analytics.authRequests)}`);
      }
      if (analytics.realtimeRequests !== null) {
        breakdownParts.push(
          `Realtime: ${formatNumber(analytics.realtimeRequests)}`
        );
      }
      if (analytics.storageRequests !== null) {
        breakdownParts.push(
          `Storage: ${formatNumber(analytics.storageRequests)}`
        );
      }
      resources.push({
        id: 'api_requests',
        name: 'API Requests',
        supported: true,
        currentValue: analytics.totalRequests,
        currentFormatted: `${formatNumber(analytics.totalRequests)} lượt`,
        limitValue: null,
        limitFormatted: null,
        usagePercent: null,
        severity: analytics.spikeInfo ? 'watch' : 'info',
        statusLabel: analytics.spikeInfo ? 'Tăng đột biến' : 'Đang ghi nhận',
        detailNote:
          breakdownParts.length > 0
            ? breakdownParts.join(' · ')
            : 'Tổng hợp từ Supabase Analytics usage.api-requests-count.',
        sourceLabel: 'Analytics API (cache 5 phút)',
        updatedAt: overviewIso,
      });
    } else {
      resources.push({
        id: 'api_requests',
        name: 'API Requests',
        supported: false,
        currentValue: null,
        currentFormatted: 'Chưa có dữ liệu',
        limitValue: null,
        limitFormatted: null,
        usagePercent: null,
        severity: 'unavailable',
        statusLabel: 'Không khả dụng',
        detailNote: analyticsUnavailableReason,
        sourceLabel: 'Analytics API',
        updatedAt: null,
      });
    }

    if (detailSnap.ok && detailSnap.storageBytes !== null) {
      const pct =
        quotas.storageBytesLimit !== null
          ? Math.round(
              (detailSnap.storageBytes / quotas.storageBytesLimit) * 1000
            ) / 10
          : null;
      const evalState = evaluateThreshold(pct);
      resources.push({
        id: 'storage_size',
        name: 'Dung lượng Storage',
        supported: true,
        currentValue: detailSnap.storageBytes,
        currentFormatted: formatBytes(detailSnap.storageBytes),
        limitValue: quotas.storageBytesLimit,
        limitFormatted:
          quotas.storageBytesLimit !== null
            ? formatBytes(quotas.storageBytesLimit)
            : null,
        usagePercent: pct,
        severity: evalState.severity,
        statusLabel: evalState.label,
        detailNote:
          detailSnap.storageObjectsCount !== null
            ? `Đang lưu ${formatNumber(detailSnap.storageObjectsCount)} tệp trong Storage.`
            : 'Tính tổng kích thước tệp trong storage.objects.',
        sourceLabel: 'Storage Catalog (cache 12 phút)',
        updatedAt: detailIso,
      });
    } else {
      resources.push({
        id: 'storage_size',
        name: 'Dung lượng Storage',
        supported: false,
        currentValue: null,
        currentFormatted: 'Chưa có dữ liệu',
        limitValue: quotas.storageBytesLimit,
        limitFormatted:
          quotas.storageBytesLimit !== null
            ? formatBytes(quotas.storageBytesLimit)
            : null,
        usagePercent: null,
        severity: 'unavailable',
        statusLabel: 'Không khả dụng',
        detailNote:
          detailSnap.errorNote || 'API không trả về dung lượng Storage.',
        sourceLabel: 'Management API',
        updatedAt: null,
      });
    }

    if (analytics.realtimeRequests !== null) {
      resources.push({
        id: 'realtime',
        name: 'Realtime',
        supported: true,
        currentValue: analytics.realtimeRequests,
        currentFormatted: `${formatNumber(analytics.realtimeRequests)} yêu cầu`,
        limitValue: null,
        limitFormatted: null,
        usagePercent: null,
        severity: 'info',
        statusLabel: 'Đang ghi nhận',
        detailNote:
          'Số yêu cầu qua Realtime API. Số kết nối WebSocket đồng thời hiện tại không được Management API công khai.',
        sourceLabel: 'Analytics API (cache 5 phút)',
        updatedAt: overviewIso,
      });
    } else {
      resources.push({
        id: 'realtime',
        name: 'Realtime',
        supported: false,
        currentValue: null,
        currentFormatted: 'API không hỗ trợ',
        limitValue: null,
        limitFormatted: null,
        usagePercent: null,
        severity: 'unavailable',
        statusLabel: 'Không hỗ trợ',
        detailNote: analyticsUnavailableReason,
        sourceLabel: 'Analytics API',
        updatedAt: null,
      });
    }

    if (detailSnap.ok && detailSnap.authUsersTotal !== null) {
      const authReqNote =
        analytics.authRequests !== null
          ? ` · ${formatNumber(analytics.authRequests)} lượt gọi Auth API`
          : '';
      resources.push({
        id: 'auth',
        name: 'Authentication',
        supported: true,
        currentValue: detailSnap.authUsersTotal,
        currentFormatted: `${formatNumber(detailSnap.authUsersTotal)} tài khoản`,
        limitValue: null,
        limitFormatted: null,
        usagePercent: null,
        severity: 'info',
        statusLabel: 'Đang ghi nhận',
        detailNote: `Tổng tài khoản đã tạo trên Auth${authReqNote}. Hạn mức MAU theo tháng xem trên Supabase Dashboard.`,
        sourceLabel: 'Auth Catalog + Analytics',
        updatedAt: detailIso || overviewIso,
      });
    } else if (analytics.authRequests !== null) {
      resources.push({
        id: 'auth',
        name: 'Authentication',
        supported: true,
        currentValue: analytics.authRequests,
        currentFormatted: `${formatNumber(analytics.authRequests)} lượt gọi`,
        limitValue: null,
        limitFormatted: null,
        usagePercent: null,
        severity: 'info',
        statusLabel: 'Đang ghi nhận',
        detailNote:
          'Số lượt gọi Auth API (chưa đọc được tổng tài khoản từ auth.users).',
        sourceLabel: 'Analytics API (cache 5 phút)',
        updatedAt: overviewIso,
      });
    } else {
      resources.push({
        id: 'auth',
        name: 'Authentication',
        supported: false,
        currentValue: null,
        currentFormatted: 'Chưa có dữ liệu',
        limitValue: null,
        limitFormatted: null,
        usagePercent: null,
        severity: 'unavailable',
        statusLabel: 'Không khả dụng',
        detailNote: detailSnap.errorNote || 'API không trả về số liệu Auth.',
        sourceLabel: 'Management API',
        updatedAt: null,
      });
    }

    resources.push({
      id: 'egress',
      name: 'Egress & Băng thông mạng',
      supported: false,
      currentValue: null,
      currentFormatted: 'API không hỗ trợ',
      limitValue: null,
      limitFormatted: null,
      usagePercent: null,
      severity: 'unavailable',
      statusLabel: 'API không hỗ trợ',
      detailNote:
        'Supabase Management API (v1) không cung cấp dung lượng Egress truyền tải mạng. Hãy xem trực tiếp tại Supabase Dashboard → Organization → Usage.',
      sourceLabel: 'Supabase Dashboard',
      updatedAt: null,
    });

    const alerts = buildAlerts(resources, analytics.spikeInfo, overviewIso);

    const payload: SupabaseUsageResponsePayload = {
      available: true,
      cached: false,
      detailCached: detailSnap.ok && Date.now() - detailSnap.fetchedAt > 1000,
      cacheTtlSeconds: Math.round(OVERVIEW_CACHE_TTL_MS / 1000),
      detailCacheTtlSeconds: Math.round(DETAIL_CACHE_TTL_MS / 1000),
      projectRef,
      projectName,
      region,
      projectStatus,
      plan,
      fetchedAt: overviewIso,
      detailFetchedAt: detailIso,
      resources,
      alerts,
    };

    overviewCache.set(projectRef, {
      fetchedAt: Date.now(),
      projectRef,
      payload,
    });

    return payload;
  })();

  inFlightRequests.set(projectRef, fetchPromise);
  try {
    const result = await fetchPromise;
    return { status: 200, body: result };
  } catch {
    return {
      status: 502,
      body: {
        available: false,
        reason: 'network_error',
        httpStatus: 502,
        projectRef,
        message: 'Không thể kết nối tới Supabase Management API.',
      },
    };
  } finally {
    inFlightRequests.delete(projectRef);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const authHeader = request.headers.get('authorization') || '';
    const jwt = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';

    const supabaseUrlRaw =
      request.headers.get('x-supabase-url') ||
      process.env.VITE_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      '';

    const anonKeyRaw =
      request.headers.get('x-supabase-anon-key') ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      '';

    const urlObj = new URL(request.url);
    const forceRefresh = urlObj.searchParams.get('refresh') === '1';

    const result = await processUsageRequest({
      jwt,
      supabaseUrlRaw,
      anonKeyRaw: cleanEnv(anonKeyRaw),
      forceRefresh,
    });

    return Response.json(result.body, {
      status: result.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch {
    return Response.json(
      {
        available: false,
        reason: 'server_error',
        httpStatus: 500,
        message: 'Lỗi xử lý máy chủ API giám sát tài nguyên (/api/supabase-usage).',
      },
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    );
  }
}
