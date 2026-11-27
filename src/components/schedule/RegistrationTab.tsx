import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CalendarPlus,
  Check,
  CheckCheck,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import {
  SHIFT_META,
  SHIFT_ORDER,
  canApproveWeekendOverQuotaDo,
  computeWeekDoSummary,
  countPersonalWeekRegistrations,
  evaluateDoSubmission,
  formatRegisteredTimestamp,
  formatViDate,
  formatYmd,
  getShiftMeta,
  getWeekDays,
  getMondayOfWeek,
  isWeekendOverQuotaPendingDo,
} from '../../lib/scheduleMeta';
import type {
  OfficialWorkSchedule,
  SchedulePermissionLevel,
  ScheduleShiftCode,
  ShiftRegistration,
  ShiftRegistrationStatus,
} from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';

interface RegistrationTabProps {
  currentUid: string;
  currentName: string;
  currentDepartment: string;
  scheduleLevel: SchedulePermissionLevel;
  registrations: ShiftRegistration[];
  officialSchedules: OfficialWorkSchedule[];
  loading: boolean;
  onSubmitRegistration: (payload: {
    shiftType: ScheduleShiftCode;
    dates: string[];
    note: string;
  }) => Promise<void>;
  onApproveOne: (reg: ShiftRegistration) => Promise<void>;
  onApproveAll: (regs: ShiftRegistration[]) => Promise<void>;
  onRejectOne: (reg: ShiftRegistration) => Promise<void>;
  onDeleteOne: (reg: ShiftRegistration) => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}

type TimeScopeFilter = 'all' | 'date' | 'month' | 'year';
type SortMode = 'date_asc' | 'date_desc' | 'created_desc' | 'created_asc';

