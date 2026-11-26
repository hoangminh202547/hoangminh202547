import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CheckCircle2,
  Clock,
  FileSpreadsheet,
  History,
  LogOut as CheckOutIcon,
  Plus,
  Search,
} from 'lucide-react';
import { useDebouncedValue } from '../../lib/cache';
import { exportAttendanceToExcel } from '../../lib/excel';
import {
  appendAttendanceNoteOrCheckout,
  createAttendanceCheckIn,
  fetchAttendancePage,
  useScopedRealtime,
} from '../../lib/supabaseOps';
import type {
  AttendanceNoteEntry,
  AttendanceRecord,
  AuthenticatedUser,
  ShiftDefinition,
  WorkSchedule,
} from '../../types';
import { PaginationBar } from '../PaginationBar';

interface AttendanceTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  todaySchedules: WorkSchedule[];
  shifts: ShiftDefinition[];
  defaultPageSize: 20 | 50 | 100;
  canExport: boolean;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onLogActivity: (action: 'create' | 'update' | 'export', targetId: string, summary: string) => void;
}

const NOTE_TYPE_LABELS: Record<AttendanceNoteEntry['type'], string> = {
  overtime: 'Tăng ca',
  early_leave: 'Về sớm',
  incident: 'Phát sinh',
  note: 'Ghi chú',
};

