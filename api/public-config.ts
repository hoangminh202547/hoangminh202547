type RuntimeEnvKind =
  | 'vercel_production'
  | 'vercel_preview'
  | 'ai_studio'
  | 'local';

function cleanEnv(val: string | undefined): string {
  return (val || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function detectRuntimeEnv(): RuntimeEnvKind {
  const vercelEnv = (process.env.VERCEL_ENV || '').trim().toLowerCase();
  if (vercelEnv === 'production') return 'vercel_production';
  if (vercelEnv === 'preview') return 'vercel_preview';
  if (process.env.VERCEL === '1') return 'vercel_preview';
  const appUrl = (process.env.APP_URL || '').trim().toLowerCase();
  if (appUrl.includes('run.app') || appUrl.includes('aistudio')) {
    return 'ai_studio';
  }
  return 'local';
}

function validatePublicEnvPair(
  rawUrl: string,
  rawKey: string
): { url: string; anonKey: string; envError: string | null } {
  const url = rawUrl.replace(/\/+$/, '');
  const anonKey = rawKey;

  if (!url && !anonKey) {
    return { url: '', anonKey: '', envError: null };
  }

  if (/^sb_(publishable|secret)_/i.test(url) || /^eyJ[A-Za-z0-9_-]+\./.test(url)) {
    return {
      url: '',
      anonKey: '',
      envError:
        'Biến môi trường VITE_SUPABASE_URL đang chứa API Key thay vì URL dự án (https://<project-ref>.supabase.co).',
    };
  }

  let urlValid = false;
  try {
    const parsed = new URL(url);
    urlValid =
      parsed.protocol === 'https:' &&
      /^[a-z0-9-]{8,40}\.supabase\.co$/i.test(parsed.hostname) &&
      (parsed.pathname === '/' || parsed.pathname === '') &&
      !parsed.search &&
      !parsed.hash;
  } catch {
    urlValid = false;
  }

  if (!urlValid) {
    return {
      url: '',
      anonKey: '',
      envError:
        'Biến môi trường VITE_SUPABASE_URL không hợp lệ (phải có dạng https://<project-ref>.supabase.co).',
    };
  }

  if (/^https?:\/\//i.test(anonKey)) {
    return {
      url: '',
      anonKey: '',
      envError:
        'Biến môi trường VITE_SUPABASE_ANON_KEY đang chứa URL thay vì Public Key.',
    };
  }

  if (/^sb_secret_/i.test(anonKey)) {
    return {
      url: '',
      anonKey: '',
      envError:
        'Phát hiện Secret Key (sb_secret_...) trong biến môi trường công khai. Đã chặn truyền khóa bí mật ra trình duyệt.',
    };
  }

  const isPublishable = /^sb_publishable_[A-Za-z0-9_-]{12,}$/i.test(anonKey);
  let isAnonJwt = false;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(anonKey)) {
    try {
      const part = anonKey.split('.')[1] || '';
      const padded = part.replace(/-/g, '+').replace(/_/g, '/');
      const json = JSON.parse(
        Buffer.from(padded, 'base64').toString('utf8')
      ) as { role?: string };
      if (json.role === 'service_role') {
        return {
          url: '',
          anonKey: '',
          envError:
            'Phát hiện Service Role JWT trong biến môi trường công khai. Đã chặn truyền khóa bí mật ra trình duyệt.',
        };
      }
      isAnonJwt = !json.role || json.role === 'anon';
    } catch {
      isAnonJwt = false;
    }
  }

  if (!isPublishable && !isAnonJwt) {
    return {
      url: '',
      anonKey: '',
      envError:
        'Biến môi trường VITE_SUPABASE_ANON_KEY không đúng định dạng Public Key hoặc Anon Key.',
    };
  }

  return { url, anonKey, envError: null };
}

export function GET(): Response {
  const rawUrl = cleanEnv(
    process.env.VITE_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL
  );

  const rawKey = cleanEnv(
    process.env.VITE_SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  );

  const validated = validatePublicEnvPair(rawUrl, rawKey);
  const runtimeEnv = detectRuntimeEnv();

  return Response.json(
    {
      url: validated.url,
      anonKey: validated.anonKey,
      configured: Boolean(validated.url && validated.anonKey),
      envError: validated.envError,
      runtimeEnv,
    },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  );
}