export function RegistrationTab({
  currentUid,
  currentName,
  currentDepartment,
  scheduleLevel,
  registrations,
  officialSchedules,
  loading,
  onSubmitRegistration,
  onApproveOne,
  onApproveAll,
  onRejectOne,
  onDeleteOne,
  onNotify,
}: RegistrationTabProps) {
  const todayYmd = useMemo(() => formatYmd(new Date()), []);
  const canManage = scheduleLevel === 'manage' || scheduleLevel === 'admin';

  // Form State
  const [shiftType, setShiftType] = useState<ScheduleShiftCode>('ca_sang');
  const [date1, setDate1] = useState(todayYmd);
  const [enableDate2, setEnableDate2] = useState(false);
  const [date2, setDate2] = useState(todayYmd);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Filters State
  const [timeScope, setTimeScope] = useState<TimeScopeFilter>('all');
  const [filterDateValue, setFilterDateValue] = useState(todayYmd);
  const [filterMonthValue, setFilterMonthValue] = useState(todayYmd.slice(0, 7));
  const [filterYearValue, setFilterYearValue] = useState(todayYmd.slice(0, 4));
  const [statusFilter, setStatusFilter] = useState<'ALL' | ShiftRegistrationStatus>('ALL');
  const [sortMode, setSortMode] = useState<SortMode>('date_asc');

  const [busyId, setBusyId] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ShiftRegistration | null>(null);

  const personalWeek1Regs = useMemo(
    () => countPersonalWeekRegistrations(registrations, currentUid, date1),
    [registrations, currentUid, date1]
  );

  const personalWeek2Regs = useMemo(
    () =>
      enableDate2
        ? countPersonalWeekRegistrations(registrations, currentUid, date2)
        : [],
    [registrations, currentUid, enableDate2, date2]
  );

  const week1DoSummary = useMemo(
    () => computeWeekDoSummary(registrations, officialSchedules, date1),
    [registrations, officialSchedules, date1]
  );

  const week1Days = useMemo(
    () => getWeekDays(getMondayOfWeek(date1)),
    [date1]
  );

  const formValidation = useMemo(() => {
    const selectedDates = enableDate2 ? [date1, date2] : [date1];
    if (!date1 || (enableDate2 && !date2)) {
      return { blocked: true, blockMessage: 'Vui lòng chọn đầy đủ ngày đăng ký.', warnings: [] as string[] };
    }
    if (enableDate2 && date1 === date2) {
      return {
        blocked: true,
        blockMessage: 'Ngày đăng ký 1 và Ngày đăng ký 2 không được trùng nhau.',
        warnings: [] as string[],
      };
    }

    // Check existing non-rejected registrations on same day
    for (const d of selectedDates) {
      const existsSameDay = registrations.some(
        (r) => r.staffUid === currentUid && r.date === d && r.status !== 'rejected'
      );
      if (existsSameDay) {
        return {
          blocked: true,
          blockMessage: `Bạn đã có đơn đăng ký cho ngày ${formatViDate(d)} trong tuần này.`,
          warnings: [] as string[],
        };
      }
    }

    // Check max 2 registrations/week per staff
    const weekCounts = new Map<string, number>();
    for (const d of selectedDates) {
      const mondayKey = formatYmd(getMondayOfWeek(d));
      const base =
        mondayKey === formatYmd(getMondayOfWeek(date1))
          ? personalWeek1Regs.length
          : personalWeek2Regs.length;
      weekCounts.set(mondayKey, (weekCounts.get(mondayKey) || base) + 1);
    }
    for (const [, totalCount] of weekCounts.entries()) {
      if (totalCount > 2) {
        return {
          blocked: true,
          blockMessage:
            'Mỗi nhân sự chỉ được đăng ký tối đa 2 ngày/tuần (tính cả chờ duyệt và đã duyệt).',
          warnings: [] as string[],
        };
      }
    }

    const warnings: string[] = [];
    if (shiftType === 'do') {
      const eval1 = evaluateDoSubmission(registrations, officialSchedules, date1);
      if (!eval1.allowed) {
        return { blocked: true, blockMessage: eval1.message, warnings };
      }
      if (eval1.level === 'warning_admin') warnings.push(eval1.message);

      if (enableDate2) {
        const eval2 = evaluateDoSubmission(registrations, officialSchedules, date2, [
          date1,
        ]);
        if (!eval2.allowed) {
          return { blocked: true, blockMessage: eval2.message, warnings };
        }
        if (eval2.level === 'warning_admin' && !warnings.includes(eval2.message)) {
          warnings.push(eval2.message);
        }
      }
    }

    return { blocked: false, blockMessage: '', warnings };
  }, [
    date1,
    date2,
    enableDate2,
    shiftType,
    registrations,
    officialSchedules,
    currentUid,
    personalWeek1Regs.length,
    personalWeek2Regs.length,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formValidation.blocked) {
      onNotify('error', formValidation.blockMessage);
      return;
    }
    const dates = enableDate2 ? [date1, date2] : [date1];
    setSubmitting(true);
    try {
      await onSubmitRegistration({
        shiftType,
        dates,
        note: note.trim().slice(0, 300),
      });
      setNote('');
      setEnableDate2(false);
    } finally {
      setSubmitting(false);
    }
  };

  const yearOptions = useMemo(() => {
    const years = new Set<string>([todayYmd.slice(0, 4)]);
    for (const r of registrations) {
      if (r.date.length >= 4) years.add(r.date.slice(0, 4));
    }
    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }, [registrations, todayYmd]);

  const visibleRegistrations = useMemo(() => {
    const base = canManage
      ? registrations
      : registrations.filter((r) => r.staffUid === currentUid);

    const filtered = base.filter((r) => {
      if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
      if (timeScope === 'date' && filterDateValue) {
        return r.date === filterDateValue;
      }
      if (timeScope === 'month' && filterMonthValue) {
        return r.date.startsWith(filterMonthValue);
      }
      if (timeScope === 'year' && filterYearValue) {
        return r.date.startsWith(filterYearValue);
      }
      return true;
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortMode === 'date_asc') {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return (
          SHIFT_META[a.shiftType].sortOrder - SHIFT_META[b.shiftType].sortOrder
        );
      }
      if (sortMode === 'date_desc') {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return (
          SHIFT_META[b.shiftType].sortOrder - SHIFT_META[a.shiftType].sortOrder
        );
      }
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return sortMode === 'created_desc' ? tb - ta : ta - tb;
    });
    return sorted;
  }, [
    canManage,
    registrations,
    currentUid,
    statusFilter,
    timeScope,
    filterDateValue,
    filterMonthValue,
    filterYearValue,
    sortMode,
  ]);

  const pendingItems = useMemo(
    () => visibleRegistrations.filter((r) => r.status === 'pending'),
    [visibleRegistrations]
  );

  const handleApproveSingle = async (reg: ShiftRegistration) => {
    if (!canApproveWeekendOverQuotaDo(scheduleLevel, reg, registrations, officialSchedules)) {
      onNotify(
        'error',
        'Trường hợp nghỉ DO cuối tuần (T7/CN) vượt định mức 1 người/tuần. Vui lòng liên hệ Quản trị (Admin) để duyệt.'
      );
      return;
    }
    setBusyId(reg.id);
    try {
      await onApproveOne(reg);
    } finally {
      setBusyId(null);
    }
  };

  const handleApproveAllClick = async () => {
    if (!canManage || pendingItems.length === 0) return;
    const approvable = pendingItems.filter((reg) =>
      canApproveWeekendOverQuotaDo(scheduleLevel, reg, registrations, officialSchedules)
    );
    const skippedCount = pendingItems.length - approvable.length;
    if (approvable.length === 0) {
      onNotify(
        'error',
        'Tất cả đơn đang chờ đều là DO cuối tuần vượt định mức, chỉ Quản trị (Admin) mới có quyền duyệt.'
      );
      return;
    }
    setApprovingAll(true);
    try {
      await onApproveAll(approvable);
      if (skippedCount > 0) {
        onNotify(
          'info',
          `Đã duyệt ${approvable.length} đơn. Bỏ qua ${skippedCount} đơn DO cuối tuần vượt định mức (cần Quản trị duyệt).`
        );
      }
    } finally {
      setApprovingAll(false);
    }
  };

  const handleResetFilters = () => {
    setTimeScope('all');
    setFilterDateValue(todayYmd);
    setFilterMonthValue(todayYmd.slice(0, 7));
    setFilterYearValue(todayYmd.slice(0, 4));
    setStatusFilter('ALL');
    setSortMode('date_asc');
  };

  const quotaPct = Math.min(100, (personalWeek1Regs.length / 2) * 100);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      {/* Left 4 columns: Registration Form */}
      <form
        onSubmit={handleSubmit}
        className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Đăng ký ca / Ngày nghỉ
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {currentName} · {currentDepartment || 'Nhân viên'}
            </p>
          </div>
          <span className="text-xs font-medium px-2.5 py-1 rounded-md bg-blue-50 text-blue-700 shrink-0">
            Tối đa 2 ngày/tuần
          </span>
        </div>

        {/* Personal Weekly Quota Progress */}
        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-700">
              Định mức tuần ({formatViDate(week1Days[0].ymd)} –{' '}
              {formatViDate(week1Days[6].ymd)})
            </span>
            <span
              className={`font-bold tabular-nums ${
                personalWeek1Regs.length >= 2
                  ? 'text-amber-700'
                  : 'text-blue-700'
              }`}
            >
              {personalWeek1Regs.length}/2 ngày
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                personalWeek1Regs.length >= 2 ? 'bg-amber-500' : 'bg-blue-600'
              }`}
              style={{ width: `${quotaPct}%` }}
            />
          </div>
        </div>

        {/* Shift Select */}
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1.5">
            Chọn ca làm việc / Loại nghỉ *
          </label>
          <select
            value={shiftType}
            onChange={(e) => setShiftType(e.target.value as ScheduleShiftCode)}
            className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            {SHIFT_ORDER.map((code) => {
              const m = SHIFT_META[code];
              return (
                <option key={code} value={code}>
                  {m.label} ({m.isOffDay ? 'Nghỉ cả ngày' : `${m.startTime}–${m.endTime}`})
                </option>
              );
            })}
          </select>
        </div>

        {/* Date 1 + Date 2 */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Ngày đăng ký 1 *
            </label>
            <input
              type="date"
              required
              value={date1}
              onChange={(e) => setDate1(e.target.value)}
              className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-800 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={enableDate2}
              onChange={(e) => setEnableDate2(e.target.checked)}
              className="h-4 w-4 accent-blue-600 rounded"
            />
            <span className="font-medium text-xs sm:text-sm">
              Ngày đăng ký 2 (cùng lượt)
            </span>
          </label>

          {enableDate2 && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Ngày đăng ký 2 *
              </label>
              <input
                type="date"
                required
                value={date2}
                onChange={(e) => setDate2(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
          )}
        </div>

        {/* 7-cell DO Quota Visual Grid */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-700">
              Số người nghỉ DO trong tuần
            </span>
            <span className="text-[11px] text-slate-500">
              T2–T6: 2/ngày · T7+CN: 1/tuần
            </span>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {week1Days.map((d) => {
              const count = week1DoSummary.byDateCount[d.ymd] || 0;
              const isWeekend = d.isWeekend;
              const isOverOrFull = isWeekend
                ? week1DoSummary.weekendTotal >= 1
                : count >= 2;
              return (
                <div
                  key={d.ymd}
                  className={`rounded-lg border p-1.5 text-center ${
                    isOverOrFull
                      ? isWeekend
                        ? 'bg-amber-50 border-amber-300 text-amber-900'
                        : 'bg-red-50 border-red-200 text-red-800'
                      : 'bg-slate-50 border-slate-200 text-slate-700'
                  }`}
                  title={`${d.weekday} (${formatViDate(d.ymd)})`}
                >
                  <div className="text-[11px] font-bold">{d.weekday}</div>
                  <div className="text-[10px] text-slate-500">{d.ddMm}</div>
                  <div className="mt-1 text-[10px] font-bold tabular-nums">
                    {isWeekend
                      ? `${week1DoSummary.weekendTotal}/1 tuần`
                      : `${count}/2`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Validation Block / Admin Warning Banners */}
        {formValidation.blocked && (
          <div
            role="alert"
            className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2"
          >
            <Ban className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
            <span>{formValidation.blockMessage}</span>
          </div>
        )}

        {!formValidation.blocked &&
          formValidation.warnings.map((w, idx) => (
            <div
              key={idx}
              role="status"
              className="p-3 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-900 flex items-start gap-2"
            >
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <span>{w}</span>
            </div>
          ))}

        {/* Note */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-slate-700">
              Ghi chú thêm
            </label>
            <span className="text-[11px] text-slate-400 tabular-nums">
              {note.length}/300
            </span>
          </div>
          <textarea
            rows={2}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Lý do hoặc lưu ý cho quản lý (tối đa 300 ký tự)..."
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <button
          type="submit"
          disabled={submitting || formValidation.blocked}
          className="w-full min-h-[44px] px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center justify-center gap-2 transition-colors"
        >
          <CalendarPlus className="h-4 w-4" />
          <span>
            {submitting
              ? 'Đang gửi...'
              : enableDate2
                ? 'Gửi đăng ký 2 ngày'
                : 'Gửi đăng ký lịch'}
          </span>
        </button>
      </form>

      {/* Right 8 columns: Registrations List */}
      <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-200 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                {canManage
                  ? 'Danh sách đăng ký toàn bộ nhân sự'
                  : 'Lịch sử đăng ký của bạn'}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Hiển thị {visibleRegistrations.length} đơn đăng ký
              </p>
            </div>

            {canManage && pendingItems.length > 0 && (
              <button
                type="button"
                disabled={approvingAll}
                onClick={() => void handleApproveAllClick()}
                className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <CheckCheck className="h-4 w-4" />
                <span>
                  {approvingAll
                    ? 'Đang duyệt...'
                    : `Duyệt tất cả (${pendingItems.length})`}
                </span>
              </button>
            )}
          </div>

          {/* Filter & Sort Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={timeScope}
              onChange={(e) => setTimeScope(e.target.value as TimeScopeFilter)}
              className="min-h-[38px] px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              aria-label="Lọc theo thời gian"
            >
              <option value="all">Tất cả thời gian</option>
              <option value="date">Theo ngày</option>
              <option value="month">Theo tháng</option>
              <option value="year">Theo năm</option>
            </select>

            {timeScope === 'date' && (
              <input
                type="date"
                value={filterDateValue}
                onChange={(e) => setFilterDateValue(e.target.value)}
                className="min-h-[38px] px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
              />
            )}
            {timeScope === 'month' && (
              <input
                type="month"
                value={filterMonthValue}
                onChange={(e) => setFilterMonthValue(e.target.value)}
                className="min-h-[38px] px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
              />
            )}
            {timeScope === 'year' && (
              <select
                value={filterYearValue}
                onChange={(e) => setFilterYearValue(e.target.value)}
                className="min-h-[38px] px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg bg-white"
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    Năm {y}
                  </option>
                ))}
              </select>
            )}

            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as 'ALL' | ShiftRegistrationStatus)
              }
              className="min-h-[38px] px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              aria-label="Lọc theo trạng thái"
            >
              <option value="ALL">Mọi trạng thái</option>
              <option value="pending">Chờ tổng hợp</option>
              <option value="approved">Đã duyệt vào lịch</option>
              <option value="rejected">Từ chối</option>
            </select>

            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="min-h-[38px] px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              aria-label="Sắp xếp"
            >
              <option value="date_asc">Ngày &amp; Ca tăng dần</option>
              <option value="date_desc">Ngày &amp; Ca giảm dần</option>
              <option value="created_desc">Mới gửi nhất</option>
              <option value="created_asc">Cũ nhất</option>
            </select>

            <button
              type="button"
              onClick={handleResetFilters}
              className="min-h-[38px] px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Đặt lại</span>
            </button>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : visibleRegistrations.length === 0 ? (
          <div className="py-14 px-6 text-center text-sm text-slate-500">
            Chưa có đơn đăng ký lịch làm việc nào phù hợp bộ lọc.
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                    <th className="py-3 px-4">Nhân sự</th>
                    <th className="py-3 px-4">Ca &amp; Giờ ca</th>
                    <th className="py-3 px-4">Giờ đăng ký</th>
                    <th className="py-3 px-4">Ghi chú</th>
                    <th className="py-3 px-4">Trạng thái</th>
                    <th className="py-3 px-4 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRegistrations.map((reg) => {
                    const meta = getShiftMeta(reg.shiftType);
                    const overQuotaWeekend = isWeekendOverQuotaPendingDo(
                      reg,
                      registrations,
                      officialSchedules
                    );
                    const canDeleteRow =
                      canManage ||
                      (reg.staffUid === currentUid && reg.status === 'pending');

                    return (
                      <tr key={reg.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4">
                          <p className="font-bold text-slate-900">{reg.staffName}</p>
                          <p className="text-[11px] text-slate-500">
                            {reg.department || 'Nhân viên'}
                          </p>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-mono text-[11px] font-bold text-slate-800 mb-1">
                            {formatViDate(reg.date)}
                          </div>
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium ${meta.cardBgClass} ${meta.cardBorderClass} ${meta.cardTextClass}`}
                          >
                            <span>{meta.shortLabel}</span>
                            {!meta.isOffDay && (
                              <span className="font-mono opacity-80">
                                {meta.startTime}–{meta.endTime}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-600 whitespace-nowrap tabular-nums">
                          {formatRegisteredTimestamp(reg.createdAt)}
                        </td>
                        <td className="py-3 px-4 max-w-[200px] text-slate-700">
                          {reg.note ? (
                            <span className="line-clamp-2">{reg.note}</span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {reg.status === 'approved' && (
                            <span className="inline-block px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-700 font-medium whitespace-nowrap">
                              Đã duyệt vào lịch
                            </span>
                          )}
                          {reg.status === 'rejected' && (
                            <span className="inline-block px-2 py-0.5 rounded border border-red-200 bg-red-50 text-red-700 font-medium whitespace-nowrap">
                              Từ chối
                            </span>
                          )}
                          {reg.status === 'pending' && overQuotaWeekend && (
                            <span className="inline-block px-2 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800 font-medium">
                              Chờ Quản trị duyệt - Vượt 1 người DO T7/CN
                            </span>
                          )}
                          {reg.status === 'pending' && !overQuotaWeekend && (
                            <span className="inline-block px-2 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-700 font-medium whitespace-nowrap">
                              Chờ tổng hợp
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1">
                            {canManage && reg.status === 'pending' && (
                              <>
                                <button
                                  type="button"
                                  disabled={busyId === reg.id}
                                  onClick={() => void handleApproveSingle(reg)}
                                  title="Duyệt vào lịch"
                                  className="h-8 w-8 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center justify-center"
                                >
                                  <Check className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  disabled={busyId === reg.id}
                                  onClick={() => void onRejectOne(reg)}
                                  title="Từ chối"
                                  className="h-8 w-8 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-50 inline-flex items-center justify-center"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </>
                            )}
                            {canDeleteRow && (
                              <button
                                type="button"
                                disabled={busyId === reg.id}
                                onClick={() => setDeleteTarget(reg)}
                                title="Xóa đăng ký"
                                className="h-8 w-8 rounded-lg border border-slate-200 text-slate-400 hover:text-red-600 hover:border-red-200 hover:bg-red-50 inline-flex items-center justify-center"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Card List */}
            <div className="md:hidden divide-y divide-slate-100">
              {visibleRegistrations.map((reg) => {
                const meta = getShiftMeta(reg.shiftType);
                const overQuotaWeekend = isWeekendOverQuotaPendingDo(
                  reg,
                  registrations,
                  officialSchedules
                );
                const canDeleteRow =
                  canManage ||
                  (reg.staffUid === currentUid && reg.status === 'pending');

                return (
                  <div key={reg.id} className="p-4 space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-slate-900">
                          {reg.staffName}
                        </p>
                        <p className="text-xs text-slate-500">
                          {reg.department || 'Nhân viên'} ·{' '}
                          <span className="font-mono">
                            {formatViDate(reg.date)}
                          </span>
                        </p>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded border text-xs font-semibold ${meta.cardBgClass} ${meta.cardBorderClass} ${meta.cardTextClass}`}
                      >
                        {meta.shortLabel}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-mono text-slate-500">
                        Gửi: {formatRegisteredTimestamp(reg.createdAt)}
                      </span>
                      {reg.status === 'approved' && (
                        <span className="px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-700 font-medium">
                          Đã duyệt vào lịch
                        </span>
                      )}
                      {reg.status === 'rejected' && (
                        <span className="px-2 py-0.5 rounded border border-red-200 bg-red-50 text-red-700 font-medium">
                          Từ chối
                        </span>
                      )}
                      {reg.status === 'pending' && overQuotaWeekend && (
                        <span className="px-2 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800 font-medium">
                          Chờ Quản trị duyệt - Vượt 1 người DO T7/CN
                        </span>
                      )}
                      {reg.status === 'pending' && !overQuotaWeekend && (
                        <span className="px-2 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-700 font-medium">
                          Chờ tổng hợp
                        </span>
                      )}
                    </div>

                    {reg.note && (
                      <p className="text-xs text-slate-600 bg-slate-50 rounded-md px-2.5 py-1.5">
                        {reg.note}
                      </p>
                    )}

                    {(canManage && reg.status === 'pending') || canDeleteRow ? (
                      <div className="flex items-center justify-end gap-2 pt-1">
                        {canManage && reg.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              disabled={busyId === reg.id}
                              onClick={() => void handleApproveSingle(reg)}
                              className="min-h-[36px] px-3 py-1 rounded-lg bg-emerald-600 text-white text-xs font-medium inline-flex items-center gap-1"
                            >
                              <Check className="h-3.5 w-3.5" />
                              <span>Duyệt</span>
                            </button>
                            <button
                              type="button"
                              disabled={busyId === reg.id}
                              onClick={() => void onRejectOne(reg)}
                              className="min-h-[36px] px-3 py-1 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-xs font-medium inline-flex items-center gap-1"
                            >
                              <X className="h-3.5 w-3.5" />
                              <span>Từ chối</span>
                            </button>
                          </>
                        )}
                        {canDeleteRow && (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(reg)}
                            className="min-h-[36px] px-3 py-1 rounded-lg border border-red-200 text-red-600 text-xs font-medium inline-flex items-center gap-1"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Xóa</span>
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Xóa đơn đăng ký lịch này?"
        description={
          deleteTarget
            ? `Xóa đơn đăng ký ${getShiftMeta(deleteTarget.shiftType).label} ngày ${formatViDate(
                deleteTarget.date
              )} của ${deleteTarget.staffName}?`
            : ''
        }
        confirmLabel="Xóa đăng ký"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await onDeleteOne(deleteTarget);
          }
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
