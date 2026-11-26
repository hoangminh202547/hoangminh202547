import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GET as handleSupabaseUsageGet } from './api/supabase-usage.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

function cleanEnv(val: string | undefined): string {
  return (val || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
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
    try {
      const protocol = req.protocol || 'http';
      const host = req.get('host') || `localhost:${PORT}`;
      const webReq = new Request(`${protocol}://${host}${req.originalUrl}`, {
        method: 'GET',
        headers: {
          authorization: String(req.headers.authorization || ''),
          'x-supabase-url': String(req.headers['x-supabase-url'] || ''),
          'x-supabase-anon-key': String(req.headers['x-supabase-anon-key'] || ''),
        },
      });
      const webRes = await handleSupabaseUsageGet(webReq);
      const rawText = await webRes.text();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.status(webRes.status).send(rawText);
    } catch {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.status(500).json({
        available: false,
        reason: 'server_error',
        httpStatus: 500,
        message: 'Lỗi máy chủ API giám sát tài nguyên.',
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
