import { useEffect, useState } from 'react';
import { Download, Monitor, Share2, Smartphone, X } from 'lucide-react';
import {
  canvasToPngBlob,
  downloadPngBlob,
  renderScheduleMatrixCanvas,
  type ExportCanvasLayout,
  type MatrixExportRow,
} from '../../lib/scheduleExport';
import { formatViDate, type WeekDayInfo } from '../../lib/scheduleMeta';

interface ScheduleExportModalProps {
  open: boolean;
  onClose: () => void;
  rows: MatrixExportRow[];
  weekDays: WeekDayInfo[];
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onExportLogged?: (fileName: string, count: number) => void;
}

export function ScheduleExportModal({
  open,
  onClose,
  rows,
  weekDays,
  onNotify,
  onExportLogged,
}: ScheduleExportModalProps) {
  const [layout, setLayout] = useState<ExportCanvasLayout>('desktop');
  const [showNotes, setShowNotes] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [pngBlob, setPngBlob] = useState<Blob | null>(null);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    let objectUrl = '';

    const generate = async () => {
      setRendering(true);
      try {
        if (typeof document !== 'undefined' && 'fonts' in document) {
          await document.fonts.ready;
        }
        const canvas = renderScheduleMatrixCanvas({
          rows,
          weekDays,
          layout,
          showNotes,
        });
        const blob = await canvasToPngBlob(canvas);
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPngBlob(blob);
        setPreviewUrl(objectUrl);
      } catch (err) {
        if (active) {
          onNotify(
            'error',
            err instanceof Error ? err.message : 'Không thể tạo ảnh xem trước.'
          );
        }
      } finally {
        if (active) setRendering(false);
      }
    };

    void generate();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, rows, weekDays, layout, showNotes, onNotify]);

  if (!open) return null;

  const fileName = `LichLamViec_${weekDays[0]?.ymd || 'Tuan'}_${
    layout === 'desktop' ? 'Ngang' : 'Doc'
  }.png`;

  const handleDownload = () => {
    if (!pngBlob) return;
    downloadPngBlob(pngBlob, fileName);
    onNotify('success', `Đã tải ảnh ${fileName}`);
    onExportLogged?.(fileName, rows.length);
  };

  const handleShare = async () => {
    if (!pngBlob) return;
    const file = new File([pngBlob], fileName, { type: 'image/png' });
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.share === 'function' &&
      (!navigator.canShare || navigator.canShare({ files: [file] }))
    ) {
      try {
        await navigator.share({
          title: 'Lịch làm việc tuần chính thức',
          text: `Lịch làm việc tuần ${formatViDate(weekDays[0].ymd)} – ${formatViDate(
            weekDays[6].ymd
          )}`,
          files: [file],
        });
        onExportLogged?.(fileName, rows.length);
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
      }
    }
    downloadPngBlob(pngBlob, fileName);
    onNotify(
      'info',
      'Trình duyệt không hỗ trợ chia sẻ tệp trực tiếp, đã tải ảnh về máy.'
    );
    onExportLogged?.(fileName, rows.length);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-png-title"
    >
      <div className="w-full sm:max-w-5xl bg-white border border-slate-200 rounded-t-2xl sm:rounded-2xl max-h-[94vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3
              id="export-png-title"
              className="text-base sm:text-lg font-bold text-slate-900"
            >
              Xuất ảnh lịch làm việc
            </h3>
            <p className="text-xs text-slate-500">
              Tuần {formatViDate(weekDays[0].ymd)} – {formatViDate(weekDays[6].ymd)} ·{' '}
              {rows.length} nhân sự đang hiển thị
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center"
            aria-label="Đóng"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Options Toolbar */}
        <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex p-1 bg-slate-200/70 rounded-lg">
            <button
              type="button"
              onClick={() => setLayout('desktop')}
              className={`min-h-[36px] px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                layout === 'desktop'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Monitor className="h-3.5 w-3.5" />
              <span>Bảng ngang (Máy tính)</span>
            </button>
            <button
              type="button"
              onClick={() => setLayout('mobile')}
              className={`min-h-[36px] px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                layout === 'mobile'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Smartphone className="h-3.5 w-3.5" />
              <span>Thẻ dọc (Điện thoại)</span>
            </button>
          </div>

          <label className="min-h-[36px] inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showNotes}
              onChange={(e) => setShowNotes(e.target.checked)}
              className="h-4 w-4 accent-blue-600 rounded"
            />
            <span>Hiện ghi chú ca</span>
          </label>
        </div>

        {/* Canvas Image Preview */}
        <div className="flex-1 overflow-auto p-4 sm:p-6 bg-slate-100 flex items-start justify-center">
          {rendering ? (
            <div className="py-20 text-sm text-slate-500">Đang kết xuất hình ảnh...</div>
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt="Xem trước ảnh lịch làm việc"
              className={`rounded-lg border border-slate-200 bg-white shadow-sm ${
                layout === 'mobile' ? 'max-w-[440px] w-full' : 'max-w-full h-auto'
              }`}
            />
          ) : (
            <div className="py-20 text-sm text-slate-500">Không có dữ liệu xem trước.</div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-slate-200 bg-white flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Đóng
          </button>
          <button
            type="button"
            onClick={() => void handleShare()}
            disabled={!pngBlob || rendering}
            className="min-h-[42px] px-4 py-2 rounded-lg border border-blue-200 bg-blue-50 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <Share2 className="h-4 w-4" />
            <span>Lưu / Chia sẻ</span>
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={!pngBlob || rendering}
            className="min-h-[42px] px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <Download className="h-4 w-4" />
            <span>Tải ảnh về máy</span>
          </button>
        </div>
      </div>
    </div>
  );
}
