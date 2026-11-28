import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Download,
  FileSpreadsheet,
  FileText,
  ImageDown,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useDebouncedValue } from '../../lib/cache';
import {
  downloadPromotionTemplate,
  exportPromotionsToExcel,
  normalizeCellNumber,
  normalizeCellString,
  normalizeExcelDate,
  parseTrailingBadgeB,
  readExcelSheetRows,
} from '../../lib/excel';
import { exportTableToPdf, exportTableToPng } from '../../lib/media';
import { extractShortStaffName } from '../../lib/permissions';
import {
  deletePromotionsBatch,
  fetchAllCatalogForCache,
  fetchAuthorizedStaffOptions,
  fetchPromotionsPage,
  upsertPromotionItem,
  useScopedRealtime,
  type AuthorizedStaffOption,
} from '../../lib/supabaseOps';
import type {
  AuthenticatedUser,
  AuthorizedEmail,
  ProductCatalogItem,
  PromotionItem,
} from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { PaginationBar } from '../PaginationBar';

interface PromotionsTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  authorizedMembers?: AuthorizedEmail[];
  canEdit: boolean;
  canDelete: boolean;
  canExport: boolean;
  autoResetIdle: boolean;
  defaultPageSize: 20 | 50 | 100;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onLogActivity: (
    action: 'create' | 'update' | 'delete' | 'export',
    targetId: string,
    summary: string
  ) => void;
}

