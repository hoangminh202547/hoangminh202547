import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CheckCircle2,
  Clock,
  Eraser,
  FileSpreadsheet,
  History,
  LogOut as CheckOutIcon,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useDebouncedValue } from '../../lib/cache';
import { exportAttendanceToExcel } from '../../lib/excel';
import { formatViDate, formatYmd } from '../../lib/scheduleMeta';
import {
  appendAttendanceNoteOrCheckout,
  createAttendanceCheckIn,
  deleteAttendanceRecord,
  fetchAttendancePage,
  updateAttendanceRecord,
  useScopedRealtime,
} from '../../lib/supabaseOps';
import type {
  AttendanceNoteEntry,
  AttendanceRecord,
  AuthenticatedUser,
  ShiftDefinition,
  WorkSchedule,
} from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { PaginationBar } from '../PaginationBar';

interface AttendanceTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  todaySchedules: WorkSchedule[];
  shifts: ShiftDefinition[];
  defaultPageSize: 20 | 50 | 100;
  canExport: boolean;
  canManage: boolean;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onLogActivity: (
    action: 'create' | 'update' | 'delete' | 'export',
    targetId: string,
    summary: string
  ) => void;
}

const NOTE_TYPE_LABELS: Record<AttendanceNoteEntry['type'], string> = {
  overtime: 'Tăng ca',
  early_leave: 'Về sớm',
  clear_time: 'Clear giờ',
  incident: 'Phát sinh',
  note: 'Ghi chú',
};

const NOTE_TYPE_BADGE: Record<AttendanceNoteEntry['type'], string> = {
  overtime: 'text-blue-700 bg-blue-50 border-blue-200',
  early_leave: 'text-amber-700 bg-amber-50 border-amber-200',
  clear_time: 'text-violet-700 bg-violet-50 border-violet-200',
  incident: 'text-rose-700 bg-rose-50 border-rose-200',
  note: 'text-slate-700 bg-slate-100 border-slate-200',
};

