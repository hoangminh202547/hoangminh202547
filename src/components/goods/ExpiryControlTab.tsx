import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ChevronDown,
  ChevronUp,
  Download,
  FileSpreadsheet,
  FileText,
  Filter,
  ImageDown,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useDebouncedValue } from '../../lib/cache';
import {
  downloadExpiryTemplate,
  exportExpiryToExcel,
  normalizeCellString,
  normalizeExcelDate,
  readExcelSheetRows,
} from '../../lib/excel';
import { exportTableToPdf, exportTableToPng } from '../../lib/media';
import {
  extractNoticeMonthsFromPolicy,
  extractShortStaffName,
} from '../../lib/permissions';
import {
  deleteExpiryBatch,
  fetchAllCatalogForCache,
  fetchAllPoliciesForCache,
  fetchAuthorizedStaffOptions,
  fetchExpiryPage,
  upsertExpiryItem,
  useScopedRealtime,
  type AuthorizedStaffOption,
} from '../../lib/supabaseOps';
import type {
  AuthenticatedUser,
  AuthorizedEmail,
  ExpiryTrackingItem,
  ProductCatalogItem,
  SupplierPolicyItem,
} from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { PaginationBar } from '../PaginationBar';

interface ExpiryControlTabProps {
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

interface ExpiryAlertInfo {
  code: 'expired' | 'return_due' | 'soon' | 'ok';
  label: string;
  subLabel: string;
  cls: string;
}

function formatViDdMmYyyy(ms: number): string {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function getExpiryAlertStatus(
  expDate: string,
  warnMonthsBefore: number,
  returnPolicy = ''
): ExpiryAlertInfo {
  if (!expDate) {
    return { code: 'ok', label: 'Chưa rõ HSD', subLabel: '', cls: 'text-slate-500' };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(`${expDate}T00:00:00`);
  if (Number.isNaN(exp.getTime())) {
    return { code: 'ok', label: 'HSD không hợp lệ', subLabel: '', cls: 'text-slate-500' };
  }

  const diffDays = Math.ceil((exp.getTime() - today.getTime()) / 86_400_000);
  const noticeMonths = extractNoticeMonthsFromPolicy(returnPolicy, warnMonthsBefore);

  if (diffDays < 0) {
    return {
      code: 'expired',
      label: `Đã hết hạn (${Math.abs(diffDays)} ngày)`,
      subLabel:
        noticeMonths > 0 ? `Chính sách NCC báo trước ${noticeMonths} tháng` : '',
      cls: 'text-red-700 font-bold',
    };
  }

  if (noticeMonths > 0) {
    const deadlineMs = exp.getTime() - noticeMonths * 30 * 86_400_000;
    const noticeDiffDays = Math.ceil((deadlineMs - today.getTime()) / 86_400_000);
    const deadlineLabel = formatViDdMmYyyy(deadlineMs);

    if (noticeDiffDays < 0) {
      return {
        code: 'return_due',
        label: `Quá hạn báo đổi trả NCC ${Math.abs(noticeDiffDays)} ngày`,
        subLabel: `Hạn báo: ${deadlineLabel} · Còn ${diffDays} ngày hết HSD (CS ${noticeMonths} tháng)`,
        cls: 'text-red-700 font-bold',
      };
    }
    if (noticeDiffDays === 0) {
      return {
        code: 'return_due',
        label: `Hôm nay hạn báo đổi trả NCC`,
        subLabel: `Hạn báo: ${deadlineLabel} · Còn ${diffDays} ngày hết HSD (CS ${noticeMonths} tháng)`,
        cls: 'text-red-600 font-bold',
      };
    }
    if (noticeDiffDays <= 30) {
      return {
        code: 'return_due',
        label: `Còn ${noticeDiffDays} ngày báo đổi trả NCC`,
        subLabel: `Hạn báo: ${deadlineLabel} · Còn ${diffDays} ngày hết HSD (CS ${noticeMonths} tháng)`,
        cls: noticeDiffDays <= 14 ? 'text-red-600 font-bold' : 'text-amber-700 font-bold',
      };
    }
    return {
      code: diffDays <= 45 ? 'soon' : 'ok',
      label: `Còn ${noticeDiffDays} ngày đến hạn báo NCC`,
      subLabel: `Hạn báo: ${deadlineLabel} · Còn ${diffDays} ngày hết HSD (CS ${noticeMonths} tháng)`,
      cls: 'text-emerald-700 font-medium',
    };
  }

  if (diffDays <= 45) {
    return {
      code: 'soon',
      label: `Cận hạn (còn ${diffDays} ngày)`,
      subLabel: 'Chưa có mốc báo trước tháng của NCC',
      cls: 'text-amber-700 font-semibold',
    };
  }

  return {
    code: 'ok',
    label: `Còn ${diffDays} ngày hết hạn`,
    subLabel: '',
    cls: 'text-emerald-700',
  };
}

export function ExpiryControlTab({
  client,
  user,
  authorizedMembers = [],
  canDelete,
  canExport,
  defaultPageSize,
  onNotify,
  onLogActivity,
}: ExpiryControlTabProps) {
  const defaultShortPt = useMemo(
    () => extractShortStaffName(user.displayName, user.email),
    [user.displayName, user.email]
  );

  const [rows, setRows] = useState<ExpiryTrackingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(defaultPageSize);
  const [loading, setLoading] = useState(true);

  const [catalogCache, setCatalogCache] = useState<ProductCatalogItem[]>([]);
  const [policyCache, setPolicyCache] = useState<SupplierPolicyItem[]>([]);
  const [staffOptions, setStaffOptions] = useState<AuthorizedStaffOption[]>([]);

  // Collapsible Form & Filters
  const [formOpen, setFormOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 380);
  const [ptFilter, setPtFilter] = useState('');
  const debouncedPt = useDebouncedValue(ptFilter, 380);
  const [supplierFilter, setSupplierFilter] = useState('');
  const debouncedSup = useDebouncedValue(supplierFilter, 380);
  const [alertFilter, setAlertFilter] = useState<'ALL' | 'expired' | 'return_due' | 'soon'>('ALL');

  // Form inputs (auto-filled from catalog + policy)
  const [productCode, setProductCode] = useState('');
  const [barcode, setBarcode] = useState('');
  const [productName, setProductName] = useState('');
  const [unit, setUnit] = useState('');
  const [supplierSystemName, setSupplierSystemName] = useState('');
  const [returnPolicy, setReturnPolicy] = useState('');
  const [warnMonthsBefore, setWarnMonthsBefore] = useState(0);
  const [mfgDate, setMfgDate] = useState('');
  const [expDate, setExpDate] = useState('');
  const [ptCode, setPtCode] = useState(defaultShortPt);
  const [note, setNote] = useState('');

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!client) return;
    void Promise.all([
      fetchAllCatalogForCache(client),
      fetchAllPoliciesForCache(client),
      fetchAuthorizedStaffOptions(client, authorizedMembers),
    ]).then(([cats, pols, staff]) => {
      setCatalogCache(cats);
      setPolicyCache(pols);
      setStaffOptions(staff);
    });
  }, [client, authorizedMembers]);

