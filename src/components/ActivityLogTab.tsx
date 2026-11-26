import { useMemo, useState } from 'react';
import { History, Search } from 'lucide-react';
import { ROLE_LABELS } from '../lib/permissions';
import type { ActivityAction, ActivityLog, ActivityModule } from '../types';

interface ActivityLogTabProps {
  logs: ActivityLog[];
  loading: boolean;
}

const MODULE_LABELS: Record<ActivityModule, string> = {
  barcode: 'Mã vạch',
  schedule: 'Lịch làm việc',
  attendance: 'Chấm công',
  staff: 'Nhân sự',
  feedback: 'Ý kiến khách hàng',
  warehouse: 'Kho dữ liệu',
  expiry: 'Kiểm soát HSD',
  returns: 'Đổi trả hàng',
  promotions: 'Khuyến mãi',
  storage: 'Quản lý Storage',
  access: 'Phân quyền',
  export: 'Xuất dữ liệu',
  system: 'Hệ thống',
};

const ACTION_LABELS: Record<ActivityAction, { label: string; textClass: string }> = {
  create: { label: 'Thêm mới', textClass: 'text-emerald-700' },
  update: { label: 'Chỉnh sửa', textClass: 'text-blue-700' },
  delete: { label: 'Xóa', textClass: 'text-red-600' },
  approve: { label: 'Phê duyệt', textClass: 'text-emerald-700' },
  cancel: { label: 'Hủy ca', textClass: 'text-amber-700' },
  export: { label: 'Xuất file', textClass: 'text-slate-700' },
  sync: { label: 'Đồng bộ', textClass: 'text-blue-700' },
  migrate: { label: 'Chuyển dữ liệu', textClass: 'text-blue-700' },
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

export function ActivityLogTab({ logs, loading }: ActivityLogTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [moduleFilter, setModuleFilter] = useState<'ALL' | ActivityModule>('ALL');
  const [actionFilter, setActionFilter] = useState<'ALL' | ActivityAction>('ALL');

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return logs.filter((log) => {
      const matchModule = moduleFilter === 'ALL' || log.module === moduleFilter;
      const matchAction = actionFilter === 'ALL' || log.action === actionFilter;
      const matchSearch =
        !q ||
        log.summary.toLowerCase().includes(q) ||
        log.actorEmail.toLowerCase().includes(q) ||
        log.actorName.toLowerCase().includes(q);
      return matchModule && matchAction && matchSearch;
    });
  }, [logs, moduleFilter, actionFilter, searchQuery]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Tổng nhật ký ghi nhận</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {logs.length}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Thao tác vận hành</p>
          <p className="mt-1 text-2xl font-bold text-blue-600 tabular-nums">
            {
              logs.filter((l) =>
                ['schedule', 'attendance', 'staff', 'feedback'].includes(l.module)
              ).length
            }
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Thao tác hàng hóa</p>
          <p className="mt-1 text-2xl font-bold text-emerald-600 tabular-nums">
            {
              logs.filter((l) =>
                ['barcode', 'warehouse', 'expiry', 'returns', 'promotions'].includes(
                  l.module
                )
              ).length
            }
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Hệ thống &amp; Phân quyền</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {
              logs.filter((l) =>
                ['access', 'storage', 'system', 'export'].includes(l.module)
              ).length
            }
          </p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm người thực hiện hoặc nội dung thay đổi..."
              className="w-full min-h-[44px] pl-10 pr-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={moduleFilter}
              onChange={(e) =>
                setModuleFilter(e.target.value as 'ALL' | ActivityModule)
              }
              className="min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-700"
              aria-label="Lọc theo phân hệ"
            >
              <option value="ALL">Tất cả phân hệ</option>
              {(Object.keys(MODULE_LABELS) as ActivityModule[]).map((mod) => (
                <option key={mod} value={mod}>
                  {MODULE_LABELS[mod]}
                </option>
              ))}
            </select>

            <select
              value={actionFilter}
              onChange={(e) =>
                setActionFilter(e.target.value as 'ALL' | ActivityAction)
              }
              className="min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-700"
              aria-label="Lọc theo thao tác"
            >
              <option value="ALL">Mọi thao tác</option>
              <option value="create">Thêm mới</option>
              <option value="update">Chỉnh sửa</option>
              <option value="delete">Xóa</option>
              <option value="approve">Phê duyệt</option>
              <option value="cancel">Hủy ca</option>
              <option value="export">Xuất file</option>
              <option value="migrate">Chuyển dữ liệu</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-14 bg-slate-100 rounded-lg" />
            ))}
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="py-12 px-6 text-center">
            <History className="h-9 w-9 text-slate-300 mx-auto mb-2.5" />
            <p className="text-base font-bold text-slate-900">
              Chưa có nhật ký hoạt động phù hợp
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Mọi thao tác thêm, sửa, xóa, phê duyệt và xuất dữ liệu đều được lưu tự động tại đây.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredLogs.map((log) => {
              const actionMeta = ACTION_LABELS[log.action] || {
                label: log.action,
                textClass: 'text-slate-700',
              };
              const changeEntries = Object.entries(log.changes || {});

              return (
                <div key={log.id} className="p-4 sm:p-5 space-y-1.5 hover:bg-slate-50/70">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-medium">
                    <span className={actionMeta.textClass}>{actionMeta.label}</span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="text-slate-700">
                      {MODULE_LABELS[log.module] || log.module}
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="text-slate-500 tabular-nums">
                      {formatDateTime(log.createdAt)}
                    </span>
                  </div>

                  <p className="text-sm font-medium text-slate-900">{log.summary}</p>

                  <p className="text-xs text-slate-600">
                    Thực hiện bởi: <span className="font-medium">{log.actorName || log.actorEmail}</span>{' '}
                    <span aria-hidden="true">·</span>{' '}
                    <span className="font-mono">{log.actorEmail}</span>{' '}
                    <span aria-hidden="true">·</span>{' '}
                    <span>{ROLE_LABELS[log.actorRole] || log.actorRole}</span>
                  </p>

                  {changeEntries.length > 0 && (
                    <div className="mt-1.5 text-xs font-mono text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 overflow-x-auto">
                      {changeEntries
                        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                        .join(' | ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
