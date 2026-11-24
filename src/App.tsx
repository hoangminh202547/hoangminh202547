import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  CalendarDays,
  CheckCircle2,
  Database,
  History,
  LogOut,
  ScanBarcode,
  ShieldCheck,
  UserCircle,
  X,
} from 'lucide-react';
import { AccessControlTab, type SaveMemberParams } from './components/AccessControlTab';
import { AccessPendingScreen } from './components/AccessPendingScreen';
import { ActivityLogTab } from './components/ActivityLogTab';
import { BarcodeScannerTab } from './components/BarcodeScannerTab';
import { ConflictDialog } from './components/ConflictDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SignInScreen } from './components/SignInScreen';
import { SupabasePanel } from './components/SupabasePanel';
import { SyncStatusBadge } from './components/SyncStatusBadge';
import { WorkScheduleTab } from './components/WorkScheduleTab';
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
  ROLE_DEFAULT_PERMS,
  ROLE_LABELS,
  SUPER_ADMIN_EMAIL,
  emailToKey,
  normalizeEmail,
  normalizeRole,
} from './lib/permissions';
import {
  appendActivityLog,
  createBarcodeScanInSupabase,
  createRealtimeSyncSession,
  createWorkScheduleInSupabase,
  deleteBarcodeScansInSupabase,
  deleteUserAccessInSupabase,
  deleteWorkScheduleInSupabase,
  fetchAllSyncedData,
  fetchMyAccessFromSupabase,
  getEnvSupabaseConfig,
  getSupabaseClient,
  handleSupabaseOAuthRedirectIfPresent,
  isValidSupabaseConfig,
  pushBarcodeScansToSupabase,
  pushSchedulesToSupabase,
  saveUserAccessInSupabase,
  updateBarcodeScanWithVersion,
  updateWorkScheduleWithVersion,
  upsertUserProfile,
  type RealtimeSubscriptionHandle,
} from './lib/supabase';
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
  ScheduleStatus,
  ShiftType,
  SupabaseConfig,
  SyncState,
  ToastMessage,
  UserRole,
  WorkSchedule,
} from './types';

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
      },
      deactivated: false,
    };
  }

  const active = Boolean(access.active);
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
    },
    deactivated: !active,
  };
}

