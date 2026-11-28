import type {
  EffectivePermissions,
  OfficialWorkSchedule,
  SchedulePermissionLevel,
  ScheduleShiftCode,
  ShiftRegistration,
} from '../types';

export interface ShiftMetaEntry {
  code: ScheduleShiftCode;
  label: string;
  shortLabel: string;
  startTime: string;
  endTime: string;
  isOffDay: boolean;
  sortOrder: number;
  // Tailwind classes for cards & badges
  cardBgClass: string;
  cardBorderClass: string;
  cardTextClass: string;
  badgeBgClass: string;
  badgeTextClass: string;
  // Hex colors for Canvas PNG export
  hexBg: string;
  hexBorder: string;
  hexText: string;
  hexAccent: string;
}

export const SHIFT_ORDER: ScheduleShiftCode[] = [
  'ca_sang',
  'hanh_chinh',
  'ca_chieu',
  'parttime_1700',
  'parttime_1730',
  'parttime_1800',
  'do',
  'al',
  'ph',
  'nb',
];

export const SHIFT_META: Record<ScheduleShiftCode, ShiftMetaEntry> = {
  ca_sang: {
    code: 'ca_sang',
    label: 'Ca sáng',
    shortLabel: 'Sáng',
    startTime: '07:00',
    endTime: '15:00',
    isOffDay: false,
    sortOrder: 1,
    cardBgClass: 'bg-sky-50',
    cardBorderClass: 'border-sky-200',
    cardTextClass: 'text-sky-900',
    badgeBgClass: 'bg-sky-100',
    badgeTextClass: 'text-sky-800',
    hexBg: '#F0F9FF',
    hexBorder: '#BAE6FD',
    hexText: '#0C4A6E',
    hexAccent: '#0284C7',
  },
  hanh_chinh: {
    code: 'hanh_chinh',
    label: 'Ca hành chính',
    shortLabel: 'HC',
    startTime: '08:00',
    endTime: '16:00',
    isOffDay: false,
    sortOrder: 2,
    cardBgClass: 'bg-indigo-50',
    cardBorderClass: 'border-indigo-200',
    cardTextClass: 'text-indigo-900',
    badgeBgClass: 'bg-indigo-100',
    badgeTextClass: 'text-indigo-800',
    hexBg: '#EEF2FF',
    hexBorder: '#C7D2FE',
    hexText: '#312E81',
    hexAccent: '#4F46E5',
  },
  ca_chieu: {
    code: 'ca_chieu',
    label: 'Ca chiều',
    shortLabel: 'Chiều',
    startTime: '14:30',
    endTime: '22:30',
    isOffDay: false,
    sortOrder: 3,
    cardBgClass: 'bg-amber-50',
    cardBorderClass: 'border-amber-200',
    cardTextClass: 'text-amber-900',
    badgeBgClass: 'bg-amber-100',
    badgeTextClass: 'text-amber-800',
    hexBg: '#FFFBEB',
    hexBorder: '#FDE68A',
    hexText: '#78350F',
    hexAccent: '#D97706',
  },
  parttime_1700: {
    code: 'parttime_1700',
    label: 'Ca Parttime 17:00',
    shortLabel: 'PT 17:00',
    startTime: '17:00',
    endTime: '22:30',
    isOffDay: false,
    sortOrder: 4,
    cardBgClass: 'bg-teal-50',
    cardBorderClass: 'border-teal-200',
    cardTextClass: 'text-teal-900',
    badgeBgClass: 'bg-teal-100',
    badgeTextClass: 'text-teal-800',
    hexBg: '#F0FDFA',
    hexBorder: '#99F6E4',
    hexText: '#134E4A',
    hexAccent: '#0D9488',
  },
  parttime_1730: {
    code: 'parttime_1730',
    label: 'Ca Parttime 17:30',
    shortLabel: 'PT 17:30',
    startTime: '17:30',
    endTime: '22:30',
    isOffDay: false,
    sortOrder: 5,
    cardBgClass: 'bg-teal-50',
    cardBorderClass: 'border-teal-200',
    cardTextClass: 'text-teal-900',
    badgeBgClass: 'bg-teal-100',
    badgeTextClass: 'text-teal-800',
    hexBg: '#F0FDFA',
    hexBorder: '#99F6E4',
    hexText: '#134E4A',
    hexAccent: '#0D9488',
  },
  parttime_1800: {
    code: 'parttime_1800',
    label: 'Ca Parttime 18:00',
    shortLabel: 'PT 18:00',
    startTime: '18:00',
    endTime: '22:30',
    isOffDay: false,
    sortOrder: 6,
    cardBgClass: 'bg-teal-50',
    cardBorderClass: 'border-teal-200',
    cardTextClass: 'text-teal-900',
    badgeBgClass: 'bg-teal-100',
    badgeTextClass: 'text-teal-800',
    hexBg: '#F0FDFA',
    hexBorder: '#99F6E4',
    hexText: '#134E4A',
    hexAccent: '#0D9488',
  },
  do: {
    code: 'do',
    label: 'Nghỉ DO (Day Off)',
    shortLabel: 'DO',
    startTime: '00:00',
    endTime: '00:00',
    isOffDay: true,
    sortOrder: 7,
    cardBgClass: 'bg-slate-100',
    cardBorderClass: 'border-slate-300',
    cardTextClass: 'text-slate-800',
    badgeBgClass: 'bg-slate-200',
    badgeTextClass: 'text-slate-700',
    hexBg: '#F1F5F9',
    hexBorder: '#CBD5E1',
    hexText: '#1E293B',
    hexAccent: '#475569',
  },
  al: {
    code: 'al',
    label: 'Nghỉ phép năm (AL)',
    shortLabel: 'AL',
    startTime: '00:00',
    endTime: '00:00',
    isOffDay: true,
    sortOrder: 8,
    cardBgClass: 'bg-rose-50',
    cardBorderClass: 'border-rose-200',
    cardTextClass: 'text-rose-900',
    badgeBgClass: 'bg-rose-100',
    badgeTextClass: 'text-rose-800',
    hexBg: '#FFF1F2',
    hexBorder: '#FECDD3',
    hexText: '#881337',
    hexAccent: '#E11D48',
  },
  ph: {
    code: 'ph',
    label: 'Nghỉ lễ (PH)',
    shortLabel: 'PH',
    startTime: '00:00',
    endTime: '00:00',
    isOffDay: true,
    sortOrder: 9,
    cardBgClass: 'bg-violet-50',
    cardBorderClass: 'border-violet-200',
    cardTextClass: 'text-violet-900',
    badgeBgClass: 'bg-violet-100',
    badgeTextClass: 'text-violet-800',
    hexBg: '#F5F3FF',
    hexBorder: '#DDD6FE',
    hexText: '#4C1D95',
    hexAccent: '#7C3AED',
  },
  nb: {
    code: 'nb',
    label: 'Nghỉ bù (NB)',
    shortLabel: 'NB',
    startTime: '00:00',
    endTime: '00:00',
    isOffDay: true,
    sortOrder: 10,
    cardBgClass: 'bg-emerald-50',
    cardBorderClass: 'border-emerald-200',
    cardTextClass: 'text-emerald-900',
    badgeBgClass: 'bg-emerald-100',
    badgeTextClass: 'text-emerald-800',
    hexBg: '#ECFDF5',
    hexBorder: '#A7F3D0',
    hexText: '#064E3B',
    hexAccent: '#059669',
  },
};

