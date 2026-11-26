import {
  createClient,
  type RealtimeChannel,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';
import schemaSql from '../../supabase/schema.sql?raw';
import migration002Sql from '../../supabase/migrations/002_full_erp.sql?raw';
import migration003Sql from '../../supabase/migrations/003_fix_rls_policies.sql?raw';
import type {
  ActivityAction,
  ActivityLog,
  ActivityModule,
  AuthorizedEmail,
  BarcodeScan,
  ModuleAccessFlags,
  ScheduleStatus,
  ShiftType,
  SupabaseConfig,
  SupabaseKeyType,
  SupabaseOverallStatus,
  SupabaseRuntimeEnv,
  SupabaseSubsystemStatus,
  UserRole,
  WorkSchedule,
} from '../types';
import { emailToKey, normalizeEmail, normalizeRole } from './permissions';

export const SUPABASE_SCHEMA_SQL = schemaSql;
export const SUPABASE_MIGRATION_002_SQL = migration002Sql;
export const SUPABASE_MIGRATION_003_SQL = migration003Sql;

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

export const SUPABASE_OAUTH_CHANNEL = 'scanshift_supabase_oauth';

export function cleanConfigValue(raw: string): string {
  return raw
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

export function normalizeSupabaseUrl(raw: string): string {
  return cleanConfigValue(raw).replace(/\/+$/, '');
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (base64.length % 4)) % 4;
    const padded = base64 + '='.repeat(padLength);
    const json = atob(padded);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractSupabaseProjectRef(rawUrl: string): string {
  const trimmed = normalizeSupabaseUrl(rawUrl);
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const match = parsed.hostname.match(/^([a-z0-9-]{8,40})\.supabase\.co$/i);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

export interface SupabaseKeyInspection {
  keyType: SupabaseKeyType;
  role: string;
  ref: string;
  isSecret: boolean;
  isUrl: boolean;
}

export function inspectSupabaseKey(rawKey: string): SupabaseKeyInspection {
  const cleaned = cleanConfigValue(rawKey);
  if (!cleaned) {
    return { keyType: 'invalid', role: '', ref: '', isSecret: false, isUrl: false };
  }
  if (/^https?:\/\//i.test(cleaned) || /\.supabase\.co(\/|$)/i.test(cleaned)) {
    return { keyType: 'invalid', role: '', ref: '', isSecret: false, isUrl: true };
  }
  if (/^sb_secret_/i.test(cleaned)) {
    return { keyType: 'invalid', role: 'secret', ref: '', isSecret: true, isUrl: false };
  }
  if (/^sb_publishable_[A-Za-z0-9_-]{12,}$/i.test(cleaned)) {
    return { keyType: 'publishable', role: 'anon', ref: '', isSecret: false, isUrl: false };
  }
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cleaned)) {
    const payload = decodeJwtPayload(cleaned);
    if (!payload) {
      return { keyType: 'invalid', role: '', ref: '', isSecret: false, isUrl: false };
    }
    const role = typeof payload.role === 'string' ? payload.role : '';
    const ref = typeof payload.ref === 'string' ? payload.ref.toLowerCase() : '';
    if (role === 'service_role') {
      return { keyType: 'invalid', role, ref, isSecret: true, isUrl: false };
    }
    if (!role || role === 'anon') {
      return { keyType: 'anon_jwt', role: role || 'anon', ref, isSecret: false, isUrl: false };
    }
  }
  return { keyType: 'invalid', role: '', ref: '', isSecret: false, isUrl: false };
}

export function maskSupabaseKey(rawKey: string): string {
  const cleaned = cleanConfigValue(rawKey);
  if (!cleaned) return 'Chưa có';
  if (cleaned.length <= 12) return '••••••••';
  if (cleaned.startsWith('sb_publishable_')) {
    return `sb_publishable_••••${cleaned.slice(-4)}`;
  }
  return `${cleaned.slice(0, 6)}••••${cleaned.slice(-4)}`;
}

export function getSupabaseUrlError(rawUrl: string): string | null {
  const trimmed = normalizeSupabaseUrl(rawUrl);
  if (!trimmed) return 'Vui lòng nhập Supabase Project URL.';
  if (
    /^sb_(publishable|secret)_/i.test(trimmed) ||
    /^eyJ[A-Za-z0-9_-]+\./.test(trimmed)
  ) {
    return 'Supabase Project URL không hợp lệ. Vui lòng nhập URL dự án dạng https://<project-ref>.supabase.co. Bạn có thể đang nhập nhầm API Key vào trường URL.';
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.hostname === 'supabase.com' ||
      parsed.pathname.includes('/dashboard/')
    ) {
      return 'Đây là link trang quản trị Dashboard. Hãy dùng Project URL dạng https://<project-ref>.supabase.co (trong Project Settings -> API).';
    }
    if (parsed.protocol !== 'https:') {
      return 'Supabase Project URL không hợp lệ. Vui lòng nhập URL dự án dạng https://<project-ref>.supabase.co. Bạn có thể đang nhập nhầm API Key vào trường URL.';
    }
    if (
      !/^[a-z0-9-]{8,40}\.supabase\.co$/i.test(parsed.hostname) ||
      (parsed.pathname !== '/' && parsed.pathname !== '') ||
      Boolean(parsed.search) ||
      Boolean(parsed.hash)
    ) {
      return 'Supabase Project URL không hợp lệ. Vui lòng nhập URL dự án dạng https://<project-ref>.supabase.co. Bạn có thể đang nhập nhầm API Key vào trường URL.';
    }
    return null;
  } catch {
    return 'Supabase Project URL không hợp lệ. Vui lòng nhập URL dự án dạng https://<project-ref>.supabase.co. Bạn có thể đang nhập nhầm API Key vào trường URL.';
  }
}