  const loadRows = useCallback(async () => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await fetchExpiryPage(client, {
      page,
      pageSize,
      search: debouncedSearch,
      ptFilter: debouncedPt,
      supplierFilter: debouncedSup,
    });
    if (res.error) onNotify('error', res.error);
    else {
      setRows(res.rows);
      setTotal(res.total);
    }
    setLoading(false);
  }, [client, page, pageSize, debouncedSearch, debouncedPt, debouncedSup, onNotify]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  useScopedRealtime(client, Boolean(client), ['expiry_tracking'], () => {
    void loadRows();
  });

  const resetForm = () => {
    setEditingId(null);
    setProductCode('');
    setBarcode('');
    setProductName('');
    setUnit('');
    setSupplierSystemName('');
    setReturnPolicy('');
    setWarnMonthsBefore(0);
    setMfgDate('');
    setExpDate('');
    setPtCode(defaultShortPt);
    setNote('');
  };

  const startEditItem = (item: ExpiryTrackingItem) => {
    setEditingId(item.id);
    setProductCode(item.productCode);
    setBarcode(item.barcode);
    setProductName(item.productName);
    setUnit(item.unit);
    setSupplierSystemName(item.supplierSystemName);
    setReturnPolicy(item.returnPolicy);
    setWarnMonthsBefore(
      extractNoticeMonthsFromPolicy(item.returnPolicy, item.warnMonthsBefore)
    );
    setMfgDate(item.mfgDate);
    setExpDate(item.expDate);
    setPtCode(item.ptCode || defaultShortPt);
    setNote(item.note);
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Lookup catalog + supplier policy by Mã hàng or Barcode
  const lookupMasterByCode = (rawCode: string) => {
    const clean = rawCode.trim().toLowerCase();
    setProductCode(rawCode);
    if (!clean) return;
    const cat = catalogCache.find(
      (c) => c.productCode.toLowerCase() === clean || c.barcode.toLowerCase() === clean
    );
    if (cat) {
      setProductCode(cat.productCode);
      setBarcode(cat.barcode);
      setProductName(cat.name);
      setUnit(cat.unit);
      setSupplierSystemName(cat.supplierName);
      const pol =
        policyCache.find(
          (p) =>
            p.supplierSystemName.toLowerCase() === cat.supplierName.toLowerCase() &&
            (p.productName.toLowerCase() === 'tất cả' ||
              p.productName.toLowerCase() === cat.name.toLowerCase())
        ) ||
        policyCache.find(
          (p) => p.supplierSystemName.toLowerCase() === cat.supplierName.toLowerCase()
        );
      if (pol) {
        setReturnPolicy(pol.returnPolicy);
        setWarnMonthsBefore(
          extractNoticeMonthsFromPolicy(pol.returnPolicy, pol.warnMonthsBefore)
        );
      }
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;
    if (!productCode.trim() || !expDate) {
      onNotify('error', 'Nhập Mã hàng và Hạn sử dụng.');
      return;
    }
    const effectiveMonths = extractNoticeMonthsFromPolicy(returnPolicy, warnMonthsBefore);
    const res = await upsertExpiryItem(client, {
      id: editingId || undefined,
      productCode,
      barcode,
      productName,
      unit,
      supplierSystemName,
      returnPolicy,
      warnMonthsBefore: effectiveMonths,
      mfgDate,
      expDate,
      ptCode,
      note,
      updatedBy: user.email,
    });
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    onNotify(
      'success',
      editingId
        ? `Đã cập nhật thông tin HSD mã ${productCode}`
        : `Đã lưu hạn sử dụng cho mã ${productCode}`
    );
    onLogActivity(
      editingId ? 'update' : 'create',
      editingId || productCode,
      `${editingId ? 'Điều chỉnh' : 'Thêm mới'} HSD ${productCode} (${expDate})`
    );
    resetForm();
    setFormOpen(false);
    void loadRows();
  };

  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !client) return;
    try {
      const sheet = await readExcelSheetRows(file);
      if (sheet.length <= 1) return;
      let count = 0;
      for (const r of sheet.slice(1)) {
        const sup = normalizeCellString(r[1]);
        const code = normalizeCellString(r[2]);
        const bar = normalizeCellString(r[3]);
        const name = normalizeCellString(r[4]);
        const u = normalizeCellString(r[5]);
        const mfg = normalizeExcelDate(r[6]);
        const exp = normalizeExcelDate(r[7]);
        const pol = normalizeCellString(r[8]);
        const n = normalizeCellString(r[9]);
        const pt = normalizeCellString(r[10]);
        if (!code || !exp) continue;

        const cat = catalogCache.find((c) => c.productCode.toLowerCase() === code.toLowerCase());
        const finalSup = sup || cat?.supplierName || '';
        const matchedPol = policyCache.find(
          (p) => p.supplierSystemName.toLowerCase() === finalSup.toLowerCase()
        );
        const finalPolicy = pol || matchedPol?.returnPolicy || '';
        const finalNoticeMonths = extractNoticeMonthsFromPolicy(
          finalPolicy,
          matchedPol?.warnMonthsBefore || 0
        );

        const res = await upsertExpiryItem(client, {
          productCode: code,
          barcode: bar || cat?.barcode || '',
          productName: name || cat?.name || '',
          unit: u || cat?.unit || '',
          supplierSystemName: finalSup,
          returnPolicy: finalPolicy,
          warnMonthsBefore: finalNoticeMonths,
          mfgDate: mfg,
          expDate: exp,
          ptCode: pt || defaultShortPt,
          note: n,
          updatedBy: user.email,
        });
        if (!res.error) count += 1;
      }
      onNotify('success', `Đã import ${count} dòng hạn sử dụng.`);
      onLogActivity('update', 'expiry_import', `Import Excel HSD (${count} dòng)`);
      void loadRows();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Lỗi import Excel HSD.');
    }
  };

