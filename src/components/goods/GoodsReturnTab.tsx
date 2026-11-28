import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BellRing,
  CalendarCheck,
  FileSpreadsheet,
  FileText,
  Filter,
  ImageDown,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useDebouncedValue } from '../../lib/cache';
import { exportReturnsToExcel } from '../../lib/excel';
import { exportTableToPdf, exportTableToPng } from '../../lib/media';
import { extractShortStaffName } from '../../lib/permissions';
import {
  deleteReturnRecords,
  fetchAllPoliciesForCache,
  fetchAuthorizedStaffOptions,
  fetchReturnsPage,
  upsertReturnRecord,
  useScopedRealtime,
  type AuthorizedStaffOption,
} from '../../lib/supabaseOps';
import type {
  AuthenticatedUser,
  AuthorizedEmail,
  ReturnRecordItem,
  SupplierPolicyItem,
} from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { PaginationBar } from '../PaginationBar';

interface GoodsReturnTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  authorizedMembers?: AuthorizedEmail[];
  canDelete: boolean;
  canExport: boolean;
  defaultPageSize: 20 | 50 | 100;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onLogActivity: (
    action: 'create' | 'update' | 'delete' | 'export',
    targetId: string,
    summary: string
  ) => void;
}

function formatViDdMmYyyy(ymd: string): string {
  if (!ymd) return '—';
  const parts = ymd.split('-');
  if (parts.length !== 3) return ymd;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function GoodsReturnTab({
  client,
  user,
  authorizedMembers = [],
  canDelete,
  canExport,
  defaultPageSize,
  onNotify,
  onLogActivity,
}: GoodsReturnTabProps) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const defaultShortPt = useMemo(
    () => extractShortStaffName(user.displayName, user.email),
    [user.displayName, user.email]
  );

  const [rows, setRows] = useState<ReturnRecordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(defaultPageSize);
  const [loading, setLoading] = useState(true);

  const [staffOptions, setStaffOptions] = useState<AuthorizedStaffOption[]>([]);
  const [policyCache, setPolicyCache] = useState<SupplierPolicyItem[]>([]);

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
    ptCode: defaultShortPt,
    supplierSystemName: '',
    productSummary: '',
    returnMethod: 'Thu hồi trực tiếp tại CH',
    reportedDate: todayStr,
  });

  // Modal requiring processed Date (Ngày/Tháng/Năm) when switching progress -> Đã xử lý
  const [completeTarget, setCompleteTarget] = useState<ReturnRecordItem | null>(null);
  const [completeDateInput, setCompleteDateInput] = useState(todayStr);

  const [lastLiveNotice, setLastLiveNotice] = useState<{
    time: string;
    actor: string;
    summary: string;
  } | null>(null);
  const lastLiveNoticeRef = useRef(lastLiveNotice);
  lastLiveNoticeRef.current = lastLiveNotice;

  const [deleteTarget, setDeleteTarget] = useState<ReturnRecordItem | null>(null);

  useEffect(() => {
    if (!client) return;
    void Promise.all([
      fetchAuthorizedStaffOptions(client, authorizedMembers),
      fetchAllPoliciesForCache(client),
    ]).then(([staff, pols]) => {
      setStaffOptions(staff);
      setPolicyCache(pols);
    });
  }, [client, authorizedMembers]);

  const supplierSuggestions = useMemo(() => {
    const uniq = new Set<string>();
    for (const p of policyCache) {
      if (p.supplierSystemName) uniq.add(p.supplierSystemName);
    }
    return Array.from(uniq).sort((a, b) => a.localeCompare(b, 'vi'));
  }, [policyCache]);

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
            ? new Intl.DateTimeFormat('vi-VN', {
                dateStyle: 'short',
                timeStyle: 'short',
              }).format(new Date(top.updatedAt))
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
      time: new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(
        new Date()
      ),
      actor: user.email,
      summary: noteText,
    });
    onNotify('success', 'Đã ghi nhận phiếu đổi trả hàng hóa.');
    onLogActivity('create', form.supplierSystemName, noteText);
    setForm({
      ptCode: defaultShortPt,
      supplierSystemName: '',
      productSummary: '',
      returnMethod: 'Thu hồi trực tiếp tại CH',
      reportedDate: todayStr,
    });
    setFormOpen(false);
    void loadRows();
  };

  const commitProgressUpdate = async (
    item: ReturnRecordItem,
    nextProgress: 'processing' | 'completed',
    processedDate: string
  ) => {
    if (!client) return;
    const summaryText =
      nextProgress === 'completed'
        ? `Hoàn tất đổi trả "${item.productSummary}" ngày ${formatViDdMmYyyy(processedDate)}`
        : `Chuyển lại trạng thái Đang xử lý "${item.productSummary}"`;

    const res = await upsertReturnRecord(client, {
      ...item,
      progress: nextProgress,
      completedDate: nextProgress === 'completed' ? processedDate : '',
      lastUpdateNote: summaryText,
      updatedBy: user.email,
    });
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    setLastLiveNotice({
      time: new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(
        new Date()
      ),
      actor: user.email,
      summary: summaryText,
    });
    onNotify('success', summaryText);
    onLogActivity('update', item.id, summaryText);
    void loadRows();
  };

  const handleProgressSelectChange = (
    item: ReturnRecordItem,
    nextValue: 'processing' | 'completed'
  ) => {
    if (nextValue === 'completed') {
      setCompleteTarget(item);
      setCompleteDateInput(item.completedDate || todayStr);
      return;
    }
    if (item.progress !== 'processing') {
      void commitProgressUpdate(item, 'processing', '');
    }
  };

  const handleConfirmCompleteModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!completeTarget) return;
    if (!completeDateInput) {
      onNotify('error', 'Vui lòng chọn đầy đủ Ngày/Tháng/Năm đã xử lý.');
      return;
    }
    const target = completeTarget;
    const dateVal = completeDateInput;
    setCompleteTarget(null);
    await commitProgressUpdate(target, 'completed', dateVal);
  };

  const exportColumns = [
    { header: 'STT', width: 42, align: 'center' as const },
    { header: 'Người PT', width: 85 },
    { header: 'Tên NCC HT', width: 135 },
    { header: 'Hàng đổi trả', width: 205 },
    { header: 'Hình thức', width: 130 },
    { header: 'Tiến độ', width: 100 },
    { header: 'Ngày xử lý', width: 92 },
    { header: 'Báo đổi trả', width: 92 },
  ];

  const exportValues = rows.map((r, idx) => [
    idx + 1,
    r.ptCode || '—',
    r.supplierSystemName,
    r.productSummary,
    r.returnMethod,
    r.progress === 'completed' ? 'Đã xử lý' : 'Đang xử lý',
    r.completedDate ? formatViDdMmYyyy(r.completedDate) : '—',
    r.reportedDate ? formatViDdMmYyyy(r.reportedDate) : '—',
  ]);

  return (
    <div className="space-y-4">
      {/* Live Update Notification Line */}
      {lastLiveNotice && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 flex items-center gap-2.5 text-xs sm:text-sm text-blue-950">
          <BellRing className="h-4 w-4 text-blue-600 shrink-0" />
          <p className="truncate">
            <strong>Cập nhật mới nhất ({lastLiveNotice.time}):</strong>{' '}
            <span className="font-mono">{lastLiveNotice.actor}</span> · {lastLiveNotice.summary}
          </p>
        </div>
      )}

      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFormOpen((v) => !v)}
              className="min-h-[40px] px-3.5 py-2 rounded-lg bg-blue-600 text-white text-xs sm:text-sm font-medium hover:bg-blue-700 inline-flex items-center gap-1.5"
            >
              <Plus className="h-4 w-4" />
              <span>Báo đổi trả mới</span>
            </button>
            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
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
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
              >
                <ImageDown className="h-4 w-4 text-blue-600" />
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
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
              >
                <FileText className="h-4 w-4 text-red-600" />
                <span>PDF</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  const f = await exportReturnsToExcel(rows);
                  onNotify('success', `Đã xuất ${f}`);
                }}
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
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
              className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              value={itemFilter}
              onChange={(e) => {
                setItemFilter(e.target.value);
                setPage(1);
              }}
              placeholder="Hàng đổi trả..."
              className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              value={methodFilter}
              onChange={(e) => {
                setMethodFilter(e.target.value);
                setPage(1);
              }}
              placeholder="Hình thức..."
              className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              value={ptFilter}
              onChange={(e) => {
                setPtFilter(e.target.value);
                setPage(1);
              }}
              placeholder="Người PT..."
              className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
          </div>
        )}

        {/* Structured, easy-to-read "Báo đổi trả mới" form */}
        {formOpen && (
          <form
            onSubmit={handleAdd}
            className="pt-4 border-t border-slate-200 bg-slate-50/70 -mx-4 px-4 pb-2 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">
                Thông tin phiếu báo đổi trả hàng hóa mới
              </h3>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="text-xs font-medium text-slate-500 hover:text-slate-800"
              >
                Thu gọn
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
              <div className="lg:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Tên nhà cung cấp hệ thống (Tên NCC HT) *
                </label>
                <input
                  type="text"
                  required
                  list="return-supplier-suggestions"
                  placeholder="Nhập hoặc chọn Tên NCC HT..."
                  value={form.supplierSystemName}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, supplierSystemName: e.target.value }))
                  }
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                />
                <datalist id="return-supplier-suggestions">
                  {supplierSuggestions.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>

              <div className="lg:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Hàng đổi trả (tên hàng / số lượng / HSD) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="VD: Canxi D3 x 5 hộp (HSD 08/2026)"
                  value={form.productSummary}
                  onChange={(e) => setForm((p) => ({ ...p, productSummary: e.target.value }))}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Người PT phụ trách
                </label>
                {staffOptions.length > 0 ? (
                  <select
                    value={form.ptCode}
                    onChange={(e) => setForm((p) => ({ ...p, ptCode: e.target.value }))}
                    className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">-- Chọn PT --</option>
                    {staffOptions.map((opt) => (
                      <option key={opt.email || opt.shortName} value={opt.shortName}>
                        {opt.shortName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    placeholder="Tên rút gọn PT"
                    value={form.ptCode}
                    onChange={(e) => setForm((p) => ({ ...p, ptCode: e.target.value }))}
                    className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Ngày báo đổi trả
                </label>
                <input
                  type="date"
                  value={form.reportedDate}
                  onChange={(e) => setForm((p) => ({ ...p, reportedDate: e.target.value }))}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div className="sm:col-span-2 lg:col-span-4">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Hình thức đổi trả
                </label>
                <input
                  type="text"
                  list="return-method-suggestions"
                  placeholder="VD: Thu hồi trực tiếp tại CH / Đổi hàng mới / Trừ công nợ"
                  value={form.returnMethod}
                  onChange={(e) => setForm((p) => ({ ...p, returnMethod: e.target.value }))}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                />
                <datalist id="return-method-suggestions">
                  <option value="Thu hồi trực tiếp tại CH" />
                  <option value="Đổi hàng date mới 1:1" />
                  <option value="Trừ công nợ hóa đơn sau" />
                  <option value="Gửi chuyển phát về NCC" />
                </datalist>
              </div>

              <div className="sm:col-span-2 flex items-end justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="min-h-[42px] px-4 rounded-lg border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50"
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  className="min-h-[42px] px-5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 whitespace-nowrap"
                >
                  Lưu phiếu đổi trả
                </button>
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Desktop Table & Mobile Vertical Cards */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                <th className="py-3 px-3">STT</th>
                <th className="py-3 px-3">Người PT</th>
                <th className="py-3 px-3">Tên NCC HT</th>
                <th className="py-3 px-3">Hàng đổi trả</th>
                <th className="py-3 px-3">Hình thức</th>
                <th className="py-3 px-3">Tiến độ &amp; Ngày xử lý</th>
                <th className="py-3 px-3">Ngày báo</th>
                {canDelete && <th className="py-3 px-3 text-right">Xóa</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={canDelete ? 8 : 7} className="py-8 text-center text-slate-500">
                    Đang tải hồ sơ đổi trả...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={canDelete ? 8 : 7} className="py-10 text-center text-slate-500">
                    Chưa có hồ sơ đổi trả nào.
                  </td>
                </tr>
              ) : (
                rows.map((item, idx) => (
                  <tr key={item.id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-3 font-mono text-xs text-slate-500 tabular-nums">
                      {(page - 1) * pageSize + idx + 1}
                    </td>
                    <td className="py-3 px-3 text-xs font-semibold text-slate-800 whitespace-nowrap">
                      {item.ptCode || '—'}
                    </td>
                    <td className="py-3 px-3 font-bold text-slate-900">
                      {item.supplierSystemName}
                    </td>
                    <td className="py-3 px-3 text-slate-900">{item.productSummary}</td>
                    <td className="py-3 px-3 text-xs text-slate-700">{item.returnMethod}</td>
                    <td className="py-3 px-3">
                      <div className="space-y-1">
                        <select
                          value={item.progress}
                          onChange={(e) =>
                            handleProgressSelectChange(
                              item,
                              e.target.value as 'processing' | 'completed'
                            )
                          }
                          aria-label={`Tiến độ ${item.productSummary}`}
                          className={`min-h-[34px] px-2.5 py-1 rounded-lg border text-xs font-semibold cursor-pointer ${
                            item.progress === 'completed'
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                              : 'bg-amber-50 border-amber-200 text-amber-800'
                          }`}
                        >
                          <option value="processing">Đang xử lý</option>
                          <option value="completed">Đã xử lý</option>
                        </select>

                        {item.progress === 'completed' && (
                          <div className="flex items-center gap-2 text-xs text-emerald-700 font-mono tabular-nums">
                            <span>Ngày xử lý: {formatViDdMmYyyy(item.completedDate)}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setCompleteTarget(item);
                                setCompleteDateInput(item.completedDate || todayStr);
                              }}
                              className="font-sans text-[11px] font-medium text-blue-600 hover:underline"
                            >
                              Đổi ngày
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-3 font-mono text-xs tabular-nums text-slate-700 whitespace-nowrap">
                      {formatViDdMmYyyy(item.reportedDate)}
                    </td>
                    {canDelete && (
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(item)}
                          className="min-h-[34px] p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"
                          title="Xóa phiếu đổi trả"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Portrait Vertical Cards */}
        <div className="md:hidden divide-y divide-slate-200">
          {loading ? (
            <div className="p-6 text-center text-sm text-slate-500">Đang tải hồ sơ đổi trả...</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Chưa có hồ sơ đổi trả nào.
            </div>
          ) : (
            rows.map((item, idx) => (
              <div key={item.id} className="p-4 space-y-2.5 text-[15px]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-mono text-xs text-slate-500 mr-2 tabular-nums">
                      #{(page - 1) * pageSize + idx + 1}
                    </span>
                    <span className="font-bold text-slate-900">{item.supplierSystemName}</span>
                  </div>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(item)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 shrink-0"
                      aria-label="Xóa phiếu"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>

                <p className="font-medium text-slate-900 leading-snug">{item.productSummary}</p>

                <div className="rounded-lg bg-slate-50 p-3 space-y-1.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">Người PT:</span>
                    <span className="font-semibold text-slate-900">{item.ptCode || '—'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">Hình thức:</span>
                    <span className="text-slate-800 text-right">{item.returnMethod || '—'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">Ngày báo:</span>
                    <span className="font-mono text-slate-800 tabular-nums">
                      {formatViDdMmYyyy(item.reportedDate)}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <select
                    value={item.progress}
                    onChange={(e) =>
                      handleProgressSelectChange(
                        item,
                        e.target.value as 'processing' | 'completed'
                      )
                    }
                    className={`min-h-[40px] px-3 py-1.5 rounded-lg border text-sm font-semibold ${
                      item.progress === 'completed'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : 'bg-amber-50 border-amber-200 text-amber-800'
                    }`}
                  >
                    <option value="processing">Đang xử lý</option>
                    <option value="completed">Đã xử lý</option>
                  </select>

                  {item.progress === 'completed' && (
                    <div className="flex items-center gap-2 text-xs text-emerald-700 font-mono tabular-nums">
                      <span>Đã xử lý: {formatViDdMmYyyy(item.completedDate)}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setCompleteTarget(item);
                          setCompleteDateInput(item.completedDate || todayStr);
                        }}
                        className="font-sans font-semibold text-blue-600 underline"
                      >
                        Sửa ngày
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
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

      {/* Modal: Required Completed Date when switching -> Đã xử lý */}
      {completeTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmCompleteModal}
            className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-5 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-900 font-bold">
                <CalendarCheck className="h-5 w-5 text-emerald-600" />
                <span>Xác nhận ngày đã xử lý đổi trả</span>
              </div>
              <button
                type="button"
                onClick={() => setCompleteTarget(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3 space-y-1">
              <p className="font-bold text-slate-900">{completeTarget.supplierSystemName}</p>
              <p>{completeTarget.productSummary}</p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Ngày / Tháng / Năm đã xử lý *
              </label>
              <input
                type="date"
                required
                value={completeDateInput}
                onChange={(e) => setCompleteDateInput(e.target.value)}
                className="w-full min-h-[44px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
              {completeDateInput && (
                <p className="mt-1 text-xs text-emerald-700 font-medium">
                  Sẽ ghi nhận ngày hoàn tất: {formatViDdMmYyyy(completeDateInput)}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCompleteTarget(null)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="submit"
                className="min-h-[40px] px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
              >
                Xác nhận Đã xử lý
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Xóa phiếu đổi trả"
        description={`Xóa phiếu đổi trả "${deleteTarget?.productSummary}" (${deleteTarget?.supplierSystemName})?`}
        confirmLabel="Xóa"
        variant="danger"
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
