import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import {
  CalendarCheck2,
  CalendarPlus,
  ChevronDown,
  Download,
  FileSpreadsheet,
  ImageDown,
  LogIn,
  Plus,
} from 'lucide-react';
import { signInWithGmail } from '../lib/firebase';
import { emailToKey, normalizeEmail } from '../lib/permissions';
import { exportWeeklyMatrixToExcel, type MatrixExportRow } from '../lib/scheduleExport';
import {
  approveRegistrationsAndPublish,
  createOfficialWorkSchedule,
  createShiftRegistrationsBatch,
  deleteOfficialWorkSchedule,
  deleteShiftRegistration,
  rejectShiftRegistration,
  saveScheduleMatrixConfig,
  subscribeScheduleMatrixConfig,
  subscribeShiftRegistrations,
  subscribeWorkSchedules,
  updateOfficialWorkSchedule,
} from '../lib/scheduleFirestore';
import {
  canApproveWeekendOverQuotaDo,
  evaluateDoSubmission,
  formatViDate,
  formatYmd,
  getMondayOfWeek,
  getShiftMeta,
  getWeekDays,
} from '../lib/scheduleMeta';
import type {
  AuthenticatedUser,
  OfficialWorkSchedule,
  ScheduleMatrixConfig,
  ScheduleMatrixSortMode,
  SchedulePermissionLevel,
  ScheduleShiftCode,
  ScheduleStaffMember,
  ShiftRegistration,
} from '../types';
import { RegistrationTab } from './schedule/RegistrationTab';
import { ScheduleEditModal } from './schedule/ScheduleEditModal';
import { ScheduleExportModal } from './schedule/ScheduleExportModal';
import { WeeklyMatrixTab } from './schedule/WeeklyMatrixTab';

export interface ScheduleTeamMemberInput {
  uid?: string;
  email: string;
  displayName: string;
  department?: string;
}

interface WorkScheduleTabProps {
  currentUser: AuthenticatedUser;
  firebaseUser: FirebaseUser | null;
  scheduleLevel: SchedulePermissionLevel;
  canExport: boolean;
  departmentLabel: string;
  teamMembers?: ScheduleTeamMemberInput[];
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onExportLogged?: (fileName: string, count: number) => void;
  onScheduleActivity?: (
    action: 'create' | 'update' | 'delete' | 'approve' | 'export',
    targetId: string,
    summary: string
  ) => void;
}

type ScheduleSubTab = 'register' | 'matrix';