  const visibleRows = useMemo(() => {
    if (alertFilter === 'ALL') return rows;
    return rows.filter(
      (r) =>
        getExpiryAlertStatus(r.expDate, r.warnMonthsBefore, r.returnPolicy).code === alertFilter
    );
  }, [rows, alertFilter]);

  const exportColumns = [
    { header: 'STT', width: 42, align: 'center' as const },
    { header: 'NCC HT', width: 110 },
    { header: 'Mã hàng', width: 88 },
    { header: 'Tên hàng', width: 185 },
    { header: 'ĐVT', width: 52 },
    { header: 'NSX', width: 82 },
    { header: 'HSD', width: 82 },
    { header: 'Đổi trả SP', width: 125 },
    { header: 'Cảnh báo báo NCC / Ghi chú', width: 185 },
    { header: 'Người PT', width: 85 },
  ];

  const exportRowValues = visibleRows.map((r, idx) => {
    const alert = getExpiryAlertStatus(r.expDate, r.warnMonthsBefore, r.returnPolicy);
    return [
      idx + 1,
      r.supplierSystemName,
      r.productCode,
      r.productName,
      r.unit,
      r.mfgDate || '—',
      r.expDate,
      r.returnPolicy || '—',
      `${alert.label}${alert.subLabel ? ` (${alert.subLabel})` : ''}${r.note ? ` · ${r.note}` : ''}`,
      r.ptCode || '—',
    ];
  });

