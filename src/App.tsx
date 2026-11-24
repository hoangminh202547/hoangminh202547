import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
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
  LogOut,
  ScanBarcode,
  X,
} from 'lucide-react';
import { BarcodeScannerTab } from './components/BarcodeScannerTab';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SignInScreen } from './components/SignInScreen';
import { SupabasePanel } from './components/SupabasePanel';
import { WorkScheduleTab } from './components/WorkScheduleTab';
import {
  OperationType,
  auth,
  db,
  handleFirestoreError,
  signOutAccount,
  testConnection,
} from './lib/firebase';
import {
  getEnvSupabaseConfig,
  isValidSupabaseConfig,
  pullFromSupabase,
  pushBarcodeScansToSupabase,
  pushSchedulesToSupabase,
} from './lib/supabase';
import type {
  AppTab,
  BarcodeScan,
  ScheduleStatus,
  ShiftType,
  SupabaseConfig,
  ToastMessage,
  WorkSchedule,
} from './types';

function MainApp() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('scanner');

  const [scans, setScans] = useState<BarcodeScan[]>([]);
  const [scansLoading, setScansLoading] = useState(true);

  const [schedules, setSchedules] = useState<WorkSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);

  const [supabaseConfig, setSupabaseConfig] = useState<SupabaseConfig>(() =>
    getEnvSupabaseConfig()
  );
  const [isSyncing, setIsSyncing] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const notify = useCallback(
    (type: ToastMessage['type'], message: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, type, message }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3600);
    },
    []
  );

  // Startup Firestore connectivity check
  useEffect(() => {
    void testConnection();
  }, []);

  // Auth listener & User profile bootstrap
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);

      if (!currentUser) {
        setScans([]);
        setSchedules([]);
        setSupabaseConfig(getEnvSupabaseConfig());
        return;
      }

      const userRef = doc(db, 'users', currentUser.uid);
      try {
        const snap = await getDoc(userRef);
        const safeEmail = currentUser.email || '';
        const safeName =
          currentUser.displayName || safeEmail.split('@')[0] || 'Người dùng';
        if (!snap.exists()) {
          const payload: Record<string, unknown> = {
            uid: currentUser.uid,
            email: safeEmail,
            displayName: safeName.slice(0, 120),
            updatedAt: serverTimestamp(),
          };
          if (currentUser.photoURL) {
            payload.photoURL = currentUser.photoURL.slice(0, 500);
          }
          const envCfg = getEnvSupabaseConfig();
          if (envCfg.url) payload.supabaseUrl = envCfg.url.slice(0, 300);
          if (envCfg.anonKey) {
            payload.supabaseAnonKey = envCfg.anonKey.slice(0, 500);
          }
          await setDoc(userRef, payload);
        }
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.WRITE,
          `users/${currentUser.uid}`
        );
      }
    });

    return () => unsubscribe();
  }, []);

  // Subscribe to user profile (for saved Supabase config)
  useEffect(() => {
    if (!user) return;
    const path = `users/${user.uid}`;
    const unsub = onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const envCfg = getEnvSupabaseConfig();
          setSupabaseConfig({
            url:
              typeof data.supabaseUrl === 'string' && data.supabaseUrl
                ? data.supabaseUrl
                : envCfg.url,
            anonKey:
              typeof data.supabaseAnonKey === 'string' && data.supabaseAnonKey
                ? data.supabaseAnonKey
                : envCfg.anonKey,
          });
        }
      },
      (error) => handleFirestoreError(error, OperationType.GET, path)
    );
    return () => unsub();
  }, [user]);

  // Subscribe to barcode_scans
  useEffect(() => {
    if (!user) return;
    setScansLoading(true);
    const path = 'barcode_scans';
    const q = query(collection(db, path), where('ownerId', '==', user.uid));
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
            syncedToSupabase: Boolean(data.syncedToSupabase),
            scannedAt: (data.scannedAt as Timestamp) || null,
            updatedAt: (data.updatedAt as Timestamp) || null,
          };
        });
        list.sort((a, b) => {
          const ta = a.updatedAt?.toMillis() ?? Date.now();
          const tb = b.updatedAt?.toMillis() ?? Date.now();
          return tb - ta;
        });
        setScans(list);
        setScansLoading(false);
      },
      (error) => {
        setScansLoading(false);
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );
    return () => unsub();
  }, [user]);

  // Subscribe to work_schedules
  useEffect(() => {
    if (!user) return;
    setSchedulesLoading(true);
    const path = 'work_schedules';
    const q = query(collection(db, path), where('ownerId', '==', user.uid));
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
            syncedToSupabase: Boolean(data.syncedToSupabase),
            createdAt: (data.createdAt as Timestamp) || null,
            updatedAt: (data.updatedAt as Timestamp) || null,
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
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );
    return () => unsub();
  }, [user]);

  // Barcode CRUD handlers
  const handleAddOrIncrementScan = useCallback(
    async (params: {
      code: string;
      format: string;
      sessionName: string;
      note: string;
      accumulate: boolean;
    }) => {
      if (!user || !user.email) return;
      const cleanCode = params.code.trim().slice(0, 200);
      const cleanSession = params.sessionName.trim().slice(0, 100) || 'Mặc định';

      if (params.accumulate) {
        const existing = scans.find(
          (s) => s.code === cleanCode && s.sessionName === cleanSession
        );
        if (existing) {
          const ref = doc(db, 'barcode_scans', existing.id);
          try {
            await updateDoc(ref, {
              quantity: Math.min(999999, existing.quantity + 1),
              note: params.note ? params.note.slice(0, 300) : existing.note,
              syncedToSupabase: false,
              updatedAt: serverTimestamp(),
            });
            notify('success', `Đã cộng dồn ${cleanCode} (SL: ${existing.quantity + 1})`);
            return;
          } catch (error) {
            handleFirestoreError(
              error,
              OperationType.UPDATE,
              `barcode_scans/${existing.id}`
            );
          }
        }
      }

      try {
        await addDoc(collection(db, 'barcode_scans'), {
          ownerId: user.uid,
          ownerEmail: user.email,
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
        handleFirestoreError(error, OperationType.CREATE, 'barcode_scans');
      }
    },
    [user, scans, notify]
  );

  const handleUpdateScanQuantity = useCallback(
    async (scan: BarcodeScan, newQty: number) => {
      const safeQty = Math.max(1, Math.min(999999, Math.round(newQty)));
      const ref = doc(db, 'barcode_scans', scan.id);
      try {
        await updateDoc(ref, {
          quantity: safeQty,
          syncedToSupabase: false,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.UPDATE,
          `barcode_scans/${scan.id}`
        );
      }
    },
    []
  );

  const handleUpdateScanNote = useCallback(
    async (scan: BarcodeScan, newNote: string) => {
      const ref = doc(db, 'barcode_scans', scan.id);
      try {
        await updateDoc(ref, {
          note: newNote.slice(0, 300),
          syncedToSupabase: false,
          updatedAt: serverTimestamp(),
        });
        notify('success', 'Đã cập nhật ghi chú mã vạch.');
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.UPDATE,
          `barcode_scans/${scan.id}`
        );
      }
    },
    [notify]
  );

  const handleDeleteScan = useCallback(
    async (scan: BarcodeScan) => {
      const ref = doc(db, 'barcode_scans', scan.id);
      try {
        await deleteDoc(ref);
        notify('info', `Đã xóa mã ${scan.code}`);
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.DELETE,
          `barcode_scans/${scan.id}`
        );
      }
    },
    [notify]
  );

  const handleClearScans = useCallback(
    async (_label: string, items: BarcodeScan[]) => {
      if (items.length === 0) return;
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
        handleFirestoreError(error, OperationType.DELETE, 'barcode_scans');
      }
    },
    [notify]
  );

  // Schedule CRUD handlers
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
      if (!user || !user.email) return;
      try {
        await addDoc(collection(db, 'work_schedules'), {
          ownerId: user.uid,
          ownerEmail: user.email,
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
        handleFirestoreError(error, OperationType.CREATE, 'work_schedules');
      }
    },
    [user, notify]
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
      const ref = doc(db, 'work_schedules', schedule.id);
      try {
        await updateDoc(ref, {
          ...updates,
          syncedToSupabase: false,
          updatedAt: serverTimestamp(),
        });
        notify('success', 'Đã cập nhật lịch làm việc.');
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.UPDATE,
          `work_schedules/${schedule.id}`
        );
      }
    },
    [notify]
  );

  const handleDeleteSchedule = useCallback(
    async (schedule: WorkSchedule) => {
      const ref = doc(db, 'work_schedules', schedule.id);
      try {
        await deleteDoc(ref);
        notify('info', `Đã xóa ca "${schedule.title}".`);
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.DELETE,
          `work_schedules/${schedule.id}`
        );
      }
    },
    [notify]
  );

  // Supabase handlers
  const supabaseReady = useMemo(
    () => isValidSupabaseConfig(supabaseConfig),
    [supabaseConfig]
  );

  const handleSaveSupabaseConfig = useCallback(
    async (cfg: SupabaseConfig) => {
      if (!user) return;
      const userRef = doc(db, 'users', user.uid);
      try {
        await updateDoc(userRef, {
          supabaseUrl: cfg.url.slice(0, 300),
          supabaseAnonKey: cfg.anonKey.slice(0, 500),
          updatedAt: serverTimestamp(),
        });
        setSupabaseConfig(cfg);
        notify('success', 'Đã lưu cấu hình Supabase.');
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.UPDATE,
          `users/${user.uid}`
        );
      }
    },
    [user, notify]
  );

  const handleSyncToSupabase = useCallback(async () => {
    if (!supabaseReady) {
      setActiveTab('account');
      notify('info', 'Vui lòng nhập URL và Anon Key của Supabase trước.');
      return;
    }
    setIsSyncing(true);
    try {
      const unsyncedScans = scans.filter((s) => !s.syncedToSupabase);
      const unsyncedSchedules = schedules.filter((w) => !w.syncedToSupabase);

      const [scanRes, schedRes] = await Promise.all([
        pushBarcodeScansToSupabase(supabaseConfig, unsyncedScans),
        pushSchedulesToSupabase(supabaseConfig, unsyncedSchedules),
      ]);

      if (scanRes.error || schedRes.error) {
        notify(
          'error',
          scanRes.error || schedRes.error || 'Đồng bộ Supabase gặp lỗi.'
        );
        return;
      }

      const batch = writeBatch(db);
      for (const id of scanRes.syncedIds) {
        batch.update(doc(db, 'barcode_scans', id), {
          syncedToSupabase: true,
          updatedAt: serverTimestamp(),
        });
      }
      for (const id of schedRes.syncedIds) {
        batch.update(doc(db, 'work_schedules', id), {
          syncedToSupabase: true,
          updatedAt: serverTimestamp(),
        });
      }
      if (scanRes.syncedIds.length + schedRes.syncedIds.length > 0) {
        await batch.commit();
      }

      notify(
        'success',
        `Đã đồng bộ ${scanRes.syncedIds.length} mã vạch và ${schedRes.syncedIds.length} lịch làm việc lên Supabase.`
      );
    } catch (err) {
      notify(
        'error',
        err instanceof Error ? err.message : 'Đồng bộ Supabase thất bại.'
      );
    } finally {
      setIsSyncing(false);
    }
  }, [supabaseReady, supabaseConfig, scans, schedules, notify]);

  const handlePullFromSupabase = useCallback(async () => {
    if (!user || !user.email || !supabaseReady) return;
    setIsSyncing(true);
    try {
      const res = await pullFromSupabase(supabaseConfig, user.email);
      if (res.error) {
        notify('error', `Lỗi tải từ Supabase: ${res.error}`);
        return;
      }

      const existingScanIds = new Set(scans.map((s) => s.id));
      const existingScheduleIds = new Set(schedules.map((w) => w.id));
      let importedCount = 0;

      for (const s of res.scans) {
        if (!s.id || existingScanIds.has(s.id) || !/^[a-zA-Z0-9_-]+$/.test(s.id)) {
          continue;
        }
        await setDoc(doc(db, 'barcode_scans', s.id), {
          ownerId: user.uid,
          ownerEmail: user.email,
          code: s.code.slice(0, 200) || 'UNKNOWN',
          format: s.format.slice(0, 40) || 'SUPABASE',
          sessionName: s.sessionName.slice(0, 100) || 'Mặc định',
          quantity: Math.max(1, Math.min(999999, Math.round(s.quantity))),
          note: s.note.slice(0, 300),
          syncedToSupabase: true,
          scannedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        importedCount += 1;
      }

      for (const w of res.schedules) {
        if (
          !w.id ||
          existingScheduleIds.has(w.id) ||
          !/^[a-zA-Z0-9_-]+$/.test(w.id)
        ) {
          continue;
        }
        const validWorkDate = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(w.workDate)
          ? w.workDate
          : new Date().toISOString().slice(0, 10);
        await setDoc(doc(db, 'work_schedules', w.id), {
          ownerId: user.uid,
          ownerEmail: user.email,
          employeeName:
            w.employeeName.slice(0, 120) || user.displayName || user.email,
          title: w.title.slice(0, 150) || 'Ca làm việc',
          workDate: validWorkDate,
          shiftType: ['morning', 'afternoon', 'evening', 'full_day', 'custom'].includes(
            w.shiftType
          )
            ? w.shiftType
            : 'custom',
          startTime: /^[0-9]{2}:[0-9]{2}$/.test(w.startTime)
            ? w.startTime
            : '08:00',
          endTime: /^[0-9]{2}:[0-9]{2}$/.test(w.endTime)
            ? w.endTime
            : '17:00',
          location: w.location.slice(0, 150),
          status: ['registered', 'confirmed', 'completed', 'cancelled'].includes(
            w.status
          )
            ? w.status
            : 'registered',
          note: w.note.slice(0, 400),
          syncedToSupabase: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        importedCount += 1;
      }

      notify(
        'success',
        importedCount > 0
          ? `Đã nhập thêm ${importedCount} bản ghi mới từ Supabase.`
          : 'Dữ liệu cục bộ đã khớp hoàn toàn với Supabase.'
      );
    } catch (err) {
      notify(
        'error',
        err instanceof Error ? err.message : 'Không thể tải dữ liệu từ Supabase.'
      );
    } finally {
      setIsSyncing(false);
    }
  }, [user, supabaseReady, supabaseConfig, scans, schedules, notify]);

  const unsyncedScansCount = useMemo(
    () => scans.filter((s) => !s.syncedToSupabase).length,
    [scans]
  );
  const unsyncedSchedulesCount = useMemo(
    () => schedules.filter((w) => !w.syncedToSupabase).length,
    [schedules]
  );

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <div className="h-9 w-9 rounded-lg bg-blue-600 text-white flex items-center justify-center mx-auto">
            <ScanBarcode className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-slate-600">
            Đang tải dữ liệu tài khoản...
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <SignInScreen />;
  }

  const displayName =
    user.displayName || user.email?.split('@')[0] || 'Thành viên';

  const tabMeta: Record<AppTab, { title: string; subtitle: string }> = {
    scanner: {
      title: 'Quét & Xuất mã vạch',
      subtitle: 'Quét liên tục bằng camera hoặc súng USB, lưu trữ và xuất Excel',
    },
    schedule: {
      title: 'Lịch làm việc',
      subtitle: 'Đăng ký ca làm, theo dõi lịch tuần và cập nhật trạng thái',
    },
    account: {
      title: 'Tài khoản Gmail & Liên kết Supabase',
      subtitle: 'Quản lý kết nối PostgreSQL Supabase và đồng bộ 2 chiều',
    },
  };

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
          <button
            type="button"
            onClick={() => setActiveTab('scanner')}
            className={`w-full min-h-[46px] flex items-center justify-between px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'scanner'
                ? 'bg-blue-50 text-blue-700'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-3">
              <ScanBarcode className="h-5 w-5 shrink-0" />
              <span>Quét &amp; Xuất mã vạch</span>
            </span>
            <span className="text-xs tabular-nums text-slate-500">
              {scans.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('schedule')}
            className={`w-full min-h-[46px] flex items-center justify-between px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'schedule'
                ? 'bg-blue-50 text-blue-700'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-3">
              <CalendarDays className="h-5 w-5 shrink-0" />
              <span>Lịch làm việc</span>
            </span>
            <span className="text-xs tabular-nums text-slate-500">
              {schedules.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('account')}
            className={`w-full min-h-[46px] flex items-center justify-between px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'account'
                ? 'bg-blue-50 text-blue-700'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-3">
              <Database className="h-5 w-5 shrink-0" />
              <span>Liên kết Supabase</span>
            </span>
            <span
              className={`text-xs ${
                supabaseReady ? 'text-emerald-700' : 'text-slate-400'
              }`}
            >
              {supabaseReady ? 'Sẵn sàng' : 'Chưa cài'}
            </span>
          </button>
        </nav>

        {/* User profile in sidebar footer */}
        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="flex items-center gap-3 min-w-0">
            {user.photoURL ? (
              <img
                src={user.photoURL}
                alt={displayName}
                referrerPolicy="no-referrer"
                className="h-10 w-10 rounded-full object-cover border border-slate-200 shrink-0"
              />
            ) : (
              <div className="h-10 w-10 rounded-full bg-slate-900 text-white flex items-center justify-center font-bold text-sm shrink-0">
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-900 truncate">
                {displayName}
              </p>
              <p className="text-xs text-slate-500 truncate">{user.email}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => signOutAccount()}
            className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            <LogOut className="h-4 w-4" />
            <span>Đăng xuất Gmail</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 md:pl-64 lg:pl-72 flex flex-col min-w-0">
        {/* Mobile Compact Top App Bar (56px) */}
        <header className="md:hidden sticky top-0 z-30 h-14 bg-white/95 backdrop-blur-xs border-b border-slate-200 px-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-8 w-8 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
              <ScanBarcode className="h-4 w-4" />
            </div>
            <span className="text-base font-bold text-slate-900 truncate">
              {tabMeta[activeTab].title}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setActiveTab('account')}
            className="min-h-[44px] min-w-[44px] flex items-center justify-end shrink-0"
            aria-label="Mở tài khoản và Supabase"
          >
            {user.photoURL ? (
              <img
                src={user.photoURL}
                alt={displayName}
                referrerPolicy="no-referrer"
                className="h-8 w-8 rounded-full object-cover border border-slate-200"
              />
            ) : (
              <div className="h-8 w-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-bold">
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
          </button>
        </header>

        {/* Desktop Header */}
        <header className="hidden md:flex h-16 bg-white border-b border-slate-200 px-8 items-center justify-between gap-8 sticky top-0 z-20">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-900 truncate">
              {tabMeta[activeTab].title}
            </h1>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <span className="text-sm text-slate-500 whitespace-nowrap">
              {user.email}
            </span>
            <button
              type="button"
              onClick={() => setActiveTab('account')}
              className="min-h-[40px] inline-flex items-center gap-2 px-3.5 py-1.5 text-sm font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap"
            >
              <Database
                className={`h-4 w-4 ${
                  supabaseReady ? 'text-emerald-600' : 'text-slate-400'
                }`}
              />
              <span>
                {supabaseReady ? 'Supabase: Đã liên kết' : 'Cài đặt Supabase'}
              </span>
            </button>
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-5 sm:py-7 pb-24 md:pb-10 max-w-7xl w-full mx-auto">
          <p className="text-sm text-slate-600 mb-5 hidden md:block">
            {tabMeta[activeTab].subtitle}
          </p>

          {activeTab === 'scanner' && (
            <BarcodeScannerTab
              scans={scans}
              loading={scansLoading}
              supabaseReady={supabaseReady}
              isSyncing={isSyncing}
              onAddOrIncrementScan={handleAddOrIncrementScan}
              onUpdateQuantity={handleUpdateScanQuantity}
              onUpdateNote={handleUpdateScanNote}
              onDeleteScan={handleDeleteScan}
              onClearSession={handleClearScans}
              onSyncToSupabase={handleSyncToSupabase}
              onNotify={notify}
            />
          )}

          {activeTab === 'schedule' && (
            <WorkScheduleTab
              schedules={schedules}
              loading={schedulesLoading}
              defaultEmployeeName={displayName}
              supabaseReady={supabaseReady}
              isSyncing={isSyncing}
              onCreateSchedule={handleCreateSchedule}
              onUpdateSchedule={handleUpdateSchedule}
              onDeleteSchedule={handleDeleteSchedule}
              onSyncToSupabase={handleSyncToSupabase}
              onNotify={notify}
            />
          )}

          {activeTab === 'account' && (
            <div className="space-y-6 max-w-3xl">
              {/* Gmail Account Summary Card */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  {user.photoURL ? (
                    <img
                      src={user.photoURL}
                      alt={displayName}
                      referrerPolicy="no-referrer"
                      className="h-14 w-14 rounded-full object-cover border border-slate-200 shrink-0"
                    />
                  ) : (
                    <div className="h-14 w-14 rounded-full bg-slate-900 text-white flex items-center justify-center text-lg font-bold shrink-0">
                      {displayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold text-slate-900 truncate">
                      {displayName}
                    </h2>
                    <p className="text-sm text-slate-600 truncate">
                      {user.email} <span aria-hidden="true">·</span> Đã xác thực Gmail
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => signOutAccount()}
                  className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Đăng xuất</span>
                </button>
              </div>

              <SupabasePanel
                config={supabaseConfig}
                unsyncedScansCount={unsyncedScansCount}
                unsyncedSchedulesCount={unsyncedSchedulesCount}
                isSyncing={isSyncing}
                onSaveConfig={handleSaveSupabaseConfig}
                onSyncAll={handleSyncToSupabase}
                onPullFromSupabase={handlePullFromSupabase}
              />
            </div>
          )}
        </main>
      </div>

      {/* Mobile Fixed Bottom Tab Bar (64px) */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-xs border-t border-slate-200 pb-safe"
        aria-label="Điều hướng di động"
      >
        <div className="grid grid-cols-3 h-16">
          <button
            type="button"
            onClick={() => setActiveTab('scanner')}
            className={`flex flex-col items-center justify-center gap-1 text-xs font-medium transition-colors ${
              activeTab === 'scanner' ? 'text-blue-600' : 'text-slate-500'
            }`}
          >
            <ScanBarcode className="h-5 w-5" />
            <span>Quét mã vạch</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('schedule')}
            className={`flex flex-col items-center justify-center gap-1 text-xs font-medium transition-colors ${
              activeTab === 'schedule' ? 'text-blue-600' : 'text-slate-500'
            }`}
          >
            <CalendarDays className="h-5 w-5" />
            <span>Lịch làm việc</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('account')}
            className={`flex flex-col items-center justify-center gap-1 text-xs font-medium transition-colors ${
              activeTab === 'account' ? 'text-blue-600' : 'text-slate-500'
            }`}
          >
            <Database className="h-5 w-5" />
            <span>Supabase</span>
          </button>
        </div>
      </nav>

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
