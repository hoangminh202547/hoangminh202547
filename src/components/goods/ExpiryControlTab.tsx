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
  deleteExpiryBatch,
  fetchAllCatalogForCache,
  fetchAllPoliciesForCache,
  fetchExpiryPage,
  upsertExpiryItem,
  useScopedRealtime,
} from '../../lib/supabaseOps';
import type {
  AuthenticatedUser,
  ExpiryTrackingItem,
  ProductCatalogItem,
  SupplierPolicyItem,
} from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { PaginationBar } from '../PaginationBar';

interface ExpiryControlTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  canDelete: boolean;
  canExport: boolean;
  defaultPageSize: 20 | 50 | 100;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onLogActivity: (action: 'create' | 'update' | 'delete' | 'export', targetId: string, summary: string) => void;
}

function getExpiryAlertStatus(
  expDate: string,
  warnMonthsBefore: number
): { code: 'expired' | 'return_due' | 'soon' | 'ok'; label: string; cls: string } {
  if (!expDate) return { code: 'ok', label: 'Chưa rõ HSD', cls: 'text-slate-500' };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(expDate);
  if (Number.isNaN(exp.getTime())) {
    return { code: 'ok', label: 'HSD lỗi', cls: 'text-slate-500' };
  }
  const diffDays = Math.ceil((exp.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) {
    return { code: 'expired', label: `Đã hết hạn (${Math.abs(diffDays)} ngày)`, cls: 'text-red-700 font-bold' };
  }
  if (warnMonthsBefore > 0) {
    const warnDays = warnMonthsBefore * 30;
    if (diffDays <= warnDays) {
      return {
        code: 'return_due',
        label: `Đến hạn báo đổi trả NCC (còn ${diffDays} ngày)`,
        cls: 'text-red-600 font-medium',
      };
    }
  }
  if (diffDays <= 45) {
    return { code: 'soon', label: `Cận hạn (còn ${diffDays} ngày)`, cls: 'text-amber-700 font-medium' };
  }
  return { code: 'ok', label: `Bình thường (còn ${diffDays} ngày)`, cls: 'text-emerald-700' };
}

export function ExpiryControlTab({
  client,
  user,
  canDelete,
  canExport,
  defaultPageSize,
  onNotify,
  onLogActivity,
}: ExpiryControlTabProps) {
  const [rows, setRows] = useState<ExpiryTrackingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(defaultPageSize);
  const [loading, setLoading] = useState(true);

  const [catalogCache, setCatalogCache] = useState<ProductCatalogItem[]>([]);
  const [policyCache, setPolicyCache] = useState<SupplierPolicyItem[]>([]);

  // Collapsible Form & Filters
  const [formOpen, setFormOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

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
  const [ptCode, setPtCode] = useState('');
  const [note, setNote] = useState('');

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!client) return;
    void Promise.all([fetchAllCatalogForCache(client), fetchAllPoliciesForCache(client)]).then(
      ([cats, pols]) => {
        setCatalogCache(cats);
        setPolicyCache(pols);
      }
    );
  }, [client]);

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
      const pol = policyCache.find(
        (p) =>
          p.supplierSystemName.toLowerCase() === cat.supplierName.toLowerCase() &&
          (p.productName.toLowerCase() === 'tất cả' ||
            p.productName.toLowerCase() === cat.name.toLowerCase())
      ) || policyCache.find((p) => p.supplierSystemName.toLowerCase() === cat.supplierName.toLowerCase());
      if (pol) {
        setReturnPolicy(pol.returnPolicy);
        setWarnMonthsBefore(pol.warnMonthsBefore);
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
    const res = await upsertExpiryItem(client, {
      productCode,
      barcode,
      productName,
      unit,
      supplierSystemName,
      returnPolicy,
      warnMonthsBefore,
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
    onNotify('success', `Đã lưu hạn sử dụng cho mã ${productCode}`);
    onLogActivity('create', productCode, `Cập nhật HSD ${productCode} (${expDate})`);
    setProductCode('');
    setBarcode('');
    setProductName('');
    setUnit('');
    setSupplierSystemName('');
    setReturnPolicy('');
    setWarnMonthsBefore(0);
    setMfgDate('');
    setExpDate('');
    setNote('');
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

        const res = await upsertExpiryItem(client, {
          productCode: code,
          barcode: bar || cat?.barcode || '',
          productName: name || cat?.name || '',
          unit: u || cat?.unit || '',
          supplierSystemName: finalSup,
          returnPolicy: pol || matchedPol?.returnPolicy || '',
          warnMonthsBefore: matchedPol?.warnMonthsBefore || 0,
          mfgDate: mfg,
          expDate: exp,
          ptCode: pt,
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
      (r) => getExpiryAlertStatus(r.expDate, r.warnMonthsBefore).code === alertFilter
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
    { header: 'Đổi trả SP', width: 130 },
    { header: 'Cảnh báo / Ghi chú', width: 160 },
    { header: 'PT', width: 58 },
  ];

  const exportRowValues = visibleRows.map((r, idx) => {
    const alert = getExpiryAlertStatus(r.expDate, r.warnMonthsBefore);
    return [
      idx + 1,
      r.supplierSystemName,
      r.productCode,
      r.productName,
      r.unit,
      r.mfgDate || '—',
      r.expDate,
      r.returnPolicy || '—',
      `${alert.label}${r.note ? ` · ${r.note}` : ''}`,
      r.ptCode || '—',
    ];
  });

  return (
    <div className="space-y-5">
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
              <span>Nhập hàng cận hạn</span>
              {formOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>

            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <Filter className="h-3.5 w-3.5" />
              <span>Bộ lọc</span>
            </button>

            <button
              type="button"
              onClick={() => void downloadExpiryTemplate()}
              className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Mẫu Excel</span>
            </button>

            <label className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 cursor-pointer">
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
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
              >
                <ImageDown className="h-3.5 w-3.5 text-blue-600" />
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
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
              >
                <FileText className="h-3.5 w-3.5 text-red-600" />
                <span>PDF</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  const f = await exportExpiryToExcel(visibleRows);
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
                className="w-full min-h-[38px] pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg"
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
              className="min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              value={ptFilter}
              onChange={(e) => {
                setPtFilter(e.target.value);
                setPage(1);
              }}
              placeholder="Lọc mã PT..."
              className="min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
            <select
              value={alertFilter}
              onChange={(e) => setAlertFilter(e.target.value as typeof alertFilter)}
              className="min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">Mọi cảnh báo</option>
              <option value="expired">Đã hết hạn</option>
              <option value="return_due">Đến hạn báo đổi trả NCC</option>
              <option value="soon">Cận hạn (≤ 45 ngày)</option>
            </select>
          </div>
        )}

        {/* Collapsible Entry Form */}
        {formOpen && (
          <form
            onSubmit={handleSave}
            className="pt-3 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
          >
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Mã hàng / Mã vạch (tự tra kho) *
              </label>
              <input
                type="text"
                required
                value={productCode}
                onChange={(e) => lookupMasterByCode(e.target.value)}
                placeholder="Nhập mã hàng để tự điền..."
                className="w-full min-h-[38px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Tên hàng</label>
              <input
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Tên NCC HT</label>
              <input
                type="text"
                value={supplierSystemName}
                onChange={(e) => setSupplierSystemName(e.target.value)}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Đổi trả SP</label>
              <input
                type="text"
                value={returnPolicy}
                onChange={(e) => setReturnPolicy(e.target.value)}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Ngày sản xuất</label>
              <input
                type="date"
                value={mfgDate}
                onChange={(e) => setMfgDate(e.target.value)}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Hạn sử dụng *</label>
              <input
                type="date"
                required
                value={expDate}
                onChange={(e) => setExpDate(e.target.value)}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">PT phụ trách</label>
              <input
                type="text"
                value={ptCode}
                onChange={(e) => setPtCode(e.target.value)}
                placeholder="VD: PT01"
                className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Ghi chú</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="flex-1 min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                />
                <button
                  type="submit"
                  className="min-h-[38px] px-4 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
                >
                  Lưu
                </button>
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Data Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {canDelete && selectedIds.size > 0 && (
          <div className="px-4 py-2 bg-red-50 border-b border-red-200 flex items-center justify-between">
            <span className="text-xs font-medium text-red-800">
              Đã chọn {selectedIds.size} dòng hạn sử dụng
            </span>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="px-3 py-1 rounded bg-red-600 text-white text-xs font-medium inline-flex items-center gap-1"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Xóa đã chọn</span>
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                {canDelete && <th className="py-3 px-3 w-8" />}
                <th className="py-3 px-3">STT</th>
                <th className="py-3 px-3">Tên NCC HT</th>
                <th className="py-3 px-3">Mã hàng</th>
                <th className="py-3 px-3">Mã vạch</th>
                <th className="py-3 px-3">Tên hàng</th>
                <th className="py-3 px-3">ĐVT</th>
                <th className="py-3 px-3">NSX</th>
                <th className="py-3 px-3">HSD</th>
                <th className="py-3 px-3">Đổi trả SP</th>
                <th className="py-3 px-3">Ghi chú &amp; cảnh báo</th>
                <th className="py-3 px-3">PT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={12} className="py-8 text-center text-slate-500">
                    Đang tải dữ liệu hạn sử dụng...
                  </td>
                </tr>
              ) : visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-10 text-center text-slate-500">
                    Chưa có hàng hóa nào trong bảng kiểm soát hạn sử dụng.
                  </td>
                </tr>
              ) : (
                visibleRows.map((item, idx) => {
                  const alert = getExpiryAlertStatus(item.expDate, item.warnMonthsBefore);
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/70">
                      {canDelete && (
                        <td className="py-2.5 px-3">
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
                      <td className="py-2.5 px-3 font-mono text-xs text-slate-500 tabular-nums">
                        {(page - 1) * pageSize + idx + 1}
                      </td>
                      <td className="py-2.5 px-3 text-xs font-medium text-slate-800">
                        {item.supplierSystemName || '—'}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs font-bold text-slate-900">
                        {item.productCode}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs text-slate-600">
                        {item.barcode || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-slate-900">{item.productName}</td>
                      <td className="py-2.5 px-3 text-xs text-slate-600">{item.unit}</td>
                      <td className="py-2.5 px-3 font-mono text-xs tabular-nums text-slate-600">
                        {item.mfgDate || '—'}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs font-bold tabular-nums text-slate-900">
                        {item.expDate}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-700">{item.returnPolicy || '—'}</td>
                      <td className="py-2.5 px-3 text-xs">
                        <p className={alert.cls}>{alert.label}</p>
                        {item.note && <p className="text-slate-500">{item.note}</p>}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs text-slate-700">
                        {item.ptCode || '—'}
                      </td>
                    </tr>
                  );
                })
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
        open={confirmDelete}
        title="Xóa bản ghi hạn sử dụng"
        description={`Xác nhận xóa ${selectedIds.size} bản ghi đã chọn?`}
        confirmLabel="Xóa"
        danger
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
