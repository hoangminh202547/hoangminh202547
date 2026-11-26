import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  fetchSupabaseUsageMetrics,
  type ResourceSeverity,
  type SupabaseUsageProxyResponse,
} from '../../lib/supabaseOps';
import type { SupabaseConfig } from '../../types';

interface ResourceMonitorTabProps {
  config: SupabaseConfig;
  session: Session | null;
}

const REFRESH_COOLDOWN_SECONDS = 30;

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Chưa có';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function getSeverityStyles(severity: ResourceSeverity): {
  text: string;
  bar: string;
  alertBg: string;
} {
  switch (severity) {
    case 'critical':
      return {
        text: 'text-red-700',
        bar: 'bg-red-600',
        alertBg: 'bg-red-50 border-red-200 text-red-950',
      };
    case 'warning':
      return {
        text: 'text-amber-700',
        bar: 'bg-amber-600',
        alertBg: 'bg-amber-50 border-amber-200 text-amber-950',
      };
    case 'watch':
      return {
        text: 'text-amber-700',
        bar: 'bg-amber-500',
        alertBg: 'bg-amber-50 border-amber-200 text-amber-950',
      };
    case 'normal':
      return {
        text: 'text-emerald-700',
        bar: 'bg-emerald-600',
        alertBg: 'bg-emerald-50 border-emerald-200 text-emerald-950',
      };
    case 'info':
      return {
        text: 'text-slate-600',
        bar: 'bg-blue-600',
        alertBg: 'bg-slate-50 border-slate-200 text-slate-900',
      };
    case 'unavailable':
    default:
      return {
        text: 'text-slate-500',
        bar: 'bg-slate-300',
        alertBg: 'bg-slate-50 border-slate-200 text-slate-800',
      };
  }
}

