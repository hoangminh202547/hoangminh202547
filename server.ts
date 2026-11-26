import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const SUPER_ADMIN_EMAIL = 'hoangminh202547@gmail.com';

interface UsageCacheEntry {
  fetchedAt: number;
  projectRef: string;
  payload: unknown;
}

const usageCache = new Map<string, UsageCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

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
      return { ok: false, status: 401, message: 'Phiên đăng nhập Supabase không hợp lệ hoặc đã hết hạn.' };
    }
    const userJson = (await userRes.json()) as { email?: string };
    const email = String(userJson.email || '').trim().toLowerCase();
    if (!email) {
      return { ok: false, status: 401, message: 'Không xác định được email người dùng từ JWT.' };
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

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/api/public-config', (_req: Request, res: Response) => {
    const rawUrl = cleanEnv(
      process.env.VITE_SUPABASE_URL ||
        process.env.SUPABASE_URL ||
        process.env.NEXT_PUBLIC_SUPABASE_URL
    ).replace(/\/+$/, '');
    const rawKey = cleanEnv(
      process.env.VITE_SUPABASE_ANON_KEY ||
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        process.env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    );

    let envError: string | null = null;
    let url = rawUrl;
    let anonKey = rawKey;

    if (rawUrl || rawKey) {
      if (
        /^sb_(publishable|secret)_/i.test(rawUrl) ||
        /^eyJ[A-Za-z0-9_-]+\./.test(rawUrl)
      ) {
        envError =
          'Biến môi trường VITE_SUPABASE_URL đang chứa API Key thay vì URL dự án (https://<project-ref>.supabase.co).';
        url = '';
        anonKey = '';
      } else {
        let urlOk = false;
        try {
          const parsed = new URL(rawUrl);
          urlOk =
            parsed.protocol === 'https:' &&
            /^[a-z0-9-]{8,40}\.supabase\.co$/i.test(parsed.hostname) &&
            (parsed.pathname === '/' || parsed.pathname === '') &&
            !parsed.search &&
            !parsed.hash;
        } catch {
          urlOk = false;
        }
        if (!urlOk) {
          envError =
            'Biến môi trường VITE_SUPABASE_URL không hợp lệ (phải có dạng https://<project-ref>.supabase.co).';
          url = '';
          anonKey = '';
        } else if (/^https?:\/\//i.test(rawKey)) {
          envError =
            'Biến môi trường VITE_SUPABASE_ANON_KEY đang chứa URL thay vì Public Key.';
          url = '';
          anonKey = '';
        } else if (/^sb_secret_/i.test(rawKey)) {
          envError =
            'Phát hiện Secret Key trong biến môi trường công khai. Đã chặn truyền ra trình duyệt.';
          url = '';
          anonKey = '';
        } else {
          const isPublishable = /^sb_publishable_[A-Za-z0-9_-]{12,}$/i.test(rawKey);
          let isAnonJwt = false;
          if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(rawKey)) {
            try {
              const part = rawKey.split('.')[1] || '';
              const padded = part.replace(/-/g, '+').replace(/_/g, '/');
              const parsedJwt = JSON.parse(
                Buffer.from(padded, 'base64').toString('utf8')
              ) as { role?: string };
              if (parsedJwt.role === 'service_role') {
                envError =
                  'Phát hiện Service Role JWT trong biến môi trường công khai. Đã chặn truyền ra trình duyệt.';
                url = '';
                anonKey = '';
              } else {
                isAnonJwt = !parsedJwt.role || parsedJwt.role === 'anon';
              }
            } catch {
              isAnonJwt = false;
            }
          }
          if (!envError && !isPublishable && !isAnonJwt) {
            envError =
              'Biến môi trường VITE_SUPABASE_ANON_KEY không đúng định dạng Public Key hoặc Anon Key.';
            url = '';
            anonKey = '';
          }
        }
      }
    }

    const vercelEnv = (process.env.VERCEL_ENV || '').trim().toLowerCase();
    const appUrl = (process.env.APP_URL || '').trim().toLowerCase();
    const runtimeEnv =
      vercelEnv === 'production'
        ? 'vercel_production'
        : vercelEnv === 'preview' || process.env.VERCEL === '1'
          ? 'vercel_preview'
          : appUrl.includes('run.app') || appUrl.includes('aistudio')
            ? 'ai_studio'
            : 'local';

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({
      url,
      anonKey,
      configured: Boolean(url && anonKey),
      envError,
      runtimeEnv,
    });
  });

  app.get('/api/supabase-usage', async (req: Request, res: Response) => {
    const authHeader = String(req.headers.authorization || '');
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const supabaseUrl = normalizeUrl(
      String(
        req.headers['x-supabase-url'] ||
          process.env.VITE_SUPABASE_URL ||
          process.env.SUPABASE_URL ||
          process.env.NEXT_PUBLIC_SUPABASE_URL ||
          ''
      )
    );
    const anonKey = cleanEnv(
      String(
        req.headers['x-supabase-anon-key'] ||
          process.env.VITE_SUPABASE_ANON_KEY ||
          process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
          process.env.SUPABASE_ANON_KEY ||
          process.env.SUPABASE_PUBLISHABLE_KEY ||
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
          process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
          ''
      )
    );

    if (!jwt || !supabaseUrl || !anonKey) {
      res.status(401).json({
        available: false,
        reason: 'missing_auth',
        message: 'Cần đăng nhập phiên Supabase Auth hợp lệ để kiểm tra tài nguyên.',
      });
      return;
    }

    const authCheck = await verifyCallerAuthorization(supabaseUrl, anonKey, jwt);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({
        available: false,
        reason: 'forbidden',
        message: authCheck.message,
      });
      return;
    }

    const accessToken = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();
    const projectRef =
      (process.env.SUPABASE_PROJECT_REF || '').trim() || extractProjectRef(supabaseUrl);

    if (!accessToken || !projectRef) {
      res.json({
        available: false,
        reason: !accessToken ? 'missing_token' : 'missing_project_ref',
        projectRef: projectRef || null,
        message: !accessToken
          ? 'Chưa cấu hình biến môi trường server SUPABASE_ACCESS_TOKEN (Personal Access Token từ Supabase Account Tokens). Không hiển thị số liệu giả lập.'
          : 'Không xác định được SUPABASE_PROJECT_REF từ Project URL.',
      });
      return;
    }

    const forceRefresh = req.query.refresh === '1';
    const cached = usageCache.get(projectRef);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      res.json({
        ...(cached.payload as Record<string, unknown>),
        cached: true,
        fetchedAt: new Date(cached.fetchedAt).toISOString(),
      });
      return;
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
        res.json({
          available: false,
          reason: 'management_api_error',
          projectRef,
          message:
            statusCode === 401 || statusCode === 403
              ? 'SUPABASE_ACCESS_TOKEN không hợp lệ hoặc không đủ quyền đọc project này.'
              : `Supabase Management API phản hồi mã ${statusCode}.`,
        });
        return;
      }

      const payload = {
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

      res.json(payload);
    } catch (err) {
      res.status(502).json({
        available: false,
        reason: 'network_error',
        projectRef,
        message:
          err instanceof Error
            ? `Lỗi kết nối Supabase Management API: ${err.message}`
            : 'Không thể kết nối Supabase Management API.',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