export const WEEKDAY_LABELS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'] as const;

export interface WeekDayInfo {
  ymd: string;
  weekday: string;
  dayNum: number;
  monthNum: number;
  ddMm: string;
  isWeekend: boolean;
  dayIndex: number; // 0=Mon..6=Sun
}

export function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return new Date();
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

export function formatViDate(ymdOrIso: string | null | undefined): string {
  if (!ymdOrIso) return '—';
  const raw = String(ymdOrIso).trim();
  if (!raw) return '—';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return raw;
  const datePart = raw.length >= 10 ? raw.slice(0, 10) : raw;
  const parts = datePart.split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    return `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
  }
  const dt = new Date(raw);
  if (!Number.isNaN(dt.getTime())) {
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  return raw;
}

export function formatViDateTime(
  iso: string | Date | null | undefined,
  includeSeconds = true
): string {
  if (!iso) return '—';
  const dt = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(dt.getTime())) return typeof iso === 'string' ? iso : '—';
  const hh = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  const ss = String(dt.getSeconds()).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return includeSeconds
    ? `${hh}:${min}:${ss} · ${dd}/${mm}/${yyyy}`
    : `${hh}:${min} · ${dd}/${mm}/${yyyy}`;
}

export function formatRegisteredTimestamp(iso: string | null): string {
  if (!iso) return 'Vừa gửi';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  const hh = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${hh}:${min} · ${dd}/${mm}/${yyyy}`;
}

