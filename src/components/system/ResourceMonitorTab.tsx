import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  Activity,
  AlertTriangle,
  Database,
  RefreshCw,
  Server,
  ShieldAlert,
} from 'lucide-react';
import {
  fetchSupabaseUsageMetrics,
  getClientDbOpsCount,
  subscribeClientDbOps,
  type SupabaseUsageProxyResponse,
} from '../../lib/supabaseOps';
import type { SupabaseConfig } from '../../types';

interface ResourceMonitorTabProps {
  config: SupabaseConfig;
  session: Session | null;
}

export function ResourceMonitorTab({ config, session }: ResourceMonitorTabProps) {
  const [usage, setUsage] = useState<SupabaseUsageProxyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [clientOps, setClientOps] = useState(() => getClientDbOpsCount());

  useEffect(() => {
    return subscribeClientDbOps(setClientOps);
  }, []);

  const loadUsage = useCallback(
    async (forceRefresh = false) => {
      if (!session?.access_token || !config.url || !config.anonKey) {
        setUsage({
          available: false,
          reason: 'missing_session',
          message: 'Cần đăng nhập phiên Supabase Auth để kiểm tra số liệu thực tế từ Management API.',
        });
        return;
      }
      setLoading(true);
      try {
        const res = await fetchSupabaseUsageMetrics(
          config.url,
          config.anonKey,
          session.access_token,
          forceRefresh
        );
        setUsage(res);
      } catch (err) {
        setUsage({
          available: false,
          reason: 'fetch_error',
          message:
            err instanceof Error
              ? err.message
              : 'Không thể gọi API kiểm tra tài nguyên /api/supabase-usage.',
        });
      } finally {
        setLoading(false);
      }
    },
    [session?.access_token, config.url, config.anonKey]
  );

  useEffect(() => {
    void loadUsage(false);
  }, [loadUsage]);

  // Extract real request counts if Management API returned structured series
  const extractTotalRequests = (raw: Record<string, unknown> | null | undefined): number | null => {
    if (!raw) return null;
    const result = raw.result;
    if (Array.isArray(result)) {
      let sum = 0;
      let found = false;
      for (const row of result) {
        if (row && typeof row === 'object') {
          const r = row as Record<string, unknown>;
          const val = Number(
            r.count ?? r.total ?? r.total_rest_requests ?? r.api_requests ?? NaN
          );
          if (Number.isFinite(val)) {
            sum += val;
            found = true;
          }
        }
      }
      return found ? sum : null;
    }
    return null;
  };

  const apiRequestTotal = extractTotalRequests(usage?.apiRequests);
  const apiCountTotal = extractTotalRequests(usage?.apiCounts);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-slate-900">
            Giám sát tài nguyên Supabase thực tế
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Kết nối an toàn qua server proxy <span className="font-mono">/api/supabase-usage</span>. Không hiển thị số liệu ước đoán hoặc giả lập nếu chưa có Management API token.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadUsage(true)}
          disabled={loading}
          className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-2 whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          <span>Làm mới số liệu</span>
        </button>
      </div>

      {/* Honest distinction: Client Session Operations vs Server Quota */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Thao tác DB trong phiên trình duyệt</span>
            <Activity className="h-4 w-4 text-blue-600" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">{clientOps}</p>
          <p className="mt-1 text-[11px] text-slate-500">
            Chỉ là bộ đếm số truy vấn client của bạn trong phiên này (không phải dung lượng server).
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Tổng API Requests (Management API)</span>
            <Server className="h-4 w-4 text-emerald-600" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {usage?.available && apiRequestTotal !== null
              ? apiRequestTotal.toLocaleString('vi-VN')
              : 'Chưa khả dụng'}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {usage?.fetchedAt
              ? `Cập nhật: ${new Intl.DateTimeFormat('vi-VN', { timeStyle: 'medium', dateStyle: 'short' }).format(new Date(usage.fetchedAt))}`
              : 'Nguồn chính thức từ Supabase Management API'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Trạng thái Project / API Counts</span>
            <Database className="h-4 w-4 text-slate-600" />
          </div>
          <p className="mt-2 text-lg font-bold text-slate-900 font-mono truncate">
            {usage?.projectRef || 'Chưa xác định'}
          </p>
          <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
            {usage?.available
              ? apiCountTotal !== null
                ? `Ghi nhận ${apiCountTotal.toLocaleString('vi-VN')} lượt gọi endpoint`
                : `Trạng thái: ${String(usage.projectMeta?.status || 'ACTIVE')}`
              : 'Chờ cấu hình SUPABASE_ACCESS_TOKEN'}
          </p>
        </div>
      </div>

      {/* Availability / Setup Guidance */}
      {usage && !usage.available ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 space-y-3">
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-bold text-amber-950">
                Chưa có số liệu sử dụng thực tế từ Supabase Management API
              </h3>
              <p className="mt-1 text-sm text-amber-900">{usage.message}</p>
            </div>
          </div>

          <div className="bg-white/80 border border-amber-200 rounded-lg p-3.5 text-xs text-slate-700 space-y-1.5">
            <p className="font-bold text-slate-900">Hướng dẫn kích hoạt giám sát thật (chỉ cấu hình trên Server):</p>
            <p>1. Tạo Personal Access Token tại Supabase Dashboard → Account Settings → Access Tokens.</p>
            <p>
              2. Thêm biến môi trường server <span className="font-mono font-bold">SUPABASE_ACCESS_TOKEN</span> (và tùy chọn{' '}
              <span className="font-mono font-bold">SUPABASE_PROJECT_REF</span>) trong Secrets / Vercel Environment Variables (tuyệt đối không gắn tiền tố <span className="font-mono">VITE_</span>).
            </p>
            <p>3. Khởi động lại server và nhấn "Làm mới số liệu".</p>
          </div>
        </div>
      ) : usage?.available ? (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">
              Dữ liệu phản hồi từ Supabase Management API
            </h3>
            {usage.cached && (
              <span className="text-xs text-slate-500">Đang dùng cache server (tối đa 5 phút)</span>
            )}
          </div>

          {apiRequestTotal !== null && apiRequestTotal >= 400_000 && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
              <span>
                Lưu lượng API Requests thực tế đạt mức cao ({apiRequestTotal.toLocaleString('vi-VN')}). Hãy kiểm tra Storage và các truy vấn phân trang.
              </span>
            </div>
          )}

          <pre className="p-3 rounded-lg bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto max-h-80">
            {JSON.stringify(
              {
                project: usage.projectMeta,
                apiCounts: usage.apiCounts,
                apiRequests: usage.apiRequests,
              },
              null,
              2
            )}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
