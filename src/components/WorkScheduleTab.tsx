import { useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Database,
  Edit3,
  FileSpreadsheet,
  ImageDown,
  List,
  MapPin,
  Plus,
  Search,
  Settings,
  Table2,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { exportSchedulesToExcel } from '../lib/excel';
import { exportTableToPng } from '../lib/media';
import { deleteShiftDefinition, saveShiftDefinition } from '../lib/supabaseOps';
import type {
  LeaveRulesConfig,
  ScheduleStatus,
  ShiftDefinition,
  ShiftType,
  WorkSchedule,
} from '../types';
import { ConfirmDialog } from './ConfirmDialog';

interface WorkScheduleTabProps {
  client: SupabaseClient | null;
  schedules: WorkSchedule[];
  shifts: ShiftDefinition[];
  leaveRules: LeaveRulesConfig;
  loading: boolean;
  defaultEmployeeName: string;
  currentUserEmail: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canApprove: boolean;
  canExport: boolean;
  canSupabase: boolean;
  showOwnerEmail: boolean;
  isStoreManager: boolean;
  supabaseReady: boolean;
  isSyncing: boolean;
  onCreateSchedule: (data: {
    employeeName: string;
    title: string;
    workDate: string;
    shiftType: ShiftType;
    shiftId?: string | null;
    isDayOff?: boolean;
    overrideApproved?: boolean;
    overrideReason?: string;
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
      shiftId: string | null;
      isDayOff: boolean;
      overrideApproved: boolean;
      overrideReason: string;
      startTime: string;
      endTime: string;
      location: string;
      status: ScheduleStatus;
      note: string;
    }>
  ) => Promise<void>;
  onDeleteSchedule: (schedule: WorkSchedule) => Promise<void>;
  onSyncToSupabase: () => Promise<void>;
  onRefreshShifts: () => Promise<void>;
  onExportLogged?: (fileName: string, count: number) => void;
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

const STATUS_META: Record<ScheduleStatus, { label: string; textClass: string }> = {
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

function calcHours(start: string, end: string, isDayOff?: boolean): number {
  if (isDayOff) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (Number.isNaN(sh) || Number.isNaN(eh)) return 0;
  const mins = eh * 60 + em - (sh * 60 + sm);
  return mins > 0 ? Math.round((mins / 60) * 10) / 10 : 0;
}

const WEEKDAY_NAMES = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

export function WorkScheduleTab({
  client,
  schedules,
  shifts,
  leaveRules,
  loading,
  defaultEmployeeName,
  currentUserEmail,
  canCreate,
  canEdit,
  canDelete,
  canApprove,
  canExport,
  canSupabase,
  showOwnerEmail,
  isStoreManager,
  supabaseReady,
  isSyncing,
  onCreateSchedule,
  onUpdateSchedule,
  onDeleteSchedule,
  onSyncToSupabase,
  onRefreshShifts,
  onExportLogged,
  onNotify,
}: WorkScheduleTabProps) {
  const todayStr = useMemo(() => toYmd(new Date()), []);
  const [viewMode, setViewMode] = useState<'week' | 'matrix' | 'list' | 'shifts'>('week');
  const [weekAnchor, setWeekAnchor] = useState<Date>(() =>
    getMondayOfWeek(new Date())
  );
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [statusFilter, setStatusFilter] = useState<'ALL' | ScheduleStatus>('ALL');
  const [shiftFilter, setShiftFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [matrixSortAsc, setMatrixSortAsc] = useState(true);

  // Form Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<WorkSchedule | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [employeeName, setEmployeeName] = useState(defaultEmployeeName);
  const [title, setTitle] = useState('');
  const [workDate, setWorkDate] = useState(todayStr);
  const [shiftType, setShiftType] = useState<ShiftType>('morning');
  const [selectedShiftId, setSelectedShiftId] = useState<string>('');
  const [isDayOff, setIsDayOff] = useState(false);
  const [overrideApproved, setOverrideApproved] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('12:00');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');

  // Shift Definition Manager state
  const [shiftCode, setShiftCode] = useState('');
  const [shiftName, setShiftName] = useState('');
  const [shiftStart, setShiftStart] = useState('08:00');
  const [shiftEnd, setShiftEnd] = useState('12:00');
  const [shiftIsDo, setShiftIsDo] = useState(false);
  const [savingShift, setSavingShift] = useState(false);

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
        isWeekend: i >= 5,
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
    const firstActiveShift = shifts.find((s) => s.active && !s.isDayOff);
    setSelectedShiftId(firstActiveShift?.id || '');
    setTitle(firstActiveShift?.name || 'Ca sáng');
    setWorkDate(presetDate || selectedDate || todayStr);
    setShiftType('morning');
    setIsDayOff(false);
    setOverrideApproved(false);
    setOverrideReason('');
    setStartTime(firstActiveShift?.startTime || '08:00');
    setEndTime(firstActiveShift?.endTime || '12:00');
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
    setSelectedShiftId(item.shiftId || '');
    setIsDayOff(Boolean(item.isDayOff));
    setOverrideApproved(Boolean(item.overrideApproved));
    setOverrideReason(item.overrideReason || '');
    setStartTime(item.startTime);
    setEndTime(item.endTime);
    setLocation(item.location);
    setNote(item.note);
    setModalOpen(true);
  };

  const handleApplyShiftPreset = (shiftDefId: string) => {
    setSelectedShiftId(shiftDefId);
    const found = shifts.find((s) => s.id === shiftDefId);
    if (!found) return;
    setTitle(found.name);
    setIsDayOff(found.isDayOff);
    if (found.isDayOff) {
      setShiftType('custom');
      setStartTime('00:00');
      setEndTime('00:00');
    } else {
      setStartTime(found.startTime);
      setEndTime(found.endTime);
      if (found.code === 'CA_SANG') setShiftType('morning');
      else if (found.code === 'CA_CHIEU') setShiftType('afternoon');
      else if (found.code === 'CA_TOI') setShiftType('evening');
      else if (found.code === 'CA_NGAY') setShiftType('full_day');
      else setShiftType('custom');
    }
  };

  const handleShiftTypeChange = (type: ShiftType) => {
    setShiftType(type);
    if (type !== 'custom') {
      setIsDayOff(false);
      setStartTime(SHIFT_PRESETS[type].startTime);
      setEndTime(SHIFT_PRESETS[type].endTime);
    }
  };

  // Validate DO quota locally before hitting DB (DB trigger also enforces)
  const validateDoQuota = (targetDate: string, excludeId?: string): string | null => {
    if (!isDayOff || overrideApproved) return null;
    const [y, m, d] = targetDate.split('-').map(Number);
    if (!y || !m || !d) return 'Ngày nghỉ DO không hợp lệ.';
    const dt = new Date(y, m - 1, d);
    const mon = getMondayOfWeek(dt);
    const sun = new Date(mon);
    sun.setDate(sun.getDate() + 6);
    const monStr = toYmd(mon);
    const sunStr = toYmd(sun);

    const userEmailTarget = (editingItem?.ownerEmail || currentUserEmail).toLowerCase();
    const userWeekDoCount = schedules.filter(
      (s) =>
        s.id !== excludeId &&
        s.status !== 'cancelled' &&
        Boolean(s.isDayOff) &&
        s.ownerEmail.toLowerCase() === userEmailTarget &&
        s.workDate >= monStr &&
        s.workDate <= sunStr
    ).length;

    if (userWeekDoCount >= leaveRules.maxDoPerWeek) {
      return `Nhân viên đã đủ tối đa ${leaveRules.maxDoPerWeek} ngày nghỉ DO trong tuần (${monStr} – ${sunStr}).`;
    }

    const dow = dt.getDay(); // 0=Sun, 6=Sat
    const isWeekend = dow === 0 || dow === 6;
    const dayLimit = isWeekend ? leaveRules.weekendMaxDo : leaveRules.weekdayMaxDo;
    const sameDayDo = schedules.filter(
      (s) =>
        s.id !== excludeId &&
        s.status !== 'cancelled' &&
        Boolean(s.isDayOff) &&
        s.workDate === targetDate
    ).length;

    if (sameDayDo >= dayLimit) {
      return `Ngày ${targetDate} đã đạt giới hạn ${dayLimit} người nghỉ DO.`;
    }
    return null;
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeName.trim()) return;
    const finalTitle = isDayOff ? 'Nghỉ tuần (DO)' : title.trim();
    if (!finalTitle) {
      onNotify('error', 'Vui lòng nhập tên ca làm việc.');
      return;
    }
    if (!isDayOff && startTime >= endTime) {
      onNotify('error', 'Giờ kết thúc phải sau giờ bắt đầu.');
      return;
    }
    const doErr = validateDoQuota(workDate, editingItem?.id);
    if (doErr) {
      onNotify('error', doErr);
      return;
    }
    setSubmitting(true);
    try {
      if (editingItem) {
        await onUpdateSchedule(editingItem, {
          employeeName: employeeName.trim(),
          title: finalTitle,
          workDate,
          shiftType,
          shiftId: selectedShiftId || null,
          isDayOff,
          overrideApproved: isStoreManager ? overrideApproved : false,
          overrideReason: overrideReason.trim(),
          startTime: isDayOff ? '00:00' : startTime,
          endTime: isDayOff ? '00:00' : endTime,
          location: location.trim(),
          note: note.trim(),
        });
      } else {
        await onCreateSchedule({
          employeeName: employeeName.trim(),
          title: finalTitle,
          workDate,
          shiftType,
          shiftId: selectedShiftId || null,
          isDayOff,
          overrideApproved: isStoreManager ? overrideApproved : false,
          overrideReason: overrideReason.trim(),
          startTime: isDayOff ? '00:00' : startTime,
          endTime: isDayOff ? '00:00' : endTime,
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

  const handleSaveShiftDef = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) {
      onNotify('error', 'Cần kích hoạt phiên Supabase Auth để thiết lập ca.');
      return;
    }
    if (!shiftCode.trim() || !shiftName.trim()) {
      onNotify('error', 'Nhập mã ca và tên ca.');
      return;
    }
    if (!shiftIsDo && shiftStart >= shiftEnd) {
      onNotify('error', 'Giờ bắt đầu phải nhỏ hơn giờ kết thúc.');
      return;
    }
    const duplicate = shifts.some(
      (s) => s.code.toUpperCase() === shiftCode.trim().toUpperCase()
    );
    if (duplicate) {
      onNotify('error', 'Mã ca đã tồn tại.');
      return;
    }
    setSavingShift(true);
    const res = await saveShiftDefinition(client, {
      code: shiftCode,
      name: shiftName,
      startTime: shiftStart,
      endTime: shiftEnd,
      isDayOff: shiftIsDo,
      sortOrder: shifts.length + 1,
      active: true,
    });
    setSavingShift(false);
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    setShiftCode('');
    setShiftName('');
    onNotify('success', 'Đã lưu ca làm việc mới.');
    await onRefreshShifts();
  };

  const handleDeleteShiftDef = async (id: string) => {
    if (!client) {
      onNotify('error', 'Cần kích hoạt phiên Supabase Auth để xóa ca.');
      return;
    }
    const res = await deleteShiftDefinition(client, id);
    if (res.error) {
      onNotify('error', res.error);
    } else {
      onNotify('success', 'Đã xóa ca làm việc.');
      await onRefreshShifts();
    }
  };

  const stats = useMemo(() => {
    const active = schedules.filter((s) => s.status !== 'cancelled');
    const confirmed = schedules.filter((s) => s.status === 'confirmed').length;
    const doCount = active.filter((s) => s.isDayOff).length;
    const totalHours = active.reduce(
      (sum, s) => sum + calcHours(s.startTime, s.endTime, s.isDayOff),
      0
    );
    return {
      total: active.length,
      confirmed,
      doCount,
      totalHours: Math.round(totalHours * 10) / 10,
    };
  }, [schedules]);

  const filteredSchedules = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return schedules.filter((item) => {
      const matchStatus = statusFilter === 'ALL' || item.status === statusFilter;
      const matchShift =
        shiftFilter === 'ALL' ||
        (shiftFilter === 'DO' ? Boolean(item.isDayOff) : item.title === shiftFilter);
      const matchSearch =
        !q ||
        item.title.toLowerCase().includes(q) ||
        item.employeeName.toLowerCase().includes(q) ||
        item.location.toLowerCase().includes(q);
      return matchStatus && matchShift && matchSearch;
    });
  }, [schedules, statusFilter, shiftFilter, searchQuery]);

  const selectedDaySchedules = useMemo(
    () => filteredSchedules.filter((s) => s.workDate === selectedDate),
    [filteredSchedules, selectedDate]
  );

  // Matrix data: unique employees × Mon-Sun columns
  const matrixRows = useMemo(() => {
    const weekStart = weekDays[0].ymd;
    const weekEnd = weekDays[6].ymd;
    const weekItems = filteredSchedules.filter(
      (s) => s.workDate >= weekStart && s.workDate <= weekEnd && s.status !== 'cancelled'
    );

    const empMap = new Map<
      string,
      { employeeKey: string; employeeName: string; byDate: Map<string, WorkSchedule[]> }
    >();

    for (const item of weekItems) {
      const key = (item.ownerEmail || item.employeeName).toLowerCase();
      let entry = empMap.get(key);
      if (!entry) {
        entry = {
          employeeKey: key,
          employeeName: item.employeeName || item.ownerEmail,
          byDate: new Map(),
        };
        empMap.set(key, entry);
      }
      const list = entry.byDate.get(item.workDate) || [];
      list.push(item);
      entry.byDate.set(item.workDate, list);
    }

    const arr = Array.from(empMap.values());
    arr.sort((a, b) =>
      matrixSortAsc
        ? a.employeeName.localeCompare(b.employeeName, 'vi')
        : b.employeeName.localeCompare(a.employeeName, 'vi')
    );
    return arr;
  }, [filteredSchedules, weekDays, matrixSortAsc]);

  const handleExportExcel = async () => {
    if (!canExport || filteredSchedules.length === 0) return;
    try {
      const fileName = await exportSchedulesToExcel(filteredSchedules);
      onNotify('success', `Đã xuất tệp ${fileName}`);
      onExportLogged?.(fileName, filteredSchedules.length);
    } catch {
      onNotify('error', 'Xuất tệp Excel thất bại.');
    }
  };

  const handleExportMatrixPng = async () => {
    const weekRange = `${weekDays[0].ymd} đến ${weekDays[6].ymd}`;
    const columns = [
      { header: 'Nhân sự', width: 170 },
      ...weekDays.map((d) => ({
        header: `${d.weekday} (${d.dayNum}/${d.monthNum})`,
        width: 118,
        align: 'center' as const,
      })),
    ];

    const rows = matrixRows.map((emp) => [
      emp.employeeName,
      ...weekDays.map((d) => {
        const items = emp.byDate.get(d.ymd) || [];
        if (items.length === 0) return '—';
        return items
          .map((i) => (i.isDayOff ? 'DO' : `${i.title} (${i.startTime}-${i.endTime})`))
          .join(' | ');
      }),
    ]);

    const fileName = `LichTuan_${weekDays[0].ymd}.png`;
    await exportTableToPng(
      'LỊCH LÀM VIỆC TUẦN CHÍNH THỨC',
      `Tuần: ${weekRange} · Quy định DO: tối đa ${leaveRules.maxDoPerWeek} ngày/tuần (T2-T6: ${leaveRules.weekdayMaxDo}, T7-CN: ${leaveRules.weekendMaxDo})`,
      columns,
      rows,
      fileName
    );
    onNotify('success', `Đã xuất ảnh lịch tuần ${fileName}`);
    onExportLogged?.(fileName, matrixRows.length);
  };

  const shiftTitleOptions = useMemo(() => {
    const set = new Set<string>(shifts.filter((s) => !s.isDayOff).map((s) => s.name));
    schedules.forEach((s) => {
      if (!s.isDayOff && s.title) set.add(s.title);
    });
    return Array.from(set);
  }, [shifts, schedules]);

  return (
    <div className="space-y-6">
      {/* KPI Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Tổng ca &amp; ngày DO</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{stats.total}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Đã xác nhận</p>
          <p className="mt-1 text-2xl font-bold text-emerald-600 tabular-nums">{stats.confirmed}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Ngày nghỉ DO</p>
          <p className="mt-1 text-2xl font-bold text-amber-600 tabular-nums">{stats.doCount}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Tổng giờ làm việc</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{stats.totalHours}h</p>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setViewMode('week')}
              className={`min-h-[38px] px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 ${
                viewMode === 'week' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              <span>Theo ngày</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('matrix')}
              className={`min-h-[38px] px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 ${
                viewMode === 'matrix' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              <Table2 className="h-3.5 w-3.5" />
              <span>Lịch tuần chính thức</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`min-h-[38px] px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 ${
                viewMode === 'list' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              <List className="h-3.5 w-3.5" />
              <span>Danh sách</span>
            </button>
            {canApprove && (
              <button
                type="button"
                onClick={() => setViewMode('shifts')}
                className={`min-h-[38px] px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 ${
                  viewMode === 'shifts' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                <Settings className="h-3.5 w-3.5" />
                <span>Thiết lập ca</span>
              </button>
            )}
          </div>

          <div className="relative">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm tên nhân sự, ca..."
              className="min-h-[40px] pl-9 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg w-48"
            />
          </div>

          <select
            value={shiftFilter}
            onChange={(e) => setShiftFilter(e.target.value)}
            className="min-h-[40px] px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
          >
            <option value="ALL">Tất cả ca</option>
            <option value="DO">Chỉ ngày DO</option>
            {shiftTitleOptions.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'ALL' | ScheduleStatus)}
            className="min-h-[40px] px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
          >
            <option value="ALL">Mọi trạng thái</option>
            <option value="registered">Đã đăng ký</option>
            <option value="confirmed">Đã xác nhận</option>
            <option value="completed">Hoàn thành</option>
            <option value="cancelled">Đã hủy</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {viewMode === 'matrix' && canExport && (
            <button
              type="button"
              onClick={() => void handleExportMatrixPng()}
              className="min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <ImageDown className="h-4 w-4 text-blue-600" />
              <span>Xuất ảnh lịch tuần</span>
            </button>
          )}
          {canExport && (
            <button
              type="button"
              onClick={() => void handleExportExcel()}
              disabled={filteredSchedules.length === 0}
              className="min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
              <span>Xuất Excel</span>
            </button>
          )}
          {canSupabase && supabaseReady && (
            <button
              type="button"
              onClick={onSyncToSupabase}
              disabled={isSyncing}
              className="min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <Database className="h-4 w-4 text-blue-600" />
              <span>Đồng bộ</span>
            </button>
          )}
          {canCreate && (
            <button
              type="button"
              onClick={() => openCreateModal()}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" />
              <span>Đăng ký ca / Nghỉ DO</span>
            </button>
          )}
        </div>
      </div>

      {/* View: Shift Definitions Setup */}
      {viewMode === 'shifts' && canApprove && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleSaveShiftDef}
            className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <h3 className="text-base font-bold text-slate-900">Thêm ca làm việc mẫu</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mã ca *</label>
                <input
                  type="text"
                  required
                  value={shiftCode}
                  onChange={(e) => setShiftCode(e.target.value)}
                  placeholder="CA_DEM"
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm font-mono uppercase border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tên ca *</label>
                <input
                  type="text"
                  required
                  value={shiftName}
                  onChange={(e) => setShiftName(e.target.value)}
                  placeholder="Ca gãy / Ca hỗ trợ"
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                checked={shiftIsDo}
                onChange={(e) => setShiftIsDo(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span>Đây là loại nghỉ tuần (DO)</span>
            </label>

            {!shiftIsDo && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Giờ bắt đầu</label>
                  <input
                    type="time"
                    value={shiftStart}
                    onChange={(e) => setShiftStart(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Giờ kết thúc</label>
                  <input
                    type="time"
                    value={shiftEnd}
                    onChange={(e) => setShiftEnd(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={savingShift}
              className="w-full min-h-[42px] px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {savingShift ? 'Đang lưu...' : 'Lưu ca làm việc'}
            </button>
          </form>

          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
              <h3 className="text-sm font-bold text-slate-900">Danh sách ca làm việc hiện có</h3>
            </div>
            <div className="divide-y divide-slate-100">
              {shifts.map((s) => (
                <div key={s.id} className="p-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-slate-900">
                      {s.name}{' '}
                      <span className="font-mono text-xs font-normal text-slate-500">({s.code})</span>
                    </p>
                    <p className="text-xs font-mono text-slate-600 mt-0.5">
                      {s.isDayOff ? 'Nghỉ tuần (DO)' : `${s.startTime} – ${s.endTime}`}
                    </p>
                  </div>
                  {s.code !== 'DO' && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteShiftDef(s.id)}
                      className="min-h-[36px] min-w-[36px] p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"
                      title="Xóa ca"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* View: Official Weekly Matrix */}
      {viewMode === 'matrix' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => shiftWeek(-7)}
                className="min-h-[36px] min-w-[36px] rounded-lg border border-slate-300 flex items-center justify-center hover:bg-slate-50"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-bold text-slate-900 font-mono tabular-nums">
                {weekDays[0].ymd} → {weekDays[6].ymd}
              </span>
              <button
                type="button"
                onClick={() => shiftWeek(7)}
                className="min-h-[36px] min-w-[36px] rounded-lg border border-slate-300 flex items-center justify-center hover:bg-slate-50"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-600">
              <span>
                Định mức DO: Tối đa <strong>{leaveRules.maxDoPerWeek}</strong>/tuần · T2–T6:{' '}
                <strong>{leaveRules.weekdayMaxDo}</strong>/ngày · T7–CN:{' '}
                <strong>{leaveRules.weekendMaxDo}</strong>/ngày
              </span>
              <button
                type="button"
                onClick={() => setMatrixSortAsc((v) => !v)}
                className="px-2.5 py-1 rounded border border-slate-300 bg-white text-slate-700 font-medium"
              >
                Sắp xếp tên: {matrixSortAsc ? 'A → Z' : 'Z → A'}
              </button>
            </div>
          </div>

          {/* Desktop Matrix Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-700">
                  <th className="py-3 px-4 font-bold min-w-[170px]">Nhân sự</th>
                  {weekDays.map((d) => (
                    <th key={d.ymd} className="py-3 px-2 font-bold text-center min-w-[125px]">
                      <div>{d.weekday}</div>
                      <div className="font-mono text-[11px] font-normal text-slate-500">
                        {d.dayNum}/{d.monthNum}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {matrixRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-sm text-slate-500">
                      Chưa có lịch làm việc nào trong tuần này.
                    </td>
                  </tr>
                ) : (
                  matrixRows.map((emp) => (
                    <tr key={emp.employeeKey} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-bold text-slate-900">{emp.employeeName}</td>
                      {weekDays.map((d) => {
                        const cellItems = emp.byDate.get(d.ymd) || [];
                        return (
                          <td key={d.ymd} className="py-2 px-2 align-top text-center">
                            {cellItems.length === 0 ? (
                              <span className="text-slate-300">—</span>
                            ) : (
                              <div className="space-y-1">
                                {cellItems.map((it) => (
                                  <button
                                    key={it.id}
                                    type="button"
                                    onClick={() => canEdit && openEditModal(it)}
                                    className={`w-full px-2 py-1.5 rounded border text-left transition-colors ${
                                      it.isDayOff
                                        ? 'bg-amber-50 border-amber-200 text-amber-800'
                                        : it.status === 'confirmed'
                                          ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                                          : 'bg-blue-50 border-blue-200 text-blue-900'
                                    }`}
                                  >
                                    <p className="font-bold truncate">{it.isDayOff ? 'Nghỉ DO' : it.title}</p>
                                    {!it.isDayOff && (
                                      <p className="font-mono text-[11px] opacity-80 tabular-nums">
                                        {it.startTime}–{it.endTime}
                                      </p>
                                    )}
                                  </button>
                                ))}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile Matrix Fallback Cards */}
          <div className="md:hidden divide-y divide-slate-100">
            {matrixRows.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Chưa có lịch làm việc tuần này.
              </div>
            ) : (
              matrixRows.map((emp) => (
                <div key={emp.employeeKey} className="p-4 space-y-2">
                  <p className="font-bold text-sm text-slate-900">{emp.employeeName}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {weekDays.map((d) => {
                      const items = emp.byDate.get(d.ymd) || [];
                      return (
                        <div key={d.ymd} className="border border-slate-200 rounded-lg p-2 text-xs">
                          <p className="font-medium text-slate-500">
                            {d.weekday} ({d.dayNum}/{d.monthNum})
                          </p>
                          {items.length === 0 ? (
                            <p className="text-slate-300 mt-0.5">—</p>
                          ) : (
                            items.map((it) => (
                              <p
                                key={it.id}
                                className={`mt-0.5 font-medium ${
                                  it.isDayOff ? 'text-amber-700' : 'text-slate-900'
                                }`}
                              >
                                {it.isDayOff ? 'DO' : `${it.title} (${it.startTime})`}
                              </p>
                            ))
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* View: Week Strip + Day Detail */}
      {viewMode === 'week' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <button
                type="button"
                onClick={() => shiftWeek(-7)}
                className="min-h-[38px] min-w-[38px] rounded-lg border border-slate-300 flex items-center justify-center hover:bg-slate-50"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-bold text-slate-900">
                Tuần {weekDays[0].dayNum}/{weekDays[0].monthNum} – {weekDays[6].dayNum}/{weekDays[6].monthNum}
              </span>
              <button
                type="button"
                onClick={() => shiftWeek(7)}
                className="min-h-[38px] min-w-[38px] rounded-lg border border-slate-300 flex items-center justify-center hover:bg-slate-50"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
              {weekDays.map((d) => {
                const count = filteredSchedules.filter(
                  (s) => s.workDate === d.ymd && s.status !== 'cancelled'
                ).length;
                const active = selectedDate === d.ymd;
                return (
                  <button
                    key={d.ymd}
                    type="button"
                    onClick={() => setSelectedDate(d.ymd)}
                    className={`min-h-[68px] rounded-xl border p-2 flex flex-col items-center justify-center transition-colors ${
                      active
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-800 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <span className="text-[11px] font-medium opacity-80">{d.weekday}</span>
                    <span className="text-base font-bold tabular-nums">{d.dayNum}</span>
                    <span
                      className={`text-[10px] tabular-nums ${
                        active ? 'text-blue-100' : 'text-slate-500'
                      }`}
                    >
                      {count} ca
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Day Detail List */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 font-mono">
                Ngày {selectedDate} ({selectedDaySchedules.length} đăng ký)
              </h3>
              {canCreate && (
                <button
                  type="button"
                  onClick={() => openCreateModal(selectedDate)}
                  className="text-xs font-medium text-blue-600 hover:underline inline-flex items-center gap-1"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Thêm ngày này</span>
                </button>
              )}
            </div>

            {loading ? (
              <div className="p-6 text-sm text-slate-500">Đang tải lịch làm việc...</div>
            ) : selectedDaySchedules.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Chưa có ca làm nào cho ngày {selectedDate}.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {selectedDaySchedules.map((item) => {
                  const st = STATUS_META[item.status] || STATUS_META.registered;
                  return (
                    <div
                      key={item.id}
                      className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-slate-900">
                            {item.isDayOff ? 'Nghỉ tuần (DO)' : item.title}
                          </span>
                          <span className={`text-xs font-medium ${st.textClass}`}>· {st.label}</span>
                          {item.overrideApproved && (
                            <span className="text-xs font-medium text-amber-700">· Ngoại lệ đã duyệt</span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                          <span className="font-medium text-slate-800">{item.employeeName}</span>
                          {!item.isDayOff && (
                            <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                              <Clock className="h-3.5 w-3.5 text-slate-400" />
                              {item.startTime}–{item.endTime}
                            </span>
                          )}
                          {item.location && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3.5 w-3.5 text-slate-400" />
                              {item.location}
                            </span>
                          )}
                          {showOwnerEmail && (
                            <span className="font-mono text-slate-400">{item.ownerEmail}</span>
                          )}
                        </div>
                        {item.note && <p className="text-xs text-slate-500">{item.note}</p>}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {canApprove && item.status === 'registered' && (
                          <button
                            type="button"
                            onClick={() => void onUpdateSchedule(item, { status: 'confirmed' })}
                            className="min-h-[36px] px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 inline-flex items-center gap-1"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Duyệt</span>
                          </button>
                        )}
                        {canEdit && item.status !== 'cancelled' && (
                          <button
                            type="button"
                            onClick={() => openEditModal(item)}
                            className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span>Sửa</span>
                          </button>
                        )}
                        {canEdit && item.status !== 'cancelled' && (
                          <button
                            type="button"
                            onClick={() => setCancelTarget(item)}
                            className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs text-amber-700 hover:bg-amber-50 inline-flex items-center gap-1"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            <span>Hủy</span>
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(item)}
                            className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-red-200 text-xs text-red-600 hover:bg-red-50 inline-flex items-center gap-1"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Xóa</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* View: Full List */}
      {viewMode === 'list' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                  <th className="py-3 px-4">Ngày</th>
                  <th className="py-3 px-4">Nhân sự</th>
                  <th className="py-3 px-4">Ca / Nghỉ DO</th>
                  <th className="py-3 px-4">Giờ</th>
                  <th className="py-3 px-4">Trạng thái</th>
                  <th className="py-3 px-4 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredSchedules.map((item) => {
                  const st = STATUS_META[item.status] || STATUS_META.registered;
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/60">
                      <td className="py-3 px-4 font-mono text-xs tabular-nums">{item.workDate}</td>
                      <td className="py-3 px-4 font-medium text-slate-900">{item.employeeName}</td>
                      <td className="py-3 px-4">{item.isDayOff ? 'Nghỉ tuần (DO)' : item.title}</td>
                      <td className="py-3 px-4 font-mono text-xs tabular-nums">
                        {item.isDayOff ? '—' : `${item.startTime}–${item.endTime}`}
                      </td>
                      <td className={`py-3 px-4 text-xs font-medium ${st.textClass}`}>{st.label}</td>
                      <td className="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
                        {canApprove && item.status === 'registered' && (
                          <button
                            type="button"
                            onClick={() => void onUpdateSchedule(item, { status: 'confirmed' })}
                            className="text-xs text-emerald-700 font-medium hover:underline"
                          >
                            Duyệt
                          </button>
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => openEditModal(item)}
                            className="text-xs text-blue-600 font-medium hover:underline"
                          >
                            Sửa
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(item)}
                            className="text-xs text-red-600 font-medium hover:underline"
                          >
                            Xóa
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal: Create / Edit Schedule */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleFormSubmit}
            className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 space-y-4 shadow-xl max-h-[92vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                {editingItem ? 'Chỉnh sửa lịch làm việc' : 'Đăng ký ca làm / Nghỉ DO'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {shifts.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Chọn nhanh từ danh sách ca chuẩn
                </label>
                <select
                  value={selectedShiftId}
                  onChange={(e) => handleApplyShiftPreset(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">-- Tùy chỉnh thủ công --</option>
                  {shifts
                    .filter((s) => s.active)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.isDayOff ? '(Nghỉ tuần DO)' : `(${s.startTime}–${s.endTime})`}
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Nhân sự *</label>
                <input
                  type="text"
                  required
                  value={employeeName}
                  onChange={(e) => setEmployeeName(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Ngày *</label>
                <input
                  type="date"
                  required
                  value={workDate}
                  onChange={(e) => setWorkDate(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isDayOff}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setIsDayOff(checked);
                  if (checked) setTitle('Nghỉ tuần (DO)');
                }}
                className="h-4 w-4 rounded border-amber-400"
              />
              <span>
                Đăng ký nghỉ tuần (DO) · Quy định: tối đa {leaveRules.maxDoPerWeek} DO/tuần (T2–T6:{' '}
                {leaveRules.weekdayMaxDo}/ngày, T7–CN: {leaveRules.weekendMaxDo}/ngày)
              </span>
            </label>

            {isDayOff && isStoreManager && (
              <div className="border border-blue-200 bg-blue-50 rounded-lg p-3 space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-blue-900 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={overrideApproved}
                    onChange={(e) => setOverrideApproved(e.target.checked)}
                    className="h-4 w-4 rounded"
                  />
                  <span>Quản trị phê duyệt ngoại lệ (vượt định mức DO)</span>
                </label>
                {overrideApproved && (
                  <input
                    type="text"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Lý do duyệt ngoại lệ..."
                    className="w-full min-h-[38px] px-3 py-1.5 text-xs border border-blue-300 rounded bg-white"
                  />
                )}
              </div>
            )}

            {!isDayOff && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Tên ca / công việc *</label>
                    <input
                      type="text"
                      required
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="VD: Ca sáng quầy TPCN"
                      className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Nhóm ca</label>
                    <select
                      value={shiftType}
                      onChange={(e) => handleShiftTypeChange(e.target.value as ShiftType)}
                      className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="morning">Ca sáng</option>
                      <option value="afternoon">Ca chiều</option>
                      <option value="evening">Ca tối</option>
                      <option value="full_day">Cả ngày</option>
                      <option value="custom">Tùy chỉnh</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Giờ bắt đầu</label>
                    <input
                      type="time"
                      required
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Giờ kết thúc</label>
                    <input
                      type="time"
                      required
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
              </>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Vị trí / Quầy</label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Quầy TPCN / Kho"
                  className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Ghi chú</label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Ghi chú thêm..."
                  className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
              >
                Đóng
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[42px] px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Đang lưu...' : editingItem ? 'Cập nhật' : 'Đăng ký'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        title="Hủy ca làm việc"
        description={`Xác nhận hủy ca "${cancelTarget?.title}" ngày ${cancelTarget?.workDate}?`}
        confirmLabel="Xác nhận hủy"
        danger
        onConfirm={async () => {
          if (cancelTarget) await onUpdateSchedule(cancelTarget, { status: 'cancelled' });
          setCancelTarget(null);
        }}
        onCancel={() => setCancelTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Xóa lịch làm việc"
        description={`Xóa vĩnh viễn lịch "${deleteTarget?.title}" ngày ${deleteTarget?.workDate}?`}
        confirmLabel="Xóa"
        danger
        onConfirm={async () => {
          if (deleteTarget) await onDeleteSchedule(deleteTarget);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