export function getSupabaseKeyError(
  rawKey: string,
  rawUrl?: string
): string | null {
  const cleaned = cleanConfigValue(rawKey);
  if (!cleaned) {
    return 'Public Key không hợp lệ. Vui lòng kiểm tra lại API Key của dự án Supabase.';
  }
  const info = inspectSupabaseKey(cleaned);
  if (info.isUrl) {
    return 'Public Key không hợp lệ. Bạn có thể đang nhập nhầm Project URL vào trường Public Key.';
  }
  if (info.isSecret) {
    return 'Không được sử dụng Secret Key hoặc Service Role Key ở phía ứng dụng. Hãy dùng Publishable Key (sb_publishable_...) hoặc Anon Key (role anon).';
  }
  if (info.keyType === 'invalid') {
    return 'Public Key không hợp lệ. Vui lòng kiểm tra lại API Key của dự án Supabase.';
  }
  if (rawUrl && info.ref) {
    const urlRef = extractSupabaseProjectRef(rawUrl);
    if (urlRef && urlRef !== info.ref) {
      return `Public Key (ref: ${info.ref}) không khớp với Supabase Project URL (ref: ${urlRef}).`;
    }
  }
  return null;
}

export interface SupabaseConfigValidation {
  valid: boolean;
  urlError: string | null;
  keyError: string | null;
  projectRef: string;
  keyType: SupabaseKeyType;
  maskedKey: string;
  normalized: SupabaseConfig;
}

export function validateSupabaseConfig(
  config: SupabaseConfig
): SupabaseConfigValidation {
  const normalized: SupabaseConfig = {
    url: normalizeSupabaseUrl(config.url || ''),
    anonKey: cleanConfigValue(config.anonKey || ''),
  };
  const urlError = getSupabaseUrlError(normalized.url);
  const keyError = getSupabaseKeyError(normalized.anonKey, normalized.url);
  const info = inspectSupabaseKey(normalized.anonKey);
  const projectRef = extractSupabaseProjectRef(normalized.url);
  return {
    valid: !urlError && !keyError,
    urlError,
    keyError,
    projectRef,
    keyType: info.keyType,
    maskedKey: maskSupabaseKey(normalized.anonKey),
    normalized,
  };
}

export function isValidSupabaseConfig(config: SupabaseConfig): boolean {
  return validateSupabaseConfig(config).valid;
}

