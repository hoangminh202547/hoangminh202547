import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LogIn,
  MailCheck,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  UploadCloud,
  XCircle,
} from 'lucide-react';
import {
  SUPABASE_MIGRATION_002_SQL,
  SUPABASE_MIGRATION_003_SQL,
  SUPABASE_MIGRATION_004_SQL,
  SUPABASE_MIGRATION_005_SQL,
  SUPABASE_MIGRATION_006_SQL,
  SUPABASE_SCHEMA_SQL,
  extractSupabaseProjectRef,
  fetchSupabaseAuthSettings,
  formatSupabaseAuthError,
  getOAuthCallbackUrl,
  getSupabaseClient,
  getSupabaseKeyError,
  getSupabaseProviderCallbackUrl,
  getSupabaseUrlError,
  inspectSupabaseKey,
  isInsideIframe,
  isValidSupabaseConfig,
  maskSupabaseKey,
  normalizeSupabaseUrl,
  signInWithSupabaseGooglePopup,
  testSupabaseConnection,
  validateSupabaseConfig,
  type SupabaseAuthSettings,
  type SupabaseConnectionTestResult,
} from '../lib/supabase';
import type {
  DataBackendMode,
  SupabaseConfig,
  SupabaseConfigSource,
  SupabaseOverallStatus,
  SupabaseRuntimeEnv,
  SupabaseSubsystemStatus,
  SyncState,
} from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { SyncStatusBadge } from './SyncStatusBadge';

const CONFIG_SOURCE_LABELS: Record<SupabaseConfigSource, string> = {
  env_build: 'Biến môi trường Build (VITE_SUPABASE_*)',
  env_runtime: 'Biến môi trường Runtime (/api/public-config)',
  firestore_user: 'Hồ sơ Firestore',
  manual: 'Cấu hình thủ công trong ứng dụng',
  none: 'Chưa cấu hình',
};

const RUNTIME_ENV_LABELS: Record<SupabaseRuntimeEnv, string> = {
  vercel_production: 'Vercel Production',
  vercel_preview: 'Vercel Preview',
  ai_studio: 'Google AI Studio',
  local: 'Local Development',
};

const OVERALL_STATUS_LABELS: Record<
  SupabaseOverallStatus,
  { label: string; tone: string }
> = {
  not_configured: { label: 'Chưa cấu hình', tone: 'bg-slate-100 text-slate-700' },
  invalid_config: { label: 'Cấu hình không hợp lệ', tone: 'bg-red-100 text-red-800' },
  configured_untested: { label: 'Đã cấu hình (chưa kiểm tra)', tone: 'bg-blue-100 text-blue-800' },
  checking: { label: 'Đang kiểm tra kết nối', tone: 'bg-amber-100 text-amber-800' },
  connected_full: { label: 'Kết nối hoàn chỉnh', tone: 'bg-emerald-100 text-emerald-800' },
  connected_db_rls: { label: 'Kết nối Database thành công', tone: 'bg-emerald-100 text-emerald-800' },
  auth_error: { label: 'Lỗi Authentication', tone: 'bg-red-100 text-red-800' },
  permission_rls_error: { label: 'Lỗi quyền truy cập / RLS', tone: 'bg-amber-100 text-amber-800' },
  schema_error: { label: 'Lỗi cấu trúc bảng', tone: 'bg-amber-100 text-amber-800' },
  realtime_error: { label: 'Lỗi Realtime', tone: 'bg-amber-100 text-amber-800' },
  network_error: { label: 'Kết nối thất bại', tone: 'bg-red-100 text-red-800' },
};

const SUBSYSTEM_LABEL: Record<
  SupabaseSubsystemStatus,
  { text: string; color: string }
> = {
  idle: { text: 'Chưa kiểm tra', color: 'text-slate-500' },
  ok: { text: 'Hoạt động', color: 'text-emerald-700 font-medium' },
  rls_protected: { text: 'Bảo vệ RLS (chờ Auth)', color: 'text-blue-700 font-medium' },
  warning: { text: 'Cần lưu ý', color: 'text-amber-700 font-medium' },
  error: { text: 'Lỗi', color: 'text-red-600 font-medium' },
};

interface SupabasePanelProps {
  config: SupabaseConfig;
  configSource: SupabaseConfigSource;
  runtimeEnv: SupabaseRuntimeEnv;
  envBaselineConfig: SupabaseConfig | null;
  envValidationError: string | null;
  configConflictWarning: string | null;
  backendMode: DataBackendMode;
  syncState: SyncState;
  lastSyncedAt: string | null;
  legacyCounts: { scans: number; schedules: number; members: number };
  isSyncing: boolean;
  currentUserEmail: string;
  supabaseEmail: string | null;
  onSaveConfig: (config: SupabaseConfig) => Promise<void>;
  onRestoreEnvConfig: () => Promise<void>;
  onForceResync: () => Promise<void>;
  onMigrateFromFirebase: () => Promise<void>;
  onSupabaseSignedIn?: (session?: Session | null) => void;
  onNotify?: (type: 'success' | 'error' | 'info', message: string) => void;
}