export function getMondayOfWeek(base: Date | string): Date {
  const d = typeof base === 'string' ? parseYmd(base) : new Date(base);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function getWeekDays(anchorMonday: Date): WeekDayInfo[] {
  const mon = getMondayOfWeek(anchorMonday);
  return Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(mon);
    dt.setDate(dt.getDate() + i);
    const dayNum = dt.getDate();
    const monthNum = dt.getMonth() + 1;
    return {
      ymd: formatYmd(dt),
      weekday: WEEKDAY_LABELS[i],
      dayNum,
      monthNum,
      ddMm: `${String(dayNum).padStart(2, '0')}/${String(monthNum).padStart(2, '0')}`,
      isWeekend: i >= 5,
      dayIndex: i,
    };
  });
}

export function isWeekendYmd(ymd: string): boolean {
  const dow = parseYmd(ymd).getDay();
  return dow === 0 || dow === 6;
}

export function getWeekBoundsYmd(ymd: string): { mon: string; sun: string } {
  const mon = getMondayOfWeek(ymd);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  return { mon: formatYmd(mon), sun: formatYmd(sun) };
}

export function isValidScheduleShiftCode(val: unknown): val is ScheduleShiftCode {
  return typeof val === 'string' && val in SHIFT_META;
}

export function getShiftMeta(code: ScheduleShiftCode): ShiftMetaEntry {
  return SHIFT_META[code] || SHIFT_META.ca_sang;
}

export function countPersonalWeekRegistrations(
  registrations: ShiftRegistration[],
  staffUid: string,
  targetYmd: string
): ShiftRegistration[] {
  const { mon, sun } = getWeekBoundsYmd(targetYmd);
  return registrations.filter(
    (r) =>
      r.staffUid === staffUid &&
      r.status !== 'rejected' &&
      r.date >= mon &&
      r.date <= sun
  );
}

export interface WeekDoSummary {
  weekStart: string;
  weekEnd: string;
  byDateCount: Record<string, number>;
  weekendTotal: number;
}

/**
 * Computes combined DO counts per date and weekend total for a given week,
 * merging non-rejected shiftRegistrations + published/active workSchedules
 * without double-counting approved registrations already linked to a schedule.
 */
export function computeWeekDoSummary(
  registrations: ShiftRegistration[],
  schedules: OfficialWorkSchedule[],
  weekAnchorYmd: string
): WeekDoSummary {
  const days = getWeekDays(getMondayOfWeek(weekAnchorYmd));
  const weekStart = days[0].ymd;
  const weekEnd = days[6].ymd;

  const byDateCount: Record<string, number> = {};
  for (const d of days) {
    byDateCount[d.ymd] = 0;
  }

  const seenStaffDate = new Set<string>();

  for (const s of schedules) {
    if (s.shiftType !== 'do') continue;
    if (s.date < weekStart || s.date > weekEnd) continue;
    const key = `${s.staffUid}__${s.date}`;
    if (seenStaffDate.has(key)) continue;
    seenStaffDate.add(key);
    byDateCount[s.date] = (byDateCount[s.date] || 0) + 1;
  }

  for (const r of registrations) {
    if (r.shiftType !== 'do' || r.status === 'rejected') continue;
    if (r.date < weekStart || r.date > weekEnd) continue;
    const key = `${r.staffUid}__${r.date}`;
    if (seenStaffDate.has(key)) continue;
    seenStaffDate.add(key);
    byDateCount[r.date] = (byDateCount[r.date] || 0) + 1;
  }

  const satYmd = days[5].ymd;
  const sunYmd = days[6].ymd;
  const weekendTotal = (byDateCount[satYmd] || 0) + (byDateCount[sunYmd] || 0);

  return {
    weekStart,
    weekEnd,
    byDateCount,
    weekendTotal,
  };
}