const STATUS_BADGE: Record<AttendanceRecord['status'], { label: string; cls: string }> = {
  checked_in: { label: 'Đã xác nhận ca', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  checked_out: { label: 'Đã xác nhận ca', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  early_leave: { label: 'Về sớm', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  overtime: { label: 'Tăng ca', cls: 'text-blue-700 bg-blue-50 border-blue-200' },
  clear_time: { label: 'Clear giờ', cls: 'text-violet-700 bg-violet-50 border-violet-200' },
};

function toDateTimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function fromDateTimeLocalValue(val: string): string | null {
  if (!val.trim()) return null;
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function formatTimeHms(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}

export function AttendanceTab({
  client,
  user,
  todaySchedules,
  shifts,
  defaultPageSize,
  canExport,
  canManage,
  onNotify,
  onLogActivity,
}: AttendanceTabProps) {
  const [nowClock, setNowClock] = useState<Date>(() => new Date());
  const todayStr = formatYmd(nowClock);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowClock(new Date());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const [rows, setRows] = useState<AttendanceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(defaultPageSize);
  const [loading, setLoading] = useState(true);

  const [filterMode, setFilterMode] = useState<'day' | 'month' | 'year' | 'all'>('month');
  const [filterDate, setFilterDate] = useState(() => formatYmd(new Date()));
  const [searchText, setSearchText] = useState('');
  const debouncedSearch = useDebouncedValue(searchText, 380);

  // Check-in form
  const [unscheduledShift, setUnscheduledShift] = useState(
    shifts.find((s) => !s.isDayOff)?.name || 'Ca phát sinh'
  );
  const [initialNote, setInitialNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Shift note entry table panel (Tăng ca / Về sớm / Clear giờ)
  const [quickRecordId, setQuickRecordId] = useState<string>('');
  const [quickNoteType, setQuickNoteType] = useState<'overtime' | 'early_leave' | 'clear_time'>(
    'overtime'
  );
  const [quickNoteContent, setQuickNoteContent] = useState('');
  const [quickActionMode, setQuickActionMode] = useState<'note_only' | 'checkout_now' | 'clear_checkout'>(
    'note_only'
  );

  // Append note modal
  const [noteTarget, setNoteTarget] = useState<AttendanceRecord | null>(null);
  const [noteType, setNoteType] = useState<AttendanceNoteEntry['type']>('note');
  const [noteContent, setNoteContent] = useState('');
  const [markCheckout, setMarkCheckout] = useState(false);
  const [clearCheckoutInModal, setClearCheckoutInModal] = useState(false);

  // Adjust / Edit modal
  const [editTarget, setEditTarget] = useState<AttendanceRecord | null>(null);
  const [editEmployeeName, setEditEmployeeName] = useState('');
  const [editShiftName, setEditShiftName] = useState('');
  const [editWorkDate, setEditWorkDate] = useState('');
  const [editCheckInLocal, setEditCheckInLocal] = useState('');
  const [editCheckOutLocal, setEditCheckOutLocal] = useState('');
  const [editStatus, setEditStatus] = useState<AttendanceRecord['status']>('checked_in');
  const [editReason, setEditReason] = useState('');

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<AttendanceRecord | null>(null);

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

  const canModifyRecord = useCallback(
    (r: AttendanceRecord) =>
      canManage || r.ownerEmail.toLowerCase() === user.email.toLowerCase(),
    [canManage, user.email]
  );

  const editableRows = useMemo(
    () => rows.filter((r) => canModifyRecord(r)),
    [rows, canModifyRecord]
  );

  useEffect(() => {
    if (editableRows.length === 0) {
      setQuickRecordId('');
      return;
    }
    if (!quickRecordId || !editableRows.some((r) => r.id === quickRecordId)) {
      const ownToday = editableRows.find(
        (r) =>
          r.workDate === todayStr &&
          r.ownerEmail.toLowerCase() === user.email.toLowerCase()
      );
      setQuickRecordId((ownToday || editableRows[0]).id);
    }
  }, [editableRows, quickRecordId, todayStr, user.email]);

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

  // Flatten shift notes for the dedicated "Bảng điền ghi chú thêm ca làm việc" view
  const shiftNoteTableRows = useMemo(() => {
    const entries: Array<{
      record: AttendanceRecord;
      note: AttendanceNoteEntry;
    }> = [];
    for (const r of rows) {
      for (const n of r.notesHistory) {
        if (
          n.type === 'overtime' ||
          n.type === 'early_leave' ||
          n.type === 'clear_time' ||
          n.type === 'incident'
        ) {
          entries.push({ record: r, note: n });
        }
      }
    }
    return entries.sort(
      (a, b) => new Date(b.note.createdAt).getTime() - new Date(a.note.createdAt).getTime()
    );
  }, [rows]);

  const handleScheduledCheckIn = async (sched: WorkSchedule) => {
    if (!client) {
      onNotify('error', 'Vui lòng kích hoạt phiên Supabase Auth để chấm công.');
      return;
    }
    const clickTimeLabel = formatTimeHms(new Date());
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
    onNotify('success', `Đã xác nhận ca lúc ${clickTimeLabel} (thời gian thực).`);
    if (res.data) {
      onLogActivity('create', res.data.id, `Xác nhận ca ${res.data.shiftName}`);
    }
    void loadRows();
  };

  const handleUnscheduledCheckIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) {
      onNotify('error', 'Vui lòng kích hoạt phiên Supabase Auth để chấm công.');
      return;
    }
    const clickTimeLabel = formatTimeHms(new Date());
    setSubmitting(true);
    const res = await createAttendanceCheckIn(client, {
      scheduleId: null,
      ownerId: user.uid,
      ownerEmail: user.email,
      employeeName: user.displayName,
      shiftName: unscheduledShift.trim() || 'Ca phát sinh',
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
    onNotify('success', `Đã xác nhận ca lúc ${clickTimeLabel} (thời gian thực).`);
    if (res.data) {
      onLogActivity('create', res.data.id, `Xác nhận ca ngoài lịch ${res.data.shiftName}`);
    }
    void loadRows();
  };

  const handleQuickShiftNoteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) {
      onNotify('error', 'Vui lòng kích hoạt phiên Supabase Auth.');
      return;
    }
    const target = editableRows.find((r) => r.id === quickRecordId);
    if (!target) {
      onNotify('error', 'Hãy chọn ca làm việc cần ghi chú (hoặc bấm chấm công trước).');
      return;
    }
    if (!quickNoteContent.trim() && quickActionMode === 'note_only') {
      onNotify('error', 'Vui lòng nhập nội dung ghi chú thêm ca làm việc.');
      return;
    }

    const clickTimeLabel = formatTimeHms(new Date());
    const effectiveContent =
      quickNoteContent.trim() ||
      (quickActionMode === 'clear_checkout'
        ? `Clear giờ kết ca lúc ${clickTimeLabel}`
        : `Xác nhận ${NOTE_TYPE_LABELS[quickNoteType]} lúc ${clickTimeLabel}`);

    const nextStatus: AttendanceRecord['status'] =
      quickNoteType === 'overtime'
        ? 'overtime'
        : quickNoteType === 'early_leave'
          ? 'early_leave'
          : 'clear_time';

    setSubmitting(true);
    const res = await appendAttendanceNoteOrCheckout(client, target, {
      actorEmail: user.email,
      noteType: quickNoteType,
      noteContent: effectiveContent,
      nextStatus,
      markCheckout: quickActionMode === 'checkout_now',
      clearCheckout: quickActionMode === 'clear_checkout',
    });
    setSubmitting(false);

    if (res.error) {
      onNotify('error', res.error);
      return;
    }

    setQuickNoteContent('');
    setQuickActionMode('note_only');
    onNotify(
      'success',
      `Đã lưu ghi chú "${NOTE_TYPE_LABELS[quickNoteType]}" lúc ${clickTimeLabel}.`
    );
    onLogActivity(
      'update',
      target.id,
      `Ghi chú ${NOTE_TYPE_LABELS[quickNoteType]} cho ca ${target.shiftName}`
    );
    void loadRows();
  };

  const handleSaveNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client || !noteTarget) return;
    if (!noteContent.trim() && !markCheckout && !clearCheckoutInModal) {
      onNotify('error', 'Nhập nội dung ghi chú hoặc chọn Kết ca / Clear giờ.');
      return;
    }
    const clickTimeLabel = formatTimeHms(new Date());
    setSubmitting(true);
    const nextStatus: AttendanceRecord['status'] | undefined =
      noteType === 'early_leave'
        ? 'early_leave'
        : noteType === 'overtime'
          ? 'overtime'
          : noteType === 'clear_time' || clearCheckoutInModal
            ? 'clear_time'
            : markCheckout
              ? 'checked_out'
              : undefined;

    const effectiveContent =
      noteContent.trim() ||
      (clearCheckoutInModal
        ? `Clear giờ ra lúc ${clickTimeLabel}`
        : markCheckout
          ? `Kết ca lúc ${clickTimeLabel}`
          : '');

    const res = await appendAttendanceNoteOrCheckout(client, noteTarget, {
      actorEmail: user.email,
      noteType,
      noteContent: effectiveContent,
      nextStatus,
      markCheckout: markCheckout && !clearCheckoutInModal,
      clearCheckout: clearCheckoutInModal,
    });
    setSubmitting(false);
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    onNotify('success', 'Đã lưu cập nhật chấm công.');
    onLogActivity('update', noteTarget.id, `Cập nhật chấm công: ${NOTE_TYPE_LABELS[noteType]}`);
    setNoteTarget(null);
    setNoteContent('');
    setMarkCheckout(false);
    setClearCheckoutInModal(false);
    void loadRows();
  };

  const openEditModal = (r: AttendanceRecord) => {
    setEditTarget(r);
    setEditEmployeeName(r.employeeName);
    setEditShiftName(r.shiftName);
    setEditWorkDate(r.workDate);
    setEditCheckInLocal(toDateTimeLocalValue(r.checkInAt));
    setEditCheckOutLocal(toDateTimeLocalValue(r.checkOutAt));
    setEditStatus(r.status);
    setEditReason('');
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client || !editTarget) return;
    const nextCheckInIso = fromDateTimeLocalValue(editCheckInLocal);
    if (!nextCheckInIso) {
      onNotify('error', 'Giờ vào không hợp lệ.');
      return;
    }
    const nextCheckOutIso = editCheckOutLocal ? fromDateTimeLocalValue(editCheckOutLocal) : null;
    if (editCheckOutLocal && !nextCheckOutIso) {
      onNotify('error', 'Giờ ra không hợp lệ.');
      return;
    }

    setSubmitting(true);
    const res = await updateAttendanceRecord(client, editTarget, {
      actorEmail: user.email,
      employeeName: editEmployeeName,
      shiftName: editShiftName,
      workDate: editWorkDate,
      checkInAt: nextCheckInIso,
      checkOutAt: nextCheckOutIso,
      status: editStatus,
      adjustmentNote: editReason.trim()
        ? `Điều chỉnh lúc ${formatTimeHms(new Date())}: ${editReason.trim()}`
        : undefined,
      noteType: editStatus === 'clear_time' ? 'clear_time' : 'note',
    });
    setSubmitting(false);
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    onNotify('success', 'Đã điều chỉnh thông tin chấm công.');
    onLogActivity('update', editTarget.id, `Điều chỉnh chấm công ${editTarget.employeeName} (${editWorkDate})`);
    setEditTarget(null);
    void loadRows();
  };

  const handleConfirmDelete = async () => {
    if (!client || !deleteTarget) return;
    setSubmitting(true);
    const res = await deleteAttendanceRecord(client, deleteTarget.id);
    setSubmitting(false);
    if (res.error) {
      onNotify('error', res.error);
    } else {
      onNotify('success', 'Đã xóa bản ghi chấm công.');
      onLogActivity(
        'delete',
        deleteTarget.id,
        `Xóa chấm công ${deleteTarget.employeeName} (${deleteTarget.workDate})`
      );
      void loadRows();
    }
    setDeleteTarget(null);
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
      {/* Real-time 1-Step Shift Confirmation Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-bold text-slate-900">
                Xác nhận ca làm việc hôm nay ({formatViDate(todayStr)})
              </h2>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-mono font-bold text-emerald-800 tabular-nums">
                <Clock className="h-3.5 w-3.5 text-emerald-600" />
                <span>{formatTimeHms(nowClock)}</span>
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-600 mt-1">
              Chỉ cần bấm nút xác nhận ca — hệ thống tự động ghi nhận chính xác thời gian thực tại thời điểm nhấn.
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs sm:text-sm text-slate-600 tabular-nums">
            <span>
              Tổng lượt lọc: <strong className="text-slate-900">{stats.totalShifts}</strong>
            </span>
          </div>
        </div>

        {/* Scheduled today */}
        {myTodaySchedules.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {myTodaySchedules.map((s) => {
              const existingRecord = rows.find(
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
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900">{s.title}</p>
                    <p className="text-xs font-mono text-slate-500 tabular-nums">
                      {s.startTime} – {s.endTime} {s.location ? `· ${s.location}` : ''}
                    </p>
                    {existingRecord && (
                      <p className="text-xs font-mono text-emerald-700 mt-1 font-semibold tabular-nums">
                        Đã xác nhận lúc {formatTimeHms(existingRecord.checkInAt)}
                      </p>
                    )}
                  </div>

                  {!existingRecord ? (
                    <button
                      type="button"
                      disabled={submitting || !client}
                      onClick={() => void handleScheduledCheckIn(s)}
                      className="min-h-[42px] px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs sm:text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span>Xác nhận ca</span>
                    </button>
                  ) : (
                    <span className="px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold whitespace-nowrap shrink-0 inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Đã xác nhận</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Quick shift confirmation (unscheduled / extra shift) */}
        <form
          onSubmit={handleUnscheduledCheckIn}
          className="grid grid-cols-1 sm:grid-cols-12 gap-3 pt-2 border-t border-slate-100"
        >
          <div className="sm:col-span-4">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Chọn ca xác nhận nhanh / Ca phát sinh
            </label>
            <select
              value={unscheduledShift}
              onChange={(e) => setUnscheduledShift(e.target.value)}
              className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              {shifts
                .filter((s) => !s.isDayOff)
                .map((s) => (
                  <option key={s.id} value={`${s.name} (${s.startTime}-${s.endTime})`}>
                    {s.name} ({s.startTime}–{s.endTime})
                  </option>
                ))}
              <option value="Ca hỗ trợ / phát sinh">Ca hỗ trợ / phát sinh</option>
            </select>
          </div>
          <div className="sm:col-span-5">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Ghi chú ban đầu (tùy chọn)
            </label>
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
              <span>Xác nhận ca ngay</span>
            </button>
          </div>
        </form>
      </div>

      {/* Shift Extra Notes Table (Tăng ca / Về sớm / Clear giờ) */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-base font-bold text-slate-900">
            Bảng điền ghi chú thêm ca làm việc (Tăng ca / Về sớm / Clear giờ)
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Ghi nhận nhanh trường hợp tăng ca, về sớm hoặc clear giờ cho ca đã chấm công và theo dõi danh sách phát sinh.
          </p>
        </div>

        <form
          onSubmit={handleQuickShiftNoteSubmit}
          className="grid grid-cols-1 sm:grid-cols-12 gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200"
        >
          <div className="sm:col-span-4">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Chọn ca làm việc áp dụng
            </label>
            <select
              value={quickRecordId}
              onChange={(e) => setQuickRecordId(e.target.value)}
              disabled={editableRows.length === 0}
              className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white disabled:bg-slate-100"
            >
              {editableRows.length === 0 ? (
                <option value="">Chưa có bản ghi chấm công để chọn</option>
              ) : (
                editableRows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.workDate} · {r.employeeName} · {r.shiftName}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Trường hợp
            </label>
            <select
              value={quickNoteType}
              onChange={(e) => {
                const v = e.target.value as 'overtime' | 'early_leave' | 'clear_time';
                setQuickNoteType(v);
                if (v === 'clear_time') setQuickActionMode('clear_checkout');
              }}
              className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="overtime">Tăng ca</option>
              <option value="early_leave">Về sớm</option>
              <option value="clear_time">Clear giờ</option>
            </select>
          </div>

          <div className="sm:col-span-3">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Thao tác giờ (nếu cần)
            </label>
            <select
              value={quickActionMode}
              onChange={(e) =>
                setQuickActionMode(
                  e.target.value as 'note_only' | 'checkout_now' | 'clear_checkout'
                )
              }
              className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="note_only">Chỉ ghi chú thêm</option>
              <option value="clear_checkout">Clear giờ (xóa mốc giờ thêm)</option>
              <option value="checkout_now">Ghi nhận giờ kết thúc ({formatTimeHms(nowClock)})</option>
            </select>
          </div>

          <div className="sm:col-span-3">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Chi tiết (số giờ / lý do)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={quickNoteContent}
                onChange={(e) => setQuickNoteContent(e.target.value)}
                placeholder="VD: Tăng ca 1.5h kiểm kho..."
                className="flex-1 min-w-0 min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
              />
              <button
                type="submit"
                disabled={submitting || !client || !quickRecordId}
                className="min-h-[40px] px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs sm:text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                Lưu
              </button>
            </div>
          </div>
        </form>

        {/* Desktop table of overtime / early_leave / clear_time notes */}
        <div className="hidden md:block overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                <th className="py-2.5 px-3">Ngày</th>
                <th className="py-2.5 px-3">Nhân sự</th>
                <th className="py-2.5 px-3">Ca làm</th>
                <th className="py-2.5 px-3">Loại phát sinh</th>
                <th className="py-2.5 px-3">Nội dung ghi chú</th>
                <th className="py-2.5 px-3">Thời điểm ghi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shiftNoteTableRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 px-3 text-center text-xs text-slate-500">
                    Chưa có ghi chú Tăng ca / Về sớm / Clear giờ trong danh sách đang lọc.
                  </td>
                </tr>
              ) : (
                shiftNoteTableRows.slice(0, 15).map(({ record, note }) => (
                  <tr key={`${record.id}_${note.id}`} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-3 font-mono text-xs text-slate-700 whitespace-nowrap tabular-nums">
                      {record.workDate}
                    </td>
                    <td className="py-2.5 px-3 font-medium text-slate-900">
                      {record.employeeName}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700">{record.shiftName}</td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <span
                        className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${
                          NOTE_TYPE_BADGE[note.type] || NOTE_TYPE_BADGE.note
                        }`}
                      >
                        {NOTE_TYPE_LABELS[note.type] || note.type}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-slate-800">{note.content}</td>
                    <td className="py-2.5 px-3 font-mono text-xs text-slate-500 whitespace-nowrap tabular-nums">
                      {formatTimeHms(note.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Portrait Cards for shift notes */}
        <div className="md:hidden border border-slate-200 rounded-lg divide-y divide-slate-100">
          {shiftNoteTableRows.length === 0 ? (
            <p className="py-5 px-3 text-center text-sm text-slate-500">
              Chưa có ghi chú Tăng ca / Về sớm / Clear giờ.
            </p>
          ) : (
            shiftNoteTableRows.slice(0, 15).map(({ record, note }) => (
              <div key={`${record.id}_${note.id}`} className="p-3.5 space-y-1.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`inline-block px-2 py-0.5 text-xs font-semibold rounded border ${
                      NOTE_TYPE_BADGE[note.type] || NOTE_TYPE_BADGE.note
                    }`}
                  >
                    {NOTE_TYPE_LABELS[note.type] || note.type}
                  </span>
                  <span className="font-mono text-xs text-slate-500 tabular-nums">
                    {record.workDate} · {formatTimeHms(note.createdAt)}
                  </span>
                </div>
                <p className="font-bold text-slate-900">
                  {record.employeeName} — {record.shiftName}
                </p>
                <p className="text-slate-700">{note.content}</p>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Filters + Tracking Table */}
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

        {/* Desktop Tracking Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Ngày</th>
                <th className="py-3 px-4">Nhân sự</th>
                <th className="py-3 px-4">Ca làm</th>
                <th className="py-3 px-4">Thời gian xác nhận</th>
                <th className="py-3 px-4">Trạng thái</th>
                <th className="py-3 px-4">Lịch sử ghi chú</th>
                <th className="py-3 px-4 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={7} className="py-4 px-4">
                      <div className="h-5 bg-slate-100 rounded animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 px-4 text-center text-sm text-slate-500">
                    Chưa có bản ghi chấm công nào khớp bộ lọc.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const badge = STATUS_BADGE[r.status] || STATUS_BADGE.checked_in;
                  const editable = canModifyRecord(r);
                  return (
                    <tr key={r.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                        {r.workDate}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-semibold text-slate-900">{r.employeeName}</p>
                        <p className="text-xs text-slate-500 font-mono">{r.ownerEmail}</p>
                      </td>
                      <td className="py-3 px-4">
                        <p className="text-slate-900 font-medium">{r.shiftName}</p>
                        {r.isUnscheduled && (
                          <span className="text-[11px] font-medium text-amber-700">Ngoài lịch</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-800 tabular-nums whitespace-nowrap">
                        <p className="font-semibold text-emerald-700">
                          {formatTimeHms(r.checkInAt)}
                        </p>
                        {r.checkOutAt && (
                          <p className="text-[11px] text-slate-500">
                            Kết: {formatTimeHms(r.checkOutAt)}
                          </p>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${badge.cls}`}
                        >
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
                                  [{NOTE_TYPE_LABELS[n.type] || n.type}]
                                </span>{' '}
                                {n.content}
                              </p>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {editable && (
                            <button
                              type="button"
                              onClick={() => {
                                setNoteTarget(r);
                                setNoteType('note');
                                setNoteContent('');
                                setMarkCheckout(false);
                                setClearCheckoutInModal(false);
                              }}
                              title="Ghi chú phát sinh"
                              className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                            >
                              <History className="h-3.5 w-3.5" />
                              <span>Ghi chú</span>
                            </button>
                          )}

                          {editable && (
                            <button
                              type="button"
                              onClick={() => openEditModal(r)}
                              title="Điều chỉnh thông tin chấm công"
                              className="min-h-[34px] px-2.5 py-1 rounded-lg border border-blue-200 bg-blue-50 text-xs font-medium text-blue-700 hover:bg-blue-100 inline-flex items-center gap-1"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              <span>Điều chỉnh</span>
                            </button>
                          )}

                          {editable && (
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(r)}
                              title="Xóa bản ghi chấm công"
                              className="min-h-[34px] min-w-[34px] p-1.5 rounded-lg border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 inline-flex items-center justify-center"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Portrait Vertical Cards */}
        <div className="md:hidden divide-y divide-slate-200">
          {loading ? (
            <div className="p-6 text-center text-sm text-slate-500">
              Đang tải dữ liệu chấm công...
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Chưa có bản ghi chấm công nào khớp bộ lọc.
            </div>
          ) : (
            rows.map((r) => {
              const badge = STATUS_BADGE[r.status] || STATUS_BADGE.checked_in;
              const editable = canModifyRecord(r);
              return (
                <div key={r.id} className="p-4 space-y-2.5 text-[15px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-slate-900">{r.employeeName}</p>
                      <p className="text-xs font-mono text-slate-500 truncate">{r.ownerEmail}</p>
                    </div>
                    <span
                      className={`inline-block px-2 py-0.5 text-xs font-semibold rounded border shrink-0 ${badge.cls}`}
                    >
                      {badge.label}
                    </span>
                  </div>

                  <div className="rounded-lg bg-slate-50 p-3 space-y-1.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Ngày / Giờ xác nhận:</span>
                      <span className="font-mono font-bold text-emerald-700 tabular-nums">
                        {r.workDate} · {formatTimeHms(r.checkInAt)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Ca làm:</span>
                      <span className="font-semibold text-slate-900 text-right">{r.shiftName}</span>
                    </div>
                    {r.checkOutAt && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Giờ điều chỉnh:</span>
                        <span className="font-mono text-slate-700 tabular-nums">
                          {formatTimeHms(r.checkOutAt)}
                        </span>
                      </div>
                    )}
                  </div>

                  {r.notesHistory.length > 0 && (
                    <div className="space-y-1 text-xs text-slate-700 bg-white border border-slate-200 rounded-lg p-2.5">
                      {r.notesHistory.map((n) => (
                        <p key={n.id}>
                          <span className="font-semibold text-slate-900">
                            [{NOTE_TYPE_LABELS[n.type] || n.type}]
                          </span>{' '}
                          {n.content}
                        </p>
                      ))}
                    </div>
                  )}

                  {editable && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setNoteTarget(r);
                          setNoteType('note');
                          setNoteContent('');
                          setMarkCheckout(false);
                          setClearCheckoutInModal(false);
                        }}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 inline-flex items-center gap-1"
                      >
                        <History className="h-3.5 w-3.5" />
                        <span>Ghi chú</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditModal(r)}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-xs font-semibold text-blue-700 inline-flex items-center gap-1"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        <span>Điều chỉnh</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(r)}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg border border-red-200 bg-red-50 text-xs font-semibold text-red-600 inline-flex items-center gap-1 ml-auto"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Xóa</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
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

      {/* Modal: Append Note / Checkout / Clear Time */}
      {noteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveNote}
            className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-5 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-900 font-bold">
                <Clock className="h-5 w-5 text-blue-600" />
                <span>Bổ sung ghi chú ca làm</span>
              </div>
              <button
                type="button"
                onClick={() => setNoteTarget(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {noteTarget.employeeName} · {noteTarget.shiftName} ({noteTarget.workDate}).
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Phân loại phát sinh
              </label>
              <select
                value={noteType}
                onChange={(e) => {
                  const nextType = e.target.value as AttendanceNoteEntry['type'];
                  setNoteType(nextType);
                  if (nextType === 'clear_time') {
                    setClearCheckoutInModal(true);
                    setMarkCheckout(false);
                  }
                }}
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="note">Ghi chú bổ sung</option>
                <option value="overtime">Tăng ca</option>
                <option value="early_leave">Về sớm</option>
                <option value="clear_time">Clear giờ</option>
                <option value="incident">Sự cố / Phát sinh</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Nội dung ghi chú
              </label>
              <textarea
                rows={3}
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                placeholder="Ghi rõ lý do, số giờ tăng ca, về sớm hoặc yêu cầu clear giờ..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div className="space-y-2">
              {!noteTarget.checkOutAt && !clearCheckoutInModal && (
                <label className="flex items-center gap-2 text-sm text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={markCheckout}
                    onChange={(e) => setMarkCheckout(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600"
                  />
                  <span className="inline-flex items-center gap-1">
                    <CheckOutIcon className="h-4 w-4 text-slate-600" />
                    Ghi nhận thêm mốc giờ lúc này ({formatTimeHms(nowClock)})
                  </span>
                </label>
              )}

              <label className="flex items-center gap-2 text-sm text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={clearCheckoutInModal}
                  onChange={(e) => {
                    setClearCheckoutInModal(e.target.checked);
                    if (e.target.checked) setMarkCheckout(false);
                  }}
                  className="h-4 w-4 rounded border-slate-300 text-violet-600"
                />
                <span className="inline-flex items-center gap-1">
                  <Eraser className="h-4 w-4 text-violet-600" />
                  Clear giờ (xóa mốc giờ thêm)
                </span>
              </label>
            </div>

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

      {/* Modal: Adjust / Edit Attendance Record */}
      {editTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveEdit}
            className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-5 space-y-4 shadow-xl max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-900 font-bold">
                <Pencil className="h-5 w-5 text-blue-600" />
                <span>Điều chỉnh thông tin chấm công</span>
              </div>
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Tên nhân sự
                </label>
                <input
                  type="text"
                  required
                  value={editEmployeeName}
                  onChange={(e) => setEditEmployeeName(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Ngày làm việc
                </label>
                <input
                  type="date"
                  required
                  value={editWorkDate}
                  onChange={(e) => setEditWorkDate(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Ca làm việc
                </label>
                <input
                  type="text"
                  required
                  value={editShiftName}
                  onChange={(e) => setEditShiftName(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Thời gian xác nhận ca
                </label>
                <div className="space-y-1">
                  <input
                    type="datetime-local"
                    required
                    value={editCheckInLocal}
                    onChange={(e) => setEditCheckInLocal(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                  <button
                    type="button"
                    onClick={() => setEditCheckInLocal(toDateTimeLocalValue(new Date().toISOString()))}
                    className="text-[11px] font-medium text-blue-600 hover:underline"
                  >
                    Lấy thời gian thực hiện tại
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Giờ kết thúc (tùy chọn / để trống nếu Clear giờ)
                </label>
                <div className="space-y-1">
                  <input
                    type="datetime-local"
                    value={editCheckOutLocal}
                    onChange={(e) => setEditCheckOutLocal(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        setEditCheckOutLocal(toDateTimeLocalValue(new Date().toISOString()))
                      }
                      className="text-[11px] font-medium text-blue-600 hover:underline"
                    >
                      Lấy giờ hiện tại
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditCheckOutLocal('');
                        setEditStatus('clear_time');
                      }}
                      className="text-[11px] font-medium text-violet-700 hover:underline"
                    >
                      Clear giờ
                    </button>
                  </div>
                </div>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Trạng thái ca làm
                </label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as AttendanceRecord['status'])}
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="checked_in">Đã xác nhận ca</option>
                  <option value="overtime">Tăng ca</option>
                  <option value="early_leave">Về sớm</option>
                  <option value="clear_time">Clear giờ</option>
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Ghi chú lý do điều chỉnh (tùy chọn)
                </label>
                <input
                  type="text"
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder="VD: Quên bấm kết ca, điều chỉnh đúng giờ thực tế..."
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Đang lưu...' : 'Lưu điều chỉnh'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Xóa bản ghi chấm công"
        description={
          deleteTarget
            ? `Bạn có chắc chắn muốn xóa chấm công của ${deleteTarget.employeeName} ngày ${deleteTarget.workDate} (${deleteTarget.shiftName})?`
            : ''
        }
        confirmLabel="Xóa bản ghi"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
