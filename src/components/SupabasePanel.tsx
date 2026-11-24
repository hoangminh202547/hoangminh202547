import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Database,
  KeyRound,
  LogIn,
  RefreshCw,
  Save,
  UploadCloud,
  XCircle,
} from 'lucide-react';
import {
  SUPABASE_SCHEMA_SQL,
  getSupabaseClient,
  isValidSupabaseConfig,
  signInWithSupabaseGooglePopup,
  testSupabaseConnection,
} from '../lib/supabase';
import type { DataBackendMode, SupabaseConfig, SyncState } from '../types';
import { SyncStatusBadge } from './SyncStatusBadge';

interface SupabasePanelProps {
  config: SupabaseConfig;
  backendMode: DataBackendMode;
  syncState: SyncState;
  lastSyncedAt: string | null;
  legacyCounts: { scans: number; schedules: number; members: number };
  isSyncing: boolean;
  onSaveConfig: (config: SupabaseConfig) => Promise<void>;
  onForceResync: () => Promise<void>;
  onMigrateFromFirebase: () => Promise<void>;
  onSupabaseSignedIn?: () => void;
  onNotify?: (type: 'success' | 'error' | 'info', message: string) => void;
}

export function SupabasePanel({
  config,
  backendMode,
  syncState,
  lastSyncedAt,
  legacyCounts,
  isSyncing,
  onSaveConfig,
  onForceResync,
  onMigrateFromFirebase,
  onSupabaseSignedIn,
  onNotify,
}: SupabasePanelProps) {
  const [url, setUrl] = useState(config.url);
  const [anonKey, setAnonKey] = useState(config.anonKey);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [copiedSql, setCopiedSql] = useState(false);
  const [showSql, setShowSql] = useState(false);

  // In-app Supabase Auth activation state
  const [authLoading, setAuthLoading] = useState(false);
  const [showPasswordAuth, setShowPasswordAuth] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authInfo, setAuthInfo] = useState<string | null>(null);

  useEffect(() => {
    setUrl(config.url);
    setAnonKey(config.anonKey);
  }, [config.url, config.anonKey]);

  const currentConfig: SupabaseConfig = {
    url: url.trim(),
    anonKey: anonKey.trim(),
  };
  const configReady = isValidSupabaseConfig(currentConfig);
  const callbackUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/auth/callback`
      : '';

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSaveConfig(currentConfig);
      setTestResult({
        ok: true,
        message: 'Đã lưu thông tin kết nối Supabase.',
      });
    } catch (err) {
      setTestResult({
        ok: false,
        message:
          err instanceof Error ? err.message : 'Không thể lưu cấu hình.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await testSupabaseConnection(currentConfig);
    setTestResult(res);
    setTesting(false);
  };

  const ensureConfigSavedAndClient = async () => {
    if (!configReady) {
      throw new Error('Vui lòng nhập Project URL và Anon Key hợp lệ trước.');
    }
    if (
      currentConfig.url !== config.url.trim() ||
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
      const client = await ensureConfigSavedAndClient();
      await signInWithSupabaseGooglePopup(client);
      onSupabaseSignedIn?.();
      onNotify?.('success', 'Đã kích hoạt phiên Supabase Auth & Realtime.');
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Không thể đăng nhập Gmail qua Supabase Auth.';
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
        });
        if (error) throw error;
        if (data.session) {
          onSupabaseSignedIn?.();
          onNotify?.('success', 'Đã đăng ký và kích hoạt phiên Supabase Auth.');
        } else {
          setAuthInfo(
            'Đã gửi email xác nhận từ Supabase Auth. Vui lòng kiểm tra hộp thư (hoặc tắt Confirm Email trong Dashboard).'
          );
        }
      } else {
        const { error } = await client.auth.signInWithPassword({
          email: cleanEmail,
          password: authPassword,
        });
        if (error) throw error;
        onSupabaseSignedIn?.();
        onNotify?.('success', 'Đã kích hoạt phiên Supabase Auth & Realtime.');
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Đăng nhập Supabase Auth thất bại.';
      setAuthError(msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleCopySql = async () => {
    try {
      await navigator.clipboard.writeText(SUPABASE_SCHEMA_SQL);
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
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-project-ref.supabase.co"
              className="w-full min-h-[44px] px-3.5 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
            />
          </div>

          <div>
            <label
              htmlFor="supabase-anon-key"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Supabase Anon / Public Key
            </label>
            <input
              id="supabase-anon-key"
              type="password"
              value={anonKey}
              onChange={(e) => setAnonKey(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
              className="w-full min-h-[44px] px-3.5 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
            />
          </div>

          {callbackUrl && (
            <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 space-y-1">
              <p className="font-medium text-slate-800">
                Redirect URL cho Supabase Auth (Google OAuth):
              </p>
              <p className="font-mono text-slate-900 break-all">{callbackUrl}</p>
            </div>
          )}

          {testResult && (
            <div
              role="status"
              className={`p-3.5 rounded-lg border text-sm flex items-start gap-2.5 ${
                testResult.ok
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
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

      {/* In-App Supabase Auth Activation Card when configured but still on Firebase session */}
      {configReady && backendMode !== 'supabase' && (
        <div className="bg-white border border-blue-200 rounded-xl p-5 sm:p-6 space-y-4">
          <div>
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <LogIn className="h-5 w-5 text-blue-600 shrink-0" />
              <span>Kích hoạt phiên Supabase Auth (Bắt buộc cho RLS &amp; Realtime)</span>
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Bạn đang đăng nhập ở chế độ dự phòng Firebase. Hãy xác thực phiên Supabase Auth bên dưới để ghi/đọc dữ liệu trực tiếp qua PostgreSQL RLS và bật đồng bộ Realtime đa tài khoản.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSupabaseGoogleAuth}
              disabled={authLoading}
              className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap"
            >
              <LogIn className="h-4 w-4" />
              <span>
                {authLoading ? 'Đang xác thực...' : 'Đăng nhập Gmail qua Supabase Auth'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setShowPasswordAuth((v) => !v)}
              className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
            >
              <KeyRound className="h-4 w-4" />
              <span>
                {showPasswordAuth ? 'Ẩn đăng nhập mật khẩu' : 'Dùng Email & Mật khẩu'}
              </span>
            </button>
          </div>

          {showPasswordAuth && (
            <form
              onSubmit={handleSupabasePasswordAuth}
              className="pt-2 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end"
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
                  Mật khẩu
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
                  {isSignUp ? 'Tạo & Kích hoạt' : 'Đăng nhập'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsSignUp((v) => !v)}
                  className="min-h-[44px] px-2.5 text-xs text-blue-600 hover:underline whitespace-nowrap"
                >
                  {isSignUp ? 'Đăng nhập' : 'Đăng ký'}
                </button>
              </div>
            </form>
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
              Vui lòng đăng nhập Supabase Auth ở khung phía trên trước khi chuyển dữ liệu để vượt qua kiểm tra bảo mật RLS.
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
              SQL khởi tạo 5 bảng, RLS phân quyền &amp; Realtime trên Supabase
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Sao chép và chạy toàn bộ script này trong SQL Editor trên Supabase Dashboard.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleCopySql}
              className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
            >
              <Copy className="h-4 w-4" />
              <span>{copiedSql ? 'Đã sao chép SQL' : 'Sao chép SQL'}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowSql((v) => !v)}
              className="min-h-[44px] px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 rounded-lg transition-colors whitespace-nowrap"
            >
              {showSql ? 'Ẩn SQL' : 'Xem SQL'}
            </button>
          </div>
        </div>

        {showSql && (
          <pre className="mt-4 p-4 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed max-h-[460px]">
            {SUPABASE_SCHEMA_SQL}
          </pre>
        )}
      </div>
    </div>
  );
}
