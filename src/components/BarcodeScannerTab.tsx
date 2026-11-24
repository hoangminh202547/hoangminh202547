import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import {
  Camera,
  CameraOff,
  Check,
  Database,
  FileSpreadsheet,
  Keyboard,
  Minus,
  Plus,
  Search,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { exportBarcodesToExcel } from '../lib/excel';
import type { BarcodeScan } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

interface BarcodeScannerTabProps {
  scans: BarcodeScan[];
  loading: boolean;
  supabaseReady: boolean;
  isSyncing: boolean;
  onAddOrIncrementScan: (params: {
    code: string;
    format: string;
    sessionName: string;
    note: string;
    accumulate: boolean;
  }) => Promise<void>;
  onUpdateQuantity: (scan: BarcodeScan, newQty: number) => Promise<void>;
  onUpdateNote: (scan: BarcodeScan, newNote: string) => Promise<void>;
  onDeleteScan: (scan: BarcodeScan) => Promise<void>;
  onClearSession: (sessionName: string, items: BarcodeScan[]) => Promise<void>;
  onSyncToSupabase: () => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}

const SUPPORTED_FORMATS = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
];

function playScanBeep() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(920, ctx.currentTime);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.11);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 200);
  } catch {
    // Ignore audio context restriction errors
  }
}