function MainApp() {
  const [supabaseConfig, setSupabaseConfig] = useState<SupabaseConfig>(() =>
    getEnvSupabaseConfig()
  );
  const supabaseReady = useMemo(
    () => isValidSupabaseConfig(supabaseConfig),
    [supabaseConfig]
  );
  const supabaseClient = useMemo(
    () => (supabaseReady ? getSupabaseClient(supabaseConfig) : null),
    [supabaseReady, supabaseConfig]
  );

  // Auth states (Supabase primary when configured & signed in; Firebase fallback/migration)
  const [supabaseAuthReady, setSupabaseAuthReady] = useState(false);
  const [supabaseSession, setSupabaseSession] = useState<Session | null>(null);
  const [firebaseAuthReady, setFirebaseAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);

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
          firebaseUser.displayName ||
          (firebaseUser.email ? firebaseUser.email.split('@')[0] : 'Người dùng'),
        photoURL: firebaseUser.photoURL || undefined,
        provider: 'firebase',
      };
    }
    return null;
  }, [supabaseSession, firebaseUser]);

  const authReady = supabaseClient
    ? supabaseAuthReady && firebaseAuthReady
    : firebaseAuthReady;

  const [activeTab, setActiveTab] = useState<AppTab>('scanner');

  // Access control & permissions
  const [accessChecked, setAccessChecked] = useState(false);
  const [recheckingAccess, setRecheckingAccess] = useState(false);
  const [accessDeactivated, setAccessDeactivated] = useState(false);
  const [permissions, setPermissions] = useState<EffectivePermissions>({
    authorized: false,
    isSuperAdmin: false,
    role: 'staff',
    ...EMPTY_MODULE_PERMISSIONS,
  });

  // Core operational datasets
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
  // Auth Initialization (Supabase Auth + Firebase Auth)
  // ============================================================================
  // Unconditional OAuth popup callback relay even when Supabase config is stored in-app (not .env)
  useEffect(() => {
    void handleSupabaseOAuthRedirectIfPresent(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!supabaseClient) {
      setSupabaseSession(null);
      setSupabaseAuthReady(true);
      return;
    }

    const init = async () => {
      try {
        await handleSupabaseOAuthRedirectIfPresent(supabaseClient);
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

    const { data: sub } = supabaseClient.auth.onAuthStateChange(
      (_event, session) => {
        if (mounted) {
          setSupabaseSession(session ?? null);
          setSupabaseAuthReady(true);
        }
      }
    );

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [supabaseClient]);

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
            const envCfg = getEnvSupabaseConfig();
            if (envCfg.url) payload.supabaseUrl = envCfg.url.slice(0, 300);
            if (envCfg.anonKey) {
              payload.supabaseAnonKey = envCfg.anonKey.slice(0, 500);
            }
            await setDoc(userRef, payload);
          }
        } catch (error) {
          reportFirestoreError(
            error,
            OperationType.WRITE,
            `users/${fbUser.uid}`
          );
        }
      }
    });

    return () => unsub();
  }, [reportFirestoreError]);

  // Load saved in-app Supabase config from Firebase user profile if env is empty
  useEffect(() => {
    if (!firebaseUser) return;
    const path = `users/${firebaseUser.uid}`;
    const unsub = onSnapshot(
      doc(db, 'users', firebaseUser.uid),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const envCfg = getEnvSupabaseConfig();
          const nextUrl =
            envCfg.url ||
            (typeof data.supabaseUrl === 'string' ? data.supabaseUrl : '');
          const nextAnonKey =
            envCfg.anonKey ||
            (typeof data.supabaseAnonKey === 'string'
              ? data.supabaseAnonKey
              : '');
          setSupabaseConfig((prev) =>
            prev.url === nextUrl && prev.anonKey === nextAnonKey
              ? prev
              : { url: nextUrl, anonKey: nextAnonKey }
          );
        }
      },
      (error) => reportFirestoreError(error, OperationType.GET, path)
    );
    return () => unsub();
  }, [firebaseUser, reportFirestoreError]);

  // Reset state on sign out
  useEffect(() => {
    if (!currentUser) {
      setAccessChecked(false);
      setAccessDeactivated(false);
      setPermissions({
        authorized: false,
        isSuperAdmin: false,
        role: 'staff',
        ...EMPTY_MODULE_PERMISSIONS,
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
    await upsertUserProfile(supabaseClient, {
      uid: currentUser.uid,
      email: currentUser.email,
      displayName: currentUser.displayName,
      photoURL: currentUser.photoURL,
    });
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

    // Firebase mode RBAC listener
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
          barcodeDelete: Boolean(data.barcodeDelete ?? (role !== 'staff' ? defaults.barcodeDelete : false)),
          scheduleView: Boolean(data.scheduleView ?? data.allowSchedule ?? defaults.scheduleView),
          scheduleCreate: Boolean(data.scheduleCreate ?? data.allowSchedule ?? defaults.scheduleCreate),
          scheduleEdit: Boolean(data.scheduleEdit ?? data.allowSchedule ?? defaults.scheduleEdit),
          scheduleDelete: Boolean(data.scheduleDelete ?? defaults.scheduleDelete),
          scheduleApprove: Boolean(data.scheduleApprove ?? defaults.scheduleApprove),
          allowExport: Boolean(data.allowExport ?? defaults.allowExport),
          activityView: Boolean(data.activityView ?? defaults.activityView),
          allowSupabase: Boolean(data.allowSupabase ?? defaults.allowSupabase),
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
        const res = await fetchMyAccessFromSupabase(
          supabaseClient,
          currentUser.email
        );
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
    const isStoreManager = permissions.role === 'store_manager';
    if (activeTab === 'scanner' && !permissions.barcodeView) {
      if (permissions.scheduleView) setActiveTab('schedule');
      else if (permissions.activityView) setActiveTab('activity');
      else if (isStoreManager) setActiveTab('access');
      else setActiveTab('account');
    } else if (activeTab === 'schedule' && !permissions.scheduleView) {
      if (permissions.barcodeView) setActiveTab('scanner');
      else if (permissions.activityView) setActiveTab('activity');
      else if (isStoreManager) setActiveTab('access');
      else setActiveTab('account');
    } else if (activeTab === 'activity' && !permissions.activityView) {
      if (permissions.barcodeView) setActiveTab('scanner');
      else if (permissions.scheduleView) setActiveTab('schedule');
      else setActiveTab('account');
    } else if (activeTab === 'access' && !isStoreManager) {
      if (permissions.barcodeView) setActiveTab('scanner');
      else if (permissions.scheduleView) setActiveTab('schedule');
      else setActiveTab('account');
    }
  }, [permissions, activeTab]);

  // ============================================================================
  // Supabase Primary Hydration & Realtime Sync Manager
  // ============================================================================
  const hydrateSupabaseData = useCallback(async () => {
    if (!supabaseClient || !currentUser || !permissions.authorized) return;
    setSyncState('syncing');
    setScansLoading(true);
    setSchedulesLoading(true);
    if (permissions.role === 'store_manager') setMembersLoading(true);
    if (permissions.activityView) setActivityLoading(true);

    const res = await fetchAllSyncedData(supabaseClient, {
      isStoreManager: permissions.role === 'store_manager',
      allowActivity: permissions.activityView,
    });

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
  }, [supabaseClient, currentUser, permissions.authorized, permissions.role, permissions.activityView, notify]);

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

    // Ensure single deduplicated Realtime subscription
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
        // Real-time permission enforcement if current user's access row changed
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
  // Firebase Live Listeners (Fallback when Supabase Auth is not yet configured)
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
            barcodeCreate: Boolean(data.barcodeCreate ?? data.allowBarcode ?? defaults.barcodeCreate),
            barcodeEdit: Boolean(data.barcodeEdit ?? data.allowBarcode ?? defaults.barcodeEdit),
            barcodeDelete: Boolean(data.barcodeDelete ?? defaults.barcodeDelete),
            scheduleView: Boolean(data.scheduleView ?? data.allowSchedule ?? defaults.scheduleView),
            scheduleCreate: Boolean(data.scheduleCreate ?? data.allowSchedule ?? defaults.scheduleCreate),
            scheduleEdit: Boolean(data.scheduleEdit ?? data.allowSchedule ?? defaults.scheduleEdit),
            scheduleDelete: Boolean(data.scheduleDelete ?? defaults.scheduleDelete),
            scheduleApprove: Boolean(data.scheduleApprove ?? defaults.scheduleApprove),
            allowExport: Boolean(data.allowExport ?? defaults.allowExport),
            activityView: Boolean(data.activityView ?? defaults.activityView),
            allowSupabase: Boolean(data.allowSupabase ?? defaults.allowSupabase),
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

      // Firebase fallback (conforms to deployed firestore.rules schema)
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
    [currentUser, backendMode, supabaseClient, hydrateSupabaseData, recordActivity, notify, reportFirestoreError]
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
  // Barcode CRUD Handlers (Optimistic Locking + Activity Log)
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

      // Firebase fallback
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
  // Work Schedule CRUD Handlers (Optimistic Locking + Approval + Activity Log)
  // ============================================================================
  const handleCreateSchedule = useCallback(
    async (data: {
      employeeName: string;
      title: string;
      workDate: string;
      shiftType: ShiftType;
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
          `Đăng ký ca "${created.title}" (${created.employeeName} · ${created.workDate})`,
          { workDate: created.workDate, startTime: created.startTime, endTime: created.endTime }
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
              setSchedules((prev) =>
                prev.map((w) => (w.id === srv.id ? srv : w))
              );
              notify('info', 'Đã tải bản lịch làm việc mới nhất.');
            },
            onForceOverwrite: async () => {
              await handleUpdateSchedule(srv, updates);
            },
          });
          return;
        }

        const updated = res.data;
        setSchedules((prev) =>
          prev.map((w) => (w.id === updated.id ? updated : w))
        );
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
        const res = await deleteWorkScheduleInSupabase(
          supabaseClient,
          schedule.id
        );
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
  const handleSaveSupabaseConfig = useCallback(
    async (cfg: SupabaseConfig) => {
      setSupabaseConfig(cfg);
      if (firebaseUser) {
        const userRef = doc(db, 'users', firebaseUser.uid);
        try {
          await updateDoc(userRef, {
            supabaseUrl: cfg.url.slice(0, 300),
            supabaseAnonKey: cfg.anonKey.slice(0, 500),
            updatedAt: serverTimestamp(),
          });
        } catch (error) {
          reportFirestoreError(
            error,
            OperationType.UPDATE,
            `users/${firebaseUser.uid}`,
            'Không thể lưu cấu hình lên hồ sơ đám mây'
          );
        }
      }
      notify('success', 'Đã lưu cấu hình Supabase.');
    },
    [firebaseUser, notify, reportFirestoreError]
  );

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
        'Vui lòng đăng nhập Supabase Auth trong mục Liên kết Supabase trước khi chuyển dữ liệu (yêu cầu bởi RLS).'
      );
      setActiveTab('account');
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
            barcodeCreate: Boolean(data.barcodeCreate ?? data.allowBarcode ?? defaults.barcodeCreate),
            barcodeEdit: Boolean(data.barcodeEdit ?? data.allowBarcode ?? defaults.barcodeEdit),
            barcodeDelete: Boolean(data.barcodeDelete ?? defaults.barcodeDelete),
            scheduleView: Boolean(data.scheduleView ?? data.allowSchedule ?? defaults.scheduleView),
            scheduleCreate: Boolean(data.scheduleCreate ?? data.allowSchedule ?? defaults.scheduleCreate),
            scheduleEdit: Boolean(data.scheduleEdit ?? data.allowSchedule ?? defaults.scheduleEdit),
            scheduleDelete: Boolean(data.scheduleDelete ?? defaults.scheduleDelete),
            scheduleApprove: Boolean(data.scheduleApprove ?? defaults.scheduleApprove),
            allowExport: Boolean(data.allowExport ?? defaults.allowExport),
            activityView: Boolean(data.activityView ?? defaults.activityView),
            allowSupabase: Boolean(data.allowSupabase ?? defaults.allowSupabase),
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
        onSupabaseSessionReady={() => setSyncState('connecting')}
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

  const tabMeta: Record<AppTab, { title: string; subtitle: string }> = {
    scanner: {
      title: 'Quét & Xuất mã vạch',
      subtitle:
        'Quét liên tục bằng camera hoặc súng USB, lưu trữ trực tuyến và xuất Excel',
    },
    schedule: {
      title: 'Lịch làm việc',
      subtitle:
        'Đăng ký ca làm, phê duyệt lịch tuần và cập nhật trạng thái thời gian thực',
    },
    activity: {
      title: 'Nhật ký hoạt động',
      subtitle:
        'Theo dõi lịch sử thêm, sửa, xóa, phê duyệt và xuất dữ liệu của toàn đội',
    },
    access: {
      title: 'Phân quyền hệ thống',
      subtitle:
        'Quản lý 4 vai trò (Quản lý siêu thị, Giám sát, Trưởng ca, Nhân viên) và quyền từng phân hệ',
    },
    account: {
      title: permissions.allowSupabase
        ? 'Tài khoản & Đồng bộ Supabase'
        : 'Thông tin tài khoản',
      subtitle: permissions.allowSupabase
        ? 'Cấu hình kết nối PostgreSQL Supabase Realtime, RLS và bảo toàn dữ liệu'
        : 'Xem vai trò và quyền truy cập hiện tại của bạn',
    },
  };

  const navItems: {
    id: AppTab;
    label: string;
    mobileLabel: string;
    icon: typeof ScanBarcode;
    badge?: string | number;
    visible: boolean;
  }[] = [
    {
      id: 'scanner',
      label: 'Quét & Xuất mã vạch',
      mobileLabel: 'Quét mã',
      icon: ScanBarcode,
      badge: scans.length,
      visible: permissions.barcodeView,
    },
    {
      id: 'schedule',
      label: 'Lịch làm việc',
      mobileLabel: 'Lịch làm',
      icon: CalendarDays,
      badge: schedules.length,
      visible: permissions.scheduleView,
    },
    {
      id: 'activity',
      label: 'Nhật ký hoạt động',
      mobileLabel: 'Nhật ký',
      icon: History,
      badge: activityLogs.length,
      visible: permissions.activityView,
    },
    {
      id: 'access',
      label: 'Phân quyền',
      mobileLabel: 'Phân quyền',
      icon: ShieldCheck,
      badge: authorizedMembers.length,
      visible: isStoreManager,
    },
    {
      id: 'account',
      label: permissions.allowSupabase ? 'Liên kết Supabase' : 'Tài khoản',
      mobileLabel: permissions.allowSupabase ? 'Supabase' : 'Tài khoản',
      icon: permissions.allowSupabase ? Database : UserCircle,
      badge: permissions.allowSupabase
        ? backendMode === 'supabase'
          ? 'Realtime'
          : supabaseReady
            ? 'Sẵn sàng'
            : 'Chưa cài'
        : undefined,
      visible: true,
    },
  ];

  const visibleNavItems = navItems.filter((item) => item.visible);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      {/* Desktop Left Sidebar */}
      <aside className="hidden md:flex md:w-64 lg:w-72 md:flex-col md:fixed md:inset-y-0 bg-white border-r border-slate-200 z-30">
        <div className="h-16 px-6 flex items-center gap-2.5 border-b border-slate-200">
          <div className="h-9 w-9 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
            <ScanBarcode className="h-5 w-5" />
          </div>
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
            ScanShift
          </span>
        </div>

        <nav className="flex-1 p-4 space-y-1.5" aria-label="Điều hướng chính">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full min-h-[46px] flex items-center justify-between px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className="h-5 w-5 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {item.badge !== undefined && (
                  <span
                    className={`text-xs tabular-nums ${
                      item.id === 'account' && backendMode === 'supabase'
                        ? 'text-emerald-700'
                        : 'text-slate-500'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* User profile in sidebar footer */}
        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="flex items-center gap-3 min-w-0">
            {currentUser.photoURL ? (
              <img
                src={currentUser.photoURL}
                alt={currentUser.displayName}
                referrerPolicy="no-referrer"
                className="h-10 w-10 rounded-full object-cover border border-slate-200 shrink-0"
              />
            ) : (
              <div className="h-10 w-10 rounded-full bg-slate-900 text-white flex items-center justify-center font-bold text-sm shrink-0">
                {currentUser.displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-900 truncate">
                {currentUser.displayName}
              </p>
              <p className="text-xs text-slate-500 truncate">
                {ROLE_LABELS[permissions.role]} · {currentUser.email}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            <LogOut className="h-4 w-4" />
            <span>Đăng xuất</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 md:pl-64 lg:pl-72 flex flex-col min-w-0">
        {/* Mobile Compact Top App Bar (56px) */}
        <header className="md:hidden sticky top-0 z-30 h-14 bg-white/95 backdrop-blur-xs border-b border-slate-200 px-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-8 w-8 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
              <ScanBarcode className="h-4 w-4" />
            </div>
            <span className="text-sm font-bold text-slate-900 truncate">
              {tabMeta[activeTab].title}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <SyncStatusBadge
              state={syncState}
              backendMode={backendMode}
              lastSyncedAt={lastSyncedAt}
              compact
              onRetrySync={handleForceResync}
            />
            <button
              type="button"
              onClick={() => setActiveTab('account')}
              className="min-h-[44px] min-w-[40px] flex items-center justify-end shrink-0"
              aria-label="Mở thông tin tài khoản"
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

        {/* Desktop Header */}
        <header className="hidden md:flex h-16 bg-white border-b border-slate-200 px-8 items-center justify-between gap-6 sticky top-0 z-20">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-900 truncate">
              {tabMeta[activeTab].title}
            </h1>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <SyncStatusBadge
              state={syncState}
              backendMode={backendMode}
              lastSyncedAt={lastSyncedAt}
              onRetrySync={handleForceResync}
            />

            <span className="text-sm text-slate-500 whitespace-nowrap">
              {ROLE_LABELS[permissions.role]} · {currentUser.email}
            </span>

            {permissions.allowSupabase && (
              <button
                type="button"
                onClick={() => setActiveTab('account')}
                className="min-h-[40px] inline-flex items-center gap-2 px-3.5 py-1.5 text-sm font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap"
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
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-5 sm:py-7 pb-24 md:pb-10 max-w-7xl w-full mx-auto">
          <p className="text-sm text-slate-600 mb-5 hidden md:block">
            {tabMeta[activeTab].subtitle}
          </p>

          {activeTab === 'scanner' && permissions.barcodeView && (
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

          {activeTab === 'schedule' && permissions.scheduleView && (
            <WorkScheduleTab
              schedules={schedules}
              loading={schedulesLoading}
              defaultEmployeeName={currentUser.displayName}
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
              onExportLogged={(fileName, count) => {
                void recordActivity(
                  'export',
                  'export',
                  fileName,
                  `Xuất Excel lịch làm việc (${count} ca): ${fileName}`
                );
              }}
              onNotify={notify}
            />
          )}

          {activeTab === 'activity' && permissions.activityView && (
            <ActivityLogTab logs={activityLogs} loading={activityLoading} />
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

          {activeTab === 'account' && (
            <div className="space-y-6 max-w-3xl">
              {/* Account Summary Card */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  {currentUser.photoURL ? (
                    <img
                      src={currentUser.photoURL}
                      alt={currentUser.displayName}
                      referrerPolicy="no-referrer"
                      className="h-14 w-14 rounded-full object-cover border border-slate-200 shrink-0"
                    />
                  ) : (
                    <div className="h-14 w-14 rounded-full bg-slate-900 text-white flex items-center justify-center text-lg font-bold shrink-0">
                      {currentUser.displayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold text-slate-900 truncate">
                      {currentUser.displayName}
                    </h2>
                    <p className="text-sm text-slate-600 truncate">
                      {currentUser.email} <span aria-hidden="true">·</span>{' '}
                      {ROLE_LABELS[permissions.role]}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Nguồn dữ liệu:{' '}
                      <span className="font-medium text-slate-800">
                        {backendMode === 'supabase'
                          ? 'Supabase Realtime + RLS'
                          : 'Firebase Cloud (Dự phòng)'}
                      </span>
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleSignOut}
                  className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Đăng xuất</span>
                </button>
              </div>

              {permissions.allowSupabase && (
                <SupabasePanel
                  config={supabaseConfig}
                  backendMode={backendMode}
                  syncState={syncState}
                  lastSyncedAt={lastSyncedAt}
                  legacyCounts={{
                    scans: scans.filter((s) => !s.syncedToSupabase).length,
                    schedules: schedules.filter((w) => !w.syncedToSupabase).length,
                    members: authorizedMembers.length,
                  }}
                  isSyncing={isSyncing}
                  onSaveConfig={handleSaveSupabaseConfig}
                  onForceResync={handleForceResync}
                  onMigrateFromFirebase={handleMigrateFromFirebase}
                  onSupabaseSignedIn={() => setSyncState('connecting')}
                  onNotify={notify}
                />
              )}
            </div>
          )}
        </main>
      </div>

      {/* Mobile Fixed Bottom Tab Bar */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-xs border-t border-slate-200 pb-safe"
        aria-label="Điều hướng di động"
      >
        <div
          className={`grid h-16 ${
            visibleNavItems.length === 1
              ? 'grid-cols-1'
              : visibleNavItems.length === 2
                ? 'grid-cols-2'
                : visibleNavItems.length === 3
                  ? 'grid-cols-3'
                  : visibleNavItems.length === 4
                    ? 'grid-cols-4'
                    : 'grid-cols-5'
          }`}
        >
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex flex-col items-center justify-center gap-1 text-xs font-medium transition-colors ${
                  isActive ? 'text-blue-600' : 'text-slate-500'
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="truncate max-w-full px-1">
                  {item.mobileLabel}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Concurrent Edit Conflict Dialog */}
      <ConflictDialog
        conflict={activeConflict}
        onClose={() => setActiveConflict(null)}
      />

      {/* Toast Stack */}
      {toasts.length > 0 && (
        <div className="fixed bottom-20 md:bottom-6 right-4 left-4 md:left-auto md:w-96 z-50 space-y-2 pointer-events-none">
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
