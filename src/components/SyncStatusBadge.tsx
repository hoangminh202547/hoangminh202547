import {
  AlertCircle,
  CheckCircle2,
  CloudOff,
  Loader2,
  RefreshCw,
  Wifi,
} from 'lucide-react';
import type { DataBackendMode, SyncState } from '../types';

interface SyncStatusBadgeProps {
  state: SyncState;
  backendMode: DataBackendMode;
  lastSyncedAt: string | null;
  compact?: boolean;
  onRetrySync?: () => void;
}

const SYNC_META: Record<
  SyncState,
  {
    label: string;
    textClass: string;
    bgClass: string;
    borderClass: string;
  }
> = {
  connecting: {
    label: 'Đang kết nối',
    textClass: 'text-amber-700',
    bgClass: 'bg-amber-50',
    borderClass: 'border-amber-200',
  },
  connected: {
    label: 'Đã kết nối',
    textClass: 'text-emerald-700',
    bgClass: 'bg-emerald-50',
    borderClass: 'border-emerald-200',
  },
  syncing: {
    label: 'Đang đồng bộ',
    textClass: 'text-blue-700',
    bgClass: 'bg-blue-50',
    borderClass: 'border-blue-200',
  },
  synced: {
    label: 'Đồng bộ thành công',
    textClass: 'text-emerald-700',
    bgClass: 'bg-emerald-50',
    borderClass: 'border-emerald-200',
  },
  disconnected: {
    label: 'Mất kết nối',
    textClass: 'text-slate-700',
    bgClass: 'bg-slate-100',
    borderClass: 'border-slate-300',
  },
  error: {
    label: 'Lỗi đồng bộ',
    textClass: 'text-red-700',
    bgClass: 'bg-red-50',
    borderClass: 'border-red-200',
  },
};

function renderIcon(state: SyncState) {
  switch (state) {
    case 'connecting':
    case 'syncing':
      return <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />;
    case 'connected':
      return <Wifi className="h-3.5 w-3.5 shrink-0" />;
    case 'synced':
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />;
    case 'disconnected':
      return <CloudOff className="h-3.5 w-3.5 shrink-0" />;
    case 'error':
      return <AlertCircle className="h-3.5 w-3.5 shrink-0" />;
  }
}

export function SyncStatusBadge({
  state,
  backendMode,
  lastSyncedAt,
  compact = false,
  onRetrySync,
}: SyncStatusBadgeProps) {
  const meta = SYNC_META[state];
  const formattedTime = lastSyncedAt
    ? new Intl.DateTimeFormat('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(new Date(lastSyncedAt))
    : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium whitespace-nowrap ${meta.bgClass} ${meta.borderClass} ${meta.textClass}`}
      title={
        formattedTime
          ? `${meta.label} · Nguồn: ${backendMode === 'supabase' ? 'Supabase Realtime' : 'Firebase Cloud'} · Cập nhật lúc ${formattedTime}`
          : `${meta.label} · Nguồn: ${backendMode === 'supabase' ? 'Supabase Realtime' : 'Firebase Cloud'}`
      }
    >
      {renderIcon(state)}
      <span>{meta.label}</span>
      {!compact && formattedTime && (
        <span className="text-slate-500 font-normal tabular-nums hidden xl:inline">
          · {formattedTime}
        </span>
      )}
      {onRetrySync && (state === 'error' || state === 'disconnected') && (
        <button
          type="button"
          onClick={onRetrySync}
          className="ml-1 inline-flex items-center gap-1 underline hover:opacity-80"
          aria-label="Thử đồng bộ lại"
        >
          <RefreshCw className="h-3 w-3" />
          <span>Thử lại</span>
        </button>
      )}
    </div>
  );
}
