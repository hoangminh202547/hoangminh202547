import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Database,
  DownloadCloud,
  RefreshCw,
  Save,
  XCircle,
} from 'lucide-react';
import {
  SUPABASE_SCHEMA_SQL,
  isValidSupabaseConfig,
  testSupabaseConnection,
} from '../lib/supabase';
import type { SupabaseConfig } from '../types';

interface SupabasePanelProps {
  config: SupabaseConfig;
  unsyncedScansCount: number;
  unsyncedSchedulesCount: number;
  isSyncing: boolean;
  onSaveConfig: (config: SupabaseConfig) => Promise<void>;
  onSyncAll: () => Promise<void>;
  onPullFromSupabase: () => Promise<void>;
}

export function SupabasePanel({
  config,
  unsyncedScansCount,
  unsyncedSchedulesCount,
  isSyncing,
  onSaveConfig,
  onSyncAll,
  onPullFromSupabase,
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

  useEffect(() => {
    setUrl(config.url);
    setAnonKey(config.anonKey);
  }, [config.url, config.anonKey]);

  const currentConfig: SupabaseConfig = {
    url: url.trim(),
    anonKey: anonKey.trim(),
  };
  const configReady = isValidSupabaseConfig(currentConfig);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSaveConfig(currentConfig);
      setTestResult({
        ok: true,
        message: 'Đã lưu thông tin kết nối Supabase vào tài khoản của bạn.',
      });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Không thể lưu cấu hình.',
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

  const handleCopySql = async () => {
    try {
      await navigator.clipboard.writeText(SUPABASE_SCHEMA_SQL);
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 2500);
    } catch {
      setShowSql(true);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Database className="h-5 w-5 text-blue-600 shrink-0" />
              <span>Liên kết cơ sở dữ liệu Supabase</span>
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Nhập Project URL và Anon Public Key từ Supabase để đồng bộ dữ liệu mã vạch và lịch làm việc.
            </p>
          </div>
          <div className="text-xs font-medium text-slate-600 whitespace-nowrap">
            {isValidSupabaseConfig(config) ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                <span>Đã cấu hình</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-slate-500">
                <XCircle className="h-4 w-4" />
                <span>Chưa liên kết</span>
              </span>
            )}
          </div>
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
              <span>{saving ? 'Đang lưu...' : 'Lưu liên kết'}</span>
            </button>

            <button
              type="button"
              onClick={handleTest}
              disabled={!configReady || testing}
              className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`h-4 w-4 ${testing ? 'animate-spin' : ''}`} />
              <span>{testing ? 'Đang kiểm tra...' : 'Kiểm tra kết nối'}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Sync actions */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
        <h3 className="text-base font-bold text-slate-900">
          Đồng bộ dữ liệu 2 chiều
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Chờ đồng bộ:{' '}
          <span className="font-medium text-slate-900 tabular-nums">
            {unsyncedScansCount} mã vạch
          </span>{' '}
          <span aria-hidden="true">·</span>{' '}
          <span className="font-medium text-slate-900 tabular-nums">
            {unsyncedSchedulesCount} lịch làm việc
          </span>
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onSyncAll}
            disabled={!isValidSupabaseConfig(config) || isSyncing}
            className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>{isSyncing ? 'Đang đồng bộ...' : 'Đẩy dữ liệu lên Supabase'}</span>
          </button>

          <button
            type="button"
            onClick={onPullFromSupabase}
            disabled={!isValidSupabaseConfig(config) || isSyncing}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <DownloadCloud className="h-4 w-4" />
            <span>Tải về từ Supabase</span>
          </button>
        </div>
      </div>

      {/* SQL Schema Helper */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              SQL khởi tạo bảng trên Supabase
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Sao chép và chạy đoạn SQL này trong mục SQL Editor trên trang quản trị Supabase của bạn.
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
          <pre className="mt-4 p-4 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed">
            {SUPABASE_SCHEMA_SQL}
          </pre>
        )}
      </div>
    </div>
  );
}
