import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Filter,
  MousePointerClick,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { MatrixExportRow } from '../../lib/scheduleExport';
import {
  SHIFT_META,
  SHIFT_ORDER,
  formatViDate,
  formatYmd,
  getShiftMeta,
  type WeekDayInfo,
} from '../../lib/scheduleMeta';
import type {
  OfficialWorkSchedule,
  ScheduleMatrixConfig,
  ScheduleMatrixSortMode,
  SchedulePermissionLevel,
  ScheduleShiftCode,
  ScheduleStaffMember,
} from '../../types';

const FILTER_OPEN_STORAGE_KEY = 'tpcn_schedule_matrix_filter_open';
const MATRIX_PREFS_STORAGE_KEY = 'tpcn_schedule_matrix_prefs';

interface WeeklyMatrixTabProps {
  weekDays: WeekDayInfo[];
  staffDirectory: ScheduleStaffMember[];
  schedules: OfficialWorkSchedule[];
  matrixConfig: ScheduleMatrixConfig | null;
  scheduleLevel: SchedulePermissionLevel;
  loading: boolean;
  onShiftWeek: (deltaDays: number) => void;
  onGoCurrentWeek: () => void;
  onOpenCreateModal: (presetStaffUid: string, presetDate: string) => void;
  onOpenEditModal: (schedule: OfficialWorkSchedule) => void;
  onQuickCreateShift: (params: {
    staff: ScheduleStaffMember;
    date: string;
    shiftType: ScheduleShiftCode;
    isTrucDam: boolean;
  }) => Promise<void>;
  onQuickDeleteShift: (schedule: OfficialWorkSchedule) => Promise<void>;
  onSaveMatrixConfig: (params: {
    sortMode: ScheduleMatrixSortMode;
    customOrder: string[];
    hiddenUids: string[];
  }) => Promise<void>;
  onVisibleRowsChange?: (rows: MatrixExportRow[]) => void;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}