const STATUS_BADGE: Record<AttendanceRecord['status'], { label: string; cls: string }> = {
  checked_in: { label: 'Đang trong ca', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  checked_out: { label: 'Đã kết ca', cls: 'text-slate-700 bg-slate-100 border-slate-200' },
  early_leave: { label: 'Về sớm', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  overtime: { label: 'Tăng ca', cls: 'text-blue-700 bg-blue-50 border-blue-200' },
};

export function AttendanceTab({
  client,
  user,
  todaySchedules,
  shifts,
  defaultPageSize,
  canExport,
  onNotify,
  onLogActivity,
}: AttendanceTabProps) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState<AttendanceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(defaultPageSize);
  const [loading, setLoading] = useState(true);

  const [filterMode, setFilterMode] = useState<'day' | 'month' | 'year' | 'all'>('month');
  const [filterDate, setFilterDate] = useState(todayStr);
  const [searchText, setSearchText] = useState('');
  const debouncedSearch = useDebouncedValue(searchText, 380);

  // Check-in form
  const [unscheduledShift, setUnscheduledShift] = useState(
    shifts.find((s) => !s.isDayOff)?.name || 'Ca phát sinh'
  );
  const [initialNote, setInitialNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Append note modal / inline drawer
  const [noteTarget, setNoteTarget] = useState<AttendanceRecord | null>(null);
  const [noteType, setNoteType] = useState<AttendanceNoteEntry['type']>('note');
  const [noteContent, setNoteContent] = useState('');
  const [markCheckout, setMarkCheckout] = useState(false);

  const datePrefix = useMemo(() => {
    if (filterMode === 'all') return '';
    if (filterMode === 'day') return filterDate.slice(0, 10);
    if (filterMode === 'month') return filterDate.slice(0, 7);
    return filterDate.slice(0, 4);
  }, [filterMode, filterDate]);

  const loadRows = useCallback(async () => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await fetchAttendancePage(client, {
      page,
      pageSize,
      search: debouncedSearch,
      datePrefix,
    });
    if (res.error) {
      onNotify('error', res.error);
    } else {
      setRows(res.rows);
      setTotal(res.total);
    }
    setLoading(false);
  }, [client, page, pageSize, debouncedSearch, datePrefix, onNotify]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  useScopedRealtime(client, Boolean(client), ['attendance_logs'], () => {
    void loadRows();
  });

  const myTodaySchedules = useMemo(
    () =>
      todaySchedules.filter(
        (s) =>
          s.workDate === todayStr &&
          s.ownerEmail.toLowerCase() === user.email.toLowerCase() &&
          s.status !== 'cancelled' &&
          !s.isDayOff
      ),
    [todaySchedules, todayStr, user.email]
  );

  const handleScheduledCheckIn = async (sched: WorkSchedule) => {
    if (!client) {
      onNotify('error', 'Vui lòng kích hoạt phiên Supabase Auth để chấm công.');
      return;
    }
    setSubmitting(true);
    const res = await createAttendanceCheckIn(client, {
      scheduleId: sched.id,
      ownerId: user.uid,
      ownerEmail: user.email,
      employeeName: sched.employeeName || user.displayName,
      shiftName: `${sched.title} (${sched.startTime}–${sched.endTime})`,
      workDate: sched.workDate,
      isUnscheduled: false,
      initialNote,
    });
    setSubmitting(false);
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    setInitialNote('');
    onNotify('success', 'Đã chấm công theo lịch (lấy giờ máy chủ).');
    if (res.data) {
      onLogActivity('create', res.data.id, `Chấm công ca ${res.data.shiftName}`);
    }
    void loadRows();
  };

  const handleUnscheduledCheckIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) {
      onNotify('error', 'Vui lòng kích hoạt phiên Supabase Auth để chấm công.');
      return;
    }
    setSubmitting(true);
    const res = await createAttendanceCheckIn(client, {
      scheduleId: null,
      ownerId: user.uid,
      ownerEmail: user.email,
      employeeName: user.displayName,
      shiftName: unscheduledShift.trim() || 'Ca ngoài lịch',
      workDate: todayStr,
      isUnscheduled: true,
      initialNote,
    });
    setSubmitting(false);
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    setInitialNote('');
    onNotify('success', 'Đã chấm công ngoài lịch thành công.');
    if (res.data) {
      onLogActivity('create', res.data.id, `Chấm công ngoài lịch ${res.data.shiftName}`);
    }
    void loadRows();
  };

  const handleSaveNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client || !noteTarget) return;
    if (!noteContent.trim() && !markCheckout) {
      onNotify('error', 'Nhập nội dung ghi chú hoặc chọn Kết ca.');
      return;
    }
    setSubmitting(true);
    const nextStatus =
      noteType === 'early_leave'
        ? 'early_leave'
        : noteType === 'overtime'
          ? 'overtime'
          : markCheckout
            ? 'checked_out'
            : undefined;

    const res = await appendAttendanceNoteOrCheckout(client, noteTarget, {
      actorEmail: user.email,
      noteType,
      noteContent,
      nextStatus,
      markCheckout,
    });
    setSubmitting(false);
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    onNotify('success', 'Đã lưu bổ sung ghi chú chấm công (bảo toàn lịch sử).');
    onLogActivity('update', noteTarget.id, `Cập nhật chấm công: ${NOTE_TYPE_LABELS[noteType]}`);
    setNoteTarget(null);
    setNoteContent('');
    setMarkCheckout(false);
    void loadRows();
  };

  const stats = useMemo(() => {
    let totalHours = 0;
    for (const r of rows) {
      if (r.checkInAt && r.checkOutAt) {
        const ms = new Date(r.checkOutAt).getTime() - new Date(r.checkInAt).getTime();
        if (ms > 0) totalHours += ms / 3600000;
      }
    }
    return {
      totalShifts: total,
      pageHours: Math.round(totalHours * 10) / 10,
    };
  }, [rows, total]);

  const handleExport = async () => {
    if (!canExport) return;
    const fileName = await exportAttendanceToExcel(rows);
    onNotify('success', `Đã xuất tệp ${fileName}`);
    onLogActivity('export', fileName, `Xuất Excel chấm công (${rows.length} dòng)`);
  };

  return (
    <div className="space-y-6">
      {/* Check-in Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Xác nhận chấm công hôm nay ({todayStr})</h2>
            <p className="text-xs text-slate-500">
              Thời gian chấm công được ghi nhận tự động theo đồng hồ máy chủ Database (chống sửa giờ thiết bị).
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-600 tabular-nums">
            <span>Tổng lượt lọc: <strong className="text-slate-900">{stats.totalShifts}</strong></span>
            <span>Giờ đã kết ca trang này: <strong className="text-slate-900">{stats.pageHours}h</strong></span>
          </div>
        </div>

        {/* Scheduled today */}
        {myTodaySchedules.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {myTodaySchedules.map((s) => {
              const alreadyDone = rows.some(
                (r) =>
                  r.scheduleId === s.id ||
                  (r.workDate === s.workDate &&
                    r.ownerEmail === user.email.toLowerCase() &&
                    r.shiftName.includes(s.title))
              );
              return (
                <div
                  key={s.id}
                  className="border border-slate-200 rounded-lg p-3.5 flex items-center justify-between gap-3"
                >
                  <div>
                    <p className="text-sm font-bold text-slate-900">{s.title}</p>
                    <p className="text-xs font-mono text-slate-500 tabular-nums">
                      {s.startTime} – {s.endTime} {s.location ? `· ${s.location}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={submitting || alreadyDone || !client}
                    onClick={() => void handleScheduledCheckIn(s)}
                    className="min-h-[42px] px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    <span>{alreadyDone ? 'Đã chấm công' : 'Chấm công ca này'}</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Unscheduled check-in */}
        <form onSubmit={handleUnscheduledCheckIn} className="grid grid-cols-1 sm:grid-cols-12 gap-3 pt-2 border-t border-slate-100">
          <div className="sm:col-span-4">
            <label className="block text-xs font-medium text-slate-600 mb-1">Chấm công ngoài lịch / Ca phát sinh</label>
            <select
              value={unscheduledShift}
              onChange={(e) => setUnscheduledShift(e.target.value)}
              className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              {shifts.filter((s) => !s.isDayOff).map((s) => (
                <option key={s.id} value={`${s.name} (${s.startTime}-${s.endTime})`}>
                  {s.name} ({s.startTime}–{s.endTime})
                </option>
              ))}
              <option value="Ca hỗ trợ / phát sinh">Ca hỗ trợ / phát sinh</option>
            </select>
          </div>
          <div className="sm:col-span-5">
            <label className="block text-xs font-medium text-slate-600 mb-1">Ghi chú ban đầu (tùy chọn)</label>
            <input
              type="text"
              value={initialNote}
              onChange={(e) => setInitialNote(e.target.value)}
              placeholder="VD: Hỗ trợ kiểm kê quầy TPCN..."
              className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div className="sm:col-span-3 flex items-end">
            <button
              type="submit"
              disabled={submitting || !client}
              className="w-full min-h-[42px] px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              <span>Chấm công ngay</span>
            </button>
          </div>
        </form>
      </div>

      {/* Filters + Export */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filterMode}
              onChange={(e) => {
                setFilterMode(e.target.value as typeof filterMode);
                setPage(1);
              }}
              className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="day">Theo ngày</option>
              <option value="month">Theo tháng</option>
              <option value="year">Theo năm</option>
              <option value="all">Tất cả</option>
            </select>

            {filterMode !== 'all' && (
              <input
                type={filterMode === 'day' ? 'date' : filterMode === 'month' ? 'month' : 'number'}
                value={
                  filterMode === 'day'
                    ? filterDate.slice(0, 10)
                    : filterMode === 'month'
                      ? filterDate.slice(0, 7)
                      : filterDate.slice(0, 4)
                }
                onChange={(e) => {
                  setFilterDate(e.target.value);
                  setPage(1);
                }}
                className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg font-mono"
              />
            )}

            <div className="relative">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={searchText}
                onChange={(e) => {
                  setSearchText(e.target.value);
                  setPage(1);
                }}
                placeholder="Tìm tên nhân sự, ca..."
                className="min-h-[40px] pl-9 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg w-56"
              />
            </div>
          </div>

          {canExport && (
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={rows.length === 0}
              className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
              <span>Xuất Excel</span>
            </button>
          )}
        </div>

        {/* Data Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                <th className="py-3 px-4">Ngày</th>
                <th className="py-3 px-4">Nhân sự</th>
                <th className="py-3 px-4">Ca làm</th>
                <th className="py-3 px-4">Giờ vào (Server)</th>
                <th className="py-3 px-4">Giờ ra</th>
                <th className="py-3 px-4">Trạng thái</th>
                <th className="py-3 px-4">Lịch sử ghi chú</th>
                <th className="py-3 px-4 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={8} className="py-4 px-4">
                      <div className="h-5 bg-slate-100 rounded animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 px-4 text-center text-sm text-slate-500">
                    Chưa có bản ghi chấm công nào khớp bộ lọc.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const badge = STATUS_BADGE[r.status] || STATUS_BADGE.checked_in;
                  return (
                    <tr key={r.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                        {r.workDate}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-medium text-slate-900">{r.employeeName}</p>
                        <p className="text-xs text-slate-500 font-mono">{r.ownerEmail}</p>
                      </td>
                      <td className="py-3 px-4">
                        <p className="text-slate-900">{r.shiftName}</p>
                        {r.isUnscheduled && (
                          <span className="text-[11px] font-medium text-amber-700">Ngoài lịch</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-800 tabular-nums whitespace-nowrap">
                        {new Intl.DateTimeFormat('vi-VN', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        }).format(new Date(r.checkInAt))}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                        {r.checkOutAt
                          ? new Intl.DateTimeFormat('vi-VN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            }).format(new Date(r.checkOutAt))
                          : '—'}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="py-3 px-4 max-w-xs">
                        {r.notesHistory.length === 0 ? (
                          <span className="text-xs text-slate-400">Chưa có ghi chú</span>
                        ) : (
                          <div className="space-y-1">
                            {r.notesHistory.map((n) => (
                              <p key={n.id} className="text-xs text-slate-700">
                                <span className="font-medium text-slate-900">
                                  [{NOTE_TYPE_LABELS[n.type]}]
                                </span>{' '}
                                {n.content}
                              </p>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => {
                            setNoteTarget(r);
                            setNoteType('note');
                            setNoteContent('');
                            setMarkCheckout(!r.checkOutAt);
                          }}
                          className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                        >
                          <History className="h-3.5 w-3.5" />
                          <span>Ghi chú / Kết ca</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(sz) => {
            setPageSize(sz);
            setPage(1);
          }}
        />
      </div>

      {/* Modal: Append Note / Checkout */}
      {noteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveNote}
            className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-5 space-y-4 shadow-xl"
          >
            <div className="flex items-center gap-2 text-slate-900 font-bold">
              <Clock className="h-5 w-5 text-blue-600" />
              <span>Bổ sung ghi chú / Kết ca</span>
            </div>
            <p className="text-xs text-slate-500">
              {noteTarget.employeeName} · {noteTarget.shiftName} ({noteTarget.workDate}). Mọi ghi chú mới được nối tiếp vào lịch sử và không thể xóa ghi chú cũ.
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Phân loại phát sinh</label>
              <select
                value={noteType}
                onChange={(e) => setNoteType(e.target.value as AttendanceNoteEntry['type'])}
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="note">Ghi chú bổ sung</option>
                <option value="overtime">Tăng ca</option>
                <option value="early_leave">Về sớm</option>
                <option value="incident">Sự cố / Phát sinh</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Nội dung ghi chú</label>
              <textarea
                rows={3}
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                placeholder="Ghi rõ lý do hoặc số giờ tăng ca..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            {!noteTarget.checkOutAt && (
              <label className="flex items-center gap-2 text-sm text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={markCheckout}
                  onChange={(e) => setMarkCheckout(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span className="inline-flex items-center gap-1">
                  <CheckOutIcon className="h-4 w-4 text-slate-600" />
                  Đánh dấu giờ kết ca ngay lúc này
                </span>
              </label>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setNoteTarget(null)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Đang lưu...' : 'Lưu cập nhật'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