export function BarcodeScannerTab({
  scans,
  loading,
  supabaseReady,
  isSyncing,
  onAddOrIncrementScan,
  onUpdateQuantity,
  onUpdateNote,
  onDeleteScan,
  onClearSession,
  onSyncToSupabase,
  onNotify,
}: BarcodeScannerTabProps) {
  const defaultSessionName = useMemo(() => {
    const d = new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `Kiểm kho ${day}/${month}`;
  }, []);

  const [sessionName, setSessionName] = useState(defaultSessionName);
  const [manualCode, setManualCode] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [accumulateMode, setAccumulateMode] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [cooldownMs, setCooldownMs] = useState(1800);

  // Camera state
  const [isScanning, setIsScanning] = useState(false);
  const [startingCamera, setStartingCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<{ id: string; label: string }[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [lastScannedFlash, setLastScannedFlash] = useState<string | null>(null);

  // Filter & editing state
  const [searchQuery, setSearchQuery] = useState('');
  const [sessionFilter, setSessionFilter] = useState<string>('ALL');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState('');

  // Confirmations
  const [deleteTarget, setDeleteTarget] = useState<BarcodeScan | null>(null);
  const [clearSessionConfirm, setClearSessionConfirm] = useState(false);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const lastScanRef = useRef<{ code: string; timestamp: number }>({
    code: '',
    timestamp: 0,
  });
  const manualInputRef = useRef<HTMLInputElement | null>(null);
  const onAddRef = useRef(onAddOrIncrementScan);
  onAddRef.current = onAddOrIncrementScan;

  const sessionNameRef = useRef(sessionName);
  sessionNameRef.current = sessionName;
  const accumulateRef = useRef(accumulateMode);
  accumulateRef.current = accumulateMode;
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;
  const cooldownRef = useRef(cooldownMs);
  cooldownRef.current = cooldownMs;

  const stopCamera = useCallback(async () => {
    const instance = scannerRef.current;
    if (instance) {
      try {
        if (instance.isScanning) {
          await instance.stop();
        }
        instance.clear();
      } catch {
        // Ignore stop errors when already stopped
      }
      scannerRef.current = null;
    }
    setIsScanning(false);
  }, []);

  useEffect(() => {
    return () => {
      if (scannerRef.current) {
        const inst = scannerRef.current;
        scannerRef.current = null;
        if (inst.isScanning) {
          inst.stop().catch(() => {});
        }
      }
    };
  }, []);

  const handleDecodedBarcode = useCallback(
    async (decodedText: string, formatName: string) => {
      const cleanCode = decodedText.trim();
      if (!cleanCode) return;

      const now = Date.now();
      if (
        lastScanRef.current.code === cleanCode &&
        now - lastScanRef.current.timestamp < cooldownRef.current
      ) {
        return;
      }
      lastScanRef.current = { code: cleanCode, timestamp: now };

      if (soundRef.current) {
        playScanBeep();
      }
      setLastScannedFlash(cleanCode);
      setTimeout(() => {
        setLastScannedFlash((prev) => (prev === cleanCode ? null : prev));
      }, 1100);

      try {
        await onAddRef.current({
          code: cleanCode,
          format: formatName || 'BARCODE',
          sessionName: sessionNameRef.current.trim() || 'Mặc định',
          note: '',
          accumulate: accumulateRef.current,
        });
      } catch (err) {
        onNotify(
          'error',
          err instanceof Error ? err.message : 'Không thể lưu mã vạch.'
        );
      }
    },
    [onNotify]
  );

  const startCamera = async () => {
    setCameraError(null);
    setStartingCamera(true);
    try {
      await stopCamera();
      const available = await Html5Qrcode.getCameras();
      setCameras(available.map((c) => ({ id: c.id, label: c.label || 'Camera' })));

      const scanner = new Html5Qrcode('barcode-reader', {
        formatsToSupport: SUPPORTED_FORMATS,
        verbose: false,
      });
      scannerRef.current = scanner;

      const cameraConfig: string | { facingMode: string } =
        selectedCameraId ||
        available.find((c) => /back|rear|environment/i.test(c.label))?.id ||
        { facingMode: 'environment' };

      await scanner.start(
        cameraConfig,
        {
          fps: 12,
          qrbox: { width: 260, height: 150 },
          aspectRatio: 1.777778,
        },
        (decodedText, decodedResult) => {
          const fmt =
            decodedResult?.result?.format?.formatName || 'BARCODE';
          void handleDecodedBarcode(decodedText, fmt);
        },
        () => {
          // Ignore per-frame miss logs
        }
      );

      setIsScanning(true);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Không thể khởi động camera. Vui lòng kiểm tra quyền truy cập camera.';
      if (msg.toLowerCase().includes('permission')) {
        setCameraError(
          'Trình duyệt chưa cấp quyền Camera. Vui lòng cấp quyền hoặc dùng chế độ nhập tay / súng quét USB bên cạnh.'
        );
      } else {
        setCameraError(msg);
      }
      setIsScanning(false);
    } finally {
      setStartingCamera(false);
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = manualCode.trim();
    if (!trimmed) return;

    if (soundEnabled) playScanBeep();
    setLastScannedFlash(trimmed);
    setTimeout(() => {
      setLastScannedFlash((prev) => (prev === trimmed ? null : prev));
    }, 900);

    try {
      await onAddOrIncrementScan({
        code: trimmed,
        format: 'NHAP_TAY',
        sessionName: sessionName.trim() || 'Mặc định',
        note: manualNote.trim(),
        accumulate: accumulateMode,
      });
      setManualCode('');
      setManualNote('');
      manualInputRef.current?.focus();
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Không thể lưu mã vạch.'
      );
    }
  };

  const uniqueSessions = useMemo(() => {
    const set = new Set<string>();
    for (const s of scans) {
      if (s.sessionName) set.add(s.sessionName);
    }
    return Array.from(set);
  }, [scans]);

  const filteredScans = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return scans.filter((item) => {
      const matchSession =
        sessionFilter === 'ALL' || item.sessionName === sessionFilter;
      const matchSearch =
        !q ||
        item.code.toLowerCase().includes(q) ||
        item.note.toLowerCase().includes(q) ||
        item.sessionName.toLowerCase().includes(q);
      return matchSession && matchSearch;
    });
  }, [scans, sessionFilter, searchQuery]);

  const totalItemsQty = useMemo(
    () => filteredScans.reduce((acc, item) => acc + item.quantity, 0),
    [filteredScans]
  );

  const unsyncedCount = useMemo(
    () => scans.filter((s) => !s.syncedToSupabase).length,
    [scans]
  );

  const handleExportExcel = async () => {
    if (filteredScans.length === 0) {
      onNotify('info', 'Chưa có dữ liệu mã vạch để xuất Excel.');
      return;
    }
    const label = sessionFilter === 'ALL' ? 'TatCa' : sessionFilter;
    const fileName = await exportBarcodesToExcel(filteredScans, label);
    onNotify('success', `Đã xuất file Excel: ${fileName}`);
  };

  const saveEditedNote = async (scan: BarcodeScan) => {
    await onUpdateNote(scan, editingNoteText.trim());
    setEditingNoteId(null);
    setEditingNoteText('');
  };

  const formatTime = (scan: BarcodeScan) => {
    if (!scan.scannedAt) return 'Vừa xong';
    return new Intl.DateTimeFormat('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
    }).format(scan.scannedAt.toDate());
  };

  return (
    <div className="space-y-6">
      {/* Top KPI summary bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Tổng dòng mã vạch</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {filteredScans.length}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Tổng số lượng</p>
          <p className="mt-1 text-2xl font-bold text-blue-600 tabular-nums">
            {totalItemsQty}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Số phiên quét</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {uniqueSessions.length}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Chờ đồng bộ Supabase</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {unsyncedCount}
          </p>
        </div>
      </div>

      {/* Scanner + Manual/USB Input Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Camera Continuous Scanner */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  Quét mã vạch liên tục bằng Camera
                </h2>
                <p className="text-sm text-slate-600 mt-0.5">
                  Đưa mã vạch EAN-13, Code-128 hoặc QR vào khung ngắm để tự động ghi nhận.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSoundEnabled((v) => !v)}
                className="min-h-[44px] inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap"
                aria-label={soundEnabled ? 'Tắt âm báo quét' : 'Bật âm báo quét'}
              >
                {soundEnabled ? (
                  <>
                    <Volume2 className="h-4 w-4 text-blue-600" />
                    <span>Âm báo: Bật</span>
                  </>
                ) : (
                  <>
                    <VolumeX className="h-4 w-4 text-slate-400" />
                    <span>Âm báo: Tắt</span>
                  </>
                )}
              </button>
            </div>

            {/* Camera viewport */}
            <div
              className={`mt-4 relative rounded-xl overflow-hidden bg-slate-900 aspect-video max-h-[320px] w-full flex items-center justify-center border-2 transition-colors ${
                lastScannedFlash ? 'border-emerald-500' : 'border-slate-200'
              }`}
            >
              <div id="barcode-reader" className="w-full h-full" />

              {!isScanning && (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-900 text-white">
                  <Camera className="h-10 w-10 text-slate-400 mb-3" />
                  <p className="text-base font-medium">
                    Camera đang tạm dừng
                  </p>
                  <p className="text-sm text-slate-400 mt-1 max-w-sm">
                    Nhấn "Bắt đầu quét" để mở camera sau trên điện thoại hoặc webcam trên máy tính.
                  </p>
                </div>
              )}

              {lastScannedFlash && (
                <div className="absolute bottom-3 left-3 right-3 bg-emerald-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-between shadow-lg">
                  <span className="truncate">
                    Đã ghi nhận: <span className="font-mono">{lastScannedFlash}</span>
                  </span>
                  <Check className="h-4 w-4 shrink-0 ml-2" />
                </div>
              )}
            </div>

            {cameraError && (
              <div
                role="alert"
                className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900"
              >
                {cameraError}
              </div>
            )}
          </div>

          {/* Camera controls */}
          <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              {!isScanning ? (
                <button
                  type="button"
                  onClick={startCamera}
                  disabled={startingCamera}
                  className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap"
                >
                  <Camera className="h-4 w-4" />
                  <span>{startingCamera ? 'Đang mở camera...' : 'Bắt đầu quét'}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopCamera}
                  className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors whitespace-nowrap"
                >
                  <CameraOff className="h-4 w-4" />
                  <span>Dừng camera</span>
                </button>
              )}

              {cameras.length > 1 && (
                <select
                  value={selectedCameraId}
                  onChange={(e) => setSelectedCameraId(e.target.value)}
                  disabled={isScanning}
                  className="min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-700 max-w-[200px]"
                  aria-label="Chọn camera"
                >
                  <option value="">Tự động chọn camera</option>
                  {cameras.map((cam) => (
                    <option key={cam.id} value={cam.id}>
                      {cam.label}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex items-center gap-2 text-sm text-slate-600">
              <label htmlFor="cooldown-select" className="whitespace-nowrap">
                Độ trễ quét lại:
              </label>
              <select
                id="cooldown-select"
                value={cooldownMs}
                onChange={(e) => setCooldownMs(Number(e.target.value))}
                className="min-h-[44px] px-2.5 py-1.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-800 tabular-nums"
              >
                <option value={1000}>1.0 giây</option>
                <option value={1800}>1.8 giây</option>
                <option value={3000}>3.0 giây</option>
              </select>
            </div>
          </div>
        </div>

        {/* Right: Session & USB/Manual Entry */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between">
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Keyboard className="h-5 w-5 text-blue-600 shrink-0" />
                <span>Nhập tay &amp; Súng quét USB</span>
              </h2>
              <p className="text-sm text-slate-600 mt-0.5">
                Phù hợp khi dùng máy quét cầm tay trên máy tính hoặc nhập nhanh mã bị mờ.
              </p>
            </div>

            <div>
              <label
                htmlFor="session-name-input"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Tên phiên quét hiện tại
              </label>
              <input
                id="session-name-input"
                type="text"
                maxLength={100}
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="VD: Kiểm kho sáng 24/11"
                className="w-full min-h-[44px] px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
              />
            </div>

            {/* Duplicate scan handling segmented control */}
            <div>
              <span className="block text-sm font-medium text-slate-700 mb-1.5">
                Khi quét trùng mã trong cùng phiên
              </span>
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setAccumulateMode(true)}
                  className={`min-h-[40px] px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                    accumulateMode
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Cộng dồn số lượng
                </button>
                <button
                  type="button"
                  onClick={() => setAccumulateMode(false)}
                  className={`min-h-[40px] px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                    !accumulateMode
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Thêm dòng mới
                </button>
              </div>
            </div>

            <form onSubmit={handleManualSubmit} className="space-y-3 pt-1">
              <div>
                <label
                  htmlFor="manual-barcode-input"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
                >
                  Mã vạch (nhấn Enter để lưu ngay)
                </label>
                <input
                  ref={manualInputRef}
                  id="manual-barcode-input"
                  type="text"
                  maxLength={200}
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  placeholder="Quét hoặc nhập mã vạch..."
                  className="w-full min-h-[44px] px-3.5 py-2.5 text-base font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                />
              </div>

              <div>
                <label
                  htmlFor="manual-note-input"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
                >
                  Ghi chú (không bắt buộc)
                </label>
                <input
                  id="manual-note-input"
                  type="text"
                  maxLength={300}
                  value={manualNote}
                  onChange={(e) => setManualNote(e.target.value)}
                  placeholder="Tên hàng hóa, vị trí kệ..."
                  className="w-full min-h-[44px] px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                />
              </div>

              <button
                type="submit"
                disabled={!manualCode.trim()}
                className="w-full min-h-[48px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-40 transition-colors"
              >
                <Plus className="h-4 w-4" />
                <span>Lưu mã vạch vào danh sách</span>
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Stored Barcodes List + Export Excel Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-1">
            <div className="relative flex-1 max-w-sm">
              <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm mã vạch hoặc ghi chú..."
                className="w-full min-h-[44px] pl-10 pr-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <select
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
              className="min-h-[44px] px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-700"
              aria-label="Lọc theo phiên quét"
            >
              <option value="ALL">Tất cả phiên ({scans.length})</option>
              {uniqueSessions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
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
                  {isSyncing
                    ? 'Đang đồng bộ...'
                    : `Đồng bộ Supabase (${unsyncedCount})`}
                </span>
              </button>
            )}

            {filteredScans.length > 0 && (
              <button
                type="button"
                onClick={() => setClearSessionConfirm(true)}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors whitespace-nowrap"
              >
                <Trash2 className="h-4 w-4" />
                <span>Xóa danh sách</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleExportExcel}
              disabled={filteredScans.length === 0}
              className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-colors whitespace-nowrap"
            >
              <FileSpreadsheet className="h-4 w-4" />
              <span>Xuất Excel (.xlsx)</span>
            </button>
          </div>
        </div>

        {/* Loading / Empty / Data views */}
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="h-12 bg-slate-100 rounded-lg animate-pulse"
              />
            ))}
          </div>
        ) : filteredScans.length === 0 ? (
          <div className="py-14 px-6 text-center">
            <p className="text-base font-bold text-slate-900">
              Chưa có mã vạch nào được lưu
            </p>
            <p className="mt-1.5 text-sm text-slate-600 max-w-md mx-auto">
              Hãy nhấn "Bắt đầu quét" để mở camera hoặc nhập mã trực tiếp vào ô súng quét USB ở trên.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                    <th className="py-3 px-4 w-12">STT</th>
                    <th className="py-3 px-4">Mã vạch</th>
                    <th className="py-3 px-4">Phiên &amp; Định dạng</th>
                    <th className="py-3 px-4 text-center">Số lượng</th>
                    <th className="py-3 px-4">Ghi chú</th>
                    <th className="py-3 px-4">Thời gian</th>
                    <th className="py-3 px-4 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredScans.map((scan, index) => (
                    <tr key={scan.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3 px-4 text-slate-500 tabular-nums">
                        {index + 1}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-mono font-semibold text-slate-900">
                          {scan.code}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {scan.syncedToSupabase
                            ? 'Đã đồng bộ Supabase'
                            : 'Lưu trên đám mây'}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-slate-700">
                        <div>{scan.sessionName}</div>
                        <div className="text-xs text-slate-500 mt-0.5 font-mono">
                          {scan.format}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateQuantity(scan, Math.max(1, scan.quantity - 1))
                            }
                            disabled={scan.quantity <= 1}
                            className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                            aria-label="Giảm số lượng"
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <span className="min-w-[36px] text-center font-bold text-slate-900 tabular-nums">
                            {scan.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => onUpdateQuantity(scan, scan.quantity + 1)}
                            className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-100"
                            aria-label="Tăng số lượng"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                      <td className="py-3 px-4 max-w-[220px]">
                        {editingNoteId === scan.id ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={editingNoteText}
                              onChange={(e) => setEditingNoteText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveEditedNote(scan);
                                if (e.key === 'Escape') setEditingNoteId(null);
                              }}
                              autoFocus
                              className="w-full px-2.5 py-1.5 text-sm border border-blue-500 rounded-md focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => saveEditedNote(scan)}
                              className="px-2.5 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md"
                            >
                              Lưu
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingNoteId(scan.id);
                              setEditingNoteText(scan.note || '');
                            }}
                            className="text-left text-slate-600 hover:text-blue-600 transition-colors truncate block w-full"
                          >
                            {scan.note ? scan.note : 'Thêm ghi chú...'}
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-4 text-slate-500 tabular-nums whitespace-nowrap">
                        {formatTime(scan)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(scan)}
                          className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                          aria-label={`Xóa mã ${scan.code}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Card List */}
            <div className="md:hidden divide-y divide-slate-100">
              {filteredScans.map((scan) => (
                <div key={scan.id} className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-base font-bold text-slate-900 break-all">
                        {scan.code}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {scan.sessionName} <span aria-hidden="true">·</span>{' '}
                        <span className="font-mono">{scan.format}</span>{' '}
                        <span aria-hidden="true">·</span>{' '}
                        <span className="tabular-nums">{formatTime(scan)}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(scan)}
                      className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-600"
                      aria-label={`Xóa mã ${scan.code}`}
                    >
                      <Trash2 className="h-5 w-5" />
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {editingNoteId === scan.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={editingNoteText}
                            onChange={(e) => setEditingNoteText(e.target.value)}
                            className="flex-1 min-h-[44px] px-3 text-sm border border-blue-500 rounded-lg"
                            placeholder="Ghi chú..."
                          />
                          <button
                            type="button"
                            onClick={() => saveEditedNote(scan)}
                            className="min-h-[44px] px-4 text-sm font-medium text-white bg-blue-600 rounded-lg"
                          >
                            Lưu
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingNoteId(scan.id);
                            setEditingNoteText(scan.note || '');
                          }}
                          className="min-h-[44px] text-left text-sm text-slate-600 truncate w-full"
                        >
                          {scan.note ? scan.note : 'Chạm để thêm ghi chú...'}
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateQuantity(scan, Math.max(1, scan.quantity - 1))
                        }
                        disabled={scan.quantity <= 1}
                        className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-700 disabled:opacity-40"
                        aria-label="Giảm số lượng"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <span className="min-w-[36px] text-center text-base font-bold text-slate-900 tabular-nums">
                        {scan.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => onUpdateQuantity(scan, scan.quantity + 1)}
                        className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-700"
                        aria-label="Tăng số lượng"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Confirm delete single scan */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Xóa mã vạch này?"
        description={
          deleteTarget
            ? `Bạn có chắc chắn muốn xóa mã "${deleteTarget.code}" (SL: ${deleteTarget.quantity}) khỏi phiên "${deleteTarget.sessionName}"?`
            : ''
        }
        confirmLabel="Xóa mã vạch"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await onDeleteScan(deleteTarget);
          }
          setDeleteTarget(null);
        }}
      />

      {/* Confirm clear filtered scans */}
      <ConfirmDialog
        open={clearSessionConfirm}
        title="Xóa các mã vạch đang hiển thị?"
        description={`Thao tác này sẽ xóa vĩnh viễn ${filteredScans.length} dòng mã vạch trong bộ lọc hiện tại. Hãy xuất Excel trước nếu cần lưu trữ bản sao.`}
        confirmLabel="Xóa tất cả"
        onCancel={() => setClearSessionConfirm(false)}
        onConfirm={async () => {
          await onClearSession(
            sessionFilter === 'ALL' ? 'Tất cả' : sessionFilter,
            filteredScans
          );
          setClearSessionConfirm(false);
        }}
      />
    </div>
  );
}
