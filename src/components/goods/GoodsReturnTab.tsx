import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BellRing,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Filter,
  ImageDown,
  Plus,
  Trash2,
} from 'lucide-react';
import { useDebouncedValue } from '../../lib/cache';
import { exportReturnsToExcel } from '../../lib/excel';
import { exportTableToPdf, exportTableToPng } from '../../lib/media';
import {
  deleteReturnRecords,
  fetchReturnsPage,
  upsertReturnRecord,
  useScopedRealtime,
} from '../../lib/supabaseOps';
import type { AuthenticatedUser, ReturnRecordItem } from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { PaginationBar } from '../PaginationBar';

interface GoodsReturnTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  canDelete: boolean;
  canExport: boolean;
  defaultPageSize: 20 | 50 | 100;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onLogActivity: (action: 'create' | 'update' | 'delete' | 'export', targetId: string, summary: string) => void;
}

export function GoodsReturnTab({
  client,
  user,
  canDelete,
  canExport,
  defaultPageSize,
  onNotify,
  onLogActivity,
}: GoodsReturnTabProps) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState<ReturnRecordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(defaultPageSize);
  const [loading, setLoading] = useState(true);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const [supplierFilter, setSupplierFilter] = useState('');
  const [itemFilter, setItemFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState('');
  const [ptFilter, setPtFilter] = useState('');

  const dSup = useDebouncedValue(supplierFilter, 380);
  const dItem = useDebouncedValue(itemFilter, 380);
  const dMethod = useDebouncedValue(methodFilter, 380);
  const dPt = useDebouncedValue(ptFilter, 380);

  const [form, setForm] = useState({
    ptCode: '',
    supplierSystemName: '',
    productSummary: '',
    returnMethod: 'Thu hồi trực tiếp tại CH',
    reportedDate: todayStr,
  });

  const [lastLiveNotice, setLastLiveNotice] = useState<{
    time: string;
    actor: string;
    summary: string;
  } | null>(null);
  const lastLiveNoticeRef = useRef(lastLiveNotice);
  lastLiveNoticeRef.current = lastLiveNotice;

  const [deleteTarget, setDeleteTarget] = useState<ReturnRecordItem | null>(null);

  const loadRows = useCallback(async () => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await fetchReturnsPage(client, {
      page,
      pageSize,
      supplierFilter: dSup,
      itemFilter: dItem,
      methodFilter: dMethod,
      ptFilter: dPt,
    });
    if (res.error) onNotify('error', res.error);
    else {
      setRows(res.rows);
      setTotal(res.total);
      if (res.rows[0] && !lastLiveNoticeRef.current) {
        const top = res.rows[0];
        setLastLiveNotice({
          time: top.updatedAt
            ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(
                new Date(top.updatedAt)
              )
            : todayStr,
          actor: top.updatedBy || 'Hệ thống',
          summary: top.lastUpdateNote || `${top.supplierSystemName} · ${top.productSummary}`,
        });
      }
    }
    setLoading(false);
  }, [client, page, pageSize, dSup, dItem, dMethod, dPt, onNotify, todayStr]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  useScopedRealtime(client, Boolean(client), ['return_records'], () => {
    void loadRows();
  });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;
    if (!form.supplierSystemName.trim() || !form.productSummary.trim()) {
      onNotify('error', 'Nhập Tên NCC HT và Hàng đổi trả.');
      return;
    }
    const noteText = `Tạo mới yêu cầu đổi trả ${form.productSummary} (${form.supplierSystemName})`;
    const res = await upsertReturnRecord(client, {
      ptCode: form.ptCode,
      supplierSystemName: form.supplierSystemName,
      productSummary: form.productSummary,
      returnMethod: form.returnMethod,
      progress: 'processing',
      reportedDate: form.reportedDate,
      completedDate: '',
      lastUpdateNote: noteText,
      updatedBy: user.email,
    });
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    setLastLiveNotice({
      time: new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date()),
      actor: user.email,
      summary: noteText,
    });
    onNotify('success', 'Đã ghi nhận phiếu đổi trả hàng hóa.');
    onLogActivity('create', form.supplierSystemName, noteText);
    setForm({
      ptCode: '',
      supplierSystemName: '',
      productSummary: '',
      returnMethod: 'Thu hồi trực tiếp tại CH',
      reportedDate: todayStr,
    });
    setFormOpen(false);
    void loadRows();
  };

  const handleMarkCompleted = async (item: ReturnRecordItem) => {
    if (!client) return;
    const nextProgress = item.progress === 'completed' ? 'processing' : 'completed';
    const summaryText =
      nextProgress === 'completed'
        ? `Hoàn tất đổi trả "${item.productSummary}" ngày ${todayStr}`
        : `Chuyển lại trạng thái Đang xử lý "${item.productSummary}"`;

    const res = await upsertReturnRecord(client, {
      ...item,
      progress: nextProgress,
      completedDate: nextProgress === 'completed' ? todayStr : '',
      lastUpdateNote: summaryText,
      updatedBy: user.email,
    });
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    setLastLiveNotice({
      time: new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date()),
      actor: user.email,
      summary: summaryText,
    });
    onLogActivity('update', item.id, summaryText);
    void loadRows();
  };

  const exportColumns = [
    { header: 'STT', width: 42, align: 'center' as const },
    { header: 'PT', width: 65 },
    { header: 'Tên NCC HT', width: 135 },
    { header: 'Hàng đổi trả', width: 210 },
    { header: 'Hình thức', width: 130 },
    { header: 'Tiến độ', width: 115 },
    { header: 'Ngày xử lý', width: 90 },
    { header: 'Báo đổi trả', width: 90 },
  ];

  const exportValues = rows.map((r, idx) => [
    idx + 1,
    r.ptCode || '—',
    r.supplierSystemName,
    r.productSummary,
    r.returnMethod,
    r.progress === 'completed' ? 'Đã xử lý' : 'Đang xử lý',
    r.completedDate || '—',
    r.reportedDate || '—',
  ]);

  return (
    <div className="space-y-5">
      {/* Live Update Notification Line */}
      {lastLiveNotice && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 flex items-center gap-2.5 text-xs text-blue-950">
          <BellRing className="h-4 w-4 text-blue-600 shrink-0" />
          <p className="truncate">
            <strong>Cập nhật mới nhất ({lastLiveNotice.time}):</strong>{' '}
            <span className="font-mono">{lastLiveNotice.actor}</span> · {lastLiveNotice.summary}
          </p>
        </div>
      )}

      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFormOpen((v) => !v)}
              className="min-h-[40px] px-3.5 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 inline-flex items-center gap-1.5"
            >
              <Plus className="h-4 w-4" />
              <span>Báo đổi trả mới</span>
            </button>
            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <Filter className="h-3.5 w-3.5" />
              <span>Bộ lọc</span>
            </button>
          </div>

          {canExport && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={async () => {
                  const f = `DoiTra_${new Date().toISOString().slice(0, 10)}.png`;
                  await exportTableToPng(
                    'THEO DÕI ĐỔI TRẢ HÀNG HÓA',
                    `Tổng ${rows.length} hồ sơ đổi trả`,
                    exportColumns,
                    exportValues,
                    f
                  );
                  onNotify('success', `Đã xuất ảnh ${f}`);
                }}
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
              >
                <ImageDown className="h-3.5 w-3.5 text-blue-600" />
                <span>Ảnh</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  const f = `DoiTra_${new Date().toISOString().slice(0, 10)}.pdf`;
                  await exportTableToPdf(
                    'THEO DÕI ĐỔI TRẢ HÀNG HÓA',
                    `Tổng ${rows.length} hồ sơ đổi trả`,
                    exportColumns,
                    exportValues,
                    f
                  );
                  onNotify('success', `Đã xuất PDF ${f}`);
                }}
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
              >
                <FileText className="h-3.5 w-3.5 text-red-600" />
                <span>PDF</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  const f = await exportReturnsToExcel(rows);
                  onNotify('success', `Đã xuất ${f}`);
                }}
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />
                <span>Excel</span>
              </button>
            </div>
          )}
        </div>

        {filtersOpen && (
          <div className="pt-3 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <input
              type="text"
              value={supplierFilter}
              onChange={(e) => {
                setSupplierFilter(e.target.value);
                setPage(1);
              }}
              placeholder="Tên NCC HT..."
              className="min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              value={itemFilter}
              onChange={(e) => {
                setItemFilter(e.target.value);
                setPage(1);
              }}
              placeholder="Hàng đổi trả..."
              className="min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              value={methodFilter}
              onChange={(e) => {
                setMethodFilter(e.target.value);
                setPage(1);
              }}
              placeholder="Hình thức..."
              className="min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              value={ptFilter}
              onChange={(e) => {
                setPtFilter(e.target.value);
                setPage(1);
              }}
              placeholder="Mã PT..."
              className="min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
          </div>
        )}

        {formOpen && (
          <form
            onSubmit={handleAdd}
            className="pt-3 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3"
          >
            <input
              type="text"
              placeholder="PT"
              value={form.ptCode}
              onChange={(e) => setForm((p) => ({ ...p, ptCode: e.target.value }))}
              className="min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              required
              placeholder="Tên NCC HT *"
              value={form.supplierSystemName}
              onChange={(e) => setForm((p) => ({ ...p, supplierSystemName: e.target.value }))}
              className="min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              required
              placeholder="Hàng đổi trả *"
              value={form.productSummary}
              onChange={(e) => setForm((p) => ({ ...p, productSummary: e.target.value }))}
              className="min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              placeholder="Hình thức"
              value={form.returnMethod}
              onChange={(e) => setForm((p) => ({ ...p, returnMethod: e.target.value }))}
              className="min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
            <div className="flex gap-2">
              <input
                type="date"
                value={form.reportedDate}
                onChange={(e) => setForm((p) => ({ ...p, reportedDate: e.target.value }))}
                className="flex-1 min-h-[38px] px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
              />
              <button
                type="submit"
                className="min-h-[38px] px-4 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
              >
                Lưu
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                <th className="py-3 px-3">STT</th>
                <th className="py-3 px-3">PT</th>
                <th className="py-3 px-3">Tên NCC HT</th>
                <th className="py-3 px-3">Hàng đổi trả</th>
                <th className="py-3 px-3">Hình thức</th>
                <th className="py-3 px-3">Tiến độ</th>
                <th className="py-3 px-3">Báo đổi trả</th>
                <th className="py-3 px-3 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    Đang tải hồ sơ đổi trả...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-slate-500">
                    Chưa có hồ sơ đổi trả nào.
                  </td>
                </tr>
              ) : (
                rows.map((item, idx) => (
                  <tr key={item.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-3 font-mono text-xs text-slate-500 tabular-nums">
                      {(page - 1) * pageSize + idx + 1}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-xs text-slate-700">
                      {item.ptCode || '—'}
                    </td>
                    <td className="py-2.5 px-3 font-bold text-slate-900">
                      {item.supplierSystemName}
                    </td>
                    <td className="py-2.5 px-3 text-slate-800">{item.productSummary}</td>
                    <td className="py-2.5 px-3 text-xs text-slate-700">{item.returnMethod}</td>
                    <td className="py-2.5 px-3 text-xs">
                      <span
                        className={`inline-block px-2 py-0.5 rounded border font-medium ${
                          item.progress === 'completed'
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                            : 'bg-amber-50 border-amber-200 text-amber-700'
                        }`}
                      >
                        {item.progress === 'completed'
                          ? `Đã xử lý (${item.completedDate || todayStr})`
                          : 'Đang xử lý'}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-xs tabular-nums text-slate-600">
                      {item.reportedDate || '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right whitespace-nowrap space-x-1.5">
                      <button
                        type="button"
                        onClick={() => void handleMarkCompleted(item)}
                        className="min-h-[34px] px-2.5 py-1 rounded border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                        <span>{item.progress === 'completed' ? 'Mở lại' : 'Hoàn tất'}</span>
                      </button>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(item)}
                          className="min-h-[34px] p-1.5 rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(sz) => {
            setPageSize(sz);
            setPage(1);
          }}
        />
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Xóa phiếu đổi trả"
        description={`Xóa phiếu đổi trả "${deleteTarget?.productSummary}" (${deleteTarget?.supplierSystemName})?`}
        confirmLabel="Xóa"
        danger
        onConfirm={async () => {
          if (client && deleteTarget) {
            const res = await deleteReturnRecords(client, [deleteTarget.id]);
            if (res.error) onNotify('error', res.error);
            else {
              onNotify('success', 'Đã xóa phiếu đổi trả.');
              void loadRows();
            }
          }
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
