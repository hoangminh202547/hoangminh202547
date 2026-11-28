import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Clock,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  Tag,
} from 'lucide-react';
import { formatViDate } from '../../lib/scheduleMeta';
import {
  fetchOverviewSummary,
  useScopedRealtime,
  type OverviewSummary,
} from '../../lib/supabaseOps';
import type { AppTab, AuthenticatedUser, ModuleAccessFlags } from '../../types';

interface OverviewTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  modules: ModuleAccessFlags;
  onNavigate: (tab: AppTab) => void;
}

function formatViDateLong(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return formatViDate(ymd);
  const weekday = new Intl.DateTimeFormat('vi-VN', { weekday: 'long' }).format(
    new Date(y, m - 1, d)
  );
  return `${weekday}, ${formatViDate(ymd)}`;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Chào buổi sáng';
  if (hour < 18) return 'Chào buổi chiều';
  return 'Chào buổi tối';
}

export function OverviewTab({
  client,
  user,
  modules,
  onNavigate,
}: OverviewTabProps) {
  const [summary, setSummary] = useState<OverviewSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSummary = useCallback(async (forceRefresh = false) => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetchOverviewSummary(client, user.email, forceRefresh);
      setSummary(res);
    } finally {
      setLoading(false);
    }
  }, [client, user.email]);

  useEffect(() => {
    void loadSummary(false);
  }, [loadSummary]);

  useScopedRealtime(
    client,
    Boolean(client),
    ['work_schedules', 'attendance_logs', 'customer_feedbacks', 'expiry_tracking', 'return_records'],
    () => {
      void loadSummary(false);
    }
  );

  const todayFallback = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      {/* Greeting Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-blue-600">
            {formatViDateLong(summary?.todayDate || todayFallback)}
          </p>
          <h2 className="mt-1 text-xl font-bold text-slate-900">
            {getGreeting()}, {user.displayName}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Tóm tắt công việc trong ngày và các mục cần xử lý ưu tiên.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadSummary(true)}
          disabled={loading || !client}
          className="min-h-[42px] px-4 py-2 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          <span>Làm mới</span>
        </button>
      </div>

      {!client && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
          Chưa kích hoạt phiên Supabase Auth — bảng tổng hợp trực tuyến sẽ hiển thị ngay sau khi kết nối Supabase.
        </div>
      )}

      {/* Primary Operational Status Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Today's Schedule */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-500">Lịch làm việc hôm nay</span>
              <CalendarDays className="h-4 w-4 text-blue-600" />
            </div>
            {loading ? (
              <div className="mt-3 h-10 bg-slate-100 rounded animate-pulse" />
            ) : summary && summary.myTodaySchedules.length > 0 ? (
              <div className="mt-2.5 space-y-1.5">
                {summary.myTodaySchedules.map((s) => (
                  <div key={s.id} className="text-sm">
                    <p className="font-bold text-slate-900">
                      {s.isDayOff ? 'Nghỉ tuần (DO)' : s.title}
                    </p>
                    {!s.isDayOff && (
                      <p className="text-xs font-mono text-slate-600 tabular-nums">
                        {s.startTime} – {s.endTime}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2.5 text-sm font-medium text-slate-500">
                Chưa có ca đăng ký cho hôm nay.
              </p>
            )}
          </div>
          {modules.schedule && (
            <button
              type="button"
              onClick={() => onNavigate('schedule')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              <span>Mở lịch làm việc</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Today's Attendance */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-500">Trạng thái chấm công</span>
              <Clock className="h-4 w-4 text-emerald-600" />
            </div>
            {loading ? (
              <div className="mt-3 h-10 bg-slate-100 rounded animate-pulse" />
            ) : summary?.myTodayAttendance ? (
              <div className="mt-2.5">
                <p className="text-base font-bold text-emerald-700">
                  Đã chấm công · {summary.myTodayAttendance.shiftName}
                </p>
                <p className="mt-1 text-xs font-mono text-slate-600 tabular-nums">
                  Giờ vào:{' '}
                  {new Intl.DateTimeFormat('vi-VN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  }).format(new Date(summary.myTodayAttendance.checkInAt))}
                </p>
              </div>
            ) : (
              <div className="mt-2.5">
                <p className="text-base font-bold text-amber-700">Chưa chấm công hôm nay</p>
                <p className="mt-1 text-xs text-slate-500">
                  Xác nhận ca làm để ghi nhận giờ vào theo thời gian máy chủ.
                </p>
              </div>
            )}
          </div>
          {modules.attendance && (
            <button
              type="button"
              onClick={() => onNavigate('attendance')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              <span>Đi tới Chấm công</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Customer Feedback Quota */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-500">Ý kiến khách hàng hôm nay</span>
              <MessageSquareText className="h-4 w-4 text-blue-600" />
            </div>
            {loading ? (
              <div className="mt-3 h-10 bg-slate-100 rounded animate-pulse" />
            ) : (
              <div className="mt-2.5">
                <p className="text-2xl font-bold text-slate-900 tabular-nums">
                  <span
                    className={
                      (summary?.myTodayFeedbackCount ?? 0) >= 2
                        ? 'text-emerald-600'
                        : 'text-amber-600'
                    }
                  >
                    {summary?.myTodayFeedbackCount ?? 0}
                  </span>
                  <span className="text-sm font-normal text-slate-500"> / 2 mục tiêu cá nhân</span>
                </p>
                <p className="mt-1 text-xs text-slate-500 tabular-nums">
                  Toàn đội hôm nay: {summary?.teamTodayFeedbackCount ?? 0} ý kiến
                </p>
              </div>
            )}
          </div>
          {modules.feedback && (
            <button
              type="button"
              onClick={() => onNavigate('feedback')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              <span>Gửi &amp; xem ý kiến KH</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Actionable Operational Alerts */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="text-sm font-bold text-slate-900">Cảnh báo cần xử lý</h3>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          <button
            type="button"
            disabled={!modules.expiry}
            onClick={() => modules.expiry && onNavigate('expiry')}
            className="text-left border border-slate-200 rounded-xl p-4 hover:bg-slate-50 transition-colors disabled:opacity-60"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600">Hàng sắp hết hạn (≤ 30 ngày)</span>
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-amber-700 tabular-nums">
              {loading ? '—' : summary?.expiringSoonCount ?? 0}
            </p>
            <p className="mt-1 text-xs text-slate-500">Kiểm tra hạn sử dụng &amp; chính sách đổi trả</p>
          </button>

          <button
            type="button"
            disabled={!modules.returns}
            onClick={() => modules.returns && onNavigate('returns')}
            className="text-left border border-slate-200 rounded-xl p-4 hover:bg-slate-50 transition-colors disabled:opacity-60"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600">Đơn đổi trả đang xử lý</span>
              <RotateCcw className="h-4 w-4 text-red-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
              {loading ? '—' : summary?.processingReturnsCount ?? 0}
            </p>
            <p className="mt-1 text-xs text-slate-500">Cập nhật tiến độ với nhà cung cấp</p>
          </button>

          <button
            type="button"
            disabled={!modules.promotions}
            onClick={() => modules.promotions && onNavigate('promotions')}
            className="text-left border border-slate-200 rounded-xl p-4 hover:bg-slate-50 transition-colors disabled:opacity-60"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600">Khuyến mãi đang chạy</span>
              <Tag className="h-4 w-4 text-emerald-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-emerald-700 tabular-nums">
              {loading ? '—' : summary?.activePromosCount ?? 0}
            </p>
            <p className="mt-1 text-xs text-slate-500">Theo dõi giá KM &amp; tồn HSD ngắn</p>
          </button>
        </div>
      </div>
    </div>
  );
}