export function getEnvSupabaseConfig(): SupabaseConfig {
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
  const anonKey =
    (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
    (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
    '';
  return { url: normalizeSupabaseUrl(url), anonKey: cleanConfigValue(anonKey) };
}

export function getValidatedEnvSupabaseConfig(): {
  config: SupabaseConfig;
  valid: boolean;
  error: string | null;
  hasAnyRaw: boolean;
} {
  const raw = getEnvSupabaseConfig();
  const hasAnyRaw = Boolean(raw.url || raw.anonKey);
  if (!hasAnyRaw) {
    return { config: raw, valid: false, error: null, hasAnyRaw: false };
  }
  const check = validateSupabaseConfig(raw);
  return {
    config: check.normalized,
    valid: check.valid,
    error: check.urlError || check.keyError,
    hasAnyRaw: true,
  };
}

export function detectClientRuntimeEnv(): SupabaseRuntimeEnv {
  if (typeof window === 'undefined') return 'local';
  const host = window.location.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
    return 'local';
  }
  if (
    host.includes('aistudio') ||
    host.includes('run.app') ||
    host.includes('webcontainer') ||
    isInsideIframe()
  ) {
    return 'ai_studio';
  }
  if (host.endsWith('.vercel.app')) {
    return host.includes('-git-') ? 'vercel_preview' : 'vercel_production';
  }
  return 'vercel_production';
}

export interface RuntimeConfigFetchResult {
  config: SupabaseConfig | null;
  valid: boolean;
  envError: string | null;
  runtimeEnv: SupabaseRuntimeEnv | null;
}

export async function fetchRuntimeSupabaseConfig(): Promise<RuntimeConfigFetchResult> {
  try {
    const res = await fetch('/api/public-config', {
      cache: 'no-store',
    });
    if (!res.ok) {
      return { config: null, valid: false, envError: null, runtimeEnv: null };
    }
    const json = (await res.json()) as {
      url?: string;
      anonKey?: string;
      envError?: string | null;
      runtimeEnv?: SupabaseRuntimeEnv | null;
    };
    const cfg: SupabaseConfig = {
      url: normalizeSupabaseUrl(json.url || ''),
      anonKey: cleanConfigValue(json.anonKey || ''),
    };
    if (json.envError) {
      return {
        config: null,
        valid: false,
        envError: json.envError,
        runtimeEnv: json.runtimeEnv ?? null,
      };
    }
    if (!cfg.url && !cfg.anonKey) {
      return {
        config: null,
        valid: false,
        envError: null,
        runtimeEnv: json.runtimeEnv ?? null,
      };
    }
    const validation = validateSupabaseConfig(cfg);
    return {
      config: validation.valid ? validation.normalized : null,
      valid: validation.valid,
      envError: validation.valid ? null : validation.urlError || validation.keyError,
      runtimeEnv: json.runtimeEnv ?? null,
    };
  } catch {
    return { config: null, valid: false, envError: null, runtimeEnv: null };
  }
}

export function getOAuthCallbackUrl(): string {
  if (typeof window === 'undefined') return '/auth/callback';
  return `${window.location.origin}/auth/callback`;
}

export function getSupabaseProviderCallbackUrl(rawUrl: string): string {
  const clean = normalizeSupabaseUrl(rawUrl);
  return clean ? `${clean}/auth/v1/callback` : '';
}

export function isInsideIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function getSupabaseClient(
  config: SupabaseConfig
): SupabaseClient | null {
  if (!isValidSupabaseConfig(config)) return null;
  const cleanUrl = normalizeSupabaseUrl(config.url);
  const cleanKey = config.anonKey.trim();
  const key = `${cleanUrl}::${cleanKey}`;
  if (cachedClient && cachedClientKey === key) {
    return cachedClient;
  }
  cachedClientKey = key;
  cachedClient = createClient(cleanUrl, cleanKey, {
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

export function formatSupabaseAuthError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Xác thực Supabase Auth thất bại.';
  const lower = raw.toLowerCase();

  if (lower.includes('invalid login credentials')) {
    return 'Email hoặc mật khẩu chưa đúng trên Supabase Auth (nếu chưa có tài khoản Supabase Auth, hãy chuyển sang tab Đăng ký hoặc dùng Mã OTP Email).';
  }
  if (lower.includes('email not confirmed')) {
    return 'Email chưa được xác nhận trên Supabase Auth. Hãy nhập mã xác nhận 6 số gửi về Gmail hoặc tắt Confirm Email trong Supabase Dashboard -> Authentication -> Providers -> Email.';
  }
  if (lower.includes('user already registered')) {
    return 'Email này đã được tạo trên Supabase Auth trước đó. Hãy chuyển sang "Đăng nhập" bằng mật khẩu hoặc dùng Mã OTP Email.';
  }
  if (lower.includes('unsupported provider') || lower.includes('provider is not enabled')) {
    return 'Google OAuth chưa được bật trên Supabase Project này. Hãy vào Supabase Dashboard -> Authentication -> Providers -> Google để bật, hoặc dùng Mã OTP Email / Mật khẩu ngay bên dưới.';
  }
  if (lower.includes('signups not allowed')) {
    return 'Dự án Supabase đang tắt cho phép đăng ký tài khoản mới (Allow new users to sign up). Hãy bật trong Authentication -> Providers -> Email.';
  }
  if (lower.includes('rate limit') || lower.includes('security purposes')) {
    return 'Gửi yêu cầu quá nhanh (giới hạn gửi email của Supabase). Vui lòng chờ khoảng 60 giây rồi thử lại.';
  }
  if (lower.includes('token has expired') || lower.includes('otp_expired') || lower.includes('invalid otp')) {
    return 'Mã OTP không đúng hoặc đã hết hạn. Vui lòng yêu cầu gửi lại mã mới.';
  }
  if (lower.includes('invalid api key') || lower.includes('apikey')) {
    return 'Supabase Anon Key không đúng. Hãy kiểm tra lại khóa công khai (anon / public) trong Project Settings -> API.';
  }
  if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
    return 'Không kết nối được tới máy chủ Supabase. Kiểm tra lại Project URL hoặc kết nối mạng.';
  }
  if (lower.includes('code verifier')) {
    return 'Phiên xác thực PKCE bị gián đoạn giữa các cửa sổ. Vui lòng thử lại hoặc dùng Mã OTP Email.';
  }
  if (lower.includes('unauthorized-domain')) {
    const host = typeof window !== 'undefined' ? window.location.host : 'domain Vercel';
    return `Tên miền "${host}" chưa được thêm vào Authorized Domains trong Firebase Console -> Authentication -> Settings. Hãy thêm "${host}" hoặc dùng đăng nhập Email/OTP Supabase.`;
  }
  if (lower.includes('redirect_uri_mismatch') || lower.includes('redirect url')) {
    const cb = typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : '/auth/callback';
    return `Redirect URL chưa khớp. Hãy thêm "${cb}" vào Supabase Dashboard -> Authentication -> URL Configuration -> Redirect URLs.`;
  }
  return raw;
}

export interface SupabaseAuthSettings {
  ok: boolean;
  googleEnabled: boolean;
  emailEnabled: boolean;
  mailerAutoconfirm: boolean;
  disableSignup: boolean;
  error?: string;
}

export async function fetchSupabaseAuthSettings(
  config: SupabaseConfig
): Promise<SupabaseAuthSettings> {
  const urlErr = getSupabaseUrlError(config.url);
  if (urlErr || !config.anonKey.trim()) {
    return {
      ok: false,
      googleEnabled: false,
      emailEnabled: false,
      mailerAutoconfirm: false,
      disableSignup: false,
      error: urlErr || 'Thiếu Supabase Anon Key.',
    };
  }
  const cleanUrl = normalizeSupabaseUrl(config.url);
  try {
    const res = await fetch(`${cleanUrl}/auth/v1/settings`, {
      headers: {
        apikey: config.anonKey.trim(),
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        googleEnabled: false,
        emailEnabled: false,
        mailerAutoconfirm: false,
        disableSignup: false,
        error:
          res.status === 401 || res.status === 403
            ? 'Anon Key không hợp lệ cho Project URL này.'
            : `Máy chủ Supabase Auth phản hồi lỗi (${res.status}).`,
      };
    }
    const json = (await res.json()) as {
      external?: Record<string, boolean>;
      disable_signup?: boolean;
      mailer_autoconfirm?: boolean;
    };
    return {
      ok: true,
      googleEnabled: Boolean(json.external?.google),
      emailEnabled: json.external?.email !== false,
      mailerAutoconfirm: Boolean(json.mailer_autoconfirm),
      disableSignup: Boolean(json.disable_signup),
    };
  } catch (err) {
    return {
      ok: false,
      googleEnabled: false,
      emailEnabled: false,
      mailerAutoconfirm: false,
      disableSignup: false,
      error: formatSupabaseAuthError(err),
    };
  }
}

export interface OAuthCallbackDetection {
  detected: boolean;
  relayed: boolean;
  missingOpener: boolean;
  error?: string;
}

/**
 * Handles OAuth redirect callback if the current window is an OAuth popup
 * or top-level redirect returning with ?code= or #access_token=.
 */
export async function handleSupabaseOAuthRedirectIfPresent(
  client: SupabaseClient | null
): Promise<OAuthCallbackDetection> {
  if (typeof window === 'undefined') {
    return { detected: false, relayed: false, missingOpener: false };
  }
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
    return { detected: false, relayed: false, missingOpener: false };
  }

  const payload = errorDesc
    ? { type: 'SUPABASE_OAUTH_RESULT', error: errorDesc }
    : accessToken && refreshToken
      ? { type: 'SUPABASE_OAUTH_RESULT', accessToken, refreshToken }
      : code
        ? { type: 'SUPABASE_OAUTH_RESULT', code }
        : null;

  let relayed = false;

  // 1) Relay via BroadcastChannel (survives COOP when same-origin storage isn't partitioned)
  if (payload && typeof BroadcastChannel !== 'undefined') {
    try {
      const bc = new BroadcastChannel(SUPABASE_OAUTH_CHANNEL);
      bc.postMessage(payload);
      bc.close();
    } catch {
      // Ignore BroadcastChannel errors
    }
  }

  // 2) Relay directly via window.opener if preserved
  if (payload && window.opener && window.opener !== window) {
    try {
      window.opener.postMessage(payload, window.location.origin);
      relayed = true;
    } catch {
      // Ignore cross-origin postMessage errors
    }
    if (relayed) {
      window.close();
      return {
        detected: true,
        relayed: true,
        missingOpener: false,
        error: errorDesc || undefined,
      };
    }
  }

  // 3) Direct top-level callback (e.g. mobile browser tab or standalone tab on Vercel)
  let exchangedOk = false;
  if (client) {
    try {
      if (accessToken && refreshToken) {
        const { error: setErr } = await client.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        exchangedOk = !setErr;
      } else if (code) {
        const { error: exErr } = await client.auth.exchangeCodeForSession(code);
        exchangedOk = !exErr;
      }
      if (exchangedOk) {
        const cleanUrl = `${window.location.origin}${window.location.pathname === '/auth/callback' ? '/' : window.location.pathname}`;
        window.history.replaceState({}, document.title, cleanUrl);
      }
    } catch {
      // Ignore exchange failure if verifier belonged to opener window
    }
  }

  const isCallbackRoute = window.location.pathname === '/auth/callback';
  return {
    detected: true,
    relayed: false,
    missingOpener: !exchangedOk && isCallbackRoute && !window.opener,
    error: errorDesc || undefined,
  };
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
    throw new Error(
      error ? formatSupabaseAuthError(error) : 'Không thể khởi tạo đăng nhập Google.'
    );
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
      'Trình duyệt đã chặn cửa sổ bật lên (popup). Vui lòng cho phép popup hoặc dùng Mã xác nhận OTP Email bên dưới.'
    );
  }

  return new Promise<Session>((resolve, reject) => {
    let settled = false;
    let bc: BroadcastChannel | null = null;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      if (bc) {
        bc.close();
        bc = null;
      }
      window.clearInterval(closedCheck);
      window.clearTimeout(timeoutId);
    };

    const handlePayload = async (
      payload:
        | {
            type?: string;
            code?: string;
            accessToken?: string;
            refreshToken?: string;
            error?: string;
          }
        | undefined
    ) => {
      if (!payload || payload.type !== 'SUPABASE_OAUTH_RESULT') return;
      if (settled) return;
      settled = true;
      cleanup();

      try {
        if (!popup.closed) popup.close();
      } catch {
        // Ignore cross-origin close
      }

      if (payload.error) {
        reject(new Error(formatSupabaseAuthError(payload.error)));
        return;
      }

      if (payload.code) {
        const { data: exchanged, error: exchangeErr } =
          await client.auth.exchangeCodeForSession(payload.code);
        if (exchangeErr || !exchanged.session) {
          reject(
            new Error(
              exchangeErr
                ? formatSupabaseAuthError(exchangeErr)
                : 'Không thể đổi mã xác thực Google lấy phiên Supabase.'
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
          new Error(
            sessionErr
              ? formatSupabaseAuthError(sessionErr)
              : 'Không thể thiết lập phiên Supabase.'
          )
        );
        return;
      }
      resolve(sessionData.session);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      void handlePayload(
        event.data as
          | {
              type?: string;
              code?: string;
              accessToken?: string;
              refreshToken?: string;
              error?: string;
            }
          | undefined
      );
    };

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        bc = new BroadcastChannel(SUPABASE_OAUTH_CHANNEL);
        bc.onmessage = (event) => {
          void handlePayload(
            event.data as
              | {
                  type?: string;
                  code?: string;
                  accessToken?: string;
                  refreshToken?: string;
                  error?: string;
                }
              | undefined
          );
        };
      } catch {
        bc = null;
      }
    }

    const closedCheck = window.setInterval(() => {
      if (popup.closed && !settled) {
        settled = true;
        cleanup();
        reject(
          new Error(
            'Cửa sổ đăng nhập đã đóng trước khi hoàn tất (hãy kiểm tra Google Provider & Redirect URL trong Supabase Dashboard, hoặc dùng Mã OTP Email bên dưới).'
          )
        );
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
    shiftId: r.shift_id ? String(r.shift_id) : null,
    isDayOff: Boolean(r.is_day_off),
    overrideApproved: Boolean(r.override_approved),
    overrideReason: String(r.override_reason || ''),
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
    modulePerms:
      r.module_perms && typeof r.module_perms === 'object'
        ? (r.module_perms as Partial<ModuleAccessFlags>)
        : undefined,
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
// Connection Diagnostics (Auth + 13 Tables + RLS + Storage + Realtime WS)
// ============================================================================
export interface SupabaseDiagnosticItem {
  name: string;
  ok: boolean;
  status: string;
}

export interface SupabaseConnectionTestResult {
  ok: boolean;
  overallStatus: SupabaseOverallStatus;
  message: string;
  tablesReady?: boolean;
  erpReady?: boolean;
  authStatus: SupabaseSubsystemStatus;
  dbStatus: SupabaseSubsystemStatus;
  realtimeStatus: SupabaseSubsystemStatus;
  storageStatus: SupabaseSubsystemStatus;
  projectRef: string;
  keyType: SupabaseKeyType;
  maskedKey: string;
  checkedAt: string;
  lastError: string | null;
  details?: SupabaseDiagnosticItem[];
}

async function probeSupabaseRealtime(
  client: SupabaseClient
): Promise<{ ok: boolean; statusText: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const channelName = `diag-ping-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const ch = client.channel(channelName);

    const finish = (ok: boolean, statusText: string, error?: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      void client.removeChannel(ch);
      resolve({ ok, statusText, error });
    };

    const timer = window.setTimeout(() => {
      finish(
        false,
        'Hết thời gian kết nối WebSocket (6s)',
        'Realtime WebSocket không phản hồi trong 6 giây.'
      );
    }, 6000);

    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        finish(true, 'WebSocket kết nối ổn định');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        finish(
          false,
          `Lỗi kênh Realtime (${status})`,
          err?.message || `Realtime phản hồi trạng thái ${status}`
        );
      }
    });
  });
}

export async function testSupabaseConnection(
  config: SupabaseConfig
): Promise<SupabaseConnectionTestResult> {
  const checkedAt = new Date().toISOString();
  const validation = validateSupabaseConfig(config);
  if (!validation.valid) {
    const errMsg =
      validation.urlError || validation.keyError || 'Cấu hình Supabase không hợp lệ.';
    return {
      ok: false,
      overallStatus: 'invalid_config',
      message: errMsg,
      authStatus: 'error',
      dbStatus: 'error',
      realtimeStatus: 'idle',
      storageStatus: 'idle',
      projectRef: validation.projectRef,
      keyType: validation.keyType,
      maskedKey: validation.maskedKey,
      checkedAt,
      lastError: errMsg,
    };
  }

  try {
    const client = getSupabaseClient(validation.normalized);
    if (!client) {
      return {
        ok: false,
        overallStatus: 'invalid_config',
        message: 'Không thể khởi tạo Supabase client.',
        authStatus: 'error',
        dbStatus: 'error',
        realtimeStatus: 'idle',
        storageStatus: 'idle',
        projectRef: validation.projectRef,
        keyType: validation.keyType,
        maskedKey: validation.maskedKey,
        checkedAt,
        lastError: 'Không thể khởi tạo Supabase client.',
      };
    }

    const coreTables = [
      'barcode_scans',
      'work_schedules',
      'user_access',
      'activity_logs',
    ] as const;
    const erpTables = [
      'system_settings',
      'shift_definitions',
      'attendance_logs',
      'customer_feedbacks',
      'product_catalog',
      'supplier_policies',
      'expiry_tracking',
      'return_records',
      'promotions',
    ] as const;

    const [authRes, coreResults, erpResults, storageRes, realtimeRes] =
      await Promise.all([
        fetchSupabaseAuthSettings(validation.normalized),
        Promise.all(
          coreTables.map(async (t) => ({
            table: t,
            res: await client.from(t).select('id', { count: 'exact', head: true }),
          }))
        ),
        Promise.all(
          erpTables.map(async (t) => ({
            table: t,
            res: await client
              .from(t)
              .select(t === 'system_settings' ? 'key' : 'id', {
                count: 'exact',
                head: true,
              }),
          }))
        ),
        client.storage.from('internal-media').list('', { limit: 1 }),
        probeSupabaseRealtime(client),
      ]);

    const details: SupabaseDiagnosticItem[] = [];
    details.push({
      name: 'Supabase Auth API',
      ok: authRes.ok,
      status: authRes.ok
        ? `Hoạt động (Google OAuth: ${authRes.googleEnabled ? 'Bật' : 'Tắt'}, Email OTP: ${authRes.emailEnabled ? 'Bật' : 'Tắt'})`
        : authRes.error || 'Không phản hồi',
    });

    details.push({
      name: 'Realtime WebSocket',
      ok: realtimeRes.ok,
      status: realtimeRes.statusText,
    });

    const isMissingTableErr = (msg: string) =>
      msg.includes('does not exist') ||
      msg.includes('schema cache') ||
      msg.includes('42P01');

    const isRlsBlocked = (msg: string) =>
      msg.includes('permission denied') ||
      msg.includes('RLS') ||
      msg.includes('row-level security');

    let missingCore = 0;
    let missingErp = 0;
    let rlsProtectedCount = 0;
    let networkErrMsg = '';

    for (const item of coreResults) {
      const err = item.res.error;
      if (!err) {
        details.push({
          name: `Bảng ${item.table}`,
          ok: true,
          status: `Sẵn sàng (${item.res.count ?? 0} bản ghi)`,
        });
      } else if (isMissingTableErr(err.message || '')) {
        missingCore += 1;
        details.push({
          name: `Bảng ${item.table}`,
          ok: false,
          status: 'Chưa tạo (cần chạy schema.sql)',
        });
      } else if (isRlsBlocked(err.message || '')) {
        rlsProtectedCount += 1;
        details.push({
          name: `Bảng ${item.table}`,
          ok: true,
          status: 'Đã tạo & bật RLS (cần đăng nhập Supabase Auth để đọc)',
        });
      } else {
        networkErrMsg = networkErrMsg || err.message;
        details.push({
          name: `Bảng ${item.table}`,
          ok: false,
          status: err.message,
        });
      }
    }

    for (const item of erpResults) {
      const err = item.res.error;
      if (!err) {
        details.push({
          name: `Bảng ${item.table}`,
          ok: true,
          status: `Sẵn sàng (${item.res.count ?? 0} bản ghi)`,
        });
      } else if (isMissingTableErr(err.message || '')) {
        missingErp += 1;
        details.push({
          name: `Bảng ${item.table}`,
          ok: false,
          status: 'Chưa tạo (cần chạy 002_full_erp.sql)',
        });
      } else if (isRlsBlocked(err.message || '')) {
        rlsProtectedCount += 1;
        details.push({
          name: `Bảng ${item.table}`,
          ok: true,
          status: 'Đã tạo & bật RLS',
        });
      } else {
        networkErrMsg = networkErrMsg || err.message;
        details.push({
          name: `Bảng ${item.table}`,
          ok: false,
          status: err.message,
        });
      }
    }

    const { data: sessData } = await client.auth.getSession();
    const hasSession = Boolean(sessData?.session);

    let storageStatus: SupabaseSubsystemStatus = 'ok';
    if (storageRes.error) {
      const sMsg = storageRes.error.message || '';
      if (sMsg.toLowerCase().includes('not found') || sMsg.toLowerCase().includes('bucket')) {
        storageStatus = hasSession ? 'warning' : 'rls_protected';
        details.push({
          name: 'Storage (internal-media)',
          ok: !hasSession,
          status: hasSession
            ? 'Chưa tạo bucket internal-media (cần chạy 002_full_erp.sql)'
            : 'Bucket private (cần đăng nhập Supabase Auth để xác minh)',
        });
      } else {
        storageStatus = 'rls_protected';
        details.push({
          name: 'Storage (internal-media)',
          ok: true,
          status: 'Bucket có bảo vệ RLS',
        });
      }
    } else {
      details.push({
        name: 'Storage (internal-media)',
        ok: true,
        status: 'Sẵn sàng',
      });
    }

    const authStatus: SupabaseSubsystemStatus = authRes.ok ? 'ok' : 'error';
    const realtimeStatus: SupabaseSubsystemStatus = realtimeRes.ok ? 'ok' : 'error';
    const dbStatus: SupabaseSubsystemStatus =
      networkErrMsg
        ? 'error'
        : missingCore > 0 || missingErp > 0
          ? 'warning'
          : rlsProtectedCount > 0 && !hasSession
            ? 'rls_protected'
            : 'ok';

    if (!authRes.ok && networkErrMsg) {
      return {
        ok: false,
        overallStatus: 'network_error',
        message: `Lỗi kết nối Supabase: ${networkErrMsg}`,
        authStatus,
        dbStatus,
        realtimeStatus,
        storageStatus,
        projectRef: validation.projectRef,
        keyType: validation.keyType,
        maskedKey: validation.maskedKey,
        checkedAt,
        lastError: networkErrMsg,
        details,
      };
    }

    if (!authRes.ok) {
      return {
        ok: false,
        overallStatus: 'auth_error',
        message: authRes.error || 'Lỗi kết nối Supabase Auth API.',
        authStatus,
        dbStatus,
        realtimeStatus,
        storageStatus,
        projectRef: validation.projectRef,
        keyType: validation.keyType,
        maskedKey: validation.maskedKey,
        checkedAt,
        lastError: authRes.error || 'Lỗi Supabase Auth API',
        details,
      };
    }

    if (missingCore > 0 || missingErp > 0) {
      const msg =
        missingCore > 0
          ? `Đã kết nối tới Supabase nhưng thiếu ${missingCore} bảng nền tảng. Hãy mở SQL Editor chạy "Schema nền tảng" rồi chạy "Nâng cấp ERP 002".`
          : `Đã kết nối Supabase (4 bảng cơ bản đã sẵn sàng) nhưng còn thiếu ${missingErp} bảng ERP mới. Hãy chạy script "Nâng cấp ERP 002" trong SQL Editor.`;
      return {
        ok: false,
        overallStatus: 'schema_error',
        tablesReady: missingCore === 0,
        erpReady: false,
        authStatus,
        dbStatus,
        realtimeStatus,
        storageStatus,
        projectRef: validation.projectRef,
        keyType: validation.keyType,
        maskedKey: validation.maskedKey,
        checkedAt,
        lastError: msg,
        details,
        message: msg,
      };
    }

    if (!realtimeRes.ok) {
      return {
        ok: false,
        overallStatus: 'realtime_error',
        tablesReady: true,
        erpReady: true,
        authStatus,
        dbStatus,
        realtimeStatus,
        storageStatus,
        projectRef: validation.projectRef,
        keyType: validation.keyType,
        maskedKey: validation.maskedKey,
        checkedAt,
        lastError: realtimeRes.error || realtimeRes.statusText,
        details,
        message: `Kết nối Database thành công (13/13 bảng sẵn sàng) nhưng Realtime WebSocket gặp lỗi: ${realtimeRes.statusText}`,
      };
    }

    const overallStatus: SupabaseOverallStatus =
      hasSession || rlsProtectedCount === 0 ? 'connected_full' : 'connected_db_rls';

    return {
      ok: true,
      overallStatus,
      tablesReady: true,
      erpReady: true,
      authStatus,
      dbStatus,
      realtimeStatus,
      storageStatus,
      projectRef: validation.projectRef,
      keyType: validation.keyType,
      maskedKey: validation.maskedKey,
      checkedAt,
      lastError: null,
      details,
      message: hasSession
        ? 'Kết nối hoàn chỉnh: Auth, 13 bảng ERP, RLS, Realtime WebSocket và Storage đang hoạt động.'
        : 'Kết nối Database & Realtime thành công (13/13 bảng sẵn sàng). Hãy kích hoạt phiên Supabase Auth để đọc/ghi dữ liệu theo RLS.',
    };
  } catch (error) {
    const errText =
      error instanceof Error ? error.message : 'Không thể kết nối tới Supabase.';
    return {
      ok: false,
      overallStatus: 'network_error',
      message: errText,
      authStatus: 'error',
      dbStatus: 'error',
      realtimeStatus: 'error',
      storageStatus: 'idle',
      projectRef: validation.projectRef,
      keyType: validation.keyType,
      maskedKey: validation.maskedKey,
      checkedAt,
      lastError: errText,
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

export async function requireAuthenticatedSession(
  client: SupabaseClient
): Promise<
  | { ok: true; userId: string; email: string }
  | { ok: false; error: string }
> {
  const { data, error } = await client.auth.getSession();
  const user = data?.session?.user;
  if (error || !user?.id) {
    return {
      ok: false,
      error:
        'Phiên Supabase Auth chưa được kích hoạt hoặc đã hết hạn. Vui lòng đăng nhập lại trong mục Quản lý Supabase.',
    };
  }
  return {
    ok: true,
    userId: user.id,
    email: normalizeEmail(user.email || ''),
  };
}

export function formatSupabaseWriteError(
  rawMessage: string | undefined,
  tableName: string,
  fallbackMessage: string
): string {
  const msg = (rawMessage || '').trim();
  if (!msg) return fallbackMessage;
  if (
    /row-level security policy/i.test(msg) ||
    /permission denied for table/i.test(msg)
  ) {
    return `Từ chối quyền ghi (RLS) tại bảng "${tableName}". Hãy kiểm tra tài khoản đã kích hoạt phiên Supabase Auth, có quyền hợp lệ trong user_access và đã chạy script SQL 003_fix_rls_policies.sql trong Supabase SQL Editor.`;
  }
  return msg;
}

export async function upsertUserProfile(
  client: SupabaseClient,
  params: { uid: string; email: string; displayName: string; photoURL?: string }
): Promise<void> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return;
  const email = authCheck.email || normalizeEmail(params.email);
  if (!email) return;

  await client.from('user_profiles').upsert(
    {
      id: authCheck.userId,
      email,
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
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  const actorEmail = authCheck.email || normalizeEmail(params.ownerEmail);
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('barcode_scans')
    .insert({
      id: params.id,
      owner_id: authCheck.userId,
      owner_email: actorEmail,
      code: params.code,
      format: params.format,
      session_name: params.sessionName,
      quantity: params.quantity,
      note: params.note,
      version: 1,
      updated_by: actorEmail,
      scanned_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error || !data) {
    return {
      error: formatSupabaseWriteError(
        error?.message,
        'barcode_scans',
        'Không thể lưu mã vạch lên Supabase.'
      ),
    };
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
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { status: 'error', error: authCheck.error };

  const dbUpdates: Record<string, unknown> = {
    version: params.expectedVersion + 1,
    updated_by: authCheck.email || normalizeEmail(params.actorEmail),
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
    return {
      status: 'error',
      error: formatSupabaseWriteError(
        error.message,
        'barcode_scans',
        'Không thể cập nhật mã vạch.'
      ),
    };
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
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  const { error } = await client.from('barcode_scans').delete().in('id', ids);
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'barcode_scans',
        'Không thể xóa mã vạch.'
      ),
    };
  }
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
    shiftId?: string | null;
    isDayOff?: boolean;
    overrideApproved?: boolean;
    overrideReason?: string;
    startTime: string;
    endTime: string;
    location: string;
    note: string;
  }
): Promise<{ data?: WorkSchedule; error?: string }> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  const actorEmail = authCheck.email || normalizeEmail(params.ownerEmail);
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    id: params.id,
    owner_id: authCheck.userId,
    owner_email: actorEmail,
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
    updated_by: actorEmail,
    created_at: now,
    updated_at: now,
  };
  if (params.shiftId !== undefined) payload.shift_id = params.shiftId;
  if (params.isDayOff !== undefined) payload.is_day_off = params.isDayOff;
  if (params.overrideApproved !== undefined) payload.override_approved = params.overrideApproved;
  if (params.overrideReason !== undefined) payload.override_reason = params.overrideReason;

  const { data, error } = await client
    .from('work_schedules')
    .insert(payload)
    .select()
    .single();

  if (error || !data) {
    return {
      error: formatSupabaseWriteError(
        error?.message,
        'work_schedules',
        'Không thể đăng ký lịch làm việc trên Supabase.'
      ),
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
      shiftId: string | null;
      isDayOff: boolean;
      overrideApproved: boolean;
      overrideReason: string;
      startTime: string;
      endTime: string;
      location: string;
      status: ScheduleStatus;
      note: string;
    }>;
  }
): Promise<OptimisticUpdateResult<WorkSchedule>> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { status: 'error', error: authCheck.error };

  const actorEmail = authCheck.email || normalizeEmail(params.actorEmail);
  const now = new Date().toISOString();
  const dbUpdates: Record<string, unknown> = {
    version: params.expectedVersion + 1,
    updated_by: actorEmail,
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
  if (params.updates.shiftId !== undefined) {
    dbUpdates.shift_id = params.updates.shiftId;
  }
  if (params.updates.isDayOff !== undefined) {
    dbUpdates.is_day_off = params.updates.isDayOff;
  }
  if (params.updates.overrideApproved !== undefined) {
    dbUpdates.override_approved = params.updates.overrideApproved;
  }
  if (params.updates.overrideReason !== undefined) {
    dbUpdates.override_reason = params.updates.overrideReason;
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
      dbUpdates.approved_by = actorEmail;
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
    return {
      status: 'error',
      error: formatSupabaseWriteError(
        error.message,
        'work_schedules',
        'Không thể cập nhật lịch làm việc.'
      ),
    };
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
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  const { error } = await client.from('work_schedules').delete().eq('id', id);
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'work_schedules',
        'Không thể xóa lịch làm việc.'
      ),
    };
  }
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
    modulePerms?: Partial<ModuleAccessFlags>;
    note: string;
    grantedBy: string;
    expectedVersion?: number;
    isEdit: boolean;
  }
): Promise<OptimisticUpdateResult<AuthorizedEmail>> {
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { status: 'error', error: authCheck.error };

  const cleanEmail = normalizeEmail(params.email);
  const id = emailToKey(cleanEmail);
  const now = new Date().toISOString();

  const payload: Record<string, unknown> = {
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
    granted_by: authCheck.email || normalizeEmail(params.grantedBy),
    updated_at: now,
  };
  if (params.modulePerms) {
    payload.module_perms = params.modulePerms;
  }

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

    if (error) {
      return {
        status: 'error',
        error: formatSupabaseWriteError(
          error.message,
          'user_access',
          'Không thể cập nhật phân quyền.'
        ),
      };
    }
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
      error: formatSupabaseWriteError(
        error?.message,
        'user_access',
        'Không thể lưu phân quyền trên Supabase.'
      ),
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
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { error: authCheck.error };

  const { error } = await client.from('user_access').delete().eq('id', id);
  if (error) {
    return {
      error: formatSupabaseWriteError(
        error.message,
        'user_access',
        'Không thể xóa phân quyền.'
      ),
    };
  }
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
  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return null;

  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const row = {
    id,
    actor_id: authCheck.userId,
    actor_email: authCheck.email || normalizeEmail(params.actorEmail),
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

  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { syncedIds: [], error: authCheck.error };

  const rows = scans.map((s) => {
    const cleanOwnerEmail = normalizeEmail(s.ownerEmail) || authCheck.email;
    const isSelf = !cleanOwnerEmail || cleanOwnerEmail === authCheck.email;
    return {
      id: s.id,
      owner_id: isSelf ? authCheck.userId : s.ownerId || authCheck.userId,
      owner_email: cleanOwnerEmail,
      code: s.code,
      format: s.format,
      session_name: s.sessionName,
      quantity: s.quantity,
      note: s.note || '',
      version: s.version || 1,
      updated_by: normalizeEmail(s.updatedBy || cleanOwnerEmail || authCheck.email),
      scanned_at: s.scannedAt || new Date().toISOString(),
      updated_at: s.updatedAt || new Date().toISOString(),
    };
  });

  const { error } = await client
    .from('barcode_scans')
    .upsert(rows, { onConflict: 'id' });
  if (error) {
    return {
      syncedIds: [],
      error: formatSupabaseWriteError(
        error.message,
        'barcode_scans',
        'Không thể chuyển dữ liệu mã vạch sang Supabase.'
      ),
    };
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

  const authCheck = await requireAuthenticatedSession(client);
  if (!authCheck.ok) return { syncedIds: [], error: authCheck.error };

  const rows = schedules.map((w) => {
    const cleanOwnerEmail = normalizeEmail(w.ownerEmail) || authCheck.email;
    const isSelf = !cleanOwnerEmail || cleanOwnerEmail === authCheck.email;
    return {
      id: w.id,
      owner_id: isSelf ? authCheck.userId : w.ownerId || authCheck.userId,
      owner_email: cleanOwnerEmail,
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
      updated_by: normalizeEmail(w.updatedBy || cleanOwnerEmail || authCheck.email),
      created_at: w.createdAt || new Date().toISOString(),
      updated_at: w.updatedAt || new Date().toISOString(),
    };
  });

  const { error } = await client
    .from('work_schedules')
    .upsert(rows, { onConflict: 'id' });
  if (error) {
    return {
      syncedIds: [],
      error: formatSupabaseWriteError(
        error.message,
        'work_schedules',
        'Không thể chuyển dữ liệu lịch làm việc sang Supabase.'
      ),
    };
  }
  return { syncedIds: schedules.map((w) => w.id) };
}