export interface DoQuotaEvaluation {
  allowed: boolean;
  level: 'ok' | 'warning_admin' | 'blocked';
  message: string;
}

export function evaluateDoSubmission(
  registrations: ShiftRegistration[],
  schedules: OfficialWorkSchedule[],
  targetYmd: string,
  extraSameWeekDates: string[] = []
): DoQuotaEvaluation {
  const summary = computeWeekDoSummary(registrations, schedules, targetYmd);
  const currentDayCount = summary.byDateCount[targetYmd] || 0;
  const weekend = isWeekendYmd(targetYmd);

  if (!weekend) {
    const extraSameDay = extraSameWeekDates.filter((d) => d === targetYmd).length;
    if (currentDayCount + extraSameDay >= 2) {
      return {
        allowed: false,
        level: 'blocked',
        message: `Ngày ${formatViDate(targetYmd)} đã đủ tối đa 2 người nghỉ DO (T2–T6). Không thể đăng ký thêm.`,
      };
    }
    return { allowed: true, level: 'ok', message: '' };
  }

  const extraWeekend = extraSameWeekDates.filter(
    (d) =>
      d >= summary.weekStart &&
      d <= summary.weekEnd &&
      isWeekendYmd(d)
  ).length;
  if (summary.weekendTotal + extraWeekend >= 1) {
    return {
      allowed: true,
      level: 'warning_admin',
      message:
        'Cuối tuần (Thứ 7 & Chủ nhật) đã có người nghỉ DO trong tuần này (định mức 1 người/tuần). Bạn vẫn có thể gửi, nhưng cần Quản trị (Admin) phê duyệt.',
    };
  }
  return { allowed: true, level: 'ok', message: '' };
}

export function isWeekendOverQuotaPendingDo(
  reg: ShiftRegistration,
  registrations: ShiftRegistration[],
  schedules: OfficialWorkSchedule[]
): boolean {
  if (reg.status !== 'pending' || reg.shiftType !== 'do') return false;
  if (!isWeekendYmd(reg.date)) return false;
  const summary = computeWeekDoSummary(registrations, schedules, reg.date);
  return summary.weekendTotal > 1;
}

export function canApproveWeekendOverQuotaDo(
  level: SchedulePermissionLevel,
  reg: ShiftRegistration,
  registrations: ShiftRegistration[],
  schedules: OfficialWorkSchedule[]
): boolean {
  if (level === 'admin') return true;
  return !isWeekendOverQuotaPendingDo(reg, registrations, schedules);
}

export function resolveSchedulePermissionLevel(
  permissions: EffectivePermissions
): SchedulePermissionLevel {
  if (permissions.isSuperAdmin || permissions.role === 'store_manager') {
    return 'admin';
  }
  if (permissions.scheduleLevel) {
    return permissions.scheduleLevel;
  }
  if (permissions.scheduleApprove || permissions.role === 'supervisor') {
    return 'manage';
  }
  if (
    permissions.role === 'shift_lead' ||
    (permissions.scheduleEdit && permissions.scopeAll)
  ) {
    return 'edit';
  }
  return 'view';
}

export const SCHEDULE_LEVEL_LABELS: Record<SchedulePermissionLevel, string> = {
  view: 'Xem & Đăng ký cá nhân',
  edit: 'Phân công bảng tuần',
  manage: 'Duyệt & Quản lý lịch',
  admin: 'Quản trị toàn quyền',
};