export function SupabasePanel({
  config,
  configSource,
  runtimeEnv,
  envBaselineConfig,
  envValidationError,
  configConflictWarning,
  backendMode,
  syncState,
  lastSyncedAt,
  legacyCounts,
  isSyncing,
  currentUserEmail,
  supabaseEmail,
  onSaveConfig,
  onRestoreEnvConfig,
  onForceResync,
  onMigrateFromFirebase,
  onSupabaseSignedIn,
  onNotify,
}: SupabasePanelProps) {
  const [url, setUrl] = useState(config.url);
  const [anonKey, setAnonKey] = useState(config.anonKey);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] =
    useState<SupabaseConnectionTestResult | null>(null);
  const [pendingProjectSwitch, setPendingProjectSwitch] =
    useState<SupabaseConfig | null>(null);
  const [copiedSql, setCopiedSql] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [sqlTab, setSqlTab] = useState<'timeout_fix' | 'attendance_fix' | 'schema_sync' | 'rls_fix' | 'migration' | 'base'>(
    'timeout_fix'
  );

  // In-app Supabase Auth activation state
  const [authMethod, setAuthMethod] = useState<'otp' | 'password' | 'google'>(
    'otp'
  );
  const [authLoading, setAuthLoading] = useState(false);
  const [isSignUp, setIsSignUp] = useState(true);
  const [authEmail, setAuthEmail] = useState(currentUserEmail || '');
  const [authPassword, setAuthPassword] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpType, setOtpType] = useState<'email' | 'signup'>('email');
  const [otpToken, setOtpToken] = useState('');
  const [authSettings, setAuthSettings] = useState<SupabaseAuthSettings | null>(
    null
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [authInfo, setAuthInfo] = useState<string | null>(null);

  useEffect(() => {
    setUrl(config.url);
    setAnonKey(config.anonKey);
  }, [config.url, config.anonKey]);

  useEffect(() => {
    if (!authEmail && currentUserEmail) {
      setAuthEmail(currentUserEmail);
    }
  }, [currentUserEmail, authEmail]);

  const currentConfig: SupabaseConfig = {
    url: normalizeSupabaseUrl(url),
    anonKey: anonKey.trim(),
  };
  const urlValidationError = url.trim() ? getSupabaseUrlError(url) : null;
  const keyValidationError = anonKey.trim()
    ? getSupabaseKeyError(anonKey, url)
    : null;
  const draftValidation = validateSupabaseConfig(currentConfig);
  const activeValidation = validateSupabaseConfig(config);
  const activeKeyInfo = inspectSupabaseKey(config.anonKey);
  const configReady = draftValidation.valid;
  const inIframe = isInsideIframe();
  const callbackUrl = getOAuthCallbackUrl();
  const providerCallbackUrl = getSupabaseProviderCallbackUrl(
    currentConfig.url || config.url
  );

  const envRef = envBaselineConfig
    ? extractSupabaseProjectRef(envBaselineConfig.url)
    : '';
  const activeRef = extractSupabaseProjectRef(config.url);
  const canRestoreEnv = Boolean(
    envBaselineConfig &&
      (configSource === 'manual' ||
        configSource === 'firestore_user' ||
        (envRef && activeRef !== envRef) ||
        configConflictWarning)
  );

  const derivedOverallStatus: SupabaseOverallStatus = testing
    ? 'checking'
    : testResult
      ? testResult.overallStatus
      : !config.url && !config.anonKey
        ? 'not_configured'
        : !activeValidation.valid
          ? 'invalid_config'
          : 'configured_untested';
  const statusBadgeMeta = OVERALL_STATUS_LABELS[derivedOverallStatus];

  // Probe Supabase Auth provider settings when config becomes ready
  useEffect(() => {
    if (!configReady || backendMode === 'supabase') {
      setAuthSettings(null);
      return;
    }
    let cancelled = false;
    void fetchSupabaseAuthSettings(currentConfig).then((res) => {
      if (!cancelled) setAuthSettings(res);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConfig.url, currentConfig.anonKey, configReady, backendMode]);

  const commitSaveConfig = async (targetConfig: SupabaseConfig) => {
    setSaving(true);
    try {
      await onSaveConfig(targetConfig);
      const diag = await testSupabaseConnection(targetConfig);
      setTestResult(diag);
      const settings = await fetchSupabaseAuthSettings(targetConfig);
      setAuthSettings(settings);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Không thể lưu cấu hình.';
      onNotify?.('error', msg);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = validateSupabaseConfig(currentConfig);
    if (!check.valid) {
      const msg =
        check.urlError || check.keyError || 'Cấu hình Supabase không hợp lệ.';
      onNotify?.('error', msg);
      return;
    }

    const prevRef = extractSupabaseProjectRef(config.url);
    if (prevRef && check.projectRef && prevRef !== check.projectRef) {
      setPendingProjectSwitch(check.normalized);
      return;
    }

    await commitSaveConfig(check.normalized);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await testSupabaseConnection(currentConfig);
    setTestResult(res);
    if (res.ok) {
      const settings = await fetchSupabaseAuthSettings(currentConfig);
      setAuthSettings(settings);
    }
    setTesting(false);
  };

  const ensureConfigSavedAndClient = async () => {
    if (!configReady) {
      throw new Error(
        urlValidationError ||
          keyValidationError ||
          'Vui lòng nhập Project URL và Public Key hợp lệ trước.'
      );
    }
    if (
      currentConfig.url !== normalizeSupabaseUrl(config.url) ||
      currentConfig.anonKey !== config.anonKey.trim()
    ) {
      await onSaveConfig(currentConfig);
    }
    const client = getSupabaseClient(currentConfig);
    if (!client) {
      throw new Error('Không thể khởi tạo kết nối Supabase.');
    }
    return client;
  };

  const handleSupabaseGoogleAuth = async () => {
    setAuthLoading(true);
    setAuthError(null);
    setAuthInfo(null);
    try {
      const settings = await fetchSupabaseAuthSettings(currentConfig);
      setAuthSettings(settings);
      if (!settings.ok) {
        throw new Error(settings.error || 'Không thể kiểm tra cấu hình Supabase Auth.');
      }
      if (!settings.googleEnabled) {
        throw new Error(
          'Google OAuth chưa được bật trong Supabase Dashboard -> Authentication -> Providers -> Google. Bạn có thể bật Google hoặc kích hoạt nhanh bằng Mã OTP Email bên cạnh.'
        );
      }
      const client = await ensureConfigSavedAndClient();
      const session = await signInWithSupabaseGooglePopup(client);
      onSupabaseSignedIn?.(session);
      onNotify?.('success', 'Đã kích hoạt phiên Supabase Auth & Realtime.');
    } catch (err) {
      const msg = formatSupabaseAuthError(err);
      setAuthError(msg);
      onNotify?.('error', msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    setAuthInfo(null);
    try {
      const client = await ensureConfigSavedAndClient();
      const cleanEmail = authEmail.trim().toLowerCase();
      if (!cleanEmail || !cleanEmail.includes('@')) {
        throw new Error('Vui lòng nhập địa chỉ Email/Gmail hợp lệ.');
      }
      const { error } = await client.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: callbackUrl,
        },
      });
      if (error) throw error;
      setOtpSent(true);
      setOtpType('email');
      setAuthInfo(
        `Đã gửi mã OTP xác nhận về hộp thư ${cleanEmail}. Hãy kiểm tra Gmail (cả mục Thư rác/Quảng cáo) và nhập mã số vào ô bên dưới.`
      );
    } catch (err) {
      const msg = formatSupabaseAuthError(err);
      setAuthError(msg);
      onNotify?.('error', msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    setAuthInfo(null);
    try {
      const client = await ensureConfigSavedAndClient();
      const cleanEmail = authEmail.trim().toLowerCase();
      const cleanToken = otpToken.replace(/\s+/g, '').trim();
      if (!cleanToken) {
        throw new Error('Vui lòng nhập mã xác nhận OTP từ email.');
      }
      const { data, error } = await client.auth.verifyOtp({
        email: cleanEmail,
        token: cleanToken,
        type: otpType,
      });
      if (error) throw error;
      if (!data.session) {
        throw new Error('Mã OTP hợp lệ nhưng chưa nhận được phiên đăng nhập.');
      }
      setOtpSent(false);
      setOtpToken('');
      onSupabaseSignedIn?.(data.session);
      onNotify?.('success', 'Đã kích hoạt phiên Supabase Auth & Realtime.');
    } catch (err) {
      const msg = formatSupabaseAuthError(err);
      setAuthError(msg);
      onNotify?.('error', msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSupabasePasswordAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    setAuthInfo(null);
    try {
      const client = await ensureConfigSavedAndClient();
      const cleanEmail = authEmail.trim().toLowerCase();
      if (isSignUp) {
        const { data, error } = await client.auth.signUp({
          email: cleanEmail,
          password: authPassword,
          options: {
            emailRedirectTo: callbackUrl,
          },
        });
        if (error) {
          if (error.message.toLowerCase().includes('already registered')) {
            const signInRes = await client.auth.signInWithPassword({
              email: cleanEmail,
              password: authPassword,
            });
            if (!signInRes.error && signInRes.data.session) {
              onSupabaseSignedIn?.(signInRes.data.session);
              onNotify?.('success', 'Đã kích hoạt phiên Supabase Auth & Realtime.');
              return;
            }
          }
          throw error;
        }
        if (data.session) {
          onSupabaseSignedIn?.(data.session);
          onNotify?.('success', 'Đã đăng ký và kích hoạt phiên Supabase Auth.');
        } else {
          setOtpSent(true);
          setOtpType('signup');
          setAuthInfo(
            `Supabase yêu cầu xác nhận email ${cleanEmail}. Hãy nhập mã xác nhận 6 số trong email (hoặc chuyển sang tab Mã OTP Email / tắt Confirm Email trong Supabase Dashboard).`
          );
        }
      } else {
        const { data, error } = await client.auth.signInWithPassword({
          email: cleanEmail,
          password: authPassword,
        });
        if (error) throw error;
        onSupabaseSignedIn?.(data.session);
        onNotify?.('success', 'Đã kích hoạt phiên Supabase Auth & Realtime.');
      }
    } catch (err) {
      const msg = formatSupabaseAuthError(err);
      setAuthError(msg);
      onNotify?.('error', msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const activeSqlScript =
    sqlTab === 'timeout_fix'
      ? SUPABASE_MIGRATION_006_SQL
      : sqlTab === 'attendance_fix'
        ? SUPABASE_MIGRATION_005_SQL
        : sqlTab === 'schema_sync'
          ? SUPABASE_MIGRATION_004_SQL
          : sqlTab === 'rls_fix'
            ? SUPABASE_MIGRATION_003_SQL
            : sqlTab === 'migration'
              ? SUPABASE_MIGRATION_002_SQL
              : SUPABASE_SCHEMA_SQL;

  const handleCopySql = async () => {
    try {
      await navigator.clipboard.writeText(activeSqlScript);
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 2500);
    } catch {
      setShowSql(true);
    }
  };

  const totalLegacy =
    legacyCounts.scans + legacyCounts.schedules + legacyCounts.members;

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Database className="h-5 w-5 text-blue-600 shrink-0" />
              <span>Cấu hình Supabase Realtime &amp; RLS</span>
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Cấu hình Project URL và Anon Public Key (hoặc đặt biến môi trường{' '}
              <span className="font-mono text-xs">VITE_SUPABASE_URL</span> /{' '}
              <span className="font-mono text-xs">VITE_SUPABASE_ANON_KEY</span>{' '}
              trên Vercel / Secrets).
            </p>
          </div>
          <SyncStatusBadge
            state={syncState}
            backendMode={backendMode}
            lastSyncedAt={lastSyncedAt}
            onRetrySync={onForceResync}
          />
        </div>

        {/* Real Config & Diagnostics Overview */}
        <div className="mt-4 p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 uppercase tracking-wider">
              <ShieldCheck className="h-4 w-4 text-blue-600" />
              <span>Thông tin kết nối &amp; Môi trường thực tế</span>
            </div>
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusBadgeMeta.tone}`}
            >
              {statusBadgeMeta.label}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs">
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <p className="text-slate-500">Môi trường chạy</p>
              <p className="font-semibold text-slate-900 mt-0.5">
                {RUNTIME_ENV_LABELS[runtimeEnv]}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <p className="text-slate-500">Nguồn cấu hình ưu tiên</p>
              <p className="font-semibold text-slate-900 mt-0.5 truncate" title={CONFIG_SOURCE_LABELS[configSource]}>
                {CONFIG_SOURCE_LABELS[configSource]}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <p className="text-slate-500">Project Reference</p>
              <p className="font-mono font-semibold text-slate-900 mt-0.5">
                {activeRef || 'Chưa xác định'}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <p className="text-slate-500">Public Key (đã che)</p>
              <p className="font-mono font-semibold text-slate-900 mt-0.5">
                {maskSupabaseKey(config.anonKey)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <p className="text-slate-500">Loại Key phát hiện</p>
              <p className="font-semibold text-slate-900 mt-0.5">
                {activeKeyInfo.keyType === 'publishable'
                  ? 'Publishable Key (sb_publishable)'
                  : activeKeyInfo.keyType === 'anon_jwt'
                    ? 'Legacy Anon JWT'
                    : 'Chưa hợp lệ / Thiếu'}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <p className="text-slate-500">Kiểm tra gần nhất</p>
              <p className="font-medium text-slate-900 mt-0.5">
                {testResult?.checkedAt
                  ? new Date(testResult.checkedAt).toLocaleString('vi-VN')
                  : 'Chưa chạy kiểm tra'}
              </p>
            </div>
          </div>

          {testResult && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs pt-1">
              <div className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
                <span className="text-slate-600">Auth</span>
                <span className={SUBSYSTEM_LABEL[testResult.authStatus].color}>
                  {SUBSYSTEM_LABEL[testResult.authStatus].text}
                </span>
              </div>
              <div className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
                <span className="text-slate-600">Database</span>
                <span className={SUBSYSTEM_LABEL[testResult.dbStatus].color}>
                  {SUBSYSTEM_LABEL[testResult.dbStatus].text}
                </span>
              </div>
              <div className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
                <span className="text-slate-600">Realtime</span>
                <span className={SUBSYSTEM_LABEL[testResult.realtimeStatus].color}>
                  {SUBSYSTEM_LABEL[testResult.realtimeStatus].text}
                </span>
              </div>
              <div className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
                <span className="text-slate-600">Storage</span>
                <span className={SUBSYSTEM_LABEL[testResult.storageStatus].color}>
                  {SUBSYSTEM_LABEL[testResult.storageStatus].text}
                </span>
              </div>
            </div>
          )}
        </div>

        {envValidationError && (
          <div
            role="alert"
            className="mt-4 p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2.5"
          >
            <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">Lỗi biến môi trường Supabase:</p>
              <p className="mt-0.5">{envValidationError}</p>
            </div>
          </div>
        )}

        {configConflictWarning && (
          <div
            role="status"
            className="mt-4 p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <span>{configConflictWarning}</span>
            </div>
            {canRestoreEnv && (
              <button
                type="button"
                onClick={() => void onRestoreEnvConfig()}
                className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-900 bg-white border border-amber-300 rounded-lg hover:bg-amber-100 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Đồng bộ theo biến môi trường</span>
              </button>
            )}
          </div>
        )}

        <form onSubmit={handleSave} className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="supabase-url"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Supabase Project URL
            </label>
            <input
              id="supabase-url"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-project-ref.supabase.co"
              className={`w-full min-h-[44px] px-3.5 py-2.5 text-sm font-mono bg-white border rounded-lg focus:outline-none focus:ring-2 ${
                urlValidationError
                  ? 'border-red-400 focus:ring-red-500 focus:border-red-500'
                  : 'border-slate-300 focus:ring-blue-600 focus:border-blue-600'
              }`}
            />
            {urlValidationError && (
              <p className="mt-1.5 text-xs text-red-600 font-medium">
                {urlValidationError}
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="supabase-anon-key"
                className="block text-sm font-medium text-slate-700"
              >
                Supabase Public / Anon Key
              </label>
              <span className="text-[11px] text-slate-500">
                Chỉ dùng Publishable Key hoặc Anon Key (tuyệt đối không nhập Secret Key)
              </span>
            </div>
            <div className="relative">
              <input
                id="supabase-anon-key"
                type={showKeyInput ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={anonKey}
                onChange={(e) => setAnonKey(e.target.value)}
                placeholder="sb_publishable_... hoặc eyJhbGciOiJIUzI1NiIs..."
                className={`w-full min-h-[44px] pl-3.5 pr-11 py-2.5 text-sm font-mono bg-white border rounded-lg focus:outline-none focus:ring-2 ${
                  keyValidationError
                    ? 'border-red-400 focus:ring-red-500 focus:border-red-500'
                    : 'border-slate-300 focus:ring-blue-600 focus:border-blue-600'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowKeyInput((v) => !v)}
                aria-label={showKeyInput ? 'Ẩn khóa công khai' : 'Hiện khóa công khai'}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-700 rounded-md"
              >
                {showKeyInput ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {keyValidationError && (
              <p className="mt-1.5 text-xs text-red-600 font-medium">
                {keyValidationError}
              </p>
            )}
          </div>

          {callbackUrl && (
            <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 space-y-1.5">
              <div>
                <p className="font-medium text-slate-800">
                  1. Redirect URL ứng dụng (khai báo trong Supabase &rarr; URL Configuration):
                </p>
                <p className="font-mono text-slate-900 break-all">{callbackUrl}</p>
              </div>
              {providerCallbackUrl && (
                <div>
                  <p className="font-medium text-slate-800">
                    2. Callback URL cho Google Cloud Console (Authorized redirect URIs):
                  </p>
                  <p className="font-mono text-slate-900 break-all">
                    {providerCallbackUrl}
                  </p>
                </div>
              )}
            </div>
          )}

          {testResult && (
            <div
              role="status"
              className={`p-3.5 rounded-lg border text-sm space-y-3 ${
                testResult.ok
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              <div className="flex items-start gap-2.5">
                {testResult.ok ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <span className="font-medium block">{testResult.message}</span>
                  {testResult.lastError && !testResult.ok && (
                    <span className="text-xs text-red-700 block mt-0.5">
                      Chi tiết lỗi: {testResult.lastError}
                    </span>
                  )}
                </div>
              </div>

              {testResult.details && testResult.details.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-2 border-t border-black/10 text-xs">
                  {testResult.details.map((d) => (
                    <div
                      key={d.name}
                      className="flex items-center justify-between gap-2 bg-white/80 rounded px-2.5 py-1.5"
                    >
                      <span className="font-medium text-slate-800 truncate">
                        {d.name}
                      </span>
                      <span
                        className={`shrink-0 ${
                          d.ok ? 'text-emerald-700' : 'text-red-600 font-medium'
                        }`}
                      >
                        {d.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={saving || Boolean(urlValidationError || keyValidationError)}
              className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap"
            >
              <Save className="h-4 w-4" />
              <span>{saving ? 'Đang lưu...' : 'Lưu cấu hình'}</span>
            </button>

            <button
              type="button"
              onClick={handleTest}
              disabled={!configReady || testing}
              className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`h-4 w-4 ${testing ? 'animate-spin' : ''}`} />
              <span>
                {testing ? 'Đang kiểm tra...' : 'Kiểm tra kết nối & bảng'}
              </span>
            </button>

            {canRestoreEnv && (
              <button
                type="button"
                onClick={() => void onRestoreEnvConfig()}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Khôi phục theo Biến môi trường</span>
              </button>
            )}

            {backendMode === 'supabase' && (
              <button
                type="button"
                onClick={onForceResync}
                disabled={isSyncing}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <RefreshCw
                  className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`}
                />
                <span>Đồng bộ lại từ Database</span>
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Active Supabase Auth Banner */}
      {backendMode === 'supabase' && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5 flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h3 className="text-base font-bold text-emerald-950">
              Đã kích hoạt phiên Supabase Auth &amp; Realtime
            </h3>
            <p className="mt-1 text-sm text-emerald-900">
              Phiên hiện tại:{' '}
              <span className="font-mono font-medium">
                {supabaseEmail || currentUserEmail}
              </span>
              . Toàn bộ thao tác quét mã, lịch làm việc, phân quyền và nhật ký đang đồng bộ trực tiếp với PostgreSQL RLS.
            </p>
          </div>
        </div>
      )}

      {/* In-App Supabase Auth Activation Card when configured but still on Firebase session */}
      {configReady && backendMode !== 'supabase' && (
        <div className="bg-white border border-blue-200 rounded-xl p-5 sm:p-6 space-y-4">
          <div>
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <LogIn className="h-5 w-5 text-blue-600 shrink-0" />
              <span>
                Kích hoạt phiên Supabase Auth (Bắt buộc cho RLS &amp; Realtime)
              </span>
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Bạn đang đăng nhập ở chế độ dự phòng Firebase. Chọn một trong 3 cách dưới đây để kích hoạt phiên Supabase Auth hợp lệ cho{' '}
              <span className="font-mono text-slate-900">{currentUserEmail}</span> (chỉ cần đăng nhập 1 lần — phiên sẽ tự động lưu cho các lần truy cập sau):
            </p>
          </div>

          {authSettings && !authSettings.ok && authSettings.error && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900"
            >
              {authSettings.error}
            </div>
          )}

          {/* Method Switcher */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => {
                setAuthMethod('otp');
                setAuthError(null);
                setAuthInfo(null);
              }}
              className={`min-h-[42px] px-3 py-2 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 ${
                authMethod === 'otp'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <MailCheck className="h-4 w-4 text-blue-600 shrink-0" />
              <span>Mã OTP Email (Nhanh nhất)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMethod('password');
                setAuthError(null);
                setAuthInfo(null);
                setOtpSent(false);
              }}
              className={`min-h-[42px] px-3 py-2 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 ${
                authMethod === 'password'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <KeyRound className="h-4 w-4 text-slate-700 shrink-0" />
              <span>Email &amp; Mật khẩu</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMethod('google');
                setAuthError(null);
                setAuthInfo(null);
              }}
              className={`min-h-[42px] px-3 py-2 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 ${
                authMethod === 'google'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <LogIn className="h-4 w-4 text-emerald-600 shrink-0" />
              <span>Google OAuth</span>
            </button>
          </div>

          {/* Method 1: Email OTP (works without Google Provider or Popups or Passwords) */}
          {authMethod === 'otp' && (
            <div className="space-y-3">
              <p className="text-xs text-slate-600">
                Cách này hoạt động ngay cả khi bạn chưa cấu hình Google OAuth hoặc đang chạy trong khung nhúng (iFrame): Supabase gửi mã 6–8 số về Gmail của bạn để kích hoạt phiên tức thì.
              </p>

              <form
                onSubmit={handleSendOtp}
                className="flex flex-col sm:flex-row gap-2.5 sm:items-end"
              >
                <div className="flex-1">
                  <label
                    htmlFor="sb-otp-email"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Email nhận mã kích hoạt
                  </label>
                  <input
                    id="sb-otp-email"
                    type="email"
                    required
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="hoangminh202547@gmail.com"
                    className="w-full min-h-[44px] px-3.5 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <button
                  type="submit"
                  disabled={authLoading}
                  className="min-h-[44px] px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 whitespace-nowrap"
                >
                  {authLoading
                    ? 'Đang gửi...'
                    : otpSent
                      ? 'Gửi lại mã OTP'
                      : 'Gửi mã OTP về Gmail'}
                </button>
              </form>

              {otpSent && (
                <form
                  onSubmit={handleVerifyOtp}
                  className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 flex flex-col sm:flex-row gap-2.5 sm:items-end"
                >
                  <div className="flex-1">
                    <label
                      htmlFor="sb-otp-code"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Nhập mã xác nhận OTP trong Gmail
                    </label>
                    <input
                      id="sb-otp-code"
                      type="text"
                      inputMode="numeric"
                      required
                      value={otpToken}
                      onChange={(e) => setOtpToken(e.target.value)}
                      placeholder="VD: 123456"
                      className="w-full min-h-[44px] px-3.5 py-2 text-base font-mono tracking-widest border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={authLoading || !otpToken.trim()}
                    className="min-h-[44px] px-5 py-2.5 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-60 whitespace-nowrap"
                  >
                    {authLoading ? 'Đang xác nhận...' : 'Xác nhận & Kích hoạt'}
                  </button>
                </form>
              )}
            </div>
          )}

          {/* Method 2: Email & Password + inline signup confirmation OTP */}
          {authMethod === 'password' && (
            <div className="space-y-3">
              <form
                onSubmit={handleSupabasePasswordAuth}
                className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end"
              >
                <div>
                  <label
                    htmlFor="sb-auth-email"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Email / Gmail
                  </label>
                  <input
                    id="sb-auth-email"
                    type="email"
                    required
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="email@gmail.com"
                    className="w-full min-h-[44px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label
                    htmlFor="sb-auth-pass"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Mật khẩu Supabase Auth
                  </label>
                  <input
                    id="sb-auth-pass"
                    type="password"
                    required
                    minLength={6}
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="Tối thiểu 6 ký tự"
                    className="w-full min-h-[44px] px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={authLoading}
                    className="min-h-[44px] flex-1 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
                  >
                    {authLoading
                      ? 'Đang xử lý...'
                      : isSignUp
                        ? 'Tạo & Kích hoạt'
                        : 'Đăng nhập'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsSignUp((v) => !v);
                      setAuthError(null);
                      setAuthInfo(null);
                    }}
                    className="min-h-[44px] px-2.5 text-xs text-blue-600 hover:underline whitespace-nowrap"
                  >
                    {isSignUp ? 'Đã có MK?' : 'Tạo mới'}
                  </button>
                </div>
              </form>

              {otpSent && otpType === 'signup' && (
                <form
                  onSubmit={handleVerifyOtp}
                  className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 flex flex-col sm:flex-row gap-2.5 sm:items-end"
                >
                  <div className="flex-1">
                    <label
                      htmlFor="sb-signup-otp"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Mã xác nhận tài khoản từ Gmail
                    </label>
                    <input
                      id="sb-signup-otp"
                      type="text"
                      inputMode="numeric"
                      required
                      value={otpToken}
                      onChange={(e) => setOtpToken(e.target.value)}
                      placeholder="Nhập mã số trong email xác nhận..."
                      className="w-full min-h-[44px] px-3.5 py-2 text-base font-mono border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={authLoading || !otpToken.trim()}
                    className="min-h-[44px] px-5 py-2.5 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-60 whitespace-nowrap"
                  >
                    Xác nhận mã
                  </button>
                </form>
              )}
            </div>
          )}

          {/* Method 3: Google OAuth Popup + standalone tab note */}
          {authMethod === 'google' && (
            <div className="space-y-3">
              {authSettings?.ok && !authSettings.googleEnabled && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1"
                >
                  <p className="font-bold">
                    Google OAuth chưa được bật trên Supabase Project này
                  </p>
                  <p>
                    Hãy bật tại <strong>Supabase Dashboard &rarr; Authentication &rarr; Providers &rarr; Google</strong> và thêm Redirect URL{' '}
                    <span className="font-mono break-all">{callbackUrl}</span> vào{' '}
                    <strong>URL Configuration</strong>, hoặc dùng tab{' '}
                    <strong>Mã OTP Email</strong> bên cạnh để kích hoạt ngay.
                  </p>
                </div>
              )}

              {inIframe && (
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <span>
                    Trình duyệt đang chạy trong khung nhúng (iFrame), có thể chặn giao tiếp với popup Google OAuth. Nếu popup không tự đóng, hãy mở ứng dụng ở tab riêng hoặc dùng <strong>Mã OTP Email</strong>.
                  </span>
                  <a
                    href={
                      typeof window !== 'undefined' ? window.location.href : '/'
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>Mở tab riêng</span>
                  </a>
                </div>
              )}

              <button
                type="button"
                onClick={handleSupabaseGoogleAuth}
                disabled={authLoading}
                className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap"
              >
                <LogIn className="h-4 w-4" />
                <span>
                  {authLoading
                    ? 'Đang xác thực Google...'
                    : 'Đăng nhập Gmail qua Supabase Auth'}
                </span>
              </button>
            </div>
          )}

          {authError && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700"
            >
              {authError}
            </div>
          )}

          {authInfo && (
            <div
              role="status"
              className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800"
            >
              {authInfo}
            </div>
          )}
        </div>
      )}

      {/* Zero Data Loss Migration Card */}
      {totalLegacy > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
          <h3 className="text-base font-bold text-slate-900">
            Bảo toàn &amp; Chuyển dữ liệu hiện có sang Supabase
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Phát hiện dữ liệu đang lưu trước đó trên Firebase:{' '}
            <span className="font-medium text-slate-900 tabular-nums">
              {legacyCounts.scans} mã vạch
            </span>{' '}
            ·{' '}
            <span className="font-medium text-slate-900 tabular-nums">
              {legacyCounts.schedules} lịch làm việc
            </span>{' '}
            ·{' '}
            <span className="font-medium text-slate-900 tabular-nums">
              {legacyCounts.members} phân quyền
            </span>
            . Bạn có thể chuyển toàn bộ sang Supabase mà không làm mất dữ liệu cũ.
          </p>

          {backendMode !== 'supabase' && isValidSupabaseConfig(config) && (
            <p className="mt-2 text-xs font-medium text-amber-800">
              Vui lòng kích hoạt phiên Supabase Auth ở khung phía trên trước khi chuyển dữ liệu để vượt qua kiểm tra bảo mật RLS.
            </p>
          )}

          <div className="mt-4">
            <button
              type="button"
              onClick={onMigrateFromFirebase}
              disabled={backendMode !== 'supabase' || isSyncing}
              className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <UploadCloud className="h-4 w-4" />
              <span>
                {isSyncing
                  ? 'Đang chuyển dữ liệu...'
                  : 'Chuyển toàn bộ dữ liệu sang Supabase'}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* SQL Schema Helper */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              SQL Schema &amp; Nâng cấp Database (RLS, Trigger, Storage, Realtime)
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Chạy <span className="font-mono text-xs">schema.sql</span> khi cài mới,{' '}
              <span className="font-mono text-xs">002_full_erp.sql</span> cho bảng ERP,{' '}
              <span className="font-mono text-xs">003_fix_rls_policies.sql</span> để đồng bộ RLS,{' '}
              <span className="font-mono text-xs">004_sync_and_schema_hardening.sql</span> để bổ sung cột thiếu &amp; Realtime và{' '}
              <span className="font-mono text-xs">005_attendance_and_updates.sql</span> để mở khóa điều chỉnh/xóa chấm công &amp; Clear giờ và{' '}
              <span className="font-mono text-xs">006_query_optimization_and_timeout_fix.sql</span> để bổ sung chỉ mục tìm kiếm, tối ưu RLS &amp; khắc phục lỗi statement timeout trong SQL Editor trên Supabase Dashboard.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div className="inline-flex flex-wrap p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setSqlTab('timeout_fix')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                  sqlTab === 'timeout_fix' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                006_query_optimization_and_timeout_fix.sql (Tối ưu &amp; Fix Timeout)
              </button>
              <button
                type="button"
                onClick={() => setSqlTab('attendance_fix')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                  sqlTab === 'attendance_fix' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                005_attendance_and_updates.sql (Chấm công)
              </button>
              <button
                type="button"
                onClick={() => setSqlTab('schema_sync')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                  sqlTab === 'schema_sync' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                004_sync_and_schema_hardening.sql (Cột thiếu &amp; Realtime)
              </button>
              <button
                type="button"
                onClick={() => setSqlTab('rls_fix')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                  sqlTab === 'rls_fix' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                003_fix_rls_policies.sql (Sửa RLS)
              </button>
              <button
                type="button"
                onClick={() => setSqlTab('migration')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                  sqlTab === 'migration' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                002_full_erp.sql (Mở rộng)
              </button>
              <button
                type="button"
                onClick={() => setSqlTab('base')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                  sqlTab === 'base' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                schema.sql (Gốc)
              </button>
            </div>
            <button
              type="button"
              onClick={handleCopySql}
              className="min-h-[42px] inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
            >
              <Copy className="h-4 w-4" />
              <span>{copiedSql ? 'Đã sao chép SQL' : 'Sao chép SQL'}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowSql((v) => !v)}
              className="min-h-[42px] px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 rounded-lg transition-colors whitespace-nowrap"
            >
              {showSql ? 'Ẩn SQL' : 'Xem SQL'}
            </button>
          </div>
        </div>

        {showSql && (
          <pre className="mt-4 p-4 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed max-h-[460px]">
            {activeSqlScript}
          </pre>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(pendingProjectSwitch)}
        title="Xác nhận thay đổi Supabase Project"
        description="Bạn đang thay đổi Supabase Project. Việc này có thể khiến ứng dụng truy cập nguồn dữ liệu khác. Hãy xác minh dự án trước khi xác nhận."
        confirmLabel="Xác nhận chuyển Project"
        cancelLabel="Hủy thay đổi"
        variant="danger"
        onConfirm={() => {
          const target = pendingProjectSwitch;
          setPendingProjectSwitch(null);
          if (target) {
            void commitSaveConfig(target);
          }
        }}
        onCancel={() => {
          setPendingProjectSwitch(null);
          setUrl(config.url);
          setAnonKey(config.anonKey);
        }}
      />
    </div>
  );
}
