const SUPER_ADMIN_EMAIL = 'hoangminh202547@gmail.com';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface UsageCacheEntry {
  fetchedAt: number;
  projectRef: string;
  payload: Record<string, unknown>;
}

const usageCache = new Map<string, UsageCacheEntry>();

function cleanEnv(val: string | undefined): string {
  return (val || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function extractProjectRef(supabaseUrl: string): string {
  try {
    const u = new URL(supabaseUrl);
    const hostPart = u.hostname.split('.')[0] || '';
    return /^[a-z0-9]{10,32}$/i.test(hostPart) ? hostPart : '';
  } catch {
    return '';
  }
}

function normalizeUrl(raw: string): string {
  return cleanEnv(raw).replace(/\/+$/, '');
}

async function verifyCallerAuthorization(
  supabaseUrl: string,
  anonKey: string,
  jwt: string
): Promise<{ ok: true; email: string } | { ok: false; status: number; message: string }> {
  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${jwt}`,
      },
    });
    if (!userRes.ok) {
      return {
        ok: false,
        status: 401,
        message: 'Phiên đăng nhập Supabase không hợp lệ hoặc đã hết hạn.',
      };
    }
    const userJson = (await userRes.json()) as { email?: string };
    const email = String(userJson.email || '').trim().toLowerCase();
    if (!email) {
      return {
        ok: false,
        status: 401,
        message: 'Không xác định được email người dùng từ JWT.',
      };
    }
    if (email === SUPER_ADMIN_EMAIL) {
      return { ok: true, email };
    }

    const accessUrl = `${supabaseUrl}/rest/v1/user_access?select=role,active,allow_supabase&email=eq.${encodeURIComponent(
      email
    )}&limit=1`;
    const accessRes = await fetch(accessUrl, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${jwt}`,
      },
    });

    if (!accessRes.ok) {
      return {
        ok: false,
        status: 403,
        message: 'Không thể xác minh quyền quản trị tài nguyên Supabase.',
      };
    }

    const rows = (await accessRes.json()) as Array<{
      role?: string;
      active?: boolean;
      allow_supabase?: boolean;
    }>;
    const row = rows[0];
    if (!row || !row.active || (row.role !== 'store_manager' && !row.allow_supabase)) {
      return {
        ok: false,
        status: 403,
        message: 'Chỉ Quản lý / Quản trị được phép truy cập số liệu tài nguyên Supabase.',
      };
    }
    return { ok: true, email };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      message: err instanceof Error ? err.message : 'Lỗi xác thực máy chủ.',
    };
  }
}

export async function GET(request: Request): Promise<Response> {
  const authHeader = request.headers.get('authorization') || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const supabaseUrl = normalizeUrl(
    request.headers.get('x-supabase-url') ||
      process.env.VITE_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      ''
  );
  const anonKey = cleanEnv(
    request.headers.get('x-supabase-anon-key') ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      ''
  );

  if (!jwt || !supabaseUrl || !anonKey) {
    return Response.json(
      {
        available: false,
        reason: 'missing_auth',
        message: 'Cần đăng nhập phiên Supabase Auth hợp lệ để kiểm tra tài nguyên.',
      },
      { status: 401 }
    );
  }

  const authCheck = await verifyCallerAuthorization(supabaseUrl, anonKey, jwt);
  if (!authCheck.ok) {
    return Response.json(
      {
        available: false,
        reason: 'forbidden',
        message: authCheck.message,
      },
      { status: authCheck.status }
    );
  }

  const accessToken = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();
  const projectRef =
    (process.env.SUPABASE_PROJECT_REF || '').trim() || extractProjectRef(supabaseUrl);

  if (!accessToken || !projectRef) {
    return Response.json({
      available: false,
      reason: !accessToken ? 'missing_token' : 'missing_project_ref',
      projectRef: projectRef || null,
      message: !accessToken
        ? 'Chưa cấu hình biến môi trường server SUPABASE_ACCESS_TOKEN (Personal Access Token từ Supabase Account Tokens). Không hiển thị số liệu giả lập.'
        : 'Không xác định được SUPABASE_PROJECT_REF từ Project URL.',
    });
  }

  const urlObj = new URL(request.url);
  const forceRefresh = urlObj.searchParams.get('refresh') === '1';
  const cached = usageCache.get(projectRef);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return Response.json({
      ...cached.payload,
      cached: true,
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
    });
  }

  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
    const baseApi = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}`;

    const [apiCountsRes, apiRequestsRes, projectMetaRes] = await Promise.allSettled([
      fetch(`${baseApi}/analytics/endpoints/usage.api-counts`, { headers }),
      fetch(`${baseApi}/analytics/endpoints/usage.api-requests-count`, { headers }),
      fetch(baseApi, { headers }),
    ]);

    const readJsonSafe = async (settled: PromiseSettledResult<globalThis.Response>) => {
      if (settled.status !== 'fulfilled') {
        return { ok: false, status: 0, data: null as unknown };
      }
      const r = settled.value;
      let data: unknown = null;
      try {
        data = await r.json();
      } catch {
        data = null;
      }
      return { ok: r.ok, status: r.status, data };
    };

    const [apiCounts, apiRequests, projectMeta] = await Promise.all([
      readJsonSafe(apiCountsRes),
      readJsonSafe(apiRequestsRes),
      readJsonSafe(projectMetaRes),
    ]);

    if (!apiCounts.ok && !apiRequests.ok && !projectMeta.ok) {
      const statusCode = apiCounts.status || apiRequests.status || projectMeta.status || 502;
      return Response.json({
        available: false,
        reason: 'management_api_error',
        projectRef,
        message:
          statusCode === 401 || statusCode === 403
            ? 'SUPABASE_ACCESS_TOKEN không hợp lệ hoặc không đủ quyền đọc project này.'
            : `Supabase Management API phản hồi mã ${statusCode}.`,
      });
    }

    const payload: Record<string, unknown> = {
      available: true,
      cached: false,
      projectRef,
      fetchedAt: new Date().toISOString(),
      projectMeta: projectMeta.ok ? projectMeta.data : null,
      apiCounts: apiCounts.ok ? apiCounts.data : null,
      apiRequests: apiRequests.ok ? apiRequests.data : null,
    };

    usageCache.set(projectRef, {
      fetchedAt: Date.now(),
      projectRef,
      payload,
    });

    return Response.json(payload);
  } catch (err) {
    return Response.json(
      {
        available: false,
        reason: 'network_error',
        projectRef,
        message:
          err instanceof Error
            ? `Lỗi kết nối Supabase Management API: ${err.message}`
            : 'Không thể kết nối Supabase Management API.',
      },
      { status: 502 }
    );
  }
}