export function WorkScheduleTab({
  currentUser,
  firebaseUser,
  scheduleLevel,
  canExport,
  departmentLabel,
  teamMembers = [],
  onNotify,
  onExportLogged,
  onScheduleActivity,
}: WorkScheduleTabProps) {
  const [subTab, setSubTab] = useState<ScheduleSubTab>('matrix');
  const [signingInGoogle, setSigningInGoogle] = useState(false);

  // Realtime Firestore state
  const [registrations, setRegistrations] = useState<ShiftRegistration[]>([]);
  const [regsLoading, setRegsLoading] = useState(true);

  const [officialSchedules, setOfficialSchedules] = useState<OfficialWorkSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);

  const [matrixConfig, setMatrixConfig] = useState<ScheduleMatrixConfig | null>(null);

  // Week navigation shared across matrix & top header exports
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => getMondayOfWeek(new Date()));
  const weekDays = useMemo(() => getWeekDays(weekAnchor), [weekAnchor]);

  // Modal state
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<OfficialWorkSchedule | null>(null);
  const [presetStaffUid, setPresetStaffUid] = useState('');
  const [presetDate, setPresetDate] = useState(() => formatYmd(new Date()));
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [modalExportRows, setModalExportRows] = useState<MatrixExportRow[] | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const latestMatrixRowsRef = useRef<MatrixExportRow[] | null>(null);
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;

  useEffect(() => {
    if (!exportMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExportMenuOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [exportMenuOpen]);

  const canEdit = scheduleLevel !== 'view';
  const canManage = scheduleLevel === 'manage' || scheduleLevel === 'admin';
  const actorUid = firebaseUser?.uid || '';

  // Subscribe to shiftRegistrations, workSchedules, scheduleConfigs/weekly_matrix
  useEffect(() => {
    if (!firebaseUser) {
      setRegistrations([]);
      setOfficialSchedules([]);
      setMatrixConfig(null);
      setRegsLoading(false);
      setSchedulesLoading(false);
      return;
    }

    setRegsLoading(true);
    setSchedulesLoading(true);

    const unsubRegs = subscribeShiftRegistrations(
      firebaseUser.uid,
      canManage,
      (rows) => {
        setRegistrations(rows);
        setRegsLoading(false);
      },
      (err) => {
        setRegsLoading(false);
        onNotifyRef.current('error', `Không thể tải danh sách đăng ký ca: ${err.message}`);
      }
    );

    const unsubScheds = subscribeWorkSchedules(
      canEdit,
      (rows) => {
        setOfficialSchedules(rows);
        setSchedulesLoading(false);
      },
      (err) => {
        setSchedulesLoading(false);
        onNotifyRef.current('error', `Không thể tải lịch tuần chính thức: ${err.message}`);
      }
    );

    const unsubConfig = subscribeScheduleMatrixConfig(
      (cfg) => {
        setMatrixConfig(cfg);
      },
      () => {
        // Non-fatal: fallback to local config
      }
    );

    return () => {
      unsubRegs();
      unsubScheds();
      unsubConfig();
    };
  }, [firebaseUser, canManage, canEdit]);

  // Build unified staff directory (current user + schedules + registrations + teamMembers)
  const staffDirectory = useMemo<ScheduleStaffMember[]>(() => {
    const byUid = new Map<string, ScheduleStaffMember>();
    const knownNames = new Set<string>();
    const knownEmails = new Set<string>();

    if (firebaseUser) {
      const cleanName = currentUser.displayName.trim() || 'Nhân viên';
      byUid.set(firebaseUser.uid, {
        uid: firebaseUser.uid,
        name: cleanName,
        department: departmentLabel || 'Nhân viên',
        email: normalizeEmail(currentUser.email),
      });
      knownNames.add(cleanName.toLowerCase());
      if (currentUser.email) knownEmails.add(normalizeEmail(currentUser.email));
    }

    for (const s of officialSchedules) {
      if (!s.staffUid) continue;
      const existing = byUid.get(s.staffUid);
      if (!existing) {
        byUid.set(s.staffUid, {
          uid: s.staffUid,
          name: s.staffName || 'Nhân viên',
          department: s.department || 'Nhân viên',
        });
      } else {
        if (s.staffName && (!existing.name || existing.name === 'Nhân viên')) {
          existing.name = s.staffName;
        }
        if (s.department && existing.department === 'Nhân viên') {
          existing.department = s.department;
        }
      }
      if (s.staffName) knownNames.add(s.staffName.trim().toLowerCase());
    }

    for (const r of registrations) {
      if (!r.staffUid) continue;
      if (!byUid.has(r.staffUid)) {
        byUid.set(r.staffUid, {
          uid: r.staffUid,
          name: r.staffName || 'Nhân viên',
          department: r.department || 'Nhân viên',
        });
      }
      if (r.staffName) knownNames.add(r.staffName.trim().toLowerCase());
    }

    for (const tm of teamMembers) {
      const cleanEmail = normalizeEmail(tm.email);
      const cleanName = (tm.displayName || cleanEmail.split('@')[0] || 'Nhân viên').trim();
      if (cleanEmail && knownEmails.has(cleanEmail)) continue;
      if (knownNames.has(cleanName.toLowerCase())) continue;

      const candidateUid = tm.uid && /^[a-zA-Z0-9_-]+$/.test(tm.uid)
        ? tm.uid
        : emailToKey(cleanEmail || cleanName);
      if (!byUid.has(candidateUid)) {
        byUid.set(candidateUid, {
          uid: candidateUid,
          name: cleanName,
          department: tm.department || 'Nhân viên',
          email: cleanEmail,
        });
        if (cleanEmail) knownEmails.add(cleanEmail);
        knownNames.add(cleanName.toLowerCase());
      }
    }

    return Array.from(byUid.values()).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }, [
    firebaseUser,
    currentUser.displayName,
    currentUser.email,
    departmentLabel,
    officialSchedules,
    registrations,
    teamMembers,
  ]);

  // Fallback matrix rows when exporting from Tab 1 or before Tab 2 refines filters
  const defaultMatrixRows = useMemo<MatrixExportRow[]>(() => {
    const weekStart = weekDays[0].ymd;
    const weekEnd = weekDays[6].ymd;
    const weekScheds = officialSchedules.filter(
      (s) => s.date >= weekStart && s.date <= weekEnd
    );
    const map = new Map<string, Map<string, OfficialWorkSchedule[]>>();
    for (const s of weekScheds) {
      let dMap = map.get(s.staffUid);
      if (!dMap) {
        dMap = new Map();
        map.set(s.staffUid, dMap);
      }
      const arr = dMap.get(s.date) || [];
      arr.push(s);
      arr.sort((a, b) => a.startTime.localeCompare(b.startTime));
      dMap.set(s.date, arr);
    }

    const hiddenSet = new Set(matrixConfig?.hiddenUids || []);
    const customOrder = matrixConfig?.customOrder || [];
    const orderIdx = new Map<string, number>();
    customOrder.forEach((uid, i) => orderIdx.set(uid, i));
    const sortMode = matrixConfig?.sortMode || 'name_asc';

    const list = staffDirectory.filter((st) => !hiddenSet.has(st.uid));
    list.sort((a, b) => {
      if (sortMode === 'custom') {
        const ia = orderIdx.get(a.uid);
        const ib = orderIdx.get(b.uid);
        if (ia !== undefined && ib !== undefined) return ia - ib;
        if (ia !== undefined) return -1;
        if (ib !== undefined) return 1;
      }
      if (sortMode === 'name_desc') return b.name.localeCompare(a.name, 'vi');
      if (sortMode === 'position_asc') {
        const cmp = (a.department || '').localeCompare(b.department || '', 'vi');
        if (cmp !== 0) return cmp;
      }
      return a.name.localeCompare(b.name, 'vi');
    });

    return list.map((staff) => ({
      staff,
      byDate: map.get(staff.uid) || new Map<string, OfficialWorkSchedule[]>(),
    }));
  }, [weekDays, officialSchedules, matrixConfig, staffDirectory]);

  const getCurrentExportRows = useCallback(() => {
    if (subTab === 'matrix' && latestMatrixRowsRef.current) {
      return latestMatrixRowsRef.current;
    }
    return defaultMatrixRows;
  }, [subTab, defaultMatrixRows]);

  // Handlers
  const handleConnectGoogleAuth = async () => {
    setSigningInGoogle(true);
    try {
      await signInWithGmail();
      onNotify('success', 'Đã kết nối Google Auth & Firestore realtime.');
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Không thể đăng nhập Google Auth.'
      );
    } finally {
      setSigningInGoogle(false);
    }
  };

  const handleSubmitRegistration = useCallback(
    async (payload: { shiftType: ScheduleShiftCode; dates: string[]; note: string }) => {
      if (!firebaseUser) return;
      // Validate weekday DO quota cleanly before batch write
      if (payload.shiftType === 'do') {
        for (let i = 0; i < payload.dates.length; i++) {
          const dt = payload.dates[i];
          const extra = payload.dates.slice(0, i);
          const check = evaluateDoSubmission(registrations, officialSchedules, dt, extra);
          if (!check.allowed) {
            onNotify('error', check.message);
            return;
          }
        }
      }

      await createShiftRegistrationsBatch({
        staffUid: firebaseUser.uid,
        staffName: currentUser.displayName || 'Nhân viên',
        department: departmentLabel || 'Nhân viên',
        shiftType: payload.shiftType,
        dates: payload.dates,
        note: payload.note,
      });

      const meta = getShiftMeta(payload.shiftType);
      onScheduleActivity?.(
        'create',
        payload.dates.join(','),
        `Đăng ký ${meta.label} (${payload.dates.map(formatViDate).join(', ')})`
      );
      onNotify(
        'success',
        `Đã gửi đăng ký ${meta.shortLabel} cho ${payload.dates.length} ngày.`
      );
    },
    [
      firebaseUser,
      registrations,
      officialSchedules,
      currentUser.displayName,
      departmentLabel,
      onScheduleActivity,
      onNotify,
    ]
  );

  const handleApproveOne = useCallback(
    async (reg: ShiftRegistration) => {
      if (!canManage) return;
      if (!canApproveWeekendOverQuotaDo(scheduleLevel, reg, registrations, officialSchedules)) {
        onNotify(
          'error',
          'Trường hợp nghỉ DO cuối tuần vượt định mức 1 người/tuần chỉ Quản trị (Admin) mới được phê duyệt.'
        );
        return;
      }
      await approveRegistrationsAndPublish([reg], actorUid ? [actorUid] : []);
      onScheduleActivity?.(
        'approve',
        reg.id,
        `Duyệt đăng ký ${getShiftMeta(reg.shiftType).shortLabel} của ${reg.staffName} (${formatViDate(
          reg.date
        )})`
      );
      onNotify('success', `Đã duyệt & phát hành ca của ${reg.staffName}.`);
    },
    [canManage, scheduleLevel, registrations, officialSchedules, actorUid, onScheduleActivity, onNotify]
  );

  const handleApproveAll = useCallback(
    async (regs: ShiftRegistration[]) => {
      if (!canManage || regs.length === 0) return;
      const eligible = regs.filter((r) =>
        canApproveWeekendOverQuotaDo(scheduleLevel, r, registrations, officialSchedules)
      );
      if (eligible.length === 0) {
        onNotify(
          'info',
          'Không có đăng ký hợp lệ để duyệt (các ca DO cuối tuần vượt định mức cần Quản trị duyệt).'
        );
        return;
      }
      await approveRegistrationsAndPublish(eligible, actorUid ? [actorUid] : []);
      const skipped = regs.length - eligible.length;
      onScheduleActivity?.(
        'approve',
        `bulk-${eligible.length}`,
        `Duyệt hàng loạt ${eligible.length} đăng ký ca làm`
      );
      onNotify(
        'success',
        skipped > 0
          ? `Đã duyệt ${eligible.length} đăng ký (giữ lại ${skipped} ca DO cuối tuần chờ Quản trị).`
          : `Đã duyệt tất cả ${eligible.length} đăng ký và cập nhật vào lịch tuần.`
      );
    },
    [canManage, scheduleLevel, registrations, officialSchedules, actorUid, onScheduleActivity, onNotify]
  );

  const handleRejectOne = useCallback(
    async (reg: ShiftRegistration) => {
      if (!canManage) return;
      await rejectShiftRegistration(reg.id);
      onScheduleActivity?.(
        'update',
        reg.id,
        `Từ chối đăng ký của ${reg.staffName} (${formatViDate(reg.date)})`
      );
      onNotify('info', `Đã từ chối đăng ký ngày ${formatViDate(reg.date)} của ${reg.staffName}.`);
    },
    [canManage, onScheduleActivity, onNotify]
  );

  const handleDeleteRegistration = useCallback(
    async (reg: ShiftRegistration) => {
      await deleteShiftRegistration(reg.id);
      onScheduleActivity?.(
        'delete',
        reg.id,
        `Xóa đăng ký ca của ${reg.staffName} (${formatViDate(reg.date)})`
      );
      onNotify('info', `Đã xóa đăng ký ngày ${formatViDate(reg.date)}.`);
    },
    [onScheduleActivity, onNotify]
  );

  const handleOpenCreateModal = useCallback(
    (staffUid = '', date = '') => {
      if (!canEdit) return;
      setEditingSchedule(null);
      setPresetStaffUid(staffUid || actorUid || staffDirectory[0]?.uid || '');
      setPresetDate(date || formatYmd(new Date()));
      setEditModalOpen(true);
    },
    [canEdit, actorUid, staffDirectory]
  );

  const handleOpenEditModal = useCallback(
    (schedule: OfficialWorkSchedule) => {
      if (!canEdit) return;
      setEditingSchedule(schedule);
      setEditModalOpen(true);
    },
    [canEdit]
  );

  const handleSaveOfficialModal = useCallback(
    async (payload: {
      scheduleId?: string;
      staffUid: string;
      staffName: string;
      department: string;
      date: string;
      shiftType: ScheduleShiftCode;
      startTime: string;
      endTime: string;
      isTrucDam: boolean;
      note: string;
    }) => {
      if (!canEdit) return;
      if (payload.scheduleId) {
        await updateOfficialWorkSchedule(payload.scheduleId, {
          ...payload,
          memberUids: actorUid ? [actorUid] : [],
        });
        onScheduleActivity?.(
          'update',
          payload.scheduleId,
          `Cập nhật ca ${getShiftMeta(payload.shiftType).shortLabel} cho ${payload.staffName} (${formatViDate(
            payload.date
          )})`
        );
        onNotify('success', `Đã cập nhật lịch cho ${payload.staffName}.`);
      } else {
        await createOfficialWorkSchedule({
          ...payload,
          memberUids: actorUid ? [actorUid] : [],
        });
        onScheduleActivity?.(
          'create',
          `${payload.staffUid}_${payload.date}`,
          `Phân công ca ${getShiftMeta(payload.shiftType).shortLabel} cho ${payload.staffName} (${formatViDate(
            payload.date
          )})`
        );
        onNotify('success', `Đã phân công ca cho ${payload.staffName}.`);
      }
    },
    [canEdit, actorUid, onScheduleActivity, onNotify]
  );

  const handleQuickCreateShift = useCallback(
    async (params: {
      staff: ScheduleStaffMember;
      date: string;
      shiftType: ScheduleShiftCode;
      isTrucDam: boolean;
    }) => {
      if (!canEdit) return;
      const meta = getShiftMeta(params.shiftType);
      await createOfficialWorkSchedule({
        staffUid: params.staff.uid,
        staffName: params.staff.name,
        department: params.staff.department || 'Nhân viên',
        date: params.date,
        shiftType: params.shiftType,
        startTime: meta.startTime,
        endTime: meta.endTime,
        isTrucDam: meta.isOffDay ? false : params.isTrucDam,
        note: '',
        memberUids: actorUid ? [actorUid] : [],
      });
      onScheduleActivity?.(
        'create',
        `${params.staff.uid}_${params.date}`,
        `Gán nhanh ca ${meta.shortLabel} cho ${params.staff.name} (${formatViDate(params.date)})`
      );
      onNotify(
        'success',
        `Đã gán nhanh ${meta.shortLabel}${
          params.isTrucDam && !meta.isOffDay ? ' (TĐ)' : ''
        } cho ${params.staff.name}.`
      );
    },
    [canEdit, actorUid, onScheduleActivity, onNotify]
  );

  const handleDeleteOfficialShift = useCallback(
    async (schedule: OfficialWorkSchedule) => {
      if (!canManage) return;
      await deleteOfficialWorkSchedule(schedule.id);
      onScheduleActivity?.(
        'delete',
        schedule.id,
        `Xóa ca ${getShiftMeta(schedule.shiftType).shortLabel} của ${schedule.staffName} (${formatViDate(
          schedule.date
        )})`
      );
      onNotify(
        'info',
        `Đã xóa ca ${getShiftMeta(schedule.shiftType).shortLabel} ngày ${formatViDate(
          schedule.date
        )}.`
      );
    },
    [canManage, onScheduleActivity, onNotify]
  );

  const handleSaveMatrixConfig = useCallback(
    async (params: {
      sortMode: ScheduleMatrixSortMode;
      customOrder: string[];
      hiddenUids: string[];
    }) => {
      if (!canEdit) return;
      try {
        localStorage.setItem('tpcn_schedule_matrix_config_cache', JSON.stringify(params));
      } catch {
        // Ignore storage errors
      }
      await saveScheduleMatrixConfig({
        ...params,
        memberUids: actorUid ? [actorUid] : [],
        updatedByName: currentUser.displayName || 'Quản lý',
      });
      onScheduleActivity?.(
        'update',
        'weekly_matrix',
        `Đồng bộ cấu hình hiển thị/sắp xếp bảng lịch tuần`
      );
      onNotify('success', 'Đã lưu và đồng bộ cấu hình nhân sự lên hệ thống.');
    },
    [canEdit, actorUid, currentUser.displayName, onScheduleActivity, onNotify]
  );

  const handleExportExcel = useCallback(
    async (rows: MatrixExportRow[]) => {
      if (!canExport) return;
      try {
        const res = await exportWeeklyMatrixToExcel({ rows, weekDays });
        onExportLogged?.(res.fileName, res.rowCount);
        onScheduleActivity?.('export', res.fileName, `Xuất Excel lịch tuần (${res.rowCount} dòng)`);
        onNotify('success', `Đã xuất file Excel "${res.fileName}".`);
      } catch (err) {
        onNotify(
          'error',
          err instanceof Error ? err.message : 'Không thể xuất file Excel lịch tuần.'
        );
      }
    },
    [canExport, weekDays, onExportLogged, onScheduleActivity, onNotify]
  );

  const pendingCount = useMemo(
    () => registrations.filter((r) => r.status === 'pending').length,
    [registrations]
  );

  if (!firebaseUser) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 text-center max-w-xl mx-auto space-y-4">
        <div className="h-12 w-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
          <CalendarCheck2 className="h-6 w-6" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold text-slate-900">
            Kết nối Google Auth để đồng bộ Lịch làm việc realtime
          </h2>
          <p className="text-sm text-slate-600 leading-relaxed">
            Phân hệ Lịch làm việc sử dụng Firebase Firestore &amp; Google Auth để đồng bộ đăng ký ca,
            định mức ngày nghỉ DO và bảng phân công tuần theo thời gian thực.
          </p>
        </div>
        <button
          type="button"
          disabled={signingInGoogle}
          onClick={() => void handleConnectGoogleAuth()}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          <LogIn className="h-4 w-4" />
          <span>{signingInGoogle ? 'Đang kết nối...' : 'Đăng nhập Google để mở Lịch làm việc'}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5 font-[Roboto,sans-serif]">
      {/* Top Action Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">
              Đồng bộ trực tuyến Firestore · <strong className="text-slate-700">{currentUser.displayName}</strong>
            </span>
          </div>

          {/* Segmented Sub-Tab Switch */}
          <div className="inline-flex p-1 rounded-xl bg-slate-100 border border-slate-200 gap-1">
            <button
              type="button"
              onClick={() => {
                latestMatrixRowsRef.current = null;
                setSubTab('register');
              }}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 transition-all ${
                subTab === 'register'
                  ? 'bg-white text-blue-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <CalendarPlus className="h-4 w-4" />
              <span>Đăng ký lịch làm việc</span>
              {pendingCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold tabular-nums">
                  {pendingCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setSubTab('matrix')}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 transition-all ${
                subTab === 'matrix'
                  ? 'bg-white text-blue-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <CalendarCheck2 className="h-4 w-4" />
              <span>Tổng hợp &amp; Lịch tuần chính thức</span>
            </button>
          </div>
        </div>

        {/* Global Action Buttons */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {canExport && (
            <div ref={exportMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setExportMenuOpen((v) => !v)}
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
                aria-expanded={exportMenuOpen}
                aria-haspopup="menu"
              >
                <Download className="h-4 w-4 text-blue-600" />
                <span>Xuất lịch</span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>

              {exportMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-1.5 w-52 bg-white border border-slate-200 rounded-xl shadow-lg py-1.5 z-30"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setExportMenuOpen(false);
                      setModalExportRows(getCurrentExportRows());
                      setExportModalOpen(true);
                    }}
                    className="w-full px-3.5 py-2 text-left text-xs sm:text-sm text-slate-700 hover:bg-slate-50 inline-flex items-center gap-2"
                  >
                    <ImageDown className="h-4 w-4 text-blue-600 shrink-0" />
                    <span>Xuất ảnh lịch làm việc</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={defaultMatrixRows.length === 0}
                    onClick={() => {
                      setExportMenuOpen(false);
                      void handleExportExcel(getCurrentExportRows());
                    }}
                    className="w-full px-3.5 py-2 text-left text-xs sm:text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-2"
                  >
                    <FileSpreadsheet className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Xuất lịch tuần Excel</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {canEdit && (
            <button
              type="button"
              onClick={() => handleOpenCreateModal()}
              className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs sm:text-sm font-medium hover:bg-blue-700 inline-flex items-center gap-1.5"
            >
              <Plus className="h-4 w-4" />
              <span>Phân công ca</span>
            </button>
          )}
        </div>
      </div>

      {/* Active Sub-Tab Body */}
      {subTab === 'register' ? (
        <RegistrationTab
          currentUid={firebaseUser.uid}
          currentName={currentUser.displayName || 'Nhân viên'}
          currentDepartment={departmentLabel || 'Nhân viên'}
          scheduleLevel={scheduleLevel}
          registrations={registrations}
          officialSchedules={officialSchedules}
          loading={regsLoading}
          onSubmitRegistration={handleSubmitRegistration}
          onApproveOne={handleApproveOne}
          onApproveAll={handleApproveAll}
          onRejectOne={handleRejectOne}
          onDeleteOne={handleDeleteRegistration}
          onNotify={onNotify}
        />
      ) : (
        <WeeklyMatrixTab
          weekDays={weekDays}
          staffDirectory={staffDirectory}
          schedules={officialSchedules}
          matrixConfig={matrixConfig}
          scheduleLevel={scheduleLevel}
          loading={schedulesLoading}
          onShiftWeek={(deltaDays) => {
            setWeekAnchor((prev) => {
              const next = new Date(prev);
              next.setDate(next.getDate() + deltaDays);
              return getMondayOfWeek(next);
            });
          }}
          onGoCurrentWeek={() => setWeekAnchor(getMondayOfWeek(new Date()))}
          onOpenCreateModal={(uid, date) => handleOpenCreateModal(uid, date)}
          onOpenEditModal={handleOpenEditModal}
          onQuickCreateShift={handleQuickCreateShift}
          onQuickDeleteShift={handleDeleteOfficialShift}
          onSaveMatrixConfig={handleSaveMatrixConfig}
          onVisibleRowsChange={(rows) => {
            latestMatrixRowsRef.current = rows;
          }}
          onNotify={onNotify}
        />
      )}

      {/* Create / Edit Official Shift Modal */}
      <ScheduleEditModal
        open={editModalOpen}
        editingSchedule={editingSchedule}
        presetStaffUid={presetStaffUid}
        presetDate={presetDate}
        staffList={staffDirectory}
        existingSchedules={officialSchedules}
        canDelete={canManage}
        onClose={() => {
          setEditModalOpen(false);
          setEditingSchedule(null);
        }}
        onSave={handleSaveOfficialModal}
        onDelete={handleDeleteOfficialShift}
        onNotify={onNotify}
      />

      {/* Export PNG Modal (Desktop / Mobile layouts + Share) */}
      <ScheduleExportModal
        open={exportModalOpen}
        onClose={() => {
          setExportModalOpen(false);
          setModalExportRows(null);
        }}
        rows={modalExportRows || defaultMatrixRows}
        weekDays={weekDays}
        onNotify={onNotify}
        onExportLogged={(fileName, count) => {
          onExportLogged?.(fileName, count);
          onScheduleActivity?.('export', fileName, `Xuất ảnh PNG lịch tuần (${count} nhân sự)`);
        }}
      />
    </div>
  );
}
