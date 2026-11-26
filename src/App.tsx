import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Timestamp,
} from 'firebase/firestore';
import {
  Activity,
  Boxes,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Database,
  HardDrive,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  ScanBarcode,
  Settings,
  ShieldCheck,
  Tag,
  Users,
  X,
} from 'lucide-react';
import type { SaveMemberParams } from './components/AccessControlTab';
import { AccessPendingScreen } from './components/AccessPendingScreen';
import { ConflictDialog } from './components/ConflictDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SignInScreen } from './components/SignInScreen';
import { SyncStatusBadge } from './components/SyncStatusBadge';
import {
  OperationType,
  auth,
  db,
  signOutAccount as signOutFirebase,
  testConnection as testFirebaseConnection,
} from './lib/firebase';
import {
  EMPTY_MODULE_PERMISSIONS,
  FULL_ADMIN_PERMISSIONS,
  FULL_MODULE_FLAGS,
  NAV_GROUPS,
  NAV_ITEMS,
  ROLE_DEFAULT_PERMS,
  ROLE_LABELS,
  SUPER_ADMIN_EMAIL,
  emailToKey,
  normalizeEmail,
  normalizeRole,
  resolveModuleAccessFlags,
} from './lib/permissions';
import {
  appendActivityLog,
  createBarcodeScanInSupabase,
  createRealtimeSyncSession,
  createWorkScheduleInSupabase,
  deleteBarcodeScansInSupabase,
  deleteUserAccessInSupabase,
  deleteWorkScheduleInSupabase,
  detectClientRuntimeEnv,
  extractSupabaseProjectRef,
  fetchAllSyncedData,
  fetchMyAccessFromSupabase,
  fetchRuntimeSupabaseConfig,
  getSupabaseClient,
  getValidatedEnvSupabaseConfig,
  handleSupabaseOAuthRedirectIfPresent,
  isValidSupabaseConfig,
  pushBarcodeScansToSupabase,
  pushSchedulesToSupabase,
  resetCachedSupabaseClient,
  saveUserAccessInSupabase,
  updateBarcodeScanWithVersion,
  updateWorkScheduleWithVersion,
  upsertUserProfile,
  validateSupabaseConfig,
  type RealtimeSubscriptionHandle,
} from './lib/supabase';
import {
  DEFAULT_LEAVE_RULES,
  fetchLeaveRules,
  fetchShiftDefinitions,
} from './lib/supabaseOps';
import type {
  ActivityAction,
  ActivityLog,
  ActivityModule,
  AppTab,
  AuthenticatedUser,
  AuthorizedEmail,
  BarcodeScan,
  DataBackendMode,
  EditConflict,
  EffectivePermissions,
  LeaveRulesConfig,
  NavGroupId,
  ScheduleStatus,
  ShiftDefinition,
  ShiftType,
  SupabaseConfig,
  SupabaseConfigSource,
  SupabaseRuntimeEnv,
  SyncState,
  ToastMessage,
  UiPreferences,
  WorkSchedule,
} from './types';

// Lazy-loaded modules — unopened modules fetch 0 bytes and 0 Supabase queries
const OverviewTab = lazy(() =>
  import('./components/ops/OverviewTab').then((m) => ({ default: m.OverviewTab }))
);
const WorkScheduleTab = lazy(() =>
  import('./components/WorkScheduleTab').then((m) => ({ default: m.WorkScheduleTab }))
);
const AttendanceTab = lazy(() =>
  import('./components/ops/AttendanceTab').then((m) => ({ default: m.AttendanceTab }))
);
const StaffProfileTab = lazy(() =>
  import('./components/ops/StaffProfileTab').then((m) => ({ default: m.StaffProfileTab }))
);
const CustomerFeedbackTab = lazy(() =>
  import('./components/ops/CustomerFeedbackTab').then((m) => ({
    default: m.CustomerFeedbackTab,
  }))
);
const DataWarehouseTab = lazy(() =>
  import('./components/goods/DataWarehouseTab').then((m) => ({
    default: m.DataWarehouseTab,
  }))
);
const BarcodeScannerTab = lazy(() =>
  import('./components/BarcodeScannerTab').then((m) => ({
    default: m.BarcodeScannerTab,
  }))
);
const ExpiryControlTab = lazy(() =>
  import('./components/goods/ExpiryControlTab').then((m) => ({
    default: m.ExpiryControlTab,
  }))
);
const GoodsReturnTab = lazy(() =>
  import('./components/goods/GoodsReturnTab').then((m) => ({
    default: m.GoodsReturnTab,
  }))
);
const PromotionsTab = lazy(() =>
  import('./components/goods/PromotionsTab').then((m) => ({
    default: m.PromotionsTab,
  }))
);
const SupabasePanel = lazy(() =>
  import('./components/SupabasePanel').then((m) => ({ default: m.SupabasePanel }))
);
const ResourceMonitorTab = lazy(() =>
  import('./components/system/ResourceMonitorTab').then((m) => ({
    default: m.ResourceMonitorTab,
  }))
);
const StorageManagerTab = lazy(() =>
  import('./components/system/StorageManagerTab').then((m) => ({
    default: m.StorageManagerTab,
  }))
);
const SettingsTab = lazy(() =>
  import('./components/system/SettingsTab').then((m) => ({ default: m.SettingsTab }))
);
const AccessControlTab = lazy(() =>
  import('./components/AccessControlTab').then((m) => ({
    default: m.AccessControlTab,
  }))
);
const ActivityLogTab = lazy(() =>
  import('./components/ActivityLogTab').then((m) => ({ default: m.ActivityLogTab }))
);

const DEFAULT_SHIFTS_FALLBACK: ShiftDefinition[] = [
  {
    id: 'shift-ca1',
    code: 'CA1',
    name: 'Ca 1',
    startTime: '06:00',
    endTime: '14:00',
    isDayOff: false,
    sortOrder: 1,
    active: true,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: 'shift-ca2',
    code: 'CA2',
    name: 'Ca 2',
    startTime: '14:00',
    endTime: '22:00',
    isDayOff: false,
    sortOrder: 2,
    active: true,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: 'shift-hc',
    code: 'HC',
    name: 'Hành chính',
    startTime: '08:00',
    endTime: '17:00',
    isDayOff: false,
    sortOrder: 3,
    active: true,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: 'shift-do',
    code: 'DO',
    name: 'Nghỉ tuần (DO)',
    startTime: '00:00',
    endTime: '00:00',
    isDayOff: true,
    sortOrder: 4,
    active: true,
    createdAt: null,
    updatedAt: null,
  },
];

function toIso(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (typeof (val as Timestamp).toDate === 'function') {
    return (val as Timestamp).toDate().toISOString();
  }
  if (val instanceof Date) return val.toISOString();
  return null;
}

function buildEffectivePermissions(
  email: string,
  access: AuthorizedEmail | null
): { permissions: EffectivePermissions; deactivated: boolean } {
  const cleanEmail = normalizeEmail(email);
  if (cleanEmail === SUPER_ADMIN_EMAIL) {
    return {
      permissions: {
        authorized: true,
        isSuperAdmin: true,
        role: 'store_manager',
        ...FULL_ADMIN_PERMISSIONS,
        modules: { ...FULL_MODULE_FLAGS },
      },
      deactivated: false,
    };
  }

  if (!access) {
    return {
      permissions: {
        authorized: false,
        isSuperAdmin: false,
        role: 'staff',
        ...EMPTY_MODULE_PERMISSIONS,
        modules: {
          overview: false,
          schedule: false,
          attendance: false,
          staff: false,
          feedback: false,
          warehouse: false,
          scanner: false,
          expiry: false,
          returns: false,
          promotions: false,
          supabase: false,
          monitoring: false,
          storage: false,
          settings: false,
          access: false,
          activity: false,
        },
      },
      deactivated: false,
    };
  }

  const active = Boolean(access.active);
  const resolvedModules = resolveModuleAccessFlags(access.role, access.modulePerms, access);
  const gatedModules = {
    overview: active && resolvedModules.overview,
    schedule: active && resolvedModules.schedule,
    attendance: active && resolvedModules.attendance,
    staff: active && resolvedModules.staff,
    feedback: active && resolvedModules.feedback,
    warehouse: active && resolvedModules.warehouse,
    scanner: active && resolvedModules.scanner,
    expiry: active && resolvedModules.expiry,
    returns: active && resolvedModules.returns,
    promotions: active && resolvedModules.promotions,
    supabase: active && resolvedModules.supabase,
    monitoring: active && resolvedModules.monitoring,
    storage: active && resolvedModules.storage,
    settings: active && resolvedModules.settings,
    access: active && resolvedModules.access,
    activity: active && resolvedModules.activity,
  };

  return {
    permissions: {
      authorized: active,
      isSuperAdmin: false,
      role: access.role,
      scopeAll: active && access.scopeAll,
      barcodeView: active && access.barcodeView,
      barcodeCreate: active && access.barcodeCreate,
      barcodeEdit: active && access.barcodeEdit,
      barcodeDelete: active && access.barcodeDelete,
      scheduleView: active && access.scheduleView,
      scheduleCreate: active && access.scheduleCreate,
      scheduleEdit: active && access.scheduleEdit,
      scheduleDelete: active && access.scheduleDelete,
      scheduleApprove: active && access.scheduleApprove,
      allowExport: active && access.allowExport,
      activityView: active && access.activityView,
      allowSupabase: active && access.allowSupabase,
      modulePerms: gatedModules,
      modules: gatedModules,
    },
    deactivated: !active,
  };
}

const TAB_ICONS: Record<AppTab, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  schedule: CalendarDays,
  attendance: Clock,
  staff: Users,
  feedback: MessageSquareText,
  warehouse: Boxes,
  scanner: ScanBarcode,
  expiry: CalendarClock,
  returns: RotateCcw,
  promotions: Tag,
  supabase: Database,
  monitoring: Activity,
  storage: HardDrive,
  settings: Settings,
  access: ShieldCheck,
  activity: History,
};

const TAB_META: Record<AppTab, { title: string; subtitle: string }> = {
  overview: {
    title: 'Tổng quan vận hành',
    subtitle: 'Ca làm hôm nay, chấm công, cảnh báo hạn sử dụng và lối tắt nghiệp vụ',
  },
  schedule: {
    title: 'Lịch làm việc',
    subtitle: 'Đăng ký ca làm, định mức ngày nghỉ DO, bảng phân công tuần và xuất ảnh PNG',
  },
  attendance: {
    title: 'Chấm công',
    subtitle: 'Vào ca / Kết ca theo thời gian máy chủ, lịch sử tăng ca – về sớm – phát sinh',
  },
  staff: {
    title: 'Nhân sự',
    subtitle: 'Cập nhật hồ sơ cá nhân, ảnh đại diện nén WebP và danh bạ cửa hàng',
  },
  feedback: {
    title: 'Ý kiến khách hàng',
    subtitle: 'Ghi nhận phản hồi sản phẩm, chất lượng dịch vụ và ảnh đính kèm theo ngày',
  },
  warehouse: {
    title: 'Kho dữ liệu',
    subtitle: 'Danh mục hàng hóa gốc (SP, barcode, giá) và chính sách nhà cung cấp',
  },
  scanner: {
    title: 'Quét mã vạch',
    subtitle: 'Quét liên tục bằng camera hoặc súng USB, lưu trữ trực tuyến và xuất Excel',
  },
  expiry: {
    title: 'Kiểm soát hạn sử dụng',
    subtitle: 'Theo dõi lô hàng theo HSD, tự động tính ngày cảnh báo trả NCC và xuất báo cáo',
  },
  returns: {
    title: 'Đổi trả hàng hóa',
    subtitle: 'Quản lý phiếu trả (PT), hình thức thu hồi, tiến độ xử lý và nhắc việc quá hạn',
  },
  promotions: {
    title: 'Chương trình khuyến mãi',
    subtitle: 'Theo dõi hàng cận date giảm giá, tính tự động giá KM và xuất tem/báo cáo',
  },
  supabase: {
    title: 'Quản lý Supabase',
    subtitle: 'Kết nối Supabase Realtime + RLS, script SQL nâng cấp và đồng bộ dữ liệu cũ',
  },
  monitoring: {
    title: 'Giám sát tài nguyên',
    subtitle: 'Theo dõi chỉ số thực tế từ Supabase Management API và thống kê truy vấn client',
  },
  storage: {
    title: 'Quản lý Storage',
    subtitle: 'Kiểm tra dung lượng ảnh/tài liệu, phát hiện file mồ côi và dọn dẹp an toàn',
  },
  settings: {
    title: 'Cấu hình',
    subtitle: 'Tùy chọn hiển thị bảng, tối ưu dữ liệu và quy định ngày nghỉ tuần (DO)',
  },
  access: {
    title: 'Phân quyền',
    subtitle: 'Quản lý 4 vai trò và bật/tắt chi tiết từng phân hệ trong toàn cửa hàng',
  },
  activity: {
    title: 'Nhật ký hoạt động',
    subtitle: 'Theo dõi lịch sử thêm, sửa, xóa, phê duyệt và xuất dữ liệu toàn hệ thống',
  },
};