export function ResourceMonitorTab({
  config,
  session,
}: ResourceMonitorTabProps) {
  const [usage, setUsage] = useState<SupabaseUsageProxyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const requestLockRef = useRef(false);

  useEffect(() => {
    if (cooldownRemaining <= 0) return;
    const timer = window.setTimeout(() => {
      setCooldownRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [cooldownRemaining]);

  const loadUsage = useCallback(
    async (forceRefresh = false) => {
      if (requestLockRef.current) return;
      if (forceRefresh && cooldownRemaining > 0) return;

      if (!session?.access_token || !config.url || !config.anonKey) {
        setUsage({
          available: false,
          reason: 'missing_session',
          message:
            'Cần kích hoạt phiên Supabase Auth để xác thực quyền quản trị khi xem tài nguyên thật.',
        });
        return;
      }

      requestLockRef.current = true;
      setLoading(true);
      try {
        const res = await fetchSupabaseUsageMetrics(
          config.url,
          config.anonKey,
          session.access_token,
          forceRefresh
        );
        setUsage(res);
        if (forceRefresh) {
          setCooldownRemaining(
            res.refreshCooldownSec && res.refreshCooldownSec > 0
              ? res.refreshCooldownSec
              : REFRESH_COOLDOWN_SECONDS
          );
        }
      } catch (err) {
        setUsage({
          available: false,
          reason: 'fetch_error',
          message:
            err instanceof Error
              ? err.name === 'AbortError'
                ? 'Hết thời gian chờ phản hồi từ máy chủ giám sát (12 giây).'
                : err.message
              : 'Không thể kết nối máy chủ giám sát tài nguyên.',
        });
      } finally {
        requestLockRef.current = false;
        setLoading(false);
      }
    },
    [session?.access_token, config.url, config.anonKey, cooldownRemaining]
  );

  // Only fetch when this tab is mounted/opened (no background polling)
  useEffect(() => {
    void loadUsage(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token, config.url, config.anonKey]);

  const resources = usage?.resources || [];
  const alerts = usage?.alerts || [];

  return (
    <div className="space-y-6">
      {/* Minimal Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-slate-900">
            Giám sát tài nguyên Supabase
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 tabular-nums">
            <span>
              Project:{' '}
              <span className="font-mono font-semibold text-slate-800">
                {usage?.projectRef || 'buhpujisxuqmhccvnsfw'}
              </span>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Gói:{' '}
              <span className="font-semibold text-slate-800 uppercase">
                {usage?.plan || 'Chưa xác định'}
              </span>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Trạng thái:{' '}
              <span className="font-medium text-slate-800">
                {usage?.available
                  ? usage.cached
                    ? 'Dữ liệu thật (Cache 5 phút)'
                    : 'Dữ liệu thật (Vừa cập nhật)'
                  : 'Chưa khả dụng'}
              </span>
            </span>
            {usage?.fetchedAt && (
              <>
                <span aria-hidden="true">·</span>
                <span>Cập nhật: {formatDateTime(usage.fetchedAt)}</span>
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void loadUsage(true)}
          disabled={loading || cooldownRemaining > 0}
          className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-55 inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          <span>
            {loading
              ? 'Đang cập nhật...'
              : cooldownRemaining > 0
                ? `Chờ ${cooldownRemaining}s`
                : 'Cập nhật số liệu'}
          </span>
        </button>
      </div>

      {/* Loading Skeleton */}
      {loading && !usage && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 animate-pulse">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div
              key={idx}
              className="h-36 bg-white border border-slate-200 rounded-xl p-4"
            >
              <div className="h-4 w-32 bg-slate-200 rounded" />
              <div className="mt-4 h-7 w-24 bg-slate-200 rounded" />
              <div className="mt-4 h-2 w-full bg-slate-100 rounded" />
            </div>
          ))}
        </div>
      )}

      {/* Alerts Summary */}
      {usage?.available && alerts.length > 0 && (
        <div className="space-y-2.5">
          {alerts.map((alert) => {
            const st = getSeverityStyles(alert.severity);
            return (
              <div
                key={alert.id}
                role="alert"
                className={`border rounded-xl p-4 flex items-start gap-3 ${st.alertBg}`}
              >
                <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-bold">{alert.title}</h3>
                    <span className="text-xs font-mono tabular-nums opacity-80">
                      Ghi nhận: {formatDateTime(alert.recordedAt)}
                    </span>
                  </div>
                  <p className="text-xs tabular-nums">
                    Hiện tại: <strong>{alert.currentFormatted}</strong>
                    {alert.limitFormatted && (
                      <> · Giới hạn: <strong>{alert.limitFormatted}</strong></>
                    )}
                  </p>
                  <p className="text-xs opacity-90">
                    Gợi ý xử lý: {alert.recommendation}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {usage?.available && alerts.length === 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 flex items-center gap-2.5 text-xs text-emerald-900">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
          <span>
            Không phát hiện tài nguyên vượt ngưỡng cảnh báo nội bộ (&ge; 70%). Hệ thống ERP đang hoạt động ổn định.
          </span>
        </div>
      )}

      {/* Unavailable / Setup Guidance */}
      {usage && !usage.available && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 space-y-3">
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-bold text-amber-950">
                Chưa đọc được số liệu thực tế từ Supabase Management API
                {usage.httpStatus ? ` (HTTP ${usage.httpStatus})` : ''}
              </h3>
              <p className="mt-1 text-sm text-amber-900">{usage.message}</p>
            </div>
          </div>

          <div className="bg-white border border-amber-200 rounded-lg p-3.5 text-xs text-slate-700 space-y-1.5">
            {usage.reason === 'rate_limited' ? (
              <>
                <p className="font-bold text-slate-900">
                  API đang giới hạn tần suất yêu cầu:
                </p>
                <p>
                  Vui lòng chờ 1–2 phút rồi nhấn “Cập nhật số liệu” để tải lại từ máy chủ.
                </p>
              </>
            ) : usage.reason === 'vercel_server_error' || usage.reason === 'upstream_server_error' ? (
              <>
                <p className="font-bold text-slate-900">
                  Khắc phục sự cố máy chủ API / dịch vụ trung gian:
                </p>
                <p>
                  1. Đảm bảo đã triển khai bản cập nhật mới nhất lên Vercel (Redeploy).
                </p>
                <p>
                  2. Kiểm tra lại Vercel → Logs (Functions) cho route{' '}
                  <span className="font-mono">/api/supabase-usage</span> và thử tải lại sau ít phút.
                </p>
              </>
            ) : (
              <>
                <p className="font-bold text-slate-900">
                  Cấu hình biến môi trường Server trên Vercel (Production &amp; Preview):
                </p>
                <p>
                  1. Tạo Access Token tại{' '}
                  <span className="font-mono">supabase.com/dashboard/account/tokens</span>.
                  Nếu dùng Scoped Token, cần bật đủ quyền{' '}
                  <span className="font-mono">analytics_usage_read</span> (Analytics Read) và{' '}
                  <span className="font-mono">database:read</span> (Read-Only Postgres).
                </p>
                <p>
                  2. Vào Vercel → Settings → Environment Variables, cấu hình 2 biến Server (không dùng tiền tố <span className="font-mono">VITE_</span> hoặc <span className="font-mono">NEXT_PUBLIC_</span>):
                </p>
                <p className="font-mono text-slate-900 pl-3">
                  SUPABASE_ACCESS_TOKEN
                  <br />
                  SUPABASE_PROJECT_REF = buhpujisxuqmhccvnsfw
                </p>
                <p>3. Nhấn Redeploy trên Vercel rồi bấm “Cập nhật số liệu”.</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Minimalist Resource Cards */}
      {usage?.available && resources.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {resources.map((item) => {
            const st = getSeverityStyles(item.severity);
            const barWidth =
              item.usagePercent !== null
                ? Math.min(100, Math.max(2, item.usagePercent))
                : 0;

            return (
              <div
                key={item.id}
                className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between gap-3"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">
                      {item.name}
                    </h3>
                    <span className={`text-xs font-medium whitespace-nowrap ${st.text}`}>
                      {item.statusLabel}
                    </span>
                  </div>

                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xl font-bold text-slate-900 tabular-nums">
                      {item.currentFormatted}
                    </p>
                    {item.limitFormatted && (
                      <p className="text-xs text-slate-500 tabular-nums whitespace-nowrap">
                        / {item.limitFormatted}
                      </p>
                    )}
                  </div>

                  {item.usagePercent !== null && (
                    <div className="space-y-1">
                      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${st.bar}`}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-500 tabular-nums">
                        <span>Mức sử dụng</span>
                        <span className="font-semibold text-slate-700">
                          {item.usagePercent.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-slate-600 leading-relaxed">
                    {item.detailNote}
                  </p>
                </div>

                <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2 text-[11px] text-slate-400 tabular-nums">
                  <span className="truncate">{item.sourceLabel}</span>
                  <span className="shrink-0">
                    {item.updatedAt ? formatDateTime(item.updatedAt) : 'Chưa hỗ trợ'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Threshold Legend */}
      <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        <span className="font-medium text-slate-700">Ngưỡng cảnh báo nội bộ:</span>
        <span>&lt; 70% Bình thường</span>
        <span aria-hidden="true">·</span>
        <span>70%–84% Theo dõi</span>
        <span aria-hidden="true">·</span>
        <span>85%–94% Cảnh báo</span>
        <span aria-hidden="true">·</span>
        <span>&ge; 95% Nguy hiểm</span>
      </div>
    </div>
  );
}