  const hasCustomPtOption = Boolean(
    ptCode && !staffOptions.some((s) => s.shortName.toLowerCase() === ptCode.toLowerCase())
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (formOpen && editingId) {
                  resetForm();
                } else {
                  setFormOpen((v) => !v);
                  if (!formOpen) {
                    setEditingId(null);
                    setPtCode((prev) => prev || defaultShortPt);
                  }
                }
              }}
              className="min-h-[40px] px-3.5 py-2 rounded-lg bg-blue-600 text-white text-xs sm:text-sm font-medium hover:bg-blue-700 inline-flex items-center gap-1.5"
            >
              <Plus className="h-4 w-4" />
              <span>{editingId ? 'Đang sửa hàng cận hạn' : 'Nhập hàng cận hạn'}</span>
              {formOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <Filter className="h-3.5 w-3.5" />
              <span>Bộ lọc</span>
            </button>

            <button
              type="button"
              onClick={() => void downloadExpiryTemplate()}
              className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Mẫu Excel</span>
            </button>

            <label className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 cursor-pointer">
              <Upload className="h-3.5 w-3.5 text-blue-600" />
              <span>Import Excel</span>
              <input type="file" accept=".xlsx" onChange={handleImportExcel} className="hidden" />
            </label>
          </div>

          {canExport && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={async () => {
                  const f = `HanSuDung_${new Date().toISOString().slice(0, 10)}.png`;
                  await exportTableToPng(
                    'KIỂM SOÁT HẠN SỬ DỤNG',
                    `Sắp xếp gần hạn nhất · Tổng ${visibleRows.length} dòng`,
                    exportColumns,
                    exportRowValues,
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
                  const f = `HanSuDung_${new Date().toISOString().slice(0, 10)}.pdf`;
                  await exportTableToPdf(
                    'KIỂM SOÁT HẠN SỬ DỤNG',
                    `Sắp xếp gần hạn nhất · Tổng ${visibleRows.length} dòng`,
                    exportColumns,
                    exportRowValues,
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
                  const f = await exportExpiryToExcel(visibleRows);
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

        {/* Collapsible Filters */}
        {filtersOpen && (
          <div className="pt-3 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="relative">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Mã hàng, mã vạch, tên hàng..."
                className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <input
              type="text"
              value={supplierFilter}
              onChange={(e) => {
                setSupplierFilter(e.target.value);
                setPage(1);
              }}
              placeholder="Lọc Tên NCC HT..."
              className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
            <div>
              <input
                type="text"
                list="expiry-pt-filter-options"
                value={ptFilter}
                onChange={(e) => {
                  setPtFilter(e.target.value);
                  setPage(1);
                }}
                placeholder="Lọc Người PT..."
                className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
              <datalist id="expiry-pt-filter-options">
                {staffOptions.map((opt) => (
                  <option key={opt.email || opt.shortName} value={opt.shortName}>
                    {opt.displayName}
                  </option>
                ))}
              </datalist>
            </div>
            <select
              value={alertFilter}
              onChange={(e) => setAlertFilter(e.target.value as typeof alertFilter)}
              className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">Mọi cảnh báo</option>
              <option value="expired">Đã hết hạn</option>
              <option value="return_due">Cảnh báo đổi trả NCC</option>
              <option value="soon">Cận hạn (≤ 45 ngày)</option>
            </select>
          </div>
        )}

        {/* Collapsible Entry / Edit Form */}
        {formOpen && (
          <form
            onSubmit={handleSave}
            className="pt-4 border-t border-slate-200 space-y-3 bg-slate-50/70 -mx-4 px-4 pb-2"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-900">
                {editingId ? 'Điều chỉnh thông tin hàng cận hạn' : 'Nhập thông tin hàng cận hạn mới'}
              </h3>
              {editingId && (
                <button
                  type="button"
                  onClick={() => {
                    resetForm();
                    setFormOpen(false);
                  }}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 underline"
                >
                  Hủy chỉnh sửa
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Mã hàng / Mã vạch (tự tra kho) *
                </label>
                <input
                  type="text"
                  required
                  value={productCode}
                  onChange={(e) => lookupMasterByCode(e.target.value)}
                  placeholder="Nhập mã hàng để tự điền..."
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tên hàng</label>
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tên NCC HT</label>
                <input
                  type="text"
                  value={supplierSystemName}
                  onChange={(e) => setSupplierSystemName(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Chính sách đổi trả NCC
                </label>
                <input
                  type="text"
                  value={returnPolicy}
                  onChange={(e) => {
                    const nextPol = e.target.value;
                    setReturnPolicy(nextPol);
                    setWarnMonthsBefore(extractNoticeMonthsFromPolicy(nextPol, warnMonthsBefore));
                  }}
                  placeholder="VD: Báo trước 3 tháng"
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Ngày sản xuất</label>
                <input
                  type="date"
                  value={mfgDate}
                  onChange={(e) => setMfgDate(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Hạn sử dụng *</label>
                <input
                  type="date"
                  required
                  value={expDate}
                  onChange={(e) => setExpDate(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Người PT (tên rút gọn phân quyền)
                </label>
                {staffOptions.length > 0 ? (
                  <select
                    value={ptCode}
                    onChange={(e) => setPtCode(e.target.value)}
                    className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">-- Chọn người phụ trách --</option>
                    {hasCustomPtOption && (
                      <option value={ptCode}>{ptCode} (giá trị hiện tại)</option>
                    )}
                    {staffOptions.map((opt) => (
                      <option key={opt.email || opt.shortName} value={opt.shortName}>
                        {opt.shortName}
                        {opt.displayName && opt.displayName !== opt.shortName
                          ? ` (${opt.displayName})`
                          : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={ptCode}
                    onChange={(e) => setPtCode(e.target.value)}
                    placeholder={defaultShortPt || 'Tên rút gọn PT'}
                    className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                  />
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Ghi chú</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Ghi chú lô hàng..."
                    className="flex-1 min-w-0 min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                  />
                  <button
                    type="submit"
                    className="min-h-[42px] px-4 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 whitespace-nowrap shrink-0"
                  >
                    {editingId ? 'Cập nhật' : 'Lưu'}
                  </button>
                </div>
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Data Table & Mobile Portrait Cards */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {canDelete && selectedIds.size > 0 && (
          <div className="px-4 py-2.5 bg-red-50 border-b border-red-200 flex items-center justify-between">
            <span className="text-xs sm:text-sm font-medium text-red-800">
              Đã chọn {selectedIds.size} dòng hạn sử dụng
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
                <th className="py-3 px-3">Tên NCC HT</th>
                <th className="py-3 px-3">Mã hàng</th>
                <th className="py-3 px-3">Tên hàng</th>
                <th className="py-3 px-3">ĐVT</th>
                <th className="py-3 px-3">NSX</th>
                <th className="py-3 px-3">HSD</th>
                <th className="py-3 px-3">Đổi trả SP</th>
                <th className="py-3 px-3">Cảnh báo báo NCC &amp; Ghi chú</th>
                <th className="py-3 px-3">Người PT</th>
                <th className="py-3 px-3 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={canDelete ? 12 : 11} className="py-8 text-center text-slate-500">
                    Đang tải dữ liệu hạn sử dụng...
                  </td>
                </tr>
              ) : visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={canDelete ? 12 : 11} className="py-10 text-center text-slate-500">
                    Chưa có hàng hóa nào trong bảng kiểm soát hạn sử dụng.
                  </td>
                </tr>
              ) : (
                visibleRows.map((item, idx) => {
                  const alert = getExpiryAlertStatus(
                    item.expDate,
                    item.warnMonthsBefore,
                    item.returnPolicy
                  );
                  return (
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
                      <td className="py-3 px-3 text-xs font-semibold text-slate-800">
                        {item.supplierSystemName || '—'}
                      </td>
                      <td className="py-3 px-3">
                        <p className="font-mono text-xs font-bold text-slate-900">
                          {item.productCode}
                        </p>
                        {item.barcode && (
                          <p className="font-mono text-[11px] text-slate-500">{item.barcode}</p>
                        )}
                      </td>
                      <td className="py-3 px-3 text-slate-900 font-medium">{item.productName}</td>
                      <td className="py-3 px-3 text-xs text-slate-600">{item.unit}</td>
                      <td className="py-3 px-3 font-mono text-xs tabular-nums text-slate-600 whitespace-nowrap">
                        {item.mfgDate || '—'}
                      </td>
                      <td className="py-3 px-3 font-mono text-xs font-bold tabular-nums text-slate-900 whitespace-nowrap">
                        {item.expDate}
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-700">
                        {item.returnPolicy || '—'}
                      </td>
                      <td className="py-3 px-3 text-xs max-w-xs">
                        <p className={alert.cls}>{alert.label}</p>
                        {alert.subLabel && (
                          <p className="text-[11px] text-slate-600 mt-0.5">{alert.subLabel}</p>
                        )}
                        {item.note && (
                          <p className="text-slate-600 mt-0.5 italic">Ghi chú: {item.note}</p>
                        )}
                      </td>
                      <td className="py-3 px-3 text-xs font-semibold text-slate-800 whitespace-nowrap">
                        {item.ptCode || '—'}
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => startEditItem(item)}
                          className="min-h-[34px] px-2.5 py-1 rounded-lg border border-blue-200 bg-blue-50 text-xs font-medium text-blue-700 hover:bg-blue-100 inline-flex items-center gap-1"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          <span>Điều chỉnh</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Portrait Vertical Cards */}
        <div className="md:hidden divide-y divide-slate-200">
          {loading ? (
            <div className="p-6 text-center text-sm text-slate-500">
              Đang tải dữ liệu hạn sử dụng...
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Chưa có hàng hóa nào trong bảng kiểm soát hạn sử dụng.
            </div>
          ) : (
            visibleRows.map((item, idx) => {
              const alert = getExpiryAlertStatus(
                item.expDate,
                item.warnMonthsBefore,
                item.returnPolicy
              );
              return (
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
                    <button
                      type="button"
                      onClick={() => startEditItem(item)}
                      className="min-h-[36px] px-3 py-1 rounded-lg border border-blue-200 bg-blue-50 text-xs font-semibold text-blue-700 hover:bg-blue-100 inline-flex items-center gap-1 shrink-0"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span>Điều chỉnh</span>
                    </button>
                  </div>

                  <p className="font-bold text-slate-900 leading-snug">{item.productName}</p>

                  <div className="rounded-lg bg-slate-50 p-3 space-y-1.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">NCC HT:</span>
                      <span className="font-semibold text-slate-900 text-right">
                        {item.supplierSystemName || '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">NSX / HSD:</span>
                      <span className="font-mono font-bold text-slate-900 tabular-nums">
                        {item.mfgDate || '—'} → {item.expDate}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Chính sách đổi trả:</span>
                      <span className="text-slate-800 text-right">{item.returnPolicy || '—'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Người PT:</span>
                      <span className="font-semibold text-slate-900">{item.ptCode || '—'}</span>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm space-y-0.5">
                    <p className={alert.cls}>{alert.label}</p>
                    {alert.subLabel && <p className="text-xs text-slate-600">{alert.subLabel}</p>}
                    {item.note && <p className="text-xs text-slate-600">Ghi chú: {item.note}</p>}
                  </div>
                </div>
              );
            })
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
        title="Xóa bản ghi hạn sử dụng"
        description={`Xác nhận xóa ${selectedIds.size} bản ghi đã chọn?`}
        confirmLabel="Xóa"
        variant="danger"
        onConfirm={async () => {
          if (!client) return;
          const res = await deleteExpiryBatch(client, Array.from(selectedIds));
          if (res.error) onNotify('error', res.error);
          else {
            onNotify('success', `Đã xóa ${selectedIds.size} bản ghi.`);
            onLogActivity('delete', 'expiry_batch', `Xóa ${selectedIds.size} dòng HSD`);
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
