import { useMemo, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Database,
  Edit3,
  FileSpreadsheet,
  List,
  MapPin,
  Plus,
  Search,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { exportSchedulesToExcel } from '../lib/excel';
import type { ScheduleStatus, ShiftType, WorkSchedule } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

interface WorkScheduleTabProps {
  schedules: WorkSchedule[];
  loading: boolean;
  defaultEmployeeName: string;
  supabaseReady: boolean;
  isSyncing: boolean;
  onCreateSchedule: (data: {
    employeeName: string;
    title: string;
    workDate: string;
    shiftType: ShiftType;
    startTime: string;
    endTime: string;
    location: string;
    note: string;
  }) => Promise<void>;
  onUpdateSchedule: (
    schedule: WorkSchedule,
    updates: Partial<{
      employeeName: string;
      title: string;
      workDate: string;
      shiftType: ShiftType;
      startTime: string;
      endTime: string;
      location: string;
      status: ScheduleStatus;
      note: string;
    }>
  ) => Promise<void>;
  onDeleteSchedule: (schedule: WorkSchedule) => Promise<void>;
  onSyncToSupabase: () => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}

const SHIFT_PRESETS: Record<
  ShiftType,
  { label: string; startTime: string; endTime: string }
> = {
  morning: { label: 'Ca sáng', startTime: '08:00', endTime: '12:00' },
  afternoon: { label: 'Ca chiều', startTime: '13:30', endTime: '17:30' },
  evening: { label: 'Ca tối', startTime: '18:00', endTime: '22:00' },
  full_day: { label: 'Cả ngày', startTime: '08:00', endTime: '17:30' },
  custom: { label: 'Tùy chỉnh', startTime: '09:00', endTime: '17:00' },
};

const STATUS_META: Record<
  ScheduleStatus,
  { label: string; textClass: string }
> = {
  registered: { label: 'Đã đăng ký', textClass: 'text-blue-700' },
  confirmed: { label: 'Đã xác nhận', textClass: 'text-emerald-700' },
  completed: { label: 'Hoàn thành', textClass: 'text-slate-700' },
  cancelled: { label: 'Đã hủy', textClass: 'text-red-600' },
};

function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getMondayOfWeek(baseDate: Date): Date {
  const d = new Date(baseDate);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function calcHours(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (Number.isNaN(sh) || Number.isNaN(eh)) return 0;
  const mins = eh * 60 + em - (sh * 60 + sm);
  return mins > 0 ? Math.round((mins / 60) * 10) / 10 : 0;
}

const WEEKDAY_NAMES = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

export function WorkScheduleTab({
  schedules,
  loading,
  defaultEmployeeName,
  supabaseReady,
  isSyncing,
  onCreateSchedule,
  onUpdateSchedule,
  onDeleteSchedule,
  onSyncToSupabase,
  onNotify,
}: WorkScheduleTabProps) {
  const todayStr = useMemo(() => toYmd(new Date()), []);
  const [viewMode, setViewMode] = useState<'week' | 'list'>('week');
  const [weekAnchor, setWeekAnchor] = useState<Date>(() =>
    getMondayOfWeek(new Date())
  );
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [statusFilter, setStatusFilter] = useState<'ALL' | ScheduleStatus>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Form Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<WorkSchedule | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [employeeName, setEmployeeName] = useState(defaultEmployeeName);
  const [title, setTitle] = useState('');
  const [workDate, setWorkDate] = useState(todayStr);
  const [shiftType, setShiftType] = useState<ShiftType>('morning');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('12:00');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');

  // Confirmations
  const [cancelTarget, setCancelTarget] = useState<WorkSchedule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkSchedule | null>(null);

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekAnchor);
      d.setDate(d.getDate() + i);
      return {
        ymd: toYmd(d),
        weekday: WEEKDAY_NAMES[i],
        dayNum: d.getDate(),
        monthNum: d.getMonth() + 1,
      };
    });
  }, [weekAnchor]);

  const shiftWeek = (deltaDays: number) => {
    const next = new Date(weekAnchor);
    next.setDate(next.getDate() + deltaDays);
    setWeekAnchor(next);
  };

  const openCreateModal = (presetDate?: string) => {
    setEditingItem(null);
    setEmployeeName(defaultEmployeeName);
    setTitle('');
    setWorkDate(presetDate || selectedDate || todayStr);
    setShiftType('morning');
    setStartTime('08:00');
    setEndTime('12:00');
    setLocation('');
    setNote('');
    setModalOpen(true);
  };

  const openEditModal = (item: WorkSchedule) => {
    setEditingItem(item);
    setEmployeeName(item.employeeName);
    setTitle(item.title);
    setWorkDate(item.workDate);
    setShiftType(item.shiftType);
    setStartTime(item.startTime);
    setEndTime(item.endTime);
    setLocation(item.location);
    setNote(item.note);
    setModalOpen(true);
  };

  const handleShiftTypeChange = (type: ShiftType) => {
    setShiftType(type);
    if (type !== 'custom') {
      setStartTime(SHIFT_PRESETS[type].startTime);
      setEndTime(SHIFT_PRESETS[type].endTime);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !employeeName.trim()) return;
    setSubmitting(true);
    try {
      if (editingItem) {
        await onUpdateSchedule(editingItem, {
          employeeName: employeeName.trim(),
          title: title.trim(),
          workDate,
          shiftType,
          startTime,
          endTime,
          location: location.trim(),
          note: note.trim(),
        });
      } else {
        await onCreateSchedule({
          employeeName: employeeName.trim(),
          title: title.trim(),
          workDate,
          shiftType,
          startTime,
          endTime,
          location: location.trim(),
          note: note.trim(),
        });
      }
      setModalOpen(false);
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Không thể lưu lịch làm việc.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const stats = useMemo(() => {
    const active = schedules.filter((s) => s.status !== 'cancelled');
    const confirmed = schedules.filter((s) => s.status === 'confirmed').length;
    const completed = schedules.filter((s) => s.status === 'completed').length;
    const totalHours = active.reduce(
      (sum, item) => sum + calcHours(item.startTime, item.endTime),
      0
    );
    return {
      total: active.length,
      confirmed,
      completed,
      totalHours: Math.round(totalHours * 10) / 10,
    };
  }, [schedules]);

  const unsyncedCount = useMemo(
    () => schedules.filter((s) => !s.syncedToSupabase).length,
    [schedules]
  );

  const filteredSchedules = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return schedules.filter((item) => {
      const matchStatus =
        statusFilter === 'ALL' || item.status === statusFilter;
      const matchDate =
        viewMode === 'list' || item.workDate === selectedDate;
      const matchSearch =
        !q ||
        item.title.toLowerCase().includes(q) ||
        item.employeeName.toLowerCase().includes(q) ||
        item.location.toLowerCase().includes(q);
      return matchStatus && matchDate && matchSearch;
    });
  }, [schedules, statusFilter, viewMode, selectedDate, searchQuery]);

  const handleExportExcel = async () => {
    if (schedules.length === 0) {
      onNotify('info', 'Chưa có lịch làm việc nào để xuất Excel.');
      return;
    }
    const fileName = await exportSchedulesToExcel(schedules);
    onNotify('success', `Đã xuất file Excel: ${fileName}`);
  };

  return (
    <div className="space-y-6">
      {/* KPI summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Ca làm hiệu lực</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {stats.total}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Đã xác nhận</p>
          <p className="mt-1 text-2xl font-bold text-emerald-600 tabular-nums">
            {stats.confirmed}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Đã hoàn thành</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {stats.completed}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Tổng giờ dự kiến</p>
          <p className="mt-1 text-2xl font-bold text-blue-600 tabular-nums">
            {stats.totalHours}h
          </p>
        </div>
      </div>

      {/* Main Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setViewMode('week')}
              className={`min-h-[40px] inline-flex items-center gap-2 px-3.5 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                viewMode === 'week'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <CalendarDays className="h-4 w-4" />
              <span>Lịch theo tuần</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`min-h-[40px] inline-flex items-center gap-2 px-3.5 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                viewMode === 'list'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <List className="h-4 w-4" />
              <span>Tất cả danh sách</span>
            </button>
          </div>

          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as 'ALL' | ScheduleStatus)
            }
            className="min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-700"
            aria-label="Lọc theo trạng thái"
          >
            <option value="ALL">Mọi trạng thái</option>
            <option value="registered">Đã đăng ký</option>
            <option value="confirmed">Đã xác nhận</option>
            <option value="completed">Hoàn thành</option>
            <option value="cancelled">Đã hủy</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {supabaseReady && (
            <button
              type="button"
              onClick={onSyncToSupabase}
              disabled={isSyncing || unsyncedCount === 0}
              className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <Database className="h-4 w-4 text-emerald-600" />
              <span>
                {isSyncing ? 'Đang đồng bộ...' : `Đồng bộ (${unsyncedCount})`}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={handleExportExcel}
            disabled={schedules.length === 0}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
            <span>Xuất Excel</span>
          </button>

          <button
            type="button"
            onClick={() => openCreateModal()}
            className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>Đăng ký lịch làm việc</span>
          </button>
        </div>
      </div>

      {/* Week strip selector when in Week mode */}
      {viewMode === 'week' && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-base font-bold text-slate-900">
              Tuần từ {weekDays[0].dayNum}/{weekDays[0].monthNum} –{' '}
              {weekDays[6].dayNum}/{weekDays[6].monthNum}
            </h2>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => shiftWeek(-7)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                aria-label="Tuần trước"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setWeekAnchor(getMondayOfWeek(new Date()));
                  setSelectedDate(todayStr);
                }}
                className="min-h-[44px] px-3.5 text-sm font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                Hôm nay
              </button>
              <button
                type="button"
                onClick={() => shiftWeek(7)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                aria-label="Tuần sau"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1.5 sm:gap-2.5">
            {weekDays.map((day) => {
              const count = schedules.filter(
                (s) => s.workDate === day.ymd && s.status !== 'cancelled'
              ).length;
              const isSelected = selectedDate === day.ymd;
              const isToday = todayStr === day.ymd;
              return (
                <button
                  key={day.ymd}
                  type="button"
                  onClick={() => setSelectedDate(day.ymd)}
                  className={`min-h-[68px] p-2 rounded-xl border text-center transition-colors flex flex-col items-center justify-center ${
                    isSelected
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : isToday
                        ? 'bg-blue-50/60 border-blue-200 text-slate-900 hover:bg-blue-50'
                        : 'bg-white border-slate-200 text-slate-800 hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`text-xs font-medium ${
                      isSelected ? 'text-blue-100' : 'text-slate-500'
                    }`}
                  >
                    {day.weekday}
                  </span>
                  <span className="mt-0.5 text-base sm:text-lg font-bold tabular-nums">
                    {day.dayNum}
                  </span>
                  <span
                    className={`mt-0.5 text-[11px] tabular-nums ${
                      isSelected ? 'text-blue-100' : 'text-slate-500'
                    }`}
                  >
                    {count > 0 ? `${count} ca` : '—'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Search bar for List mode */}
      {viewMode === 'list' && (
        <div className="relative max-w-md">
          <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm theo tên công việc, nhân sự hoặc địa điểm..."
            className="w-full min-h-[44px] pl-10 pr-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>
      )}

      {/* Schedule Items */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-4">
          <h3 className="text-base font-bold text-slate-900">
            {viewMode === 'week'
              ? `Lịch làm việc ngày ${selectedDate.split('-').reverse().join('/')}`
              : `Danh sách lịch làm việc (${filteredSchedules.length})`}
          </h3>
          {viewMode === 'week' && (
            <button
              type="button"
              onClick={() => openCreateModal(selectedDate)}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 rounded-lg transition-colors whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              <span>Thêm ca ngày này</span>
            </button>
          )}
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="h-16 bg-slate-100 rounded-lg animate-pulse"
              />
            ))}
          </div>
        ) : filteredSchedules.length === 0 ? (
          <div className="py-12 px-6 text-center">
            <p className="text-base font-bold text-slate-900">
              {viewMode === 'week'
                ? 'Không có ca làm việc nào trong ngày này'
                : 'Chưa có lịch làm việc phù hợp'}
            </p>
            <p className="mt-1.5 text-sm text-slate-600">
              Nhấn "Đăng ký lịch làm việc" để tạo ca làm mới.
            </p>
            <button
              type="button"
              onClick={() =>
                openCreateModal(viewMode === 'week' ? selectedDate : todayStr)
              }
              className="mt-4 min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span>Đăng ký ca làm</span>
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredSchedules.map((item) => {
              const statusInfo = STATUS_META[item.status];
              const isCancelled = item.status === 'cancelled';
              return (
                <div
                  key={item.id}
                  className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4 hover:bg-slate-50/70 transition-colors"
                >
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-medium">
                      <span className={statusInfo.textClass}>
                        {statusInfo.label}
                      </span>
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span className="text-slate-600">
                        {SHIFT_PRESETS[item.shiftType]?.label || item.shiftType}
                      </span>
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span className="text-slate-600 tabular-nums">
                        {item.workDate.split('-').reverse().join('/')}
                      </span>
                      {item.syncedToSupabase && (
                        <>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="text-emerald-700">
                            Đã đồng bộ Supabase
                          </span>
                        </>
                      )}
                    </div>

                    <h4 className="text-base font-bold text-slate-900">
                      {item.title}
                    </h4>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
                      <span className="inline-flex items-center gap-1.5 tabular-nums">
                        <Clock className="h-4 w-4 text-slate-400" />
                        {item.startTime} – {item.endTime} (
                        {calcHours(item.startTime, item.endTime)}h)
                      </span>
                      <span>Nhân sự: {item.employeeName}</span>
                      {item.location && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-4 w-4 text-slate-400" />
                          {item.location}
                        </span>
                      )}
                    </div>

                    {item.note && (
                      <p className="text-sm text-slate-500">{item.note}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {item.status === 'registered' && (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateSchedule(item, { status: 'confirmed' })
                        }
                        className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors whitespace-nowrap"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        <span>Xác nhận</span>
                      </button>
                    )}

                    {(item.status === 'registered' ||
                      item.status === 'confirmed') && (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateSchedule(item, { status: 'completed' })
                        }
                        className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors whitespace-nowrap"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        <span>Hoàn thành</span>
                      </button>
                    )}

                    {!isCancelled && (
                      <>
                        <button
                          type="button"
                          onClick={() => openEditModal(item)}
                          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100 transition-colors"
                          aria-label="Chỉnh sửa ca làm"
                        >
                          <Edit3 className="h-4 w-4" />
                        </button>

                        <button
                          type="button"
                          onClick={() => setCancelTarget(item)}
                          className="min-h-[44px] inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-amber-700 bg-white border border-amber-200 rounded-lg hover:bg-amber-50 transition-colors whitespace-nowrap"
                        >
                          <XCircle className="h-4 w-4" />
                          <span>Hủy ca</span>
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      onClick={() => setDeleteTarget(item)}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
                      aria-label="Xóa lịch làm việc"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Registration / Edit Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-xs p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="schedule-modal-title"
        >
          <div className="w-full sm:max-w-lg bg-white border border-slate-200 rounded-t-2xl sm:rounded-xl max-h-[92vh] flex flex-col overflow-hidden shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3
                id="schedule-modal-title"
                className="text-lg font-bold text-slate-900"
              >
                {editingItem
                  ? 'Chỉnh sửa lịch làm việc'
                  : 'Đăng ký lịch làm việc mới'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="min-h-[44px] min-w-[44px] -mr-2 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form
              onSubmit={handleFormSubmit}
              className="p-6 space-y-4 overflow-y-auto"
            >
              <div>
                <label
                  htmlFor="sched-title"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
                >
                  Tên công việc / Ca làm *
                </label>
                <input
                  id="sched-title"
                  type="text"
                  required
                  maxLength={150}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="VD: Kiểm kê kho hàng A1"
                  className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="sched-employee"
                    className="block text-sm font-medium text-slate-700 mb-1.5"
                  >
                    Nhân sự phụ trách *
                  </label>
                  <input
                    id="sched-employee"
                    type="text"
                    required
                    maxLength={120}
                    value={employeeName}
                    onChange={(e) => setEmployeeName(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label
                    htmlFor="sched-date"
                    className="block text-sm font-medium text-slate-700 mb-1.5"
                  >
                    Ngày làm việc *
                  </label>
                  <input
                    id="sched-date"
                    type="date"
                    required
                    value={workDate}
                    onChange={(e) => setWorkDate(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 tabular-nums"
                  />
                </div>
              </div>

              <div>
                <span className="block text-sm font-medium text-slate-700 mb-1.5">
                  Chọn nhanh loại ca
                </span>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                  {(Object.keys(SHIFT_PRESETS) as ShiftType[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleShiftTypeChange(key)}
                      className={`min-h-[40px] px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                        shiftType === key
                          ? 'bg-blue-600 border-blue-600 text-white'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {SHIFT_PRESETS[key].label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="sched-start"
                    className="block text-sm font-medium text-slate-700 mb-1.5"
                  >
                    Giờ bắt đầu
                  </label>
                  <input
                    id="sched-start"
                    type="time"
                    required
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label
                    htmlFor="sched-end"
                    className="block text-sm font-medium text-slate-700 mb-1.5"
                  >
                    Giờ kết thúc
                  </label>
                  <input
                    id="sched-end"
                    type="time"
                    required
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="sched-location"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
                >
                  Địa điểm / Kho bãi
                </label>
                <input
                  id="sched-location"
                  type="text"
                  maxLength={150}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="VD: Kho Trung tâm - Cửa số 2"
                  className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label
                  htmlFor="sched-note"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
                >
                  Ghi chú công việc
                </label>
                <textarea
                  id="sched-note"
                  rows={2}
                  maxLength={400}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Yêu cầu thiết bị, người bàn giao..."
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="pt-2 flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="min-h-[44px] px-5 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  disabled={submitting || !title.trim() || !employeeName.trim()}
                  className="min-h-[44px] px-6 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting
                    ? 'Đang lưu...'
                    : editingItem
                      ? 'Cập nhật ca làm'
                      : 'Xác nhận đăng ký'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Cancel schedule confirmation */}
      <ConfirmDialog
        open={Boolean(cancelTarget)}
        title="Hủy ca làm việc này?"
        description={
          cancelTarget
            ? `Sau khi hủy, ca "${cancelTarget.title}" ngày ${cancelTarget.workDate.split('-').reverse().join('/')} sẽ chuyển sang trạng thái Đã hủy và khóa chỉnh sửa.`
            : ''
        }
        confirmLabel="Xác nhận hủy ca"
        onCancel={() => setCancelTarget(null)}
        onConfirm={async () => {
          if (cancelTarget) {
            await onUpdateSchedule(cancelTarget, { status: 'cancelled' });
          }
          setCancelTarget(null);
        }}
      />

      {/* Delete schedule confirmation */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Xóa lịch làm việc?"
        description={
          deleteTarget
            ? `Bạn có chắc muốn xóa vĩnh viễn lịch "${deleteTarget.title}" khỏi hệ thống?`
            : ''
        }
        confirmLabel="Xóa vĩnh viễn"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await onDeleteSchedule(deleteTarget);
          }
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
