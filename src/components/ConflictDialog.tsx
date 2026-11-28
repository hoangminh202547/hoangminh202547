import { useState } from 'react';
import { AlertTriangle, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { formatViDateTime } from '../lib/scheduleMeta';
import type { EditConflict } from '../types';

interface ConflictDialogProps {
  conflict: EditConflict | null;
  onClose: () => void;
}

export function ConflictDialog({ conflict, onClose }: ConflictDialogProps) {
  const [overwriting, setOverwriting] = useState(false);

  if (!conflict) return null;

  const formattedTime = conflict.serverUpdatedAt
    ? formatViDateTime(conflict.serverUpdatedAt, true)
    : 'Vừa xong';

  const handleReload = () => {
    conflict.onReloadLatest();
    onClose();
  };

  const handleOverwrite = async () => {
    setOverwriting(true);
    try {
      await conflict.onForceOverwrite();
      onClose();
    } finally {
      setOverwriting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-dialog-title"
    >
      <div className="w-full sm:max-w-lg bg-white border border-slate-200 rounded-t-2xl sm:rounded-xl p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h3
                id="conflict-dialog-title"
                className="text-lg font-bold text-slate-900 leading-snug"
              >
                Phát hiện xung đột chỉnh sửa đồng thời
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                Bản ghi <strong>{conflict.title}</strong> đã được người dùng khác cập nhật trước bạn. Để tránh ghi đè dữ liệu mới, vui lòng chọn hướng xử lý.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            aria-label="Đóng"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200">
            <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
              <span>Phiên bản hiện tại trên Database (v{conflict.serverVersion})</span>
              <span className="tabular-nums">{formattedTime}</span>
            </div>
            <p className="mt-1 text-slate-900 font-medium">
              {conflict.serverSummary}
            </p>
            {conflict.serverUpdatedBy && (
              <p className="mt-1 text-xs text-slate-500 font-mono">
                Cập nhật bởi: {conflict.serverUpdatedBy}
              </p>
            )}
          </div>

          <div className="p-3.5 rounded-lg bg-blue-50/70 border border-blue-200">
            <div className="text-xs font-medium text-blue-700">
              Thay đổi của bạn (dựa trên bản v{conflict.expectedVersion})
            </div>
            <p className="mt-1 text-slate-900 font-medium">
              {conflict.localSummary}
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
          <button
            type="button"
            onClick={handleReload}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap"
          >
            <RefreshCw className="h-4 w-4" />
            <span>Tải lại bản mới nhất</span>
          </button>

          <button
            type="button"
            onClick={handleOverwrite}
            disabled={overwriting}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-amber-800 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <ShieldAlert className="h-4 w-4" />
            <span>
              {overwriting ? 'Đang ghi đè...' : 'Xác nhận ghi đè'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