export function PromotionsTab({
  client,
  user,
  authorizedMembers = [],
  canEdit,
  canDelete,
  canExport,
  autoResetIdle,
  defaultPageSize,
  onNotify,
  onLogActivity,
}: PromotionsTabProps) {
  const defaultShortPt = useMemo(
    () => extractShortStaffName(user.displayName, user.email),
    [user.displayName, user.email]
  );

  const [rows, setRows] = useState<PromotionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(defaultPageSize);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 380);
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'active' | 'scheduled' | 'ended'>('ALL');
  const [bBadgeFilter, setBBadgeFilter] = useState<'ALL' | 'YES' | 'NO'>('ALL');

  const [formOpen, setFormOpen] = useState(false);
  const [catalogCache, setCatalogCache] = useState<ProductCatalogItem[]>([]);
  const [staffOptions, setStaffOptions] = useState<AuthorizedStaffOption[]>([]);
  const [form, setForm] = useState({
    productCode: '',
    barcode: '',
    rawName: '',
    unit: 'Hộp',
    expDate: '',
    quantity: 1,
    discountRate: 10,
    regularPrice: 0,
    ptCode: defaultShortPt,
    status: 'active' as PromotionItem['status'],
  });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Idle auto-reset filters ONLY when user is NOT actively typing/interacting
  const lastInteractionRef = useRef<number>(Date.now());
  const markInteraction = () => {
    lastInteractionRef.current = Date.now();
  };

  useEffect(() => {
    if (!autoResetIdle) return;
    const hasFilter =
      search.trim() !== '' || statusFilter !== 'ALL' || bBadgeFilter !== 'ALL';
    if (!hasFilter) return;

    const timer = window.setInterval(() => {
      if (Date.now() - lastInteractionRef.current > 60_000) {
        setSearch('');
        setStatusFilter('ALL');
        setBBadgeFilter('ALL');
        setPage(1);
      }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [autoResetIdle, search, statusFilter, bBadgeFilter]);

  useEffect(() => {
    if (!client) return;
    void Promise.all([
      fetchAllCatalogForCache(client),
      fetchAuthorizedStaffOptions(client, authorizedMembers),
    ]).then(([cats, staff]) => {
      setCatalogCache(cats);
      setStaffOptions(staff);
    });
  }, [client, authorizedMembers]);

  const loadRows = useCallback(async () => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await fetchPromotionsPage(client, {
      page,
      pageSize,
      search: debouncedSearch,
      statusFilter,
      onlyBBadge: bBadgeFilter,
    });
    if (res.error) onNotify('error', res.error);
    else {
      setRows(res.rows);
      setTotal(res.total);
    }
    setLoading(false);
  }, [client, page, pageSize, debouncedSearch, statusFilter, bBadgeFilter, onNotify]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  useScopedRealtime(client, Boolean(client), ['promotions'], () => {
    void loadRows();
  });

  const handleCodeLookup = (codeVal: string) => {
    setForm((p) => ({ ...p, productCode: codeVal }));
    const cat = catalogCache.find(
      (c) =>
        c.productCode.toLowerCase() === codeVal.trim().toLowerCase() ||
        c.barcode === codeVal.trim()
    );
    if (cat) {
      setForm((p) => ({
        ...p,
        productCode: cat.productCode,
        barcode: cat.barcode,
        rawName: cat.name,
        unit: cat.unit,
        regularPrice: cat.price,
      }));
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;
    if (!form.productCode.trim() || !form.rawName.trim()) {
      onNotify('error', 'Nhập Mã hàng và Tên hàng.');
      return;
    }
    const parsed = parseTrailingBadgeB(form.rawName);
    const res = await upsertPromotionItem(client, {
      productCode: form.productCode,
      barcode: form.barcode,
      productName: parsed.cleanName,
      hasBBadge: parsed.hasBBadge,
      unit: form.unit,
      expDate: form.expDate,
      quantity: form.quantity,
      discountRate: form.discountRate,
      regularPrice: form.regularPrice,
      ptCode: form.ptCode,
      status: form.status,
      updatedBy: user.email,
    });
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    onNotify('success', `Đã lưu khuyến mãi cho mã ${form.productCode}`);
    onLogActivity(
      'create',
      form.productCode,
      `Thêm KM ${form.productCode} (-${form.discountRate}%)`
    );
    setFormOpen(false);
    setForm({
      productCode: '',
      barcode: '',
      rawName: '',
      unit: 'Hộp',
      expDate: '',
      quantity: 1,
      discountRate: 10,
      regularPrice: 0,
      ptCode: defaultShortPt,
      status: 'active',
    });
    void loadRows();
  };

  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !client) return;
    try {
      const sheet = await readExcelSheetRows(file);
      if (sheet.length <= 1) return;
      let added = 0;
      let skippedDup = 0;

      for (const r of sheet.slice(1)) {
        const code = normalizeCellString(r[1]);
        const barcode = normalizeCellString(r[2]);
        const rawName = normalizeCellString(r[3]);
        const unit = normalizeCellString(r[4]) || 'Hộp';
        const expDate = normalizeExcelDate(r[5]);
        const quantity = Math.max(0, Math.round(normalizeCellNumber(r[6], 1)));
        const discountRate = normalizeCellNumber(r[7], 0);
        const regularPrice = normalizeCellNumber(r[8], 0);
        const ptCode = normalizeCellString(r[9]) || defaultShortPt;
        const rawStatus = normalizeCellString(r[10]).toLowerCase();
        const status: PromotionItem['status'] =
          rawStatus === 'scheduled' || rawStatus === 'ended' ? rawStatus : 'active';

        if (!code || !rawName) continue;

        const dup = rows.some(
          (p) =>
            p.productCode.toLowerCase() === code.toLowerCase() &&
            p.expDate === expDate &&
            p.discountRate === discountRate
        );
        if (dup) {
          skippedDup += 1;
          continue;
        }

        const parsed = parseTrailingBadgeB(rawName);
        const res = await upsertPromotionItem(client, {
          productCode: code,
          barcode,
          productName: parsed.cleanName,
          hasBBadge: parsed.hasBBadge,
          unit,
          expDate,
          quantity,
          discountRate,
          regularPrice,
          ptCode,
          status,
          updatedBy: user.email,
        });
        if (!res.error) added += 1;
      }
      onNotify(
        'success',
        `Import KM hoàn tất: Đã lưu ${added} dòng, bỏ qua ${skippedDup} dòng trùng (Mã + HSD + % KM).`
      );
      onLogActivity('update', 'promo_import', `Import Excel KM (${added} dòng)`);
      void loadRows();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Lỗi đọc file Excel KM.');
    }
  };

  const previewPromoPrice = Math.round(
    form.regularPrice * (1 - Math.max(0, Math.min(100, form.discountRate)) / 100)
  );

  const exportColumns = [
    { header: 'STT', width: 40, align: 'center' as const },
    { header: 'Mã hàng', width: 85 },
    { header: 'Tên hàng', width: 205 },
    { header: 'ĐVT', width: 52 },
    { header: 'HSD', width: 82 },
    { header: 'SL', width: 45, align: 'right' as const },
    { header: 'KM %', width: 56, align: 'right' as const },
    { header: 'Giá bán', width: 85, align: 'right' as const },
    { header: 'Giá KM', width: 85, align: 'right' as const },
    { header: 'Trạng thái', width: 85 },
  ];

  const exportValues = rows.map((r, idx) => [
    idx + 1,
    r.productCode,
    r.hasBBadge ? `${r.productName} [B]` : r.productName,
    r.unit,
    r.expDate || '—',
    r.quantity,
    `${r.discountRate}%`,
    r.regularPrice.toLocaleString('vi-VN'),
    r.promoPrice.toLocaleString('vi-VN'),
    r.status === 'active' ? 'Đang chạy' : r.status === 'scheduled' ? 'Sắp chạy' : 'Đã kết thúc',
  ]);

  return (
    <div className="space-y-4" onMouseMove={markInteraction} onKeyDown={markInteraction}>
      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <>
                <button
                  type="button"
                  onClick={() => setFormOpen((v) => !v)}
                  className="min-h-[40px] px-3.5 py-2 rounded-lg bg-blue-600 text-white text-xs sm:text-sm font-medium hover:bg-blue-700 inline-flex items-center gap-1.5"
                >
                  <Plus className="h-4 w-4" />
                  <span>Thêm KM mới</span>
                </button>
                <label className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 cursor-pointer">
                  <Upload className="h-3.5 w-3.5 text-blue-600" />
                  <span>Import Excel</span>
                  <input type="file" accept=".xlsx" onChange={handleImportExcel} className="hidden" />
                </label>
              </>
            )}

            <button
              type="button"
              onClick={() => void downloadPromotionTemplate()}
              className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Mẫu Excel</span>
            </button>
          </div>

          {canExport && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={async () => {
                  const f = `KhuyenMai_${new Date().toISOString().slice(0, 10)}.png`;
                  await exportTableToPng(
                    'CHƯƠNG TRÌNH KHUYẾN MÃI',
                    `Giá KM = Giá bán × (1 - %/100) · Tổng ${rows.length} dòng`,
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
                  const f = `KhuyenMai_${new Date().toISOString().slice(0, 10)}.pdf`;
                  await exportTableToPdf(
                    'CHƯƠNG TRÌNH KHUYẾN MÃI',
                    `Giá KM = Giá bán × (1 - %/100) · Tổng ${rows.length} dòng`,
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
                  const f = await exportPromotionsToExcel(rows);
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

        {/* Filter Bar */}
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                markInteraction();
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Tìm mã hàng, mã vạch, tên hàng, PT..."
              className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => {
              markInteraction();
              setStatusFilter(e.target.value as typeof statusFilter);
              setPage(1);
            }}
            className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
          >
            <option value="ALL">Mọi trạng thái</option>
            <option value="active">Đang áp dụng</option>
            <option value="scheduled">Sắp diễn ra</option>
            <option value="ended">Đã kết thúc</option>
          </select>

          <select
            value={bBadgeFilter}
            onChange={(e) => {
              markInteraction();
              setBBadgeFilter(e.target.value as typeof bBadgeFilter);
              setPage(1);
            }}
            className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
          >
            <option value="ALL">Tất cả biểu tượng</option>
            <option value="YES">Chứa biểu tượng B</option>
            <option value="NO">Không có biểu tượng B</option>
          </select>
        </div>

        {/* Structured "Thêm khuyến mãi mới" Form */}
        {formOpen && canEdit && (
          <form
            onSubmit={handleSave}
            className="pt-4 border-t border-slate-200 bg-slate-50/70 -mx-4 px-4 pb-2 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">
                Thông tin sản phẩm khuyến mãi mới
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
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Mã hàng (tự tra kho) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Nhập mã hàng..."
                  value={form.productCode}
                  onChange={(e) => handleCodeLookup(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mã vạch</label>
                <input
                  type="text"
                  placeholder="Tự điền hoặc nhập"
                  value={form.barcode}
                  onChange={(e) => setForm((p) => ({ ...p, barcode: e.target.value }))}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div className="sm:col-span-2 lg:col-span-3">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Tên hàng * (đuôi (B) tự tách thành icon B)
                </label>
                <input
                  type="text"
                  required
                  placeholder="VD: Vitamin C 500mg (B)"
                  value={form.rawName}
                  onChange={(e) => setForm((p) => ({ ...p, rawName: e.target.value }))}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">ĐVT</label>
                <input
                  type="text"
                  placeholder="Hộp"
                  value={form.unit}
                  onChange={(e) => setForm((p) => ({ ...p, unit: e.target.value }))}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Hạn sử dụng (HSD)
                </label>
                <input
                  type="date"
                  value={form.expDate}
                  onChange={(e) => setForm((p) => ({ ...p, expDate: e.target.value }))}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Số lượng</label>
                <input
                  type="number"
                  min={0}
                  value={form.quantity}
                  onChange={(e) => setForm((p) => ({ ...p, quantity: Number(e.target.value) }))}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Tỷ lệ KM (%)
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={form.discountRate}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, discountRate: Number(e.target.value) }))
                  }
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Giá bán gốc (đ)
                </label>
                <input
                  type="number"
                  min={0}
                  value={form.regularPrice}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, regularPrice: Number(e.target.value) }))
                  }
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Giá sau KM (tự tính)
                </label>
                <div className="min-h-[42px] px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-sm flex items-center justify-between">
                  <span className="text-emerald-800 text-xs">Còn:</span>
                  <strong className="font-mono text-emerald-900 tabular-nums">
                    {previewPromoPrice.toLocaleString('vi-VN')} đ
                  </strong>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Người PT</label>
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
                    value={form.ptCode}
                    onChange={(e) => setForm((p) => ({ ...p, ptCode: e.target.value }))}
                    placeholder="Người PT"
                    className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                  />
                )}
              </div>

              <div className="sm:col-span-2 lg:col-span-3">
                <label className="block text-xs font-medium text-slate-700 mb-1">Trạng thái</label>
                <select
                  value={form.status}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, status: e.target.value as PromotionItem['status'] }))
                  }
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="active">Đang áp dụng</option>
                  <option value="scheduled">Sắp diễn ra</option>
                  <option value="ended">Đã kết thúc</option>
                </select>
              </div>

              <div className="sm:col-span-2 lg:col-span-3 flex items-end justify-end gap-2">
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
                  Lưu khuyến mãi
                </button>
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Desktop Table & Mobile Vertical Cards */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {canDelete && selectedIds.size > 0 && (
          <div className="px-4 py-2.5 bg-red-50 border-b border-red-200 flex items-center justify-between">
            <span className="text-xs sm:text-sm font-medium text-red-800">
              Đã chọn {selectedIds.size} dòng khuyến mãi
            </span>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium inline-flex items-center gap-1"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Xóa đã chọn</span>
            </button>
          </div>
        )}

        {/* Desktop Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                {canDelete && <th className="py-3 px-3 w-8" />}
                <th className="py-3 px-3">STT</th>
                <th className="py-3 px-3">Mã hàng</th>
                <th className="py-3 px-3">Mã vạch</th>
                <th className="py-3 px-3">Tên hàng</th>
                <th className="py-3 px-3">ĐVT</th>
                <th className="py-3 px-3">HSD</th>
                <th className="py-3 px-3 text-right">SL</th>
                <th className="py-3 px-3 text-right">Tỷ lệ KM</th>
                <th className="py-3 px-3 text-right">Giá bán</th>
                <th className="py-3 px-3 text-right">Giá KM</th>
                <th className="py-3 px-3">Trạng thái</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={canDelete ? 12 : 11} className="py-8 text-center text-slate-500">
                    Đang tải chương trình khuyến mãi...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={canDelete ? 12 : 11} className="py-10 text-center text-slate-500">
                    Chưa có sản phẩm khuyến mãi nào.
                  </td>
                </tr>
              ) : (
                rows.map((item, idx) => (
                  <tr key={item.id} className="hover:bg-slate-50/70">
                    {canDelete && (
                      <td className="py-3 px-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(item.id)}
                          onChange={(e) => {
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(item.id);
                              else next.delete(item.id);
                              return next;
                            });
                          }}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                      </td>
                    )}
                    <td className="py-3 px-3 font-mono text-xs text-slate-500 tabular-nums">
                      {(page - 1) * pageSize + idx + 1}
                    </td>
                    <td className="py-3 px-3 font-mono text-xs font-bold text-slate-900">
                      {item.productCode}
                    </td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-600">
                      {item.barcode || '—'}
                    </td>
                    <td className="py-3 px-3 text-slate-900 font-medium">
                      <span>{item.productName}</span>
                      {item.hasBBadge && (
                        <span
                          className="ml-1.5 inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded bg-amber-100 border border-amber-300 text-[11px] font-bold text-amber-900 align-middle"
                          title="Biểu tượng (B)"
                        >
                          B
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-600">{item.unit}</td>
                    <td className="py-3 px-3 font-mono text-xs tabular-nums text-slate-800 whitespace-nowrap">
                      {item.expDate || '—'}
                    </td>
                    <td className="py-3 px-3 font-mono text-xs text-right tabular-nums">
                      {item.quantity}
                    </td>
                    <td className="py-3 px-3 font-mono text-xs text-right tabular-nums text-blue-700 font-bold">
                      {item.discountRate}%
                    </td>
                    <td className="py-3 px-3 font-mono text-xs text-right tabular-nums text-slate-500 line-through">
                      {item.regularPrice.toLocaleString('vi-VN')}
                    </td>
                    <td className="py-3 px-3 font-mono text-xs text-right tabular-nums font-bold text-emerald-700">
                      {item.promoPrice.toLocaleString('vi-VN')}
                    </td>
                    <td className="py-3 px-3 text-xs font-semibold whitespace-nowrap">
                      {item.status === 'active' ? (
                        <span className="text-emerald-700">Đang áp dụng</span>
                      ) : item.status === 'scheduled' ? (
                        <span className="text-blue-700">Sắp diễn ra</span>
                      ) : (
                        <span className="text-slate-500">Đã kết thúc</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Portrait Vertical Cards */}
        <div className="md:hidden divide-y divide-slate-200">
          {loading ? (
            <div className="p-6 text-center text-sm text-slate-500">
              Đang tải chương trình khuyến mãi...
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Chưa có sản phẩm khuyến mãi nào.
            </div>
          ) : (
            rows.map((item, idx) => (
              <div key={item.id} className="p-4 space-y-2.5 text-[15px]">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {canDelete && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={(e) => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          });
                        }}
                        className="h-4 w-4 rounded border-slate-300 shrink-0"
                      />
                    )}
                    <span className="font-mono text-xs text-slate-500 tabular-nums">
                      #{(page - 1) * pageSize + idx + 1}
                    </span>
                    <span className="font-mono text-sm font-bold text-blue-700">
                      {item.productCode}
                    </span>
                  </div>
                  <span
                    className={`text-xs font-bold shrink-0 ${
                      item.status === 'active'
                        ? 'text-emerald-700'
                        : item.status === 'scheduled'
                          ? 'text-blue-700'
                          : 'text-slate-500'
                    }`}
                  >
                    {item.status === 'active'
                      ? 'Đang áp dụng'
                      : item.status === 'scheduled'
                        ? 'Sắp diễn ra'
                        : 'Đã kết thúc'}
                  </span>
                </div>

                <p className="font-bold text-slate-900 leading-snug">
                  {item.productName}
                  {item.hasBBadge && (
                    <span className="ml-1.5 inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded bg-amber-100 border border-amber-300 text-[11px] font-bold text-amber-900 align-middle">
                      B
                    </span>
                  )}
                </p>

                <div className="rounded-lg bg-slate-50 p-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  <div>
                    <span className="text-xs text-slate-500 block">Giá KM / Giá gốc</span>
                    <div className="font-mono tabular-nums">
                      <span className="font-bold text-emerald-700">
                        {item.promoPrice.toLocaleString('vi-VN')}đ
                      </span>{' '}
                      <span className="text-xs text-slate-400 line-through">
                        {item.regularPrice.toLocaleString('vi-VN')}đ
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-slate-500 block">Giảm / SL</span>
                    <span className="font-mono font-bold text-blue-700 tabular-nums">
                      -{item.discountRate}% · SL {item.quantity} {item.unit}
                    </span>
                  </div>
                  <div>
                    <span className="text-xs text-slate-500 block">HSD</span>
                    <span className="font-mono text-slate-800 tabular-nums">
                      {item.expDate || '—'}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-slate-500 block">Người PT</span>
                    <span className="font-semibold text-slate-800">{item.ptCode || '—'}</span>
                  </div>
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

      <ConfirmDialog
        open={confirmDelete}
        title="Xóa sản phẩm khuyến mãi"
        description={`Xóa ${selectedIds.size} dòng khuyến mãi đã chọn?`}
        confirmLabel="Xóa"
        variant="danger"
        onConfirm={async () => {
          if (!client) return;
          const res = await deletePromotionsBatch(client, Array.from(selectedIds));
          if (res.error) onNotify('error', res.error);
          else {
            onNotify('success', `Đã xóa ${selectedIds.size} dòng khuyến mãi.`);
            onLogActivity('delete', 'promo_batch', `Xóa ${selectedIds.size} dòng KM`);
            setSelectedIds(new Set());
            void loadRows();
          }
          setConfirmDelete(false);
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