function ModuleSuspenseFallback() {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
      <div className="h-6 w-48 bg-slate-100 rounded" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="h-24 bg-slate-100 rounded-lg" />
        <div className="h-24 bg-slate-100 rounded-lg" />
        <div className="h-24 bg-slate-100 rounded-lg" />
      </div>
      <div className="h-44 bg-slate-100 rounded-lg" />
    </div>
  );
}

function MainApp() {
  const initialBuildEnv = useMemo(() => getValidatedEnvSupabaseConfig(), []);
  const [supabaseConfig, setSupabaseConfig] = useState<SupabaseConfig>(() =>
    initialBuildEnv.valid ? initialBuildEnv.config : { url: '', anonKey: '' }
  );
  const [supabaseConfigSource, setSupabaseConfigSource] =
    useState<SupabaseConfigSource>(() =>
      initialBuildEnv.valid ? 'env_build' : 'none'
    );
  const [runtimeEnv, setRuntimeEnv] = useState<SupabaseRuntimeEnv>(() =>
    detectClientRuntimeEnv()
  );
  const [envValidationError, setEnvValidationError] = useState<string | null>(
    () => (initialBuildEnv.valid ? null : initialBuildEnv.error)
  );
  const [configConflictWarning, setConfigConflictWarning] = useState<string | null>(
    null
  );
  const envBaselineRef = useRef<{
    config: SupabaseConfig;
    source: 'env_build' | 'env_runtime';
  } | null>(
    initialBuildEnv.valid
      ? { config: initialBuildEnv.config, source: 'env_build' }
      : null
  );
  const [envBaselineConfig, setEnvBaselineConfig] =
    useState<SupabaseConfig | null>(() =>
      initialBuildEnv.valid ? initialBuildEnv.config : null
    );

  const supabaseReady = useMemo(
    () => isValidSupabaseConfig(supabaseConfig),
    [supabaseConfig]
  );
  const supabaseClient = useMemo(
    () => (supabaseReady ? getSupabaseClient(supabaseConfig) : null),
    [supabaseReady, supabaseConfig]
  );

  // Auth states
  const [supabaseAuthReady, setSupabaseAuthReady] = useState(false);
  const [supabaseSession, setSupabaseSession] = useState<Session | null>(null);
  const [firebaseAuthReady, setFirebaseAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [customDisplayName, setCustomDisplayName] = useState<string | null>(null);

  const backendMode: DataBackendMode = useMemo(() => {
    if (supabaseClient && supabaseSession?.user) return 'supabase';
    return 'firebase';
  }, [supabaseClient, supabaseSession]);

  const currentUser: AuthenticatedUser | null = useMemo(() => {
    if (supabaseSession?.user) {
      const u = supabaseSession.user;
      const meta = (u.user_metadata || {}) as Record<string, unknown>;
      return {
        uid: u.id,
        email: u.email || '',
        displayName:
          customDisplayName ||
          String(meta.full_name || meta.name || '').trim() ||
          (u.email ? u.email.split('@')[0] : 'Người dùng'),
        photoURL: typeof meta.avatar_url === 'string' ? meta.avatar_url : undefined,
        provider: 'supabase',
      };
    }
    if (firebaseUser) {
      return {
        uid: firebaseUser.uid,
        email: firebaseUser.email || '',
        displayName:
          customDisplayName ||
          firebaseUser.displayName ||
          (firebaseUser.email ? firebaseUser.email.split('@')[0] : 'Người dùng'),
        photoURL: firebaseUser.photoURL || undefined,
        provider: 'firebase',
      };
    }
    return null;
  }, [supabaseSession, firebaseUser, customDisplayName]);

  const [runtimeConfigChecked, setRuntimeConfigChecked] = useState(false);

  const authReady =
    runtimeConfigChecked &&
    (supabaseClient ? supabaseAuthReady && firebaseAuthReady : firebaseAuthReady);

  const [activeTab, setActiveTab] = useState<AppTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<NavGroupId, boolean>>({
    ops: false,
    goods: false,
    system: false,
  });

  // UI & Reference Settings
  const [uiPrefs, setUiPrefs] = useState<UiPreferences>({
    defaultPageSize: 20,
    compactSidebar: false,
    autoResetPromoIdle: true,
  });
  const [leaveRules, setLeaveRules] = useState<LeaveRulesConfig>(DEFAULT_LEAVE_RULES);
  const [shifts, setShifts] = useState<ShiftDefinition[]>(DEFAULT_SHIFTS_FALLBACK);

  // Access control & permissions
  const [accessChecked, setAccessChecked] = useState(false);
  const [recheckingAccess, setRecheckingAccess] = useState(false);
  const [accessDeactivated, setAccessDeactivated] = useState(false);
  const [permissions, setPermissions] = useState<EffectivePermissions>({
    authorized: false,
    isSuperAdmin: false,
    role: 'staff',
    ...EMPTY_MODULE_PERMISSIONS,
    modules: {
      overview: false,
      schedule: false,
      attendance: false,
      staff: false,
      feedback: false,
      warehouse: false,
      scanner: false,
      expiry: false,
      returns: false,
      promotions: false,
      supabase: false,
      monitoring: false,
      storage: false,
      settings: false,
      access: false,
      activity: false,
    },
  });

  // Core shared datasets
  const [authorizedMembers, setAuthorizedMembers] = useState<AuthorizedEmail[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  const [scans, setScans] = useState<BarcodeScan[]>([]);
  const [scansLoading, setScansLoading] = useState(true);

  const [schedules, setSchedules] = useState<WorkSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);

  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Sync status & conflict dialog
  const [syncState, setSyncState] = useState<SyncState>('connecting');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [activeConflict, setActiveConflict] = useState<EditConflict | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [orphanedCallback, setOrphanedCallback] = useState<{
    error?: string;
  } | null>(null);

  const realtimeRef = useRef<RealtimeSubscriptionHandle | null>(null);
  const prevChannelDisconnectedRef = useRef(false);

  const notify = useCallback(
    (type: ToastMessage['type'], message: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, type, message }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3800);
    },
    []
  );

  const reportFirestoreError = useCallback(
    (
      error: unknown,
      operationType: OperationType,
      path: string | null,
      userMessage?: string
    ) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        'Firestore Error:',
        JSON.stringify({
          error: msg,
          operationType,
          path,
          uid: auth.currentUser?.uid ?? null,
        })
      );
      setSyncState('error');
      if (userMessage) {
        notify('error', `${userMessage} (${msg})`);
      }
    },
    [notify]
  );

  // ============================================================================
  // Auth Initialization (Supabase Auth + Firebase Auth + Vercel Runtime Config)
  // ============================================================================
  useEffect(() => {
    let mounted = true;
    void fetchRuntimeSupabaseConfig().then((res) => {
      if (!mounted) return;
      if (res.runtimeEnv) {
        setRuntimeEnv(res.runtimeEnv);
      }
      if (!initialBuildEnv.valid) {
        if (res.valid && res.config) {
          envBaselineRef.current = { config: res.config, source: 'env_runtime' };
          setEnvBaselineConfig(res.config);
          setSupabaseConfig(res.config);
          setSupabaseConfigSource('env_runtime');
          setEnvValidationError(null);
        } else if (res.envError) {
          setEnvValidationError(res.envError);
        }
      } else if (res.valid && res.config) {
        // Warn if runtime server env differs from build-time env
        const buildRef = extractSupabaseProjectRef(initialBuildEnv.config.url);
        const rtRef = extractSupabaseProjectRef(res.config.url);
        if (buildRef && rtRef && buildRef !== rtRef) {
          setConfigConflictWarning(
            `Biến môi trường build (${buildRef}) khác với biến môi trường runtime (${rtRef}). Đang ưu tiên biến môi trường build.`
          );
        }
      }
      setRuntimeConfigChecked(true);
    });
    return () => {
      mounted = false;
    };
  }, [initialBuildEnv]);

  useEffect(() => {
    if (!runtimeConfigChecked || supabaseReady) return;
    void handleSupabaseOAuthRedirectIfPresent(null).then((res) => {
      if (res.detected && res.missingOpener) {
        setOrphanedCallback({ error: res.error });
      }
    });
  }, [runtimeConfigChecked, supabaseReady]);

  useEffect(() => {
    let mounted = true;
    if (!supabaseClient) {
      setSupabaseSession(null);
      setSupabaseAuthReady(runtimeConfigChecked);
      return;
    }

    const init = async () => {
      try {
        const res = await handleSupabaseOAuthRedirectIfPresent(supabaseClient);
        if (mounted) {
          if (res.detected && res.missingOpener) {
            setOrphanedCallback({ error: res.error });
          } else if (res.detected && !res.relayed) {
            setOrphanedCallback(null);
          }
        }
        const { data } = await supabaseClient.auth.getSession();
        if (mounted) {
          setSupabaseSession(data.session ?? null);
          setSupabaseAuthReady(true);
        }
      } catch {
        if (mounted) setSupabaseAuthReady(true);
      }
    };
    void init();

    const { data: sub } = supabaseClient.auth.onAuthStateChange((_event, session) => {
      if (mounted) {
        setSupabaseSession(session ?? null);
        setSupabaseAuthReady(true);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [supabaseClient, runtimeConfigChecked]);

  useEffect(() => {
    void testFirebaseConnection();
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      setFirebaseAuthReady(true);

      if (fbUser) {
        const userRef = doc(db, 'users', fbUser.uid);
        try {
          const snap = await getDoc(userRef);
          const safeEmail = fbUser.email || '';
          const safeName =
            fbUser.displayName || safeEmail.split('@')[0] || 'Người dùng';
          if (!snap.exists()) {
            const payload: Record<string, unknown> = {
              uid: fbUser.uid,
              email: safeEmail,
              displayName: safeName.slice(0, 120),
              updatedAt: serverTimestamp(),
            };
            if (fbUser.photoURL) {
              payload.photoURL = fbUser.photoURL.slice(0, 500);
            }
            const baseline = envBaselineRef.current?.config;
            if (baseline && isValidSupabaseConfig(baseline)) {
              payload.supabaseUrl = baseline.url.slice(0, 300);
              payload.supabaseAnonKey = baseline.anonKey.slice(0, 500);
            }
            await setDoc(userRef, payload);
          }
        } catch (error) {
          reportFirestoreError(error, OperationType.WRITE, `users/${fbUser.uid}`);
        }
      }
    });

    return () => unsub();
  }, [reportFirestoreError]);

  useEffect(() => {
    if (!firebaseUser || !runtimeConfigChecked) return;
    const path = `users/${firebaseUser.uid}`;
    const unsub = onSnapshot(
      doc(db, 'users', firebaseUser.uid),
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        const fbUrl =
          typeof data.supabaseUrl === 'string' ? data.supabaseUrl : '';
        const fbKey =
          typeof data.supabaseAnonKey === 'string' ? data.supabaseAnonKey : '';

        if (!fbUrl && !fbKey) {
          setConfigConflictWarning(null);
          return;
        }

        const fbValidation = validateSupabaseConfig({ url: fbUrl, anonKey: fbKey });
        const envBaseline = envBaselineRef.current;

        // Rule: Trusted environment config (Vercel / AI Studio) ALWAYS takes precedence over stale/corrupted Firestore data
        if (envBaseline) {
          const envRef = extractSupabaseProjectRef(envBaseline.config.url);
          if (!fbValidation.valid) {
            setConfigConflictWarning(
              'Hồ sơ Firestore đang lưu cấu hình Supabase không hợp lệ (có thể bị nhập nhầm URL/Key trước đó). Hệ thống đang ưu tiên biến môi trường chuẩn.'
            );
          } else if (fbValidation.projectRef && envRef && fbValidation.projectRef !== envRef) {
            setConfigConflictWarning(
              `Hồ sơ Firestore đang lưu Project (${fbValidation.projectRef}) khác với biến môi trường (${envRef}). Hệ thống đang ưu tiên biến môi trường.`
            );
          } else {
            setConfigConflictWarning(null);
          }
          return;
        }

        // No environment config -> use Firestore ONLY if strictly valid
        if (!fbValidation.valid) {
          setConfigConflictWarning(
            fbValidation.urlError ||
              fbValidation.keyError ||
              'Cấu hình Supabase lưu trong Firestore không hợp lệ và đã bị bỏ qua.'
          );
          return;
        }

        setConfigConflictWarning(null);
        setSupabaseConfig((prev) => {
          if (
            prev.url === fbValidation.normalized.url &&
            prev.anonKey === fbValidation.normalized.anonKey
          ) {
            return prev;
          }
          return fbValidation.normalized;
        });
        setSupabaseConfigSource((prev) => (prev === 'manual' ? prev : 'firestore_user'));
      },
      (error) => reportFirestoreError(error, OperationType.GET, path)
    );
    return () => unsub();
  }, [firebaseUser, runtimeConfigChecked, reportFirestoreError]);

  useEffect(() => {
    if (!currentUser) {
      setCustomDisplayName(null);
      setAccessChecked(false);
      setAccessDeactivated(false);
      setPermissions({
        authorized: false,
        isSuperAdmin: false,
        role: 'staff',
        ...EMPTY_MODULE_PERMISSIONS,
        modules: {
          overview: false,
          schedule: false,
          attendance: false,
          staff: false,
          feedback: false,
          warehouse: false,
          scanner: false,
          expiry: false,
          returns: false,
          promotions: false,
          supabase: false,
          monitoring: false,
          storage: false,
          settings: false,
          access: false,
          activity: false,
        },
      });
      setAuthorizedMembers([]);
      setScans([]);
      setSchedules([]);
      setActivityLogs([]);
      setSyncState('disconnected');
    }
  }, [currentUser]);

  // ============================================================================
  // Access Resolution (Supabase DB OR Firestore)
  // ============================================================================
  const refreshSupabaseAccess = useCallback(async () => {
    if (!supabaseClient || !currentUser || backendMode !== 'supabase') return;
    try {
      await upsertUserProfile(supabaseClient, {
        uid: currentUser.uid,
        email: currentUser.email,
        displayName: currentUser.displayName,
        photoURL: currentUser.photoURL,
      });
    } catch {
      // Non-fatal
    }
    const res = await fetchMyAccessFromSupabase(supabaseClient, currentUser.email);
    const resolved = buildEffectivePermissions(currentUser.email, res.access);
    setPermissions(resolved.permissions);
    setAccessDeactivated(resolved.deactivated);
    setAccessChecked(true);
  }, [supabaseClient, currentUser, backendMode]);

  useEffect(() => {
    if (!currentUser || !currentUser.email) return;

    if (backendMode === 'supabase') {
      setAccessChecked(false);
      void refreshSupabaseAccess().catch(() => {
        const resolved = buildEffectivePermissions(currentUser.email, null);
        setPermissions(resolved.permissions);
        setAccessDeactivated(resolved.deactivated);
        setAccessChecked(true);
      });
      return;
    }

    const cleanEmail = normalizeEmail(currentUser.email);
    if (cleanEmail === SUPER_ADMIN_EMAIL) {
      const resolved = buildEffectivePermissions(cleanEmail, null);
      setPermissions(resolved.permissions);
      setAccessDeactivated(false);
      setAccessChecked(true);
      return;
    }

    const emailDocId = emailToKey(cleanEmail);
    const accessPath = `authorized_emails/${emailDocId}`;
    setAccessChecked(false);

    const unsub = onSnapshot(
      doc(db, 'authorized_emails', emailDocId),
      (snap) => {
        if (!snap.exists()) {
          const resolved = buildEffectivePermissions(cleanEmail, null);
          setPermissions(resolved.permissions);
          setAccessDeactivated(false);
          setAccessChecked(true);
          return;
        }
        const data = snap.data();
        const role = normalizeRole(data.role);
        const defaults = ROLE_DEFAULT_PERMS[role];
        const mapped: AuthorizedEmail = {
          id: snap.id,
          email: cleanEmail,
          displayName: String(data.displayName || ''),
          role,
          active: Boolean(data.active),
          scopeAll: Boolean(data.scopeAll ?? defaults.scopeAll),
          barcodeView: Boolean(data.barcodeView ?? data.allowBarcode ?? defaults.barcodeView),
          barcodeCreate: Boolean(data.barcodeCreate ?? data.allowBarcode ?? defaults.barcodeCreate),
          barcodeEdit: Boolean(data.barcodeEdit ?? data.allowBarcode ?? defaults.barcodeEdit),
          barcodeDelete: Boolean(
            data.barcodeDelete ?? (role !== 'staff' ? defaults.barcodeDelete : false)
          ),
          scheduleView: Boolean(data.scheduleView ?? data.allowSchedule ?? defaults.scheduleView),
          scheduleCreate: Boolean(
            data.scheduleCreate ?? data.allowSchedule ?? defaults.scheduleCreate
          ),
          scheduleEdit: Boolean(data.scheduleEdit ?? data.allowSchedule ?? defaults.scheduleEdit),
          scheduleDelete: Boolean(data.scheduleDelete ?? defaults.scheduleDelete),
          scheduleApprove: Boolean(data.scheduleApprove ?? defaults.scheduleApprove),
          allowExport: Boolean(data.allowExport ?? defaults.allowExport),
          activityView: Boolean(data.activityView ?? defaults.activityView),
          allowSupabase: Boolean(data.allowSupabase ?? defaults.allowSupabase),
          modulePerms:
            data.modulePerms && typeof data.modulePerms === 'object'
              ? (data.modulePerms as AuthorizedEmail['modulePerms'])
              : defaults.modulePerms,
          note: String(data.note || ''),
          grantedBy: String(data.grantedBy || ''),
          version: Number(data.version || 1),
          createdAt: toIso(data.createdAt),
          updatedAt: toIso(data.updatedAt),
        };
        const resolved = buildEffectivePermissions(cleanEmail, mapped);
        setPermissions(resolved.permissions);
        setAccessDeactivated(resolved.deactivated);
        setAccessChecked(true);
      },
      (error) => {
        setAccessChecked(true);
        reportFirestoreError(
          error,
          OperationType.GET,
          accessPath,
          'Không thể kiểm tra phân quyền tài khoản'
        );
      }
    );

    return () => unsub();
  }, [currentUser, backendMode, refreshSupabaseAccess, reportFirestoreError]);

  const handleRecheckAccess = useCallback(async () => {
    if (!currentUser?.email) return;
    setRecheckingAccess(true);
    try {
      if (backendMode === 'supabase' && supabaseClient) {
        await refreshSupabaseAccess();
        const res = await fetchMyAccessFromSupabase(supabaseClient, currentUser.email);
        if (!res.access) {
          notify('info', 'Tài khoản vẫn chưa được Quản lý siêu thị cấp quyền.');
        } else if (!res.access.active) {
          notify('info', 'Tài khoản hiện đang tạm khóa.');
        }
      } else {
        const emailDocId = emailToKey(currentUser.email);
        const snap = await getDoc(doc(db, 'authorized_emails', emailDocId));
        if (!snap.exists()) {
          notify('info', 'Tài khoản vẫn chưa được quản trị viên thêm vào danh sách.');
        } else if (!snap.data().active) {
          notify('info', 'Tài khoản hiện đang tạm khóa.');
        }
      }
    } finally {
      setRecheckingAccess(false);
    }
  }, [currentUser, backendMode, supabaseClient, refreshSupabaseAccess, notify]);

  // Keep activeTab within permitted tabs
  useEffect(() => {
    if (!permissions.authorized) return;
    const allowed = permissions.modules;
    const isAllowed = (tab: AppTab): boolean => {
      if (tab === 'supabase' && permissions.allowSupabase) return true;
      return Boolean(allowed[tab]);
    };
    if (!isAllowed(activeTab)) {
      const firstPermitted = NAV_ITEMS.find((item) => isAllowed(item.id));
      if (firstPermitted) {
        setActiveTab(firstPermitted.id);
      }
    }
  }, [permissions, activeTab]);

  // ============================================================================
  // Supabase Reference & Primary Hydration + Realtime Sync
  // ============================================================================
  const refreshShiftsAndRules = useCallback(async () => {
    if (!supabaseClient || backendMode !== 'supabase') return;
    try {
      const [rules, shiftList] = await Promise.all([
        fetchLeaveRules(supabaseClient),
        fetchShiftDefinitions(supabaseClient),
      ]);
      setLeaveRules(rules);
      if (shiftList.length > 0) {
        setShifts(shiftList);
      }
    } catch {
      // Fall back to default shifts if migration 002 hasn't been executed yet
    }
  }, [supabaseClient, backendMode]);

  const hydrateSupabaseData = useCallback(async () => {
    if (!supabaseClient || !currentUser || !permissions.authorized) return;
    setSyncState('syncing');
    setScansLoading(true);
    setSchedulesLoading(true);
    if (permissions.role === 'store_manager') setMembersLoading(true);
    if (permissions.activityView) setActivityLoading(true);

    const [res] = await Promise.all([
      fetchAllSyncedData(supabaseClient, {
        isStoreManager: permissions.role === 'store_manager',
        allowActivity: permissions.activityView,
      }),
      refreshShiftsAndRules(),
    ]);

    if (res.error) {
      setSyncState('error');
      setScansLoading(false);
      setSchedulesLoading(false);
      setMembersLoading(false);
      setActivityLoading(false);
      notify('error', `Lỗi đồng bộ Supabase: ${res.error}`);
      return;
    }

    setScans(res.scans);
    setSchedules(res.schedules);
    if (permissions.role === 'store_manager') {
      setAuthorizedMembers(res.members);
    }
    if (permissions.activityView) {
      setActivityLogs(res.logs);
    }
    setScansLoading(false);
    setSchedulesLoading(false);
    setMembersLoading(false);
    setActivityLoading(false);
    setLastSyncedAt(new Date().toISOString());
    setSyncState('synced');
  }, [
    supabaseClient,
    currentUser,
    permissions.authorized,
    permissions.role,
    permissions.activityView,
    refreshShiftsAndRules,
    notify,
  ]);

  useEffect(() => {
    if (
      backendMode !== 'supabase' ||
      !supabaseClient ||
      !currentUser ||
      !permissions.authorized
    ) {
      if (realtimeRef.current) {
        void realtimeRef.current.unsubscribe();
        realtimeRef.current = null;
      }
      return;
    }

    let cancelled = false;
    setSyncState(navigator.onLine ? 'connecting' : 'disconnected');

    void hydrateSupabaseData();

    if (realtimeRef.current) {
      void realtimeRef.current.unsubscribe();
      realtimeRef.current = null;
    }

    const handle = createRealtimeSyncSession(supabaseClient, {
      onBarcodeChange: (eventType, newRow, oldId) => {
        if (cancelled) return;
        setScans((prev) => {
          if (eventType === 'DELETE') {
            return prev.filter((item) => item.id !== oldId);
          }
          if (!newRow) return prev;
          const exists = prev.some((item) => item.id === newRow.id);
          const next = exists
            ? prev.map((item) => (item.id === newRow.id ? newRow : item))
            : [newRow, ...prev];
          return [...next].sort((a, b) => {
            const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return tb - ta;
          });
        });
        setLastSyncedAt(new Date().toISOString());
        setSyncState('synced');
      },

      onScheduleChange: (eventType, newRow, oldId) => {
        if (cancelled) return;
        setSchedules((prev) => {
          if (eventType === 'DELETE') {
            return prev.filter((item) => item.id !== oldId);
          }
          if (!newRow) return prev;
          const exists = prev.some((item) => item.id === newRow.id);
          const next = exists
            ? prev.map((item) => (item.id === newRow.id ? newRow : item))
            : [...prev, newRow];
          return [...next].sort((a, b) => {
            if (a.workDate !== b.workDate) {
              return a.workDate.localeCompare(b.workDate);
            }
            return a.startTime.localeCompare(b.startTime);
          });
        });
        setLastSyncedAt(new Date().toISOString());
        setSyncState('synced');
      },

      onAccessChange: (eventType, newRow, oldId) => {
        if (cancelled) return;
        if (permissions.role === 'store_manager') {
          setAuthorizedMembers((prev) => {
            if (eventType === 'DELETE') {
              return prev.filter((item) => item.id !== oldId);
            }
            if (!newRow) return prev;
            const exists = prev.some((item) => item.id === newRow.id);
            const next = exists
              ? prev.map((item) => (item.id === newRow.id ? newRow : item))
              : [...prev, newRow];
            return [...next].sort((a, b) => a.email.localeCompare(b.email));
          });
        }
        if (
          newRow &&
          normalizeEmail(newRow.email) === normalizeEmail(currentUser.email)
        ) {
          const resolved = buildEffectivePermissions(currentUser.email, newRow);
          setPermissions(resolved.permissions);
          setAccessDeactivated(resolved.deactivated);
          notify('info', 'Quyền truy cập của bạn vừa được cập nhật theo thời gian thực.');
        } else if (
          eventType === 'DELETE' &&
          oldId === emailToKey(currentUser.email)
        ) {
          void refreshSupabaseAccess();
        }
        setLastSyncedAt(new Date().toISOString());
      },

      onActivityInsert: (row) => {
        if (cancelled || !permissions.activityView) return;
        setActivityLogs((prev) => {
          if (prev.some((l) => l.id === row.id)) return prev;
          return [row, ...prev].slice(0, 250);
        });
      },

      onBroadcastEvent: (payload) => {
        if (cancelled) return;
        if (payload.event === 'FORCE_RESYNC') {
          void hydrateSupabaseData();
        }
      },

      onChannelStatus: (status) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          if (prevChannelDisconnectedRef.current) {
            prevChannelDisconnectedRef.current = false;
            void hydrateSupabaseData();
          } else {
            setSyncState('connected');
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          prevChannelDisconnectedRef.current = true;
          setSyncState('error');
        } else if (status === 'CLOSED') {
          prevChannelDisconnectedRef.current = true;
          setSyncState('disconnected');
        }
      },
    });

    realtimeRef.current = handle;

    const handleOnline = () => {
      if (cancelled) return;
      setSyncState('connecting');
      void hydrateSupabaseData();
    };
    const handleOffline = () => {
      if (cancelled) return;
      prevChannelDisconnectedRef.current = true;
      setSyncState('disconnected');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      cancelled = true;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (realtimeRef.current === handle) {
        realtimeRef.current = null;
      }
      void handle.unsubscribe();
    };
  }, [
    backendMode,
    supabaseClient,
    currentUser,
    permissions.authorized,
    permissions.role,
    permissions.activityView,
    hydrateSupabaseData,
    refreshSupabaseAccess,
    notify,
  ]);

  // ============================================================================
  // Firebase Live Listeners (Fallback when Supabase Auth is not yet active)
  // ============================================================================
  useEffect(() => {
    if (
      backendMode !== 'firebase' ||
      !firebaseUser ||
      !permissions.authorized ||
      permissions.role !== 'store_manager'
    ) {
      if (backendMode === 'firebase') setAuthorizedMembers([]);
      return;
    }

    setMembersLoading(true);
    const path = 'authorized_emails';
    const unsub = onSnapshot(
      collection(db, path),
      (snapshot) => {
        const list: AuthorizedEmail[] = snapshot.docs.map((d) => {
          const data = d.data();
          const role = normalizeRole(data.role);
          const defaults = ROLE_DEFAULT_PERMS[role];
          return {
            id: d.id,
            email: normalizeEmail(String(data.email || '')),
            displayName: String(data.displayName || ''),
            role,
            active: Boolean(data.active),
            scopeAll: Boolean(data.scopeAll ?? defaults.scopeAll),
            barcodeView: Boolean(data.barcodeView ?? data.allowBarcode ?? defaults.barcodeView),
            barcodeCreate: Boolean(
              data.barcodeCreate ?? data.allowBarcode ?? defaults.barcodeCreate
            ),
            barcodeEdit: Boolean(data.barcodeEdit ?? data.allowBarcode ?? defaults.barcodeEdit),
            barcodeDelete: Boolean(data.barcodeDelete ?? defaults.barcodeDelete),
            scheduleView: Boolean(data.scheduleView ?? data.allowSchedule ?? defaults.scheduleView),
            scheduleCreate: Boolean(
              data.scheduleCreate ?? data.allowSchedule ?? defaults.scheduleCreate
            ),
            scheduleEdit: Boolean(data.scheduleEdit ?? data.allowSchedule ?? defaults.scheduleEdit),
            scheduleDelete: Boolean(data.scheduleDelete ?? defaults.scheduleDelete),
            scheduleApprove: Boolean(data.scheduleApprove ?? defaults.scheduleApprove),
            allowExport: Boolean(data.allowExport ?? defaults.allowExport),
            activityView: Boolean(data.activityView ?? defaults.activityView),
            allowSupabase: Boolean(data.allowSupabase ?? defaults.allowSupabase),
            modulePerms:
              data.modulePerms && typeof data.modulePerms === 'object'
                ? (data.modulePerms as AuthorizedEmail['modulePerms'])
                : defaults.modulePerms,
            note: String(data.note || ''),
            grantedBy: String(data.grantedBy || ''),
            version: Number(data.version || 1),
            createdAt: toIso(data.createdAt),
            updatedAt: toIso(data.updatedAt),
          };
        });
        list.sort((a, b) => a.email.localeCompare(b.email));
        setAuthorizedMembers(list);
        setMembersLoading(false);
      },
      (error) => {
        setMembersLoading(false);
        reportFirestoreError(
          error,
          OperationType.LIST,
          path,
          'Lỗi tải danh sách phân quyền'
        );
      }
    );
    return () => unsub();
  }, [backendMode, firebaseUser, permissions.authorized, permissions.role, reportFirestoreError]);

  useEffect(() => {
    if (backendMode !== 'firebase') return;
    if (!firebaseUser || !permissions.authorized || !permissions.barcodeView) {
      setScans([]);
      setScansLoading(false);
      return;
    }
    setScansLoading(true);
    const path = 'barcode_scans';
    const q = permissions.scopeAll
      ? collection(db, path)
      : query(collection(db, path), where('ownerId', '==', firebaseUser.uid));

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const list: BarcodeScan[] = snapshot.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            ownerId: String(data.ownerId || ''),
            ownerEmail: String(data.ownerEmail || ''),
            code: String(data.code || ''),
            format: String(data.format || 'BARCODE'),
            sessionName: String(data.sessionName || 'Mặc định'),
            quantity: Number(data.quantity || 1),
            note: String(data.note || ''),
            version: Number(data.version || 1),
            updatedBy: String(data.updatedBy || data.ownerEmail || ''),
            syncedToSupabase: Boolean(data.syncedToSupabase),
            scannedAt: toIso(data.scannedAt),
            updatedAt: toIso(data.updatedAt),
          };
        });
        list.sort((a, b) => {
          const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return tb - ta;
        });
        setScans(list);
        setScansLoading(false);
        setSyncState(navigator.onLine ? 'connected' : 'disconnected');
        setLastSyncedAt(new Date().toISOString());
      },
      (error) => {
        setScansLoading(false);
        reportFirestoreError(
          error,
          OperationType.LIST,
          path,
          'Lỗi tải dữ liệu mã vạch'
        );
      }
    );
    return () => unsub();
  }, [
    backendMode,
    firebaseUser,
    permissions.authorized,
    permissions.barcodeView,
    permissions.scopeAll,
    reportFirestoreError,
  ]);

  useEffect(() => {
    if (backendMode !== 'firebase') return;
    if (!firebaseUser || !permissions.authorized || !permissions.scheduleView) {
      setSchedules([]);
      setSchedulesLoading(false);
      return;
    }
    setSchedulesLoading(true);
    const path = 'work_schedules';
    const q = permissions.scopeAll
      ? collection(db, path)
      : query(collection(db, path), where('ownerId', '==', firebaseUser.uid));

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const list: WorkSchedule[] = snapshot.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            ownerId: String(data.ownerId || ''),
            ownerEmail: String(data.ownerEmail || ''),
            employeeName: String(data.employeeName || ''),
            title: String(data.title || ''),
            workDate: String(data.workDate || ''),
            shiftType: (data.shiftType as ShiftType) || 'custom',
            startTime: String(data.startTime || '08:00'),
            endTime: String(data.endTime || '17:00'),
            location: String(data.location || ''),
            status: (data.status as ScheduleStatus) || 'registered',
            note: String(data.note || ''),
            approvedBy: String(data.approvedBy || ''),
            approvedAt: toIso(data.approvedAt),
            version: Number(data.version || 1),
            updatedBy: String(data.updatedBy || data.ownerEmail || ''),
            syncedToSupabase: Boolean(data.syncedToSupabase),
            createdAt: toIso(data.createdAt),
            updatedAt: toIso(data.updatedAt),
          };
        });
        list.sort((a, b) => {
          if (a.workDate !== b.workDate) {
            return a.workDate.localeCompare(b.workDate);
          }
          return a.startTime.localeCompare(b.startTime);
        });
        setSchedules(list);
        setSchedulesLoading(false);
      },
      (error) => {
        setSchedulesLoading(false);
        reportFirestoreError(
          error,
          OperationType.LIST,
          path,
          'Lỗi tải lịch làm việc'
        );
      }
    );
    return () => unsub();
  }, [
    backendMode,
    firebaseUser,
    permissions.authorized,
    permissions.scheduleView,
    permissions.scopeAll,
    reportFirestoreError,
  ]);

  // ============================================================================
  // Activity Log Helper
  // ============================================================================
  const recordActivity = useCallback(
    async (
      module: ActivityModule,
      action: ActivityAction,
      targetId: string,
      summary: string,
      changes?: Record<string, unknown>
    ) => {
      if (!currentUser || backendMode !== 'supabase' || !supabaseClient) return;
      const inserted = await appendActivityLog(supabaseClient, {
        actorId: currentUser.uid,
        actorEmail: currentUser.email,
        actorName: currentUser.displayName,
        actorRole: permissions.role,
        module,
        action,
        targetId,
        summary,
        changes,
      });
      if (inserted && permissions.activityView) {
        setActivityLogs((prev) =>
          prev.some((l) => l.id === inserted.id) ? prev : [inserted, ...prev]
        );
      }
    },
    [currentUser, backendMode, supabaseClient, permissions.role, permissions.activityView]
  );

  // ============================================================================
  // RBAC Admin CRUD Handlers
  // ============================================================================
  const handleSaveAuthorizedMember = useCallback(
    async (params: SaveMemberParams) => {
      if (!currentUser?.email) return;
      const cleanEmail = normalizeEmail(params.email);
      if (cleanEmail === SUPER_ADMIN_EMAIL) {
        notify('info', 'Tài khoản Quản lý siêu thị gốc luôn có toàn quyền.');
        return;
      }

      if (backendMode === 'supabase' && supabaseClient) {
        setSyncState('syncing');
        const res = await saveUserAccessInSupabase(supabaseClient, {
          ...params,
          grantedBy: currentUser.email,
        });
        if (res.status === 'error') {
          setSyncState('error');
          notify('error', res.error);
          return;
        }
        if (res.status === 'conflict') {
          setSyncState('connected');
          const srv = res.serverRecord;
          if (!srv) {
            notify('info', 'Bản ghi phân quyền đã bị xóa bởi quản trị viên khác.');
            void hydrateSupabaseData();
            return;
          }
          setActiveConflict({
            entity: 'user_access',
            recordId: srv.id,
            title: `Phân quyền ${cleanEmail}`,
            expectedVersion: params.expectedVersion || 1,
            serverVersion: srv.version,
            serverUpdatedBy: srv.grantedBy,
            serverUpdatedAt: srv.updatedAt,
            localSummary: `${ROLE_LABELS[params.role]} · ${params.active ? 'Hoạt động' : 'Tạm khóa'}`,
            serverSummary: `${ROLE_LABELS[srv.role]} · ${srv.active ? 'Hoạt động' : 'Tạm khóa'}`,
            onReloadLatest: () => {
              setAuthorizedMembers((prev) =>
                prev.map((m) => (m.id === srv.id ? srv : m))
              );
            },
            onForceOverwrite: async () => {
              await handleSaveAuthorizedMember({
                ...params,
                expectedVersion: srv.version,
              });
            },
          });
          return;
        }

        const saved = res.data;
        setAuthorizedMembers((prev) => {
          const exists = prev.some((m) => m.id === saved.id);
          const next = exists
            ? prev.map((m) => (m.id === saved.id ? saved : m))
            : [...prev, saved];
          return [...next].sort((a, b) => a.email.localeCompare(b.email));
        });
        setSyncState('synced');
        setLastSyncedAt(new Date().toISOString());
        await recordActivity(
          'access',
          params.isEdit ? 'update' : 'create',
          saved.id,
          `${params.isEdit ? 'Cập nhật' : 'Cấp'} quyền ${ROLE_LABELS[params.role]} cho ${cleanEmail}`,
          { role: params.role, active: params.active }
        );
        realtimeRef.current?.broadcast('ACCESS_UPDATED', { email: cleanEmail });
        notify(
          'success',
          params.isEdit
            ? `Đã cập nhật phân quyền cho ${cleanEmail}`
            : `Đã cấp quyền truy cập cho ${cleanEmail}`
        );
        return;
      }

      const docId = emailToKey(cleanEmail);
      const ref = doc(db, 'authorized_emails', docId);
      const grantedBy = normalizeEmail(currentUser.email);
      const legacyRole =
        params.role === 'store_manager'
          ? 'admin'
          : params.role === 'supervisor' || params.role === 'shift_lead'
            ? 'manager'
            : 'staff';
      try {
        const safeDisplayName =
          (params.displayName.trim() || cleanEmail.split('@')[0] || 'Nhân sự').slice(
            0,
            120
          );
        const fbPayload = {
          displayName: safeDisplayName,
          role: legacyRole,
          allowBarcode: params.barcodeView,
          allowSchedule: params.scheduleView,
          allowExport: params.allowExport,
          allowSupabase: params.allowSupabase,
          active: params.active,
          note: params.note.slice(0, 300),
          grantedBy,
          updatedAt: serverTimestamp(),
        };
        if (params.isEdit) {
          await updateDoc(ref, fbPayload);
          notify('success', `Đã cập nhật phân quyền cho ${cleanEmail}`);
        } else {
          const existing = await getDoc(ref);
          if (existing.exists()) {
            await updateDoc(ref, fbPayload);
          } else {
            await setDoc(ref, {
              email: cleanEmail,
              ...fbPayload,
              createdAt: serverTimestamp(),
            });
          }
          notify('success', `Đã cấp quyền truy cập cho ${cleanEmail}`);
        }
      } catch (error) {
        reportFirestoreError(
          error,
          params.isEdit ? OperationType.UPDATE : OperationType.CREATE,
          `authorized_emails/${docId}`,
          'Không thể lưu phân quyền'
        );
      }
    },
    [
      currentUser,
      backendMode,
      supabaseClient,
      hydrateSupabaseData,
      recordActivity,
      notify,
      reportFirestoreError,
    ]
  );

  const handleToggleMemberActive = useCallback(
    async (member: AuthorizedEmail) => {
      if (!currentUser?.email) return;
      await handleSaveAuthorizedMember({
        email: member.email,
        displayName: member.displayName,
        role: member.role,
        scopeAll: member.scopeAll,
        barcodeView: member.barcodeView,
        barcodeCreate: member.barcodeCreate,
        barcodeEdit: member.barcodeEdit,
        barcodeDelete: member.barcodeDelete,
        scheduleView: member.scheduleView,
        scheduleCreate: member.scheduleCreate,
        scheduleEdit: member.scheduleEdit,
        scheduleDelete: member.scheduleDelete,
        scheduleApprove: member.scheduleApprove,
        allowExport: member.allowExport,
        activityView: member.activityView,
        allowSupabase: member.allowSupabase,
        modulePerms: member.modulePerms,
        active: !member.active,
        note: member.note,
        expectedVersion: member.version,
        isEdit: true,
      });
    },
    [currentUser, handleSaveAuthorizedMember]
  );

  const handleDeleteMember = useCallback(
    async (member: AuthorizedEmail) => {
      if (backendMode === 'supabase' && supabaseClient) {
        setSyncState('syncing');
        const res = await deleteUserAccessInSupabase(supabaseClient, member.id);
        if (res.error) {
          setSyncState('error');
          notify('error', res.error);
          return;
        }
        setAuthorizedMembers((prev) => prev.filter((m) => m.id !== member.id));
        setSyncState('synced');
        setLastSyncedAt(new Date().toISOString());
        await recordActivity(
          'access',
          'delete',
          member.id,
          `Thu hồi quyền truy cập của ${member.email}`
        );
        notify('info', `Đã thu hồi quyền truy cập của ${member.email}`);
        return;
      }

      const ref = doc(db, 'authorized_emails', member.id);
      try {
        await deleteDoc(ref);
        notify('info', `Đã thu hồi quyền truy cập của ${member.email}`);
      } catch (error) {
        reportFirestoreError(
          error,
          OperationType.DELETE,
          `authorized_emails/${member.id}`,
          'Không thể thu hồi quyền truy cập'
        );
      }
    },
    [backendMode, supabaseClient, recordActivity, notify, reportFirestoreError]
  );

  // ============================================================================
  // Barcode CRUD Handlers
  // ============================================================================
  const applyBarcodeUpdate = useCallback(
    async (
      scan: BarcodeScan,
      updates: Partial<{ quantity: number; note: string; sessionName: string }>,
      summaryText: string
    ) => {
      if (!currentUser?.email) return;

      if (backendMode === 'supabase' && supabaseClient) {
        setSyncState('syncing');
        const res = await updateBarcodeScanWithVersion(supabaseClient, {
          id: scan.id,
          expectedVersion: scan.version,
          actorEmail: currentUser.email,
          updates,
        });

        if (res.status === 'error') {
          setSyncState('error');
          notify('error', res.error);
          return;
        }

        if (res.status === 'conflict') {
          setSyncState('connected');
          const srv = res.serverRecord;
          if (!srv) {
            setScans((prev) => prev.filter((s) => s.id !== scan.id));
            notify('info', `Mã "${scan.code}" đã bị người dùng khác xóa.`);
            return;
          }
          const localDesc = [
            updates.quantity !== undefined ? `SL: ${updates.quantity}` : null,
            updates.note !== undefined ? `Ghi chú: "${updates.note}"` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          const serverDesc = `SL: ${srv.quantity} · Ghi chú: "${srv.note || '—'}"`;

          setActiveConflict({
            entity: 'barcode_scans',
            recordId: scan.id,
            title: `Mã vạch ${scan.code}`,
            expectedVersion: scan.version,
            serverVersion: srv.version,
            serverUpdatedBy: srv.updatedBy,
            serverUpdatedAt: srv.updatedAt,
            localSummary: localDesc || summaryText,
            serverSummary: serverDesc,
            onReloadLatest: () => {
              setScans((prev) => prev.map((s) => (s.id === srv.id ? srv : s)));
              notify('info', `Đã tải phiên bản mới nhất của mã ${srv.code}.`);
            },
            onForceOverwrite: async () => {
              await applyBarcodeUpdate(srv, updates, `${summaryText} (Ghi đè xung đột)`);
            },
          });
          return;
        }

        const updated = res.data;
        setScans((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        setSyncState('synced');
        setLastSyncedAt(new Date().toISOString());
        await recordActivity('barcode', 'update', updated.id, summaryText, {
          code: updated.code,
          version: updated.version,
          ...updates,
        });
        return;
      }

      const ref = doc(db, 'barcode_scans', scan.id);
      try {
        await updateDoc(ref, {
          ...updates,
          syncedToSupabase: false,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        reportFirestoreError(
          error,
          OperationType.UPDATE,
          `barcode_scans/${scan.id}`,
          'Không thể cập nhật mã vạch'
        );
      }
    },
    [currentUser, backendMode, supabaseClient, recordActivity, notify, reportFirestoreError]
  );

  const handleAddOrIncrementScan = useCallback(
    async (params: {
      code: string;
      format: string;
      sessionName: string;
      note: string;
      accumulate: boolean;
    }) => {
      if (!currentUser || !currentUser.email) return;
      const cleanCode = params.code.trim().slice(0, 200);
      const cleanSession = params.sessionName.trim().slice(0, 100) || 'Mặc định';

      if (params.accumulate) {
        const existing = scans.find(
          (s) =>
            s.code === cleanCode &&
            s.sessionName === cleanSession &&
            (s.ownerId === currentUser.uid || permissions.scopeAll)
        );
        if (existing) {
          const nextQty = Math.min(999999, existing.quantity + 1);
          await applyBarcodeUpdate(
            existing,
            {
              quantity: nextQty,
              note: params.note ? params.note.slice(0, 300) : existing.note,
            },
            `Cộng dồn mã ${cleanCode} lên SL ${nextQty}`
          );
          notify('success', `Đã cộng dồn ${cleanCode} (SL: ${nextQty})`);
          return;
        }
      }

      if (backendMode === 'supabase' && supabaseClient) {
        setSyncState('syncing');
        const newId =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const res = await createBarcodeScanInSupabase(supabaseClient, {
          id: newId,
          ownerId: currentUser.uid,
          ownerEmail: currentUser.email,
          code: cleanCode,
          format: params.format.slice(0, 40) || 'BARCODE',
          sessionName: cleanSession,
          quantity: 1,
          note: params.note.slice(0, 300),
        });
        if (res.error || !res.data) {
          setSyncState('error');
          notify('error', res.error || 'Không thể lưu mã vạch.');
          return;
        }
        const created = res.data;
        setScans((prev) =>
          prev.some((s) => s.id === created.id) ? prev : [created, ...prev]
        );
        setSyncState('synced');
        setLastSyncedAt(new Date().toISOString());
        await recordActivity(
          'barcode',
          'create',
          created.id,
          `Quét mới mã ${cleanCode} (Phiên: ${cleanSession})`,
          { code: cleanCode, sessionName: cleanSession, quantity: 1 }
        );
        notify('success', `Đã lưu mã vạch ${cleanCode}`);
        return;
      }

      try {
        await addDoc(collection(db, 'barcode_scans'), {
          ownerId: currentUser.uid,
          ownerEmail: currentUser.email,
          code: cleanCode,
          format: params.format.slice(0, 40) || 'BARCODE',
          sessionName: cleanSession,
          quantity: 1,
          note: params.note.slice(0, 300),
          syncedToSupabase: false,
          scannedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        notify('success', `Đã lưu mã vạch ${cleanCode}`);
      } catch (error) {
        reportFirestoreError(
          error,
          OperationType.CREATE,
          'barcode_scans',
          'Không thể lưu mã vạch'
        );
      }
    },
    [
      currentUser,
      scans,
      permissions.scopeAll,
      backendMode,
      supabaseClient,
      applyBarcodeUpdate,
      recordActivity,
      notify,
      reportFirestoreError,
    ]
  );

  const handleUpdateScanQuantity = useCallback(
    async (scan: BarcodeScan, newQty: number) => {
      const safeQty = Math.max(1, Math.min(999999, Math.round(newQty)));
      await applyBarcodeUpdate(
        scan,
        { quantity: safeQty },
        `Cập nhật số lượng mã ${scan.code}: ${scan.quantity} -> ${safeQty}`
      );
    },
    [applyBarcodeUpdate]
  );

  const handleUpdateScanNote = useCallback(
    async (scan: BarcodeScan, newNote: string) => {
      await applyBarcodeUpdate(
        scan,
        { note: newNote.slice(0, 300) },
        `Cập nhật ghi chú mã ${scan.code}`
      );
      notify('success', 'Đã cập nhật ghi chú mã vạch.');
    },
    [applyBarcodeUpdate, notify]
  );

  const handleDeleteScan = useCallback(
    async (scan: BarcodeScan) => {
      if (backendMode === 'supabase' && supabaseClient) {
        setSyncState('syncing');
        const res = await deleteBarcodeScansInSupabase(supabaseClient, [scan.id]);
        if (res.error) {
          setSyncState('error');
          notify('error', res.error);
          return;
        }
        setScans((prev) => prev.filter((s) => s.id !== scan.id));
        setSyncState('synced');
        setLastSyncedAt(new Date().toISOString());
        await recordActivity(
          'barcode',
          'delete',
          scan.id,
          `Xóa mã ${scan.code} (SL: ${scan.quantity}, Phiên: ${scan.sessionName})`
        );
        notify('info', `Đã xóa mã ${scan.code}`);
        return;
      }

      const ref = doc(db, 'barcode_scans', scan.id);
      try {
        await deleteDoc(ref);
        notify('info', `Đã xóa mã ${scan.code}`);
      } catch (error) {
        reportFirestoreError(
          error,
          OperationType.DELETE,
          `barcode_scans/${scan.id}`,
          'Không thể xóa mã vạch'
        );
      }
    },
    [backendMode, supabaseClient, recordActivity, notify, reportFirestoreError]
  );

  const handleClearScans = useCallback(
    async (label: string, items: BarcodeScan[]) => {
      if (items.length === 0) return;
      if (backendMode === 'supabase' && supabaseClient) {
        setSyncState('syncing');
        const ids = items.map((i) => i.id);
        const res = await deleteBarcodeScansInSupabase(supabaseClient, ids);
        if (res.error) {
          setSyncState('error');
          notify('error', res.error);
          return;
        }
        const idSet = new Set(ids);
        setScans((prev) => prev.filter((s) => !idSet.has(s.id)));
        setSyncState('synced');
        setLastSyncedAt(new Date().toISOString());
        await recordActivity(
          'barcode',
          'delete',
          label,
          `Xóa ${items.length} dòng mã vạch (Bộ lọc: ${label})`
        );
        notify('info', `Đã xóa ${items.length} dòng mã vạch.`);
        return;
      }

      try {
        const chunkSize = 400;
        for (let i = 0; i < items.length; i += chunkSize) {
          const batch = writeBatch(db);
          for (const item of items.slice(i, i + chunkSize)) {
            batch.delete(doc(db, 'barcode_scans', item.id));
          }
          await batch.commit();
        }
        notify('info', `Đã xóa ${items.length} dòng mã vạch.`);
      } catch (error) {
        reportFirestoreError(
          error,
          OperationType.DELETE,
          'barcode_scans',
          'Không thể xóa danh sách mã vạch'
        );
      }
    },
    [backendMode, supabaseClient, recordActivity, notify, reportFirestoreError]
  );

  // ============================================================================
  // Work Schedule CRUD Handlers (with ShiftDefinition + DO quota fields)
  // ============================================================================
  const handleCreateSchedule = useCallback(
    async (data: {
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
    }) => {
      if (!currentUser || !currentUser.email) return;

      if (backendMode === 'supabase' && supabaseClient) {
        setSyncState('syncing');
        const newId =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const res = await createWorkScheduleInSupabase(supabaseClient, {
          id: newId,
          ownerId: currentUser.uid,
          ownerEmail: currentUser.email,
          employeeName: data.employeeName.slice(0, 120),
          title: data.title.slice(0, 150),
          workDate: data.workDate,
          shiftType: data.shiftType,
          shiftId: data.shiftId,
          isDayOff: data.isDayOff,
          overrideApproved: data.overrideApproved,
          overrideReason: data.overrideReason,
          startTime: data.startTime,
          endTime: data.endTime,
          location: data.location.slice(0, 150),
          note: data.note.slice(0, 400),
        });
        if (res.error || !res.data) {
          setSyncState('error');
          notify('error', res.error || 'Không thể đăng ký lịch làm việc.');
          return;
        }
        const created = res.data;
        setSchedules((prev) =>
          prev.some((w) => w.id === created.id)
            ? prev
            : [...prev, created].sort((a, b) =>
                a.workDate !== b.workDate
                  ? a.workDate.localeCompare(b.workDate)
                  : a.startTime.localeCompare(b.startTime)
              )
        );
        setSyncState('synced');
        setLastSyncedAt(new Date().toISOString());
        await recordActivity(
          'schedule',
          'create',
          created.id,
          `Đăng ký "${created.title}" (${created.employeeName} · ${created.workDate})`,
          {
            workDate: created.workDate,
            startTime: created.startTime,
            endTime: created.endTime,
            isDayOff: Boolean(created.isDayOff),
          }
        );
        notify('success', 'Đã đăng ký lịch làm việc mới.');
        return;
      }

      try {
        await addDoc(collection(db, 'work_schedules'), {
          ownerId: currentUser.uid,
          ownerEmail: currentUser.email,
          employeeName: data.employeeName.slice(0, 120),
          title: data.title.slice(0, 150),
          workDate: data.workDate,
          shiftType: data.shiftType,
          startTime: data.startTime,
          endTime: data.endTime,
          location: data.location.slice(0, 150),
          status: 'registered',
          note: data.note.slice(0, 400),
          syncedToSupabase: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        notify('success', 'Đã đăng ký lịch làm việc mới.');
      } catch (error) {
        reportFirestoreError(
          error,
          OperationType.CREATE,
          'work_schedules',
          'Không thể đăng ký lịch làm việc'
        );
      }
    },
    [currentUser, backendMode, supabaseClient, recordActivity, notify, reportFirestoreError]
  );

  const handleUpdateSchedule = useCallback(
    async (
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
    ) => {
      if (!currentUser?.email) return;

      if (backendMode === 'supabase' && supabaseClient) {
        setSyncState('syncing');
        const res = await updateWorkScheduleWithVersion(supabaseClient, {
          id: schedule.id,
          expectedVersion: schedule.version,
          actorEmail: currentUser.email,
          updates,
        });

        if (res.status === 'error') {
          setSyncState('error');
          notify('error', res.error);
          return;
        }

        if (res.status === 'conflict') {
          setSyncState('connected');
          const srv = res.serverRecord;
          if (!srv) {
            setSchedules((prev) => prev.filter((w) => w.id !== schedule.id));
            notify('info', `Ca "${schedule.title}" đã bị người khác xóa.`);
            return;
          }
          setActiveConflict({
            entity: 'work_schedules',
            recordId: schedule.id,
            title: `Ca làm "${schedule.title}"`,
            expectedVersion: schedule.version,
            serverVersion: srv.version,
            serverUpdatedBy: srv.updatedBy,
            serverUpdatedAt: srv.updatedAt,
            localSummary: `${updates.title || schedule.title} · ${updates.status || schedule.status} (${updates.workDate || schedule.workDate})`,
            serverSummary: `${srv.title} · ${srv.status} (${srv.workDate})`,
            onReloadLatest: () => {
              setSchedules((prev) => prev.map((w) => (w.id === srv.id ? srv : w)));
              notify('info', 'Đã tải bản lịch làm việc mới nhất.');
            },
            onForceOverwrite: async () => {
              await handleUpdateSchedule(srv, updates);
            },
          });
          return;
        }

        const updated = res.data;
        setSchedules((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
        setSyncState('synced');
        setLastSyncedAt(new Date().toISOString());

        const act: ActivityAction =
          updates.status === 'confirmed' || updates.status === 'completed'
            ? 'approve'
            : updates.status === 'cancelled'
              ? 'cancel'
              : 'update';
        await recordActivity(
          'schedule',
          act,
          updated.id,
          `${act === 'approve' ? 'Phê duyệt' : act === 'cancel' ? 'Hủy' : 'Cập nhật'} ca "${updated.title}" (${updated.workDate})`,
          updates as Record<string, unknown>
        );
        notify('success', 'Đã cập nhật lịch làm việc.');
        return;
      }

      const ref = doc(db, 'work_schedules', schedule.id);
      try {
        await updateDoc(ref, {
          ...updates,
          syncedToSupabase: false,
          updatedAt: serverTimestamp(),
        });
        notify('success', 'Đã cập nhật lịch làm việc.');
      } catch (error) {
        reportFirestoreError(
          error,
          OperationType.UPDATE,
          `work_schedules/${schedule.id}`,
          'Không thể cập nhật lịch làm việc'
        );
      }
    },
    [currentUser, backendMode, supabaseClient, recordActivity, notify, reportFirestoreError]
  );

  const handleDeleteSchedule = useCallback(
    async (schedule: WorkSchedule) => {
      if (backendMode === 'supabase' && supabaseClient) {
        setSyncState('syncing');
        const res = await deleteWorkScheduleInSupabase(supabaseClient, schedule.id);
        if (res.error) {
          setSyncState('error');
          notify('error', res.error);
          return;
        }
        setSchedules((prev) => prev.filter((w) => w.id !== schedule.id));
        setSyncState('synced');
        setLastSyncedAt(new Date().toISOString());
        await recordActivity(
          'schedule',
          'delete',
          schedule.id,
          `Xóa ca "${schedule.title}" (${schedule.workDate})`
        );
        notify('info', `Đã xóa ca "${schedule.title}".`);
        return;
      }

      const ref = doc(db, 'work_schedules', schedule.id);
      try {
        await deleteDoc(ref);
        notify('info', `Đã xóa ca "${schedule.title}".`);
      } catch (error) {
        reportFirestoreError(
          error,
          OperationType.DELETE,
          `work_schedules/${schedule.id}`,
          'Không thể xóa lịch làm việc'
        );
      }
    },
    [backendMode, supabaseClient, recordActivity, notify, reportFirestoreError]
  );

  // ============================================================================
  // Supabase Config & Zero-Data-Loss Migration Handlers
  // ============================================================================
  const applyValidatedSupabaseConfig = useCallback(
    async (
      normalized: SupabaseConfig,
      source: SupabaseConfigSource,
      persistToFirestore: boolean
    ) => {
      const prevRef = extractSupabaseProjectRef(supabaseConfig.url);
      const nextRef = extractSupabaseProjectRef(normalized.url);
      if (prevRef && nextRef && prevRef !== nextRef) {
        if (realtimeRef.current) {
          await realtimeRef.current.unsubscribe();
          realtimeRef.current = null;
        }
        if (supabaseClient && supabaseSession) {
          await supabaseClient.auth.signOut();
        }
        resetCachedSupabaseClient();
        setSupabaseSession(null);
        setScans([]);
        setSchedules([]);
        setActivityLogs([]);
        setAuthorizedMembers([]);
      }

      setSupabaseConfig(normalized);
      setSupabaseConfigSource(source);
      setConfigConflictWarning(null);

      if (persistToFirestore && firebaseUser) {
        const userRef = doc(db, 'users', firebaseUser.uid);
        try {
          const snap = await getDoc(userRef);
          if (snap.exists()) {
            await updateDoc(userRef, {
              supabaseUrl: normalized.url.slice(0, 300),
              supabaseAnonKey: normalized.anonKey.slice(0, 500),
              updatedAt: serverTimestamp(),
            });
          } else {
            const safeEmail = firebaseUser.email || '';
            const safeName =
              firebaseUser.displayName || safeEmail.split('@')[0] || 'Người dùng';
            const payload: Record<string, unknown> = {
              uid: firebaseUser.uid,
              email: safeEmail,
              displayName: safeName.slice(0, 120),
              supabaseUrl: normalized.url.slice(0, 300),
              supabaseAnonKey: normalized.anonKey.slice(0, 500),
              updatedAt: serverTimestamp(),
            };
            if (firebaseUser.photoURL) {
              payload.photoURL = firebaseUser.photoURL.slice(0, 500);
            }
            await setDoc(userRef, payload);
          }
        } catch (error) {
          reportFirestoreError(
            error,
            OperationType.UPDATE,
            `users/${firebaseUser.uid}`,
            'Không thể lưu cấu hình lên hồ sơ đám mây'
          );
        }
      }
    },
    [
      supabaseConfig.url,
      supabaseClient,
      supabaseSession,
      firebaseUser,
      reportFirestoreError,
    ]
  );

  const handleSaveSupabaseConfig = useCallback(
    async (cfg: SupabaseConfig) => {
      const check = validateSupabaseConfig(cfg);
      if (!check.valid) {
        throw new Error(
          check.urlError || check.keyError || 'Cấu hình Supabase không hợp lệ.'
        );
      }
      await applyValidatedSupabaseConfig(check.normalized, 'manual', true);
      notify('success', 'Đã lưu cấu hình Supabase.');
    },
    [applyValidatedSupabaseConfig, notify]
  );

  const handleRestoreEnvConfig = useCallback(async () => {
    const baseline = envBaselineRef.current;
    if (!baseline) {
      notify('error', 'Không có cấu hình biến môi trường hợp lệ để khôi phục.');
      return;
    }
    await applyValidatedSupabaseConfig(baseline.config, baseline.source, true);
    setEnvValidationError(null);
    notify('success', 'Đã đồng bộ cấu hình theo biến môi trường hệ thống.');
  }, [applyValidatedSupabaseConfig, notify]);

  const handleForceResync = useCallback(async () => {
    if (backendMode === 'supabase') {
      setIsSyncing(true);
      try {
        await hydrateSupabaseData();
        notify('success', 'Đã đồng bộ lại dữ liệu mới nhất từ Supabase.');
      } finally {
        setIsSyncing(false);
      }
    }
  }, [backendMode, hydrateSupabaseData, notify]);

  const handleMigrateFromFirebase = useCallback(async () => {
    if (!supabaseReady || !permissions.allowSupabase) return;
    if (backendMode !== 'supabase' || !supabaseClient) {
      notify(
        'info',
        'Vui lòng đăng nhập Supabase Auth trong mục Quản lý Supabase trước khi chuyển dữ liệu.'
      );
      setActiveTab('supabase');
      return;
    }
    if (!firebaseUser) {
      notify('info', 'Không có phiên Firebase cũ để chuyển dữ liệu.');
      return;
    }

    setIsSyncing(true);
    setSyncState('syncing');
    try {
      const [fbScansSnap, fbSchedSnap, fbMembersSnap] = await Promise.all([
        getDocs(collection(db, 'barcode_scans')),
        getDocs(collection(db, 'work_schedules')),
        permissions.role === 'store_manager'
          ? getDocs(collection(db, 'authorized_emails'))
          : Promise.resolve(null),
      ]);

      const fbScans: BarcodeScan[] = fbScansSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ownerId: String(data.ownerId || ''),
          ownerEmail: String(data.ownerEmail || ''),
          code: String(data.code || ''),
          format: String(data.format || 'BARCODE'),
          sessionName: String(data.sessionName || 'Mặc định'),
          quantity: Number(data.quantity || 1),
          note: String(data.note || ''),
          version: Number(data.version || 1),
          updatedBy: String(data.updatedBy || data.ownerEmail || ''),
          syncedToSupabase: true,
          scannedAt: toIso(data.scannedAt),
          updatedAt: toIso(data.updatedAt),
        };
      });

      const fbSchedules: WorkSchedule[] = fbSchedSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ownerId: String(data.ownerId || ''),
          ownerEmail: String(data.ownerEmail || ''),
          employeeName: String(data.employeeName || ''),
          title: String(data.title || ''),
          workDate: String(data.workDate || ''),
          shiftType: (data.shiftType as ShiftType) || 'custom',
          startTime: String(data.startTime || '08:00'),
          endTime: String(data.endTime || '17:00'),
          location: String(data.location || ''),
          status: (data.status as ScheduleStatus) || 'registered',
          note: String(data.note || ''),
          approvedBy: String(data.approvedBy || ''),
          approvedAt: toIso(data.approvedAt),
          version: Number(data.version || 1),
          updatedBy: String(data.updatedBy || data.ownerEmail || ''),
          syncedToSupabase: true,
          createdAt: toIso(data.createdAt),
          updatedAt: toIso(data.updatedAt),
        };
      });

      const [scanRes, schedRes] = await Promise.all([
        pushBarcodeScansToSupabase(supabaseConfig, fbScans),
        pushSchedulesToSupabase(supabaseConfig, fbSchedules),
      ]);

      if (scanRes.error || schedRes.error) {
        setSyncState('error');
        notify('error', scanRes.error || schedRes.error || 'Chuyển dữ liệu gặp lỗi.');
        return;
      }

      if (fbMembersSnap && currentUser?.email) {
        for (const d of fbMembersSnap.docs) {
          const data = d.data();
          const memberEmail = normalizeEmail(String(data.email || ''));
          if (!memberEmail || memberEmail === SUPER_ADMIN_EMAIL) continue;
          const role = normalizeRole(data.role);
          const defaults = ROLE_DEFAULT_PERMS[role];
          const res = await saveUserAccessInSupabase(supabaseClient, {
            email: memberEmail,
            displayName:
              String(data.displayName || '').trim() || memberEmail.split('@')[0],
            role,
            active: Boolean(data.active),
            scopeAll: Boolean(data.scopeAll ?? defaults.scopeAll),
            barcodeView: Boolean(data.barcodeView ?? data.allowBarcode ?? defaults.barcodeView),
            barcodeCreate: Boolean(
              data.barcodeCreate ?? data.allowBarcode ?? defaults.barcodeCreate
            ),
            barcodeEdit: Boolean(data.barcodeEdit ?? data.allowBarcode ?? defaults.barcodeEdit),
            barcodeDelete: Boolean(data.barcodeDelete ?? defaults.barcodeDelete),
            scheduleView: Boolean(
              data.scheduleView ?? data.allowSchedule ?? defaults.scheduleView
            ),
            scheduleCreate: Boolean(
              data.scheduleCreate ?? data.allowSchedule ?? defaults.scheduleCreate
            ),
            scheduleEdit: Boolean(
              data.scheduleEdit ?? data.allowSchedule ?? defaults.scheduleEdit
            ),
            scheduleDelete: Boolean(data.scheduleDelete ?? defaults.scheduleDelete),
            scheduleApprove: Boolean(data.scheduleApprove ?? defaults.scheduleApprove),
            allowExport: Boolean(data.allowExport ?? defaults.allowExport),
            activityView: Boolean(data.activityView ?? defaults.activityView),
            allowSupabase: Boolean(data.allowSupabase ?? defaults.allowSupabase),
            modulePerms: defaults.modulePerms,
            note: String(data.note || ''),
            grantedBy: currentUser.email,
            isEdit: false,
          });
          if (res.status === 'error') {
            setSyncState('error');
            notify('error', `Lỗi chuyển phân quyền (${memberEmail}): ${res.error}`);
            return;
          }
        }
      }

      await recordActivity(
        'system',
        'migrate',
        'firebase-migration',
        `Chuyển ${scanRes.syncedIds.length} mã vạch và ${schedRes.syncedIds.length} lịch làm việc từ Firebase sang Supabase`
      );

      setSyncState('synced');
      setLastSyncedAt(new Date().toISOString());
      notify(
        'success',
        `Đã chuyển an toàn ${scanRes.syncedIds.length} mã vạch và ${schedRes.syncedIds.length} lịch làm việc sang Supabase.`
      );
      await hydrateSupabaseData();
    } catch (err) {
      setSyncState('error');
      notify(
        'error',
        err instanceof Error ? err.message : 'Chuyển dữ liệu sang Supabase thất bại.'
      );
    } finally {
      setIsSyncing(false);
    }
  }, [
    supabaseReady,
    permissions.allowSupabase,
    permissions.role,
    supabaseConfig,
    supabaseClient,
    firebaseUser,
    currentUser,
    backendMode,
    hydrateSupabaseData,
    recordActivity,
    notify,
  ]);

  const handleSignOut = useCallback(async () => {
    if (realtimeRef.current) {
      await realtimeRef.current.unsubscribe();
      realtimeRef.current = null;
    }
    if (supabaseClient && supabaseSession) {
      await supabaseClient.auth.signOut();
    }
    if (firebaseUser) {
      await signOutFirebase();
    }
  }, [supabaseClient, supabaseSession, firebaseUser]);

  // ============================================================================
  // Render Gates
  // ============================================================================
  if (orphanedCallback) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6 space-y-4 text-center">
          <div className="h-10 w-10 rounded-lg bg-blue-600 text-white flex items-center justify-center mx-auto">
            <ScanBarcode className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-bold text-slate-900">
            {orphanedCallback.error
              ? 'Đăng nhập Google chưa hoàn tất'
              : 'Đã nhận phản hồi xác thực từ Google'}
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            {orphanedCallback.error
              ? orphanedCallback.error
              : 'Do trình duyệt chặn giao tiếp giữa cửa sổ popup và khung nhúng, bạn có thể đóng cửa sổ này và dùng Mã OTP Email, hoặc nhấn nút bên dưới để sử dụng ứng dụng trực tiếp trên tab trình duyệt riêng.'}
          </p>
          <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => window.location.assign(window.location.origin)}
              className="min-h-[44px] flex-1 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
            >
              Mở ứng dụng ở tab này
            </button>
            <button
              type="button"
              onClick={() => window.close()}
              className="min-h-[44px] px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Đóng cửa sổ
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!authReady || (currentUser && !accessChecked)) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <div className="h-9 w-9 rounded-lg bg-blue-600 text-white flex items-center justify-center mx-auto">
            <ScanBarcode className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-slate-600">
            Đang kiểm tra xác thực và phân quyền tài khoản...
          </p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <SignInScreen
        supabaseConfig={supabaseConfig}
        onSupabaseSessionReady={(session) => {
          if (session) setSupabaseSession(session);
          setSyncState('connecting');
        }}
      />
    );
  }

  if (!permissions.authorized) {
    return (
      <AccessPendingScreen
        email={currentUser.email}
        deactivated={accessDeactivated}
        checking={recheckingAccess}
        onRecheck={handleRecheckAccess}
        onSignOut={handleSignOut}
      />
    );
  }

  const isStoreManager = permissions.role === 'store_manager';
  const canSeeTab = (tab: AppTab): boolean => {
    if (tab === 'supabase' && permissions.allowSupabase) return true;
    return Boolean(permissions.modules[tab]);
  };

  const selectTab = (tab: AppTab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  const todayStr = new Date().toISOString().slice(0, 10);
  const myTodaySchedules = schedules.filter(
    (s) =>
      s.workDate === todayStr &&
      normalizeEmail(s.ownerEmail) === normalizeEmail(currentUser.email) &&
      s.status !== 'cancelled'
  );

  const sidebarCompact = uiPrefs.compactSidebar;

  const renderSidebarNav = (mobileMode = false) => (
    <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
      {NAV_GROUPS.map((group) => {
        const items = NAV_ITEMS.filter(
          (item) => item.group === group.id && canSeeTab(item.id)
        );
        if (items.length === 0) return null;
        const isCollapsed = !mobileMode && !sidebarCompact && collapsedGroups[group.id];

        return (
          <div key={group.id}>
            {!sidebarCompact || mobileMode ? (
              <button
                type="button"
                onClick={() =>
                  setCollapsedGroups((prev) => ({
                    ...prev,
                    [group.id]: !prev[group.id],
                  }))
                }
                className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-600"
              >
                <span>{group.label}</span>
                {!mobileMode &&
                  (isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ))}
              </button>
            ) : (
              <div className="h-px bg-slate-100 my-1.5 mx-2" />
            )}

            {!isCollapsed && (
              <div className="mt-1 space-y-0.5">
                {items.map((item) => {
                  const Icon = TAB_ICONS[item.id];
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      title={item.label}
                      onClick={() => selectTab(item.id)}
                      className={`w-full min-h-[42px] flex items-center ${
                        sidebarCompact && !mobileMode
                          ? 'justify-center px-2'
                          : 'justify-between px-3'
                      } py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                        isActive
                          ? 'bg-blue-50 text-blue-700 font-semibold'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <Icon className="h-[18px] w-[18px] shrink-0" />
                        {(!sidebarCompact || mobileMode) && (
                          <span className="truncate">{item.label}</span>
                        )}
                      </span>
                      {(!sidebarCompact || mobileMode) && item.id === 'scanner' && (
                        <span className="text-xs text-slate-400 tabular-nums">
                          {scans.length}
                        </span>
                      )}
                      {(!sidebarCompact || mobileMode) && item.id === 'schedule' && (
                        <span className="text-xs text-slate-400 tabular-nums">
                          {schedules.length}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      {/* Desktop / Tablet Collapsible Sidebar */}
      <aside
        className={`hidden md:flex md:flex-col md:fixed md:inset-y-0 bg-white border-r border-slate-200 z-30 transition-all duration-200 ${
          sidebarCompact ? 'md:w-20' : 'md:w-64 lg:w-72'
        }`}
      >
        <div
          className={`h-16 px-4 flex items-center border-b border-slate-200 ${
            sidebarCompact ? 'justify-center' : 'justify-between'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-9 w-9 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
              <ScanBarcode className="h-5 w-5" />
            </div>
            {!sidebarCompact && (
              <span className="text-base font-bold tracking-tight text-slate-900 truncate">
                Vận Hành TPCN
              </span>
            )}
          </div>
          {!sidebarCompact && (
            <button
              type="button"
              onClick={() =>
                setUiPrefs((prev) => ({ ...prev, compactSidebar: true }))
              }
              className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
              aria-label="Thu gọn thanh bên"
              title="Thu gọn thanh bên"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
        </div>

        {sidebarCompact && (
          <div className="px-2 pt-2 flex justify-center">
            <button
              type="button"
              onClick={() =>
                setUiPrefs((prev) => ({ ...prev, compactSidebar: false }))
              }
              className="p-2 text-slate-500 hover:text-slate-800 rounded-lg"
              aria-label="Mở rộng thanh bên"
              title="Mở rộng thanh bên"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </div>
        )}

        <nav className="flex-1 flex flex-col overflow-hidden" aria-label="Điều hướng chính">
          {renderSidebarNav(false)}
        </nav>

        {/* User footer */}
        <div className="p-3 border-t border-slate-200 space-y-2.5">
          <button
            type="button"
            onClick={() => selectTab('staff')}
            className={`w-full flex items-center gap-2.5 min-w-0 text-left p-1 rounded-lg hover:bg-slate-50 ${
              sidebarCompact ? 'justify-center' : ''
            }`}
            title={currentUser.displayName}
          >
            {currentUser.photoURL ? (
              <img
                src={currentUser.photoURL}
                alt={currentUser.displayName}
                referrerPolicy="no-referrer"
                className="h-9 w-9 rounded-full object-cover border border-slate-200 shrink-0"
              />
            ) : (
              <div className="h-9 w-9 rounded-full bg-slate-900 text-white flex items-center justify-center font-bold text-sm shrink-0">
                {currentUser.displayName.charAt(0).toUpperCase()}
              </div>
            )}
            {!sidebarCompact && (
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-900 truncate">
                  {currentUser.displayName}
                </p>
                <p className="text-xs text-slate-500 truncate">
                  {ROLE_LABELS[permissions.role]}
                </p>
              </div>
            )}
          </button>

          <button
            type="button"
            onClick={handleSignOut}
            title="Đăng xuất"
            className="w-full min-h-[40px] inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!sidebarCompact && <span>Đăng xuất</span>}
          </button>
        </div>
      </aside>

      {/* Mobile Slide-Over Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-slate-900/50"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-72 max-w-[85vw] bg-white h-full flex flex-col shadow-xl z-10">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-blue-600 text-white flex items-center justify-center">
                  <ScanBarcode className="h-4 w-4" />
                </div>
                <span className="font-bold text-slate-900">Vận Hành TPCN</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 text-slate-500 hover:text-slate-900"
                aria-label="Đóng menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {renderSidebarNav(true)}

            <div className="p-3 border-t border-slate-200 space-y-2.5">
              <div className="text-xs text-slate-600 truncate px-1">
                {currentUser.displayName} · {ROLE_LABELS[permissions.role]}
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50"
              >
                <LogOut className="h-4 w-4" />
                <span>Đăng xuất</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div
        className={`flex-1 flex flex-col min-w-0 transition-all duration-200 ${
          sidebarCompact ? 'md:pl-20' : 'md:pl-64 lg:pl-72'
        }`}
      >
        {/* Mobile Compact Top App Bar (56px) */}
        <header className="md:hidden sticky top-0 z-30 h-14 bg-white/95 backdrop-blur-xs border-b border-slate-200 px-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="h-10 w-10 rounded-lg text-slate-700 hover:bg-slate-100 flex items-center justify-center shrink-0"
              aria-label="Mở danh mục"
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="text-sm font-bold text-slate-900 truncate">
              {TAB_META[activeTab].title}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <SyncStatusBadge
              state={syncState}
              backendMode={backendMode}
              lastSyncedAt={lastSyncedAt}
              compact
              onRetrySync={handleForceResync}
            />
            <button
              type="button"
              onClick={() => selectTab('staff')}
              className="min-h-[40px] min-w-[36px] flex items-center justify-end shrink-0"
              aria-label="Hồ sơ cá nhân"
            >
              {currentUser.photoURL ? (
                <img
                  src={currentUser.photoURL}
                  alt={currentUser.displayName}
                  referrerPolicy="no-referrer"
                  className="h-8 w-8 rounded-full object-cover border border-slate-200"
                />
              ) : (
                <div className="h-8 w-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-bold">
                  {currentUser.displayName.charAt(0).toUpperCase()}
                </div>
              )}
            </button>
          </div>
        </header>

        {/* Desktop / Tablet Top Bar */}
        <header className="hidden md:flex h-16 bg-white border-b border-slate-200 px-6 lg:px-8 items-center justify-between gap-4 sticky top-0 z-20">
          <div className="min-w-0">
            <h1 className="text-lg lg:text-xl font-bold text-slate-900 truncate">
              {TAB_META[activeTab].title}
            </h1>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <SyncStatusBadge
              state={syncState}
              backendMode={backendMode}
              lastSyncedAt={lastSyncedAt}
              onRetrySync={handleForceResync}
            />
            <span className="hidden lg:inline text-sm text-slate-500 whitespace-nowrap">
              {ROLE_LABELS[permissions.role]} · {currentUser.email}
            </span>
            {permissions.allowSupabase && (
              <button
                type="button"
                onClick={() => selectTab('supabase')}
                className="min-h-[38px] inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 whitespace-nowrap"
              >
                <Database
                  className={`h-4 w-4 ${
                    backendMode === 'supabase'
                      ? 'text-emerald-600'
                      : supabaseReady
                        ? 'text-blue-600'
                        : 'text-slate-400'
                  }`}
                />
                <span>
                  {backendMode === 'supabase'
                    ? 'Supabase Realtime'
                    : supabaseReady
                      ? 'Supabase sẵn sàng'
                      : 'Cài đặt Supabase'}
                </span>
              </button>
            )}
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 px-3 sm:px-6 lg:px-8 py-4 sm:py-6 pb-24 md:pb-10 max-w-7xl w-full mx-auto">
          <p className="text-sm text-slate-600 mb-5 hidden md:block">
            {TAB_META[activeTab].subtitle}
          </p>

          <Suspense fallback={<ModuleSuspenseFallback />}>
            {/* Group 1: Vận hành */}
            {activeTab === 'overview' && canSeeTab('overview') && (
              <OverviewTab
                client={supabaseClient}
                user={currentUser}
                modules={permissions.modules}
                onNavigate={selectTab}
              />
            )}

            {activeTab === 'schedule' && canSeeTab('schedule') && (
              <WorkScheduleTab
                client={supabaseClient}
                schedules={schedules}
                shifts={shifts}
                leaveRules={leaveRules}
                loading={schedulesLoading}
                defaultEmployeeName={currentUser.displayName}
                currentUserEmail={currentUser.email}
                canCreate={permissions.scheduleCreate}
                canEdit={permissions.scheduleEdit}
                canDelete={permissions.scheduleDelete}
                canApprove={permissions.scheduleApprove}
                canExport={permissions.allowExport}
                canSupabase={permissions.allowSupabase}
                showOwnerEmail={permissions.scopeAll}
                isStoreManager={isStoreManager}
                supabaseReady={supabaseReady}
                isSyncing={isSyncing}
                onCreateSchedule={handleCreateSchedule}
                onUpdateSchedule={handleUpdateSchedule}
                onDeleteSchedule={handleDeleteSchedule}
                onSyncToSupabase={handleMigrateFromFirebase}
                onRefreshShifts={refreshShiftsAndRules}
                onExportLogged={(fileName, count) => {
                  void recordActivity(
                    'export',
                    'export',
                    fileName,
                    `Xuất lịch làm việc (${count} dòng): ${fileName}`
                  );
                }}
                onNotify={notify}
              />
            )}

            {activeTab === 'attendance' && canSeeTab('attendance') && (
              <AttendanceTab
                client={supabaseClient}
                user={currentUser}
                todaySchedules={myTodaySchedules}
                shifts={shifts}
                defaultPageSize={uiPrefs.defaultPageSize}
                canExport={permissions.allowExport}
                onNotify={notify}
                onLogActivity={(action, targetId, summary) => {
                  void recordActivity('attendance', action, targetId, summary);
                }}
              />
            )}

            {activeTab === 'staff' && canSeeTab('staff') && (
              <StaffProfileTab
                client={supabaseClient}
                user={currentUser}
                members={authorizedMembers}
                onProfileUpdated={(newName) => setCustomDisplayName(newName)}
                onNotify={notify}
              />
            )}

            {activeTab === 'feedback' && canSeeTab('feedback') && (
              <CustomerFeedbackTab
                client={supabaseClient}
                user={currentUser}
                canDeleteAny={
                  permissions.role === 'store_manager' ||
                  permissions.role === 'supervisor'
                }
                defaultPageSize={uiPrefs.defaultPageSize}
                onNotify={notify}
                onLogActivity={(action, targetId, summary) => {
                  void recordActivity('feedback', action, targetId, summary);
                }}
              />
            )}

            {/* Group 2: Hàng hóa */}
            {activeTab === 'warehouse' && canSeeTab('warehouse') && (
              <DataWarehouseTab
                client={supabaseClient}
                user={currentUser}
                canEdit={permissions.role !== 'staff'}
                canExport={permissions.allowExport}
                defaultPageSize={uiPrefs.defaultPageSize}
                onNotify={notify}
                onLogActivity={(action, targetId, summary) => {
                  void recordActivity('warehouse', action, targetId, summary);
                }}
              />
            )}

            {activeTab === 'scanner' && canSeeTab('scanner') && (
              <BarcodeScannerTab
                scans={scans}
                loading={scansLoading}
                canCreate={permissions.barcodeCreate}
                canEdit={permissions.barcodeEdit}
                canDelete={permissions.barcodeDelete}
                canExport={permissions.allowExport}
                canSupabase={permissions.allowSupabase}
                showOwnerEmail={permissions.scopeAll}
                supabaseReady={supabaseReady}
                isSyncing={isSyncing}
                onAddOrIncrementScan={handleAddOrIncrementScan}
                onUpdateQuantity={handleUpdateScanQuantity}
                onUpdateNote={handleUpdateScanNote}
                onDeleteScan={handleDeleteScan}
                onClearSession={handleClearScans}
                onSyncToSupabase={handleMigrateFromFirebase}
                onExportLogged={(fileName, count) => {
                  void recordActivity(
                    'export',
                    'export',
                    fileName,
                    `Xuất báo cáo Excel mã vạch (${count} dòng): ${fileName}`
                  );
                }}
                onNotify={notify}
              />
            )}

            {activeTab === 'expiry' && canSeeTab('expiry') && (
              <ExpiryControlTab
                client={supabaseClient}
                user={currentUser}
                canDelete={
                  permissions.role === 'store_manager' ||
                  permissions.role === 'supervisor'
                }
                canExport={permissions.allowExport}
                defaultPageSize={uiPrefs.defaultPageSize}
                onNotify={notify}
                onLogActivity={(action, targetId, summary) => {
                  void recordActivity('expiry', action, targetId, summary);
                }}
              />
            )}

            {activeTab === 'returns' && canSeeTab('returns') && (
              <GoodsReturnTab
                client={supabaseClient}
                user={currentUser}
                canDelete={
                  permissions.role === 'store_manager' ||
                  permissions.role === 'supervisor'
                }
                canExport={permissions.allowExport}
                defaultPageSize={uiPrefs.defaultPageSize}
                onNotify={notify}
                onLogActivity={(action, targetId, summary) => {
                  void recordActivity('returns', action, targetId, summary);
                }}
              />
            )}

            {activeTab === 'promotions' && canSeeTab('promotions') && (
              <PromotionsTab
                client={supabaseClient}
                user={currentUser}
                canEdit={permissions.role !== 'staff'}
                canDelete={
                  permissions.role === 'store_manager' ||
                  permissions.role === 'supervisor'
                }
                canExport={permissions.allowExport}
                autoResetIdle={uiPrefs.autoResetPromoIdle}
                defaultPageSize={uiPrefs.defaultPageSize}
                onNotify={notify}
                onLogActivity={(action, targetId, summary) => {
                  void recordActivity('promotions', action, targetId, summary);
                }}
              />
            )}

            {/* Group 3: Hệ thống & dữ liệu */}
            {activeTab === 'supabase' && canSeeTab('supabase') && (
              <div className="space-y-6 max-w-3xl">
                <SupabasePanel
                  config={supabaseConfig}
                  configSource={supabaseConfigSource}
                  runtimeEnv={runtimeEnv}
                  envBaselineConfig={envBaselineConfig}
                  envValidationError={envValidationError}
                  configConflictWarning={configConflictWarning}
                  backendMode={backendMode}
                  syncState={syncState}
                  lastSyncedAt={lastSyncedAt}
                  legacyCounts={{
                    scans: scans.filter((s) => !s.syncedToSupabase).length,
                    schedules: schedules.filter((w) => !w.syncedToSupabase).length,
                    members: authorizedMembers.length,
                  }}
                  isSyncing={isSyncing}
                  currentUserEmail={currentUser.email}
                  supabaseEmail={supabaseSession?.user?.email || null}
                  onSaveConfig={handleSaveSupabaseConfig}
                  onRestoreEnvConfig={handleRestoreEnvConfig}
                  onForceResync={handleForceResync}
                  onMigrateFromFirebase={handleMigrateFromFirebase}
                  onSupabaseSignedIn={(session) => {
                    if (session) setSupabaseSession(session);
                    setSyncState('connecting');
                  }}
                  onNotify={notify}
                />
              </div>
            )}

            {activeTab === 'monitoring' && canSeeTab('monitoring') && (
              <ResourceMonitorTab
                config={supabaseConfig}
                session={supabaseSession}
              />
            )}

            {activeTab === 'storage' && canSeeTab('storage') && (
              <StorageManagerTab
                client={supabaseClient}
                user={currentUser}
                canManageAll={
                  permissions.role === 'store_manager' ||
                  permissions.role === 'supervisor'
                }
                defaultPageSize={uiPrefs.defaultPageSize}
                onNotify={notify}
                onLogActivity={(action, targetId, summary) => {
                  void recordActivity('storage', action, targetId, summary);
                }}
              />
            )}

            {activeTab === 'settings' && canSeeTab('settings') && (
              <SettingsTab
                client={supabaseClient}
                actorEmail={currentUser.email}
                isStoreManager={isStoreManager}
                leaveRules={leaveRules}
                uiPrefs={uiPrefs}
                onUpdateLeaveRules={(nextRules) => setLeaveRules(nextRules)}
                onUpdateUiPrefs={(nextPrefs) => setUiPrefs(nextPrefs)}
                onNotify={notify}
              />
            )}

            {activeTab === 'access' && isStoreManager && (
              <AccessControlTab
                members={authorizedMembers}
                loading={membersLoading}
                currentUserEmail={currentUser.email}
                onSaveMember={handleSaveAuthorizedMember}
                onToggleActive={handleToggleMemberActive}
                onDeleteMember={handleDeleteMember}
                onNotify={notify}
              />
            )}

            {activeTab === 'activity' && canSeeTab('activity') && (
              <ActivityLogTab logs={activityLogs} loading={activityLoading} />
            )}
          </Suspense>
        </main>
      </div>

      {/* Compact Mobile Bottom Bar (<= 15% screen height, 4 quick actions) */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-xs border-t border-slate-200 pb-safe"
        aria-label="Điều hướng nhanh di động"
      >
        <div className="grid grid-cols-4 h-14">
          {canSeeTab('overview') && (
            <button
              type="button"
              onClick={() => selectTab('overview')}
              className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                activeTab === 'overview' ? 'text-blue-600' : 'text-slate-500'
              }`}
            >
              <LayoutDashboard className="h-5 w-5" />
              <span>Tổng quan</span>
            </button>
          )}
          {canSeeTab('schedule') && (
            <button
              type="button"
              onClick={() => selectTab('schedule')}
              className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                activeTab === 'schedule' ? 'text-blue-600' : 'text-slate-500'
              }`}
            >
              <CalendarDays className="h-5 w-5" />
              <span>Lịch làm</span>
            </button>
          )}
          {canSeeTab('scanner') ? (
            <button
              type="button"
              onClick={() => selectTab('scanner')}
              className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                activeTab === 'scanner' ? 'text-blue-600' : 'text-slate-500'
              }`}
            >
              <ScanBarcode className="h-5 w-5" />
              <span>Quét mã</span>
            </button>
          ) : canSeeTab('expiry') ? (
            <button
              type="button"
              onClick={() => selectTab('expiry')}
              className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                activeTab === 'expiry' ? 'text-blue-600' : 'text-slate-500'
              }`}
            >
              <CalendarClock className="h-5 w-5" />
              <span>Hạn SD</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
              mobileMenuOpen ? 'text-blue-600' : 'text-slate-500'
            }`}
          >
            <Menu className="h-5 w-5" />
            <span>Menu</span>
          </button>
        </div>
      </nav>

      {/* Concurrent Edit Conflict Dialog */}
      <ConflictDialog
        conflict={activeConflict}
        onClose={() => setActiveConflict(null)}
      />

      {/* Toast Stack */}
      {toasts.length > 0 && (
        <div className="fixed bottom-16 md:bottom-6 right-4 left-4 md:left-auto md:w-96 z-50 space-y-2 pointer-events-none">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="status"
              className={`pointer-events-auto flex items-center justify-between gap-3 px-4 py-3 rounded-xl border shadow-lg text-sm font-medium ${
                toast.type === 'success'
                  ? 'bg-emerald-900 border-emerald-800 text-white'
                  : toast.type === 'error'
                    ? 'bg-red-900 border-red-800 text-white'
                    : 'bg-slate-900 border-slate-800 text-white'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span className="truncate">{toast.message}</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  setToasts((prev) => prev.filter((t) => t.id !== toast.id))
                }
                className="p-1 text-white/70 hover:text-white shrink-0"
                aria-label="Đóng thông báo"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}