export function WeeklyMatrixTab({
  weekDays,
  staffDirectory,
  schedules,
  matrixConfig,
  scheduleLevel,
  loading,
  onShiftWeek,
  onGoCurrentWeek,
  onOpenCreateModal,
  onOpenEditModal,
  onQuickCreateShift,
  onQuickDeleteShift,
  onSaveMatrixConfig,
  onVisibleRowsChange,
  onNotify,
}: WeeklyMatrixTabProps) {
  const canEdit = scheduleLevel !== 'view';
  const canDelete = scheduleLevel === 'manage' || scheduleLevel === 'admin';
  const todayYmd = useMemo(() => formatYmd(new Date()), []);

  // Persisted filter collapse + local filters
  const [filterOpen, setFilterOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FILTER_OPEN_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [staffManagerOpen, setStaffManagerOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState<string>(() => {
    try {
      const raw = localStorage.getItem(MATRIX_PREFS_STORAGE_KEY);
      return raw ? JSON.parse(raw).searchQuery || '' : '';
    } catch {
      return '';
    }
  });
  const [departmentFilter, setDepartmentFilter] = useState<string>(() => {
    try {
      const raw = localStorage.getItem(MATRIX_PREFS_STORAGE_KEY);
      return raw ? JSON.parse(raw).departmentFilter || 'ALL' : 'ALL';
    } catch {
      return 'ALL';
    }
  });
  const [onlyWithShifts, setOnlyWithShifts] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(MATRIX_PREFS_STORAGE_KEY);
      return raw ? Boolean(JSON.parse(raw).onlyWithShifts) : false;
    } catch {
      return false;
    }
  });

  // Sort & visibility synced from Firestore matrixConfig (with localStorage fallback)
  const [sortMode, setSortMode] = useState<ScheduleMatrixSortMode>('name_asc');
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [hiddenUids, setHiddenUids] = useState<string[]>([]);
  const [savingConfig, setSavingConfig] = useState(false);

  // Quick Brush state
  const [activeBrush, setActiveBrush] = useState<'modal' | ScheduleShiftCode>('modal');
  const [brushTrucDam, setBrushTrucDam] = useState(false);
  const [busyCellKey, setBusyCellKey] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_OPEN_STORAGE_KEY, filterOpen ? '1' : '0');
    } catch {
      // Ignore storage error
    }
  }, [filterOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(
        MATRIX_PREFS_STORAGE_KEY,
        JSON.stringify({ searchQuery, departmentFilter, onlyWithShifts })
      );
    } catch {
      // Ignore storage error
    }
  }, [searchQuery, departmentFilter, onlyWithShifts]);

  // Hydrate from Firestore config when received, otherwise fallback to localStorage
  useEffect(() => {
    if (matrixConfig) {
      setSortMode(matrixConfig.sortMode);
      setCustomOrder(matrixConfig.customOrder);
      setHiddenUids(matrixConfig.hiddenUids);
      return;
    }
    try {
      const cached = localStorage.getItem('tpcn_schedule_matrix_config_cache');
      if (cached) {
        const parsed = JSON.parse(cached) as Partial<ScheduleMatrixConfig>;
        if (parsed.sortMode) setSortMode(parsed.sortMode);
        if (Array.isArray(parsed.customOrder)) setCustomOrder(parsed.customOrder);
        if (Array.isArray(parsed.hiddenUids)) setHiddenUids(parsed.hiddenUids);
      }
    } catch {
      // Ignore cache error
    }
  }, [matrixConfig]);

  const weekStart = weekDays[0].ymd;
  const weekEnd = weekDays[6].ymd;

  const weekSchedules = useMemo(
    () => schedules.filter((s) => s.date >= weekStart && s.date <= weekEnd),
    [schedules, weekStart, weekEnd]
  );

  // Build map: staffUid -> date -> shifts[]
  const staffWeekMap = useMemo(() => {
    const map = new Map<string, Map<string, OfficialWorkSchedule[]>>();
    for (const s of weekSchedules) {
      let dayMap = map.get(s.staffUid);
      if (!dayMap) {
        dayMap = new Map();
        map.set(s.staffUid, dayMap);
      }
      const list = dayMap.get(s.date) || [];
      list.push(s);
      list.sort((a, b) => a.startTime.localeCompare(b.startTime));
      dayMap.set(s.date, list);
    }
    return map;
  }, [weekSchedules]);

  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const st of staffDirectory) {
      if (st.department) set.add(st.department);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'vi'));
  }, [staffDirectory]);

  const hiddenSet = useMemo(() => new Set(hiddenUids), [hiddenUids]);

  const orderedAllStaff = useMemo(() => {
    const list = [...staffDirectory];
    const orderIndex = new Map<string, number>();
    customOrder.forEach((uid, idx) => orderIndex.set(uid, idx));

    const getShiftCount = (uid: string): number => {
      const dayMap = staffWeekMap.get(uid);
      if (!dayMap) return 0;
      let count = 0;
      for (const items of dayMap.values()) count += items.length;
      return count;
    };

    list.sort((a, b) => {
      if (sortMode === 'custom') {
        const ia = orderIndex.get(a.uid);
        const ib = orderIndex.get(b.uid);
        if (ia !== undefined && ib !== undefined) return ia - ib;
        if (ia !== undefined) return -1;
        if (ib !== undefined) return 1;
        return a.name.localeCompare(b.name, 'vi');
      }
      if (sortMode === 'name_desc') {
        return b.name.localeCompare(a.name, 'vi');
      }
      if (sortMode === 'position_asc') {
        const cmp = (a.department || '').localeCompare(b.department || '', 'vi');
        return cmp !== 0 ? cmp : a.name.localeCompare(b.name, 'vi');
      }
      if (sortMode === 'shifts_desc') {
        const diff = getShiftCount(b.uid) - getShiftCount(a.uid);
        return diff !== 0 ? diff : a.name.localeCompare(b.name, 'vi');
      }
      return a.name.localeCompare(b.name, 'vi');
    });
    return list;
  }, [staffDirectory, customOrder, sortMode, staffWeekMap]);

  const visibleRows: MatrixExportRow[] = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return orderedAllStaff
      .filter((staff) => {
        if (hiddenSet.has(staff.uid)) return false;
        if (departmentFilter !== 'ALL' && staff.department !== departmentFilter) {
          return false;
        }
        if (q) {
          const matchName = staff.name.toLowerCase().includes(q);
          const matchDept = (staff.department || '').toLowerCase().includes(q);
          if (!matchName && !matchDept) return false;
        }
        const dayMap = staffWeekMap.get(staff.uid);
        if (onlyWithShifts) {
          let hasAny = false;
          if (dayMap) {
            for (const items of dayMap.values()) {
              if (items.length > 0) {
                hasAny = true;
                break;
              }
            }
          }
          if (!hasAny) return false;
        }
        return true;
      })
      .map((staff) => ({
        staff,
        byDate: staffWeekMap.get(staff.uid) || new Map<string, OfficialWorkSchedule[]>(),
      }));
  }, [
    orderedAllStaff,
    hiddenSet,
    departmentFilter,
    searchQuery,
    onlyWithShifts,
    staffWeekMap,
  ]);

  const onVisibleRowsChangeRef = useRef(onVisibleRowsChange);
  onVisibleRowsChangeRef.current = onVisibleRowsChange;

  useEffect(() => {
    onVisibleRowsChangeRef.current?.(visibleRows);
  }, [visibleRows]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (searchQuery.trim()) count += 1;
    if (departmentFilter !== 'ALL') count += 1;
    if (onlyWithShifts) count += 1;
    if (hiddenUids.length > 0) count += 1;
    if (sortMode !== 'name_asc') count += 1;
    return count;
  }, [searchQuery, departmentFilter, onlyWithShifts, hiddenUids.length, sortMode]);

  const handleResetFilters = () => {
    setSearchQuery('');
    setDepartmentFilter('ALL');
    setOnlyWithShifts(false);
    setHiddenUids([]);
    setSortMode('name_asc');
  };

  const toggleStaffVisible = (uid: string) => {
    setHiddenUids((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]
    );
  };

  const handleShowAllStaff = () => setHiddenUids([]);

  const handleHideWithoutShifts = () => {
    const toHide = staffDirectory
      .filter((s) => {
        const dayMap = staffWeekMap.get(s.uid);
        if (!dayMap) return true;
        for (const items of dayMap.values()) {
          if (items.length > 0) return false;
        }
        return true;
      })
      .map((s) => s.uid);
    setHiddenUids(toHide);
  };

  const handleHideAllStaff = () => setHiddenUids(staffDirectory.map((s) => s.uid));

  const handleResetOrderAZ = () => {
    const az = [...staffDirectory]
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
      .map((s) => s.uid);
    setCustomOrder(az);
    setSortMode('name_asc');
  };

  const moveStaffOrder = (uid: string, direction: -1 | 1) => {
    const currentUids = orderedAllStaff.map((s) => s.uid);
    const idx = currentUids.indexOf(uid);
    if (idx === -1) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= currentUids.length) return;
    const next = [...currentUids];
    const [moved] = next.splice(idx, 1);
    next.splice(targetIdx, 0, moved);
    setCustomOrder(next);
    setSortMode('custom');
  };

  const handleSaveConfig = async () => {
    if (!canEdit) return;
    setSavingConfig(true);
    const orderToSave =
      sortMode === 'custom' && customOrder.length > 0
        ? customOrder
        : orderedAllStaff.map((s) => s.uid);
    try {
      await onSaveMatrixConfig({
        sortMode,
        customOrder: orderToSave,
        hiddenUids,
      });
    } finally {
      setSavingConfig(false);
    }
  };

  const handleCellClick = async (staff: ScheduleStaffMember, ymd: string) => {
    if (!canEdit) return;
    if (activeBrush === 'modal') {
      onOpenCreateModal(staff.uid, ymd);
      return;
    }

    const existingSameDay = staffWeekMap.get(staff.uid)?.get(ymd) || [];
    if (existingSameDay.some((s) => s.shiftType === activeBrush)) {
      onNotify(
        'error',
        `${staff.name} đã có ca "${getShiftMeta(activeBrush).shortLabel}" trong ngày ${formatViDate(
          ymd
        )}.`
      );
      return;
    }

    const cellKey = `${staff.uid}__${ymd}`;
    setBusyCellKey(cellKey);
    try {
      await onQuickCreateShift({
        staff,
        date: ymd,
        shiftType: activeBrush,
        isTrucDam: getShiftMeta(activeBrush).isOffDay ? false : brushTrucDam,
      });
    } finally {
      setBusyCellKey(null);
    }
  };

  const dailyTotals = useMemo(() => {
    return weekDays.map((d) => {
      const byShift: Partial<Record<ScheduleShiftCode, number>> = {};
      let trucDam = 0;
      for (const row of visibleRows) {
        const items = row.byDate.get(d.ymd) || [];
        for (const s of items) {
          byShift[s.shiftType] = (byShift[s.shiftType] || 0) + 1;
          if (!getShiftMeta(s.shiftType).isOffDay && s.isTrucDam) {
            trucDam += 1;
          }
        }
      }
      const shiftBreakdown = SHIFT_ORDER.filter((code) => (byShift[code] || 0) > 0).map(
        (code) => ({
          code,
          meta: getShiftMeta(code),
          count: byShift[code] || 0,
        })
      );
      return { ymd: d.ymd, shiftBreakdown, trucDam };
    });
  }, [weekDays, visibleRows]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          {/* Week navigation + Visible count */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onShiftWeek(-7)}
              className="min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>Tuần trước</span>
            </button>
            <button
              type="button"
              onClick={onGoCurrentWeek}
              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50"
            >
              Tuần này
            </button>
            <button
              type="button"
              onClick={() => onShiftWeek(7)}
              className="min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
            >
              <span>Tuần sau</span>
              <ChevronRight className="h-4 w-4" />
            </button>

            <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-xs font-bold font-mono text-slate-900 tabular-nums">
              {formatViDate(weekStart)} – {formatViDate(weekEnd)}
            </span>

            <span className="text-xs font-medium text-slate-600 tabular-nums">
              Hiển thị{' '}
              <strong className="text-slate-900">
                {visibleRows.length}/{staffDirectory.length}
              </strong>{' '}
              nhân sự
            </span>
          </div>

          {/* Export + Filter toggle */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFilterOpen((v) => !v)}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                filterOpen || activeFilterCount > 0
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Filter className="h-3.5 w-3.5" />
              <span>Bộ lọc</span>
              {activeFilterCount > 0 && (
                <span className="px-1.5 py-0.2 rounded bg-blue-600 text-white text-[10px] font-bold tabular-nums">
                  {activeFilterCount}
                </span>
              )}
              {filterOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Collapsible Filters & Staff Manager */}
        {filterOpen && (
          <div className="pt-3 border-t border-slate-200 space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="relative flex-1 min-w-[180px] max-w-xs">
                <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Tìm tên, chức vụ..."
                  className="w-full min-h-[38px] pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
              </div>

              <select
                value={departmentFilter}
                onChange={(e) => setDepartmentFilter(e.target.value)}
                className="min-h-[38px] px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">Tất cả bộ phận</option>
                {departmentOptions.map((dept) => (
                  <option key={dept} value={dept}>
                    {dept}
                  </option>
                ))}
              </select>

              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as ScheduleMatrixSortMode)}
                className="min-h-[38px] px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                aria-label="Sắp xếp nhân sự"
              >
                <option value="name_asc">Tên A → Z</option>
                <option value="name_desc">Tên Z → A</option>
                <option value="position_asc">Chức vụ A → Z</option>
                <option value="shifts_desc">Nhiều ca nhất</option>
                <option value="custom">Thứ tự tùy chỉnh</option>
              </select>

              <label className="min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 inline-flex items-center gap-2 text-xs text-slate-800 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={onlyWithShifts}
                  onChange={(e) => setOnlyWithShifts(e.target.checked)}
                  className="h-4 w-4 accent-blue-600 rounded"
                />
                <span>Chỉ hiện có ca tuần này</span>
              </label>

              <button
                type="button"
                onClick={() => setStaffManagerOpen((v) => !v)}
                className={`min-h-[38px] px-3 py-1.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 ${
                  staffManagerOpen
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-800'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>Ẩn/hiện &amp; Sắp xếp nhân sự</span>
              </button>

              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Đặt lại</span>
                </button>
              )}
            </div>

            {/* Expandable Staff Visibility & Reorder Panel */}
            {staffManagerOpen && (
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleShowAllStaff}
                      className="px-2.5 py-1 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1"
                    >
                      <Eye className="h-3.5 w-3.5 text-emerald-600" />
                      <span>Hiện tất cả</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleHideWithoutShifts}
                      className="px-2.5 py-1 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1"
                    >
                      <EyeOff className="h-3.5 w-3.5 text-amber-600" />
                      <span>Ẩn người chưa có ca</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleHideAllStaff}
                      className="px-2.5 py-1 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      Ẩn tất cả
                    </button>
                    <button
                      type="button"
                      onClick={handleResetOrderAZ}
                      className="px-2.5 py-1 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      Đặt lại thứ tự A–Z
                    </button>
                  </div>

                  {canEdit && (
                    <button
                      type="button"
                      disabled={savingConfig}
                      onClick={() => void handleSaveConfig()}
                      className="min-h-[34px] px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      <Save className="h-3.5 w-3.5" />
                      <span>
                        {savingConfig ? 'Đang lưu...' : 'Lưu & Đồng bộ toàn hệ thống'}
                      </span>
                    </button>
                  )}
                </div>

                {matrixConfig?.updatedByName && (
                  <p className="text-[11px] text-slate-500">
                    Cấu hình đồng bộ gần nhất bởi{' '}
                    <strong className="text-slate-700">
                      {matrixConfig.updatedByName}
                    </strong>
                  </p>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-60 overflow-y-auto pr-1">
                  {orderedAllStaff.map((staff, idx) => {
                    const isVisible = !hiddenSet.has(staff.uid);
                    return (
                      <div
                        key={staff.uid}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200"
                      >
                        <label className="flex items-center gap-2 min-w-0 cursor-pointer flex-1">
                          <input
                            type="checkbox"
                            checked={isVisible}
                            onChange={() => toggleStaffVisible(staff.uid)}
                            className="h-4 w-4 accent-blue-600 shrink-0"
                          />
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-900 truncate">
                              {staff.name}
                            </p>
                            <p className="text-[10px] text-slate-500 truncate">
                              {staff.department || 'Nhân viên'}
                            </p>
                          </div>
                        </label>
                        {canEdit && (
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveStaffOrder(staff.uid, -1)}
                              className="p-1 rounded text-slate-400 hover:text-slate-800 hover:bg-slate-100 disabled:opacity-30"
                              title="Đưa lên"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === orderedAllStaff.length - 1}
                              onClick={() => moveStaffOrder(staff.uid, 1)}
                              className="p-1 rounded text-slate-400 hover:text-slate-800 hover:bg-slate-100 disabled:opacity-30"
                              title="Đưa xuống"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick Brush Bar (edit / manage / admin) */}
      {canEdit && (
        <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveBrush('modal')}
            className={`min-h-[34px] px-2.5 py-1 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
              activeBrush === 'modal'
                ? 'bg-slate-900 border-slate-900 text-white'
                : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <MousePointerClick className="h-3.5 w-3.5" />
            <span>Mở khung nhập</span>
          </button>

          <div className="h-5 w-px bg-slate-200 mx-0.5 hidden sm:block" />

          {SHIFT_ORDER.map((code) => {
            const m = SHIFT_META[code];
            const isSelected = activeBrush === code;
            return (
              <button
                key={code}
                type="button"
                onClick={() => setActiveBrush(code)}
                className={`min-h-[34px] px-2.5 py-1 rounded-lg border text-xs font-semibold transition-all ${
                  isSelected
                    ? `${m.cardBgClass} ${m.cardBorderClass} ${m.cardTextClass} ring-2 ring-blue-500`
                    : `${m.cardBgClass} ${m.cardBorderClass} ${m.cardTextClass} opacity-80 hover:opacity-100`
                }`}
              >
                {m.shortLabel}
              </button>
            );
          })}

          <div className="h-5 w-px bg-slate-200 mx-0.5 hidden sm:block" />

          <button
            type="button"
            onClick={() => setBrushTrucDam((v) => !v)}
            className={`min-h-[34px] px-2.5 py-1 rounded-lg border text-xs font-semibold inline-flex items-center gap-1 transition-colors ${
              brushTrucDam
                ? 'bg-orange-600 border-orange-600 text-white shadow-xs'
                : 'bg-white border-orange-300 text-orange-700 hover:bg-orange-50'
            }`}
          >
            <Radio className="h-3.5 w-3.5" />
            <span>+ Trực đàm (TĐ)</span>
          </button>

          {activeBrush !== 'modal' && (
            <span className="text-[11px] text-blue-700 font-medium ml-auto">
              Đang bật gán nhanh: chạm vào ô ngày để gán {getShiftMeta(activeBrush).shortLabel}
              {brushTrucDam && !getShiftMeta(activeBrush).isOffDay ? ' + TĐ' : ''}
            </span>
          )}
        </div>
      )}

      {/* Matrix Table (Desktop md+) */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="h-14 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-700">
                    <th className="py-3 px-3.5 font-bold min-w-[190px] sticky left-0 bg-slate-50 z-10 border-r border-slate-200">
                      Họ và tên / Chức vụ
                    </th>
                    {weekDays.map((d) => {
                      const isToday = d.ymd === todayYmd;
                      return (
                        <th
                          key={d.ymd}
                          className={`py-2.5 px-2 text-center min-w-[132px] border-r last:border-r-0 border-slate-200 ${
                            isToday
                              ? 'bg-blue-50 text-blue-900'
                              : d.isWeekend
                                ? 'bg-amber-50/70 text-amber-900'
                                : ''
                          }`}
                        >
                          <div className="font-bold">
                            {d.weekday}
                            {isToday ? ' (Hôm nay)' : ''}
                          </div>
                          <div className="text-[11px] font-mono text-slate-500">
                            {d.ddMm}
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="py-12 px-4 text-center text-sm text-slate-500"
                      >
                        Không có nhân sự phù hợp bộ lọc hiện tại.
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((row, rowIdx) => (
                      <tr key={row.staff.uid} className="group hover:bg-slate-50/40">
                        <td className="py-2.5 px-3.5 sticky left-0 bg-white group-hover:bg-slate-50 z-10 border-r border-slate-200 align-top">
                          <div className="flex items-start justify-between gap-1.5">
                            <div className="min-w-0">
                              <p className="font-bold text-slate-900 truncate">
                                {row.staff.name}
                              </p>
                              <p className="text-[11px] text-slate-500 truncate">
                                {row.staff.department || 'Nhân viên'}
                              </p>
                            </div>
                            {canEdit && (
                              <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 shrink-0">
                                <button
                                  type="button"
                                  disabled={rowIdx === 0}
                                  onClick={() => moveStaffOrder(row.staff.uid, -1)}
                                  className="p-1 rounded text-slate-400 hover:text-slate-800 hover:bg-slate-200/70 disabled:opacity-20"
                                  title="Đưa lên"
                                >
                                  <ArrowUp className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  disabled={rowIdx === visibleRows.length - 1}
                                  onClick={() => moveStaffOrder(row.staff.uid, 1)}
                                  className="p-1 rounded text-slate-400 hover:text-slate-800 hover:bg-slate-200/70 disabled:opacity-20"
                                  title="Đưa xuống"
                                >
                                  <ArrowDown className="h-3 w-3" />
                                </button>
                              </div>
                            )}
                          </div>
                        </td>

                        {weekDays.map((d) => {
                          const items = row.byDate.get(d.ymd) || [];
                          const cellKey = `${row.staff.uid}__${d.ymd}`;
                          const isBusy = busyCellKey === cellKey;
                          const isToday = d.ymd === todayYmd;

                          return (
                            <td
                              key={d.ymd}
                              onClick={() => {
                                if (canEdit && activeBrush !== 'modal') {
                                  void handleCellClick(row.staff, d.ymd);
                                }
                              }}
                              className={`group/cell p-1.5 align-top border-r last:border-r-0 border-slate-200 transition-colors ${
                                isToday ? 'bg-blue-50/20' : d.isWeekend ? 'bg-amber-50/15' : ''
                              } ${
                                canEdit && activeBrush !== 'modal'
                                  ? 'cursor-pointer hover:bg-blue-50/50'
                                  : ''
                              }`}
                            >
                              <div className="space-y-1.5 min-h-[48px]">
                                {items.map((shift) => {
                                  const meta = getShiftMeta(shift.shiftType);
                                  return (
                                    <div
                                      key={shift.id}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (canEdit) onOpenEditModal(shift);
                                      }}
                                      className={`group/card relative rounded-md border px-2 py-1.5 transition-shadow ${
                                        meta.cardBgClass
                                      } ${meta.cardBorderClass} ${meta.cardTextClass} ${
                                        canEdit ? 'cursor-pointer hover:shadow-xs' : ''
                                      }`}
                                    >
                                      <div className="flex items-center justify-between gap-1">
                                        <span className="font-bold text-[11px] truncate">
                                          {meta.shortLabel}
                                        </span>
                                        <div className="flex items-center gap-1 shrink-0">
                                          {shift.isTrucDam && (
                                            <span className="px-1 py-0.2 rounded bg-orange-600 text-white text-[9px] font-bold">
                                              TĐ
                                            </span>
                                          )}
                                          {canDelete && (
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                void onQuickDeleteShift(shift);
                                              }}
                                              title="Xóa nhanh ca này"
                                              className="opacity-0 group-hover/card:opacity-100 h-4 w-4 rounded hover:bg-red-600 hover:text-white inline-flex items-center justify-center transition-opacity"
                                            >
                                              <X className="h-3 w-3" />
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                      <div className="text-[10px] font-mono opacity-85 tabular-nums">
                                        {meta.isOffDay
                                          ? 'Nghỉ'
                                          : `${shift.startTime}–${shift.endTime}`}
                                      </div>
                                      {shift.note && (
                                        <p className="mt-0.5 text-[10px] opacity-80 line-clamp-1">
                                          {shift.note}
                                        </p>
                                      )}
                                    </div>
                                  );
                                })}

                                {canEdit && (
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (activeBrush !== 'modal') {
                                        void handleCellClick(row.staff, d.ymd);
                                      } else {
                                        onOpenCreateModal(row.staff.uid, d.ymd);
                                      }
                                    }}
                                    className={`w-full py-1 rounded border border-dashed border-slate-300 text-[10px] font-medium text-slate-500 hover:text-blue-700 hover:border-blue-400 hover:bg-blue-50/70 inline-flex items-center justify-center gap-0.5 transition-opacity ${
                                      items.length === 0
                                        ? 'opacity-40 group-hover/cell:opacity-100'
                                        : 'opacity-0 group-hover/cell:opacity-100'
                                    }`}
                                  >
                                    <Plus className="h-3 w-3" />
                                    <span>{isBusy ? '...' : 'Thêm ca'}</span>
                                  </button>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-100 border-t-2 border-slate-200 text-[11px] font-semibold text-slate-700">
                    <td className="py-2.5 px-3.5 sticky left-0 bg-slate-100 z-10 border-r border-slate-200">
                      Tổng hợp ca trong ngày
                    </td>
                    {dailyTotals.map((sum) => (
                      <td
                        key={sum.ymd}
                        className="py-2 px-1.5 text-center border-r last:border-r-0 border-slate-200 align-top tabular-nums"
                      >
                        {sum.shiftBreakdown.length === 0 ? (
                          <span className="text-[11px] text-slate-400 font-normal">0 ca</span>
                        ) : (
                          <div className="flex flex-wrap items-center justify-center gap-1">
                            {sum.shiftBreakdown.map((item) => (
                              <span
                                key={item.code}
                                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${item.meta.badgeBgClass} ${item.meta.badgeTextClass} ${item.meta.cardBorderClass}`}
                                title={`${item.meta.label}: ${item.count} nhân sự`}
                              >
                                <span>{item.meta.shortLabel}:</span>
                                <strong>{item.count}</strong>
                              </span>
                            ))}
                            {sum.trucDam > 0 && (
                              <span
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-500 text-white"
                                title={`Trực đàm: ${sum.trucDam} nhân sự`}
                              >
                                TĐ: {sum.trucDam}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Mobile Vertical Day Cards (< md) */}
            <div className="md:hidden divide-y divide-slate-200">
              {weekDays.map((d, dIdx) => {
                const sum = dailyTotals[dIdx];
                const isToday = d.ymd === todayYmd;
                return (
                  <div key={d.ymd} className="p-3.5 space-y-2.5">
                    <div
                      className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg ${
                        isToday
                          ? 'bg-blue-50 text-blue-900'
                          : d.isWeekend
                            ? 'bg-amber-50 text-amber-900'
                            : 'bg-slate-100 text-slate-900'
                      }`}
                    >
                      <span className="text-xs font-bold">
                        {d.weekday} · {formatViDate(d.ymd)}
                        {isToday ? ' (Hôm nay)' : ''}
                      </span>
                      <div className="flex flex-wrap items-center gap-1 text-[10px] font-semibold tabular-nums">
                        {sum.shiftBreakdown.length === 0 ? (
                          <span className="text-slate-500 font-normal">0 ca</span>
                        ) : (
                          <>
                            {sum.shiftBreakdown.map((item) => (
                              <span
                                key={item.code}
                                className={`px-1.5 py-0.5 rounded ${item.meta.badgeBgClass} ${item.meta.badgeTextClass}`}
                              >
                                {item.meta.shortLabel}: {item.count}
                              </span>
                            ))}
                            {sum.trucDam > 0 && (
                              <span className="px-1.5 py-0.5 rounded bg-orange-500 text-white">
                                TĐ: {sum.trucDam}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {visibleRows.length === 0 ? (
                      <p className="text-xs text-slate-500 px-1">
                        Không có nhân sự phù hợp bộ lọc.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {visibleRows.map((row) => {
                          const items = row.byDate.get(d.ymd) || [];
                          return (
                            <div
                              key={`${d.ymd}_${row.staff.uid}`}
                              className="p-2.5 rounded-lg border border-slate-200 bg-white flex items-start justify-between gap-2"
                            >
                              <div className="min-w-0">
                                <p className="text-xs font-bold text-slate-900 truncate">
                                  {row.staff.name}
                                </p>
                                <p className="text-[11px] text-slate-500 truncate">
                                  {row.staff.department || 'Nhân viên'}
                                </p>
                              </div>

                              <div className="flex flex-wrap items-center justify-end gap-1.5">
                                {items.length === 0 ? (
                                  canEdit ? (
                                    <button
                                      type="button"
                                      onClick={() => void handleCellClick(row.staff, d.ymd)}
                                      className="px-2 py-1 rounded border border-dashed border-slate-300 text-[11px] text-slate-600 hover:text-blue-700"
                                    >
                                      + Thêm ca
                                    </button>
                                  ) : (
                                    <span className="text-xs text-slate-400">—</span>
                                  )
                                ) : (
                                  items.map((shift) => {
                                    const meta = getShiftMeta(shift.shiftType);
                                    return (
                                      <button
                                        key={shift.id}
                                        type="button"
                                        onClick={() => canEdit && onOpenEditModal(shift)}
                                        className={`px-2 py-1 rounded border text-[11px] font-semibold inline-flex items-center gap-1 ${meta.cardBgClass} ${meta.cardBorderClass} ${meta.cardTextClass}`}
                                      >
                                        <span>{meta.shortLabel}</span>
                                        {!meta.isOffDay && (
                                          <span className="font-mono text-[10px] opacity-80">
                                            {shift.startTime}–{shift.endTime}
                                          </span>
                                        )}
                                        {shift.isTrucDam && (
                                          <span className="px-1 rounded bg-orange-600 text-white text-[9px] font-bold">
                                            TĐ
                                          </span>
                                        )}
                                      </button>
                                    );
                                  })
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
