import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CheckSquare,
  Download,
  FileSpreadsheet,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useDebouncedValue } from '../../lib/cache';
import {
  downloadCatalogTemplate,
  downloadPolicyTemplate,
  exportCatalogToExcel,
  exportPoliciesToExcel,
  normalizeCellNumber,
  normalizeCellString,
  readExcelSheetRows,
} from '../../lib/excel';
import {
  batchDeleteCatalogWithCheck,
  deletePoliciesBatch,
  fetchAllCatalogForCache,
  fetchAllPoliciesForCache,
  fetchCatalogPage,
  fetchPoliciesPage,
  upsertCatalogItem,
  upsertPolicyItem,
  useScopedRealtime,
} from '../../lib/supabaseOps';
import type {
  AuthenticatedUser,
  ProductCatalogItem,
  SupplierPolicyItem,
} from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { PaginationBar } from '../PaginationBar';

interface DataWarehouseTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  canEdit: boolean;
  canExport: boolean;
  defaultPageSize: 20 | 50 | 100;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onLogActivity: (action: 'create' | 'update' | 'delete' | 'export', targetId: string, summary: string) => void;
}

interface CatalogImportPreview {
  toInsert: Array<Omit<ProductCatalogItem, 'id' | 'createdAt' | 'updatedAt'>>;
  toUpdate: Array<Omit<ProductCatalogItem, 'createdAt' | 'updatedAt'>>;
  skippedCount: number;
  errors: string[];
}

interface PolicyImportPreview {
  toInsert: Array<Omit<SupplierPolicyItem, 'id' | 'createdAt' | 'updatedAt'>>;
  toUpdate: Array<Omit<SupplierPolicyItem, 'createdAt' | 'updatedAt'>>;
  skippedCount: number;
  errors: string[];
}

export function DataWarehouseTab({
  client,
  user,
  canEdit,
  canExport,
  defaultPageSize,
  onNotify,
  onLogActivity,
}: DataWarehouseTabProps) {
  const [subTab, setSubTab] = useState<'catalog' | 'policies'>('catalog');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(defaultPageSize);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 380);
  const [loading, setLoading] = useState(true);

  // Catalog state
  const [catalogRows, setCatalogRows] = useState<ProductCatalogItem[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [selectedCatIds, setSelectedCatIds] = useState<Set<string>>(new Set());
  const [showCatForm, setShowCatForm] = useState(false);
  const [catForm, setCatForm] = useState({
    productCode: '',
    barcode: '',
    name: '',
    unit: 'Hộp',
    price: 0,
    supplierName: '',
  });
  const [catImportPreview, setCatImportPreview] = useState<CatalogImportPreview | null>(null);

  // Policy state
  const [policyRows, setPolicyRows] = useState<SupplierPolicyItem[]>([]);
  const [policyTotal, setPolicyTotal] = useState(0);
  const [selectedPolIds, setSelectedPolIds] = useState<Set<string>>(new Set());
  const [showPolForm, setShowPolForm] = useState(false);
  const [polForm, setPolForm] = useState({
    category: 'TPCN',
    supplierName: '',
    supplierSystemName: '',
    productName: 'Tất cả',
    returnPolicy: '',
    warnMonthsBefore: 3,
  });
  const [polImportPreview, setPolImportPreview] = useState<PolicyImportPreview | null>(null);

  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [importing, setImporting] = useState(false);

  const loadData = useCallback(async () => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    if (subTab === 'catalog') {
      const res = await fetchCatalogPage(client, {
        page,
        pageSize,
        search: debouncedSearch,
      });
      if (res.error) onNotify('error', res.error);
      else {
        setCatalogRows(res.rows);
        setCatalogTotal(res.total);
      }
    } else {
      const res = await fetchPoliciesPage(client, {
        page,
        pageSize,
        search: debouncedSearch,
      });
      if (res.error) onNotify('error', res.error);
      else {
        setPolicyRows(res.rows);
        setPolicyTotal(res.total);
      }
    }
    setLoading(false);
  }, [client, subTab, page, pageSize, debouncedSearch, onNotify]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useScopedRealtime(
    client,
    Boolean(client),
    [subTab === 'catalog' ? 'product_catalog' : 'supplier_policies'],
    () => {
      void loadData();
    }
  );

  // Create single catalog item with duplicate check
  const handleCreateCatalog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;
    const code = catForm.productCode.trim();
    const barcode = catForm.barcode.trim();
    if (!code || !catForm.name.trim()) {
      onNotify('error', 'Nhập Mã hàng và Tên hàng.');
      return;
    }
    const existingAll = await fetchAllCatalogForCache(client);
    const dupCode = existingAll.find((i) => i.productCode.toLowerCase() === code.toLowerCase());
    if (dupCode) {
      onNotify('error', `Mã hàng "${code}" đã tồn tại trong kho dữ liệu.`);
      return;
    }
    if (barcode) {
      const dupBarcode = existingAll.find((i) => i.barcode && i.barcode === barcode);
      if (dupBarcode) {
        onNotify('error', `Mã vạch "${barcode}" đã gắn với mã hàng "${dupBarcode.productCode}".`);
        return;
      }
    }

    const res = await upsertCatalogItem(client, {
      ...catForm,
      updatedBy: user.email,
    });
    if (res.error) {
      onNotify('error', res.error);
    } else {
      onNotify('success', `Đã thêm mã hàng ${code}`);
      onLogActivity('create', code, `Thêm danh mục hàng ${code} - ${catForm.name}`);
      setCatForm({ productCode: '', barcode: '', name: '', unit: 'Hộp', price: 0, supplierName: '' });
      setShowCatForm(false);
      void loadData();
    }
  };

  // Create single policy
  const handleCreatePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;
    if (!polForm.supplierSystemName.trim() || !polForm.returnPolicy.trim()) {
      onNotify('error', 'Nhập Tên NCC HT và Chính sách đổi trả SP.');
      return;
    }
    const res = await upsertPolicyItem(client, {
      ...polForm,
      updatedBy: user.email,
    });
    if (res.error) {
      onNotify('error', res.error);
    } else {
      onNotify('success', `Đã lưu chính sách NCC ${polForm.supplierSystemName}`);
      onLogActivity('create', polForm.supplierSystemName, `Thêm chính sách đổi trả ${polForm.supplierSystemName}`);
      setPolForm({
        category: 'TPCN',
        supplierName: '',
        supplierSystemName: '',
        productName: 'Tất cả',
        returnPolicy: '',
        warnMonthsBefore: 3,
      });
      setShowPolForm(false);
      void loadData();
    }
  };

  // Batch delete
  const handleConfirmBatchDelete = async () => {
    if (!client) return;
    if (subTab === 'catalog') {
      const targets = catalogRows.filter((r) => selectedCatIds.has(r.id));
      const res = await batchDeleteCatalogWithCheck(client, targets);
      if (res.error) {
        onNotify('error', res.error);
      } else {
        if (res.blockedCodes.length > 0) {
          onNotify(
            'info',
            `Đã xóa ${res.deleted} mặt hàng. Không thể xóa ${res.blockedCodes.join(', ')} vì đang được dùng ở HSD/Khuyến mãi.`
          );
        } else {
          onNotify('success', `Đã xóa ${res.deleted} mặt hàng.`);
        }
        onLogActivity('delete', 'batch', `Xóa ${res.deleted} mã hàng khỏi danh mục`);
        setSelectedCatIds(new Set());
        void loadData();
      }
    } else {
      const ids = Array.from(selectedPolIds);
      const res = await deletePoliciesBatch(client, ids);
      if (res.error) {
        onNotify('error', res.error);
      } else {
        onNotify('success', `Đã xóa ${ids.length} chính sách đổi trả.`);
        onLogActivity('delete', 'batch', `Xóa ${ids.length} chính sách NCC`);
        setSelectedPolIds(new Set());
        void loadData();
      }
    }
    setConfirmBatchDelete(false);
  };

  // Excel import parsing + diff preview
  const handleUploadExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !client) return;

    try {
      const sheetRows = await readExcelSheetRows(file);
      if (sheetRows.length <= 1) {
        onNotify('error', 'File Excel không có dòng dữ liệu.');
        return;
      }
      const dataRows = sheetRows.slice(1);

      if (subTab === 'catalog') {
        const existingAll = await fetchAllCatalogForCache(client);
        const existingMap = new Map<string, ProductCatalogItem>();
        existingAll.forEach((item) => existingMap.set(item.productCode.toLowerCase(), item));

        const toInsert: CatalogImportPreview['toInsert'] = [];
        const toUpdate: CatalogImportPreview['toUpdate'] = [];
        const errors: string[] = [];
        let skippedCount = 0;

        dataRows.forEach((row, idx) => {
          const code = normalizeCellString(row[1]);
          const barcode = normalizeCellString(row[2]);
          const name = normalizeCellString(row[3]);
          const unit = normalizeCellString(row[4]);
          const price = normalizeCellNumber(row[5], 0);
          const supplierName = normalizeCellString(row[6]);

          if (!code || !name) {
            errors.push(`Dòng ${idx + 2}: Thiếu Mã hàng hoặc Tên hàng.`);
            return;
          }
          const existing = existingMap.get(code.toLowerCase());
          if (!existing) {
            toInsert.push({
              productCode: code,
              barcode,
              name,
              unit,
              price,
              supplierName,
              updatedBy: user.email,
            });
          } else {
            const changed =
              existing.barcode !== barcode ||
              existing.name !== name ||
              existing.unit !== unit ||
              existing.price !== price ||
              existing.supplierName !== supplierName;
            if (changed) {
              toUpdate.push({
                id: existing.id,
                productCode: code,
                barcode,
                name,
                unit,
                price,
                supplierName,
                updatedBy: user.email,
              });
            } else {
              skippedCount += 1;
            }
          }
        });
        setCatImportPreview({ toInsert, toUpdate, skippedCount, errors });
      } else {
        const existingAll = await fetchAllPoliciesForCache(client);
        const existingMap = new Map<string, SupplierPolicyItem>();
        existingAll.forEach((p) =>
          existingMap.set(
            `${p.supplierSystemName.toLowerCase()}__${p.productName.toLowerCase()}`,
            p
          )
        );

        const toInsert: PolicyImportPreview['toInsert'] = [];
        const toUpdate: PolicyImportPreview['toUpdate'] = [];
        const errors: string[] = [];
        let skippedCount = 0;

        dataRows.forEach((row, idx) => {
          const category = normalizeCellString(row[1]);
          const supplierName = normalizeCellString(row[2]);
          const supplierSystemName = normalizeCellString(row[3]);
          const productName = normalizeCellString(row[4]) || 'Tất cả';
          const returnPolicy = normalizeCellString(row[5]);
          const warnMonthsBefore = Math.max(0, Math.round(normalizeCellNumber(row[6], 0)));

          if (!supplierSystemName || !returnPolicy) {
            errors.push(`Dòng ${idx + 2}: Thiếu Tên NCC HT hoặc Chính sách đổi trả SP.`);
            return;
          }
          const key = `${supplierSystemName.toLowerCase()}__${productName.toLowerCase()}`;
          const existing = existingMap.get(key);
          if (!existing) {
            toInsert.push({
              category,
              supplierName,
              supplierSystemName,
              productName,
              returnPolicy,
              warnMonthsBefore,
              updatedBy: user.email,
            });
          } else {
            const changed =
              existing.category !== category ||
              existing.supplierName !== supplierName ||
              existing.returnPolicy !== returnPolicy ||
              existing.warnMonthsBefore !== warnMonthsBefore;
            if (changed) {
              toUpdate.push({
                id: existing.id,
                category,
                supplierName,
                supplierSystemName,
                productName,
                returnPolicy,
                warnMonthsBefore,
                updatedBy: user.email,
              });
            } else {
              skippedCount += 1;
            }
          }
        });
        setPolImportPreview({ toInsert, toUpdate, skippedCount, errors });
      }
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Không thể đọc tệp Excel tải lên.'
      );
    }
  };

  const applyCatalogImport = async () => {
    if (!client || !catImportPreview) return;
    setImporting(true);
    let ok = 0;
    for (const row of [...catImportPreview.toInsert, ...catImportPreview.toUpdate]) {
      const res = await upsertCatalogItem(client, row);
      if (!res.error) ok += 1;
    }
    setImporting(false);
    onNotify(
      'success',
      `Import hoàn tất: ${ok} bản ghi đã lưu (${catImportPreview.toInsert.length} mới, ${catImportPreview.toUpdate.length} cập nhật, bỏ qua ${catImportPreview.skippedCount} dòng không đổi).`
    );
    onLogActivity(
      'update',
      'catalog_import',
      `Import danh mục: +${catImportPreview.toInsert.length}, sửa ${catImportPreview.toUpdate.length}, bỏ qua ${catImportPreview.skippedCount}`
    );
    setCatImportPreview(null);
    void loadData();
  };

  const applyPolicyImport = async () => {
    if (!client || !polImportPreview) return;
    setImporting(true);
    let ok = 0;
    for (const row of [...polImportPreview.toInsert, ...polImportPreview.toUpdate]) {
      const res = await upsertPolicyItem(client, row);
      if (!res.error) ok += 1;
    }
    setImporting(false);
    onNotify(
      'success',
      `Import chính sách NCC hoàn tất: ${ok} bản ghi (${polImportPreview.toInsert.length} mới, ${polImportPreview.toUpdate.length} cập nhật, bỏ qua ${polImportPreview.skippedCount}).`
    );
    onLogActivity(
      'update',
      'policy_import',
      `Import chính sách NCC: +${polImportPreview.toInsert.length}, sửa ${polImportPreview.toUpdate.length}`
    );
    setPolImportPreview(null);
    void loadData();
  };

  return (
    <div className="space-y-5">
      {/* Sub-tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="inline-flex p-1 bg-slate-100 rounded-lg border border-slate-200">
          <button
            type="button"
            onClick={() => {
              setSubTab('catalog');
              setPage(1);
              setSearch('');
            }}
            className={`min-h-[40px] px-4 py-1.5 text-sm font-medium rounded-md ${
              subTab === 'catalog' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Danh mục hàng
          </button>
          <button
            type="button"
            onClick={() => {
              setSubTab('policies');
              setPage(1);
              setSearch('');
            }}
            className={`min-h-[40px] px-4 py-1.5 text-sm font-medium rounded-md ${
              subTab === 'policies' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Chính sách đổi trả NCC
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              void (subTab === 'catalog' ? downloadCatalogTemplate() : downloadPolicyTemplate())
            }
            className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Tải file mẫu</span>
          </button>

          {canEdit && (
            <label className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 cursor-pointer">
              <Upload className="h-3.5 w-3.5 text-blue-600" />
              <span>Import Excel (Diff)</span>
              <input
                type="file"
                accept=".xlsx"
                onChange={handleUploadExcel}
                className="hidden"
              />
            </label>
          )}

          {canExport && (
            <button
              type="button"
              onClick={async () => {
                if (subTab === 'catalog') {
                  const f = await exportCatalogToExcel(catalogRows);
                  onNotify('success', `Đã xuất ${f}`);
                } else {
                  const f = await exportPoliciesToExcel(policyRows);
                  onNotify('success', `Đã xuất ${f}`);
                }
              }}
              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />
              <span>Xuất Excel</span>
            </button>
          )}

          {canEdit && (
            <button
              type="button"
              onClick={() =>
                subTab === 'catalog'
                  ? setShowCatForm((v) => !v)
                  : setShowPolForm((v) => !v)
              }
              className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 inline-flex items-center gap-1.5"
            >
              <Plus className="h-4 w-4" />
              <span>Thêm mới</span>
            </button>
          )}
        </div>
      </div>

      {/* Excel Import Preview Drawer */}
      {subTab === 'catalog' && catImportPreview && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-bold text-blue-950">
              Xem trước Import Danh mục hàng (chỉ ghi phần thay đổi, không xóa dòng vắng mặt)
            </h4>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCatImportPreview(null)}
                className="px-3 py-1.5 rounded-lg border border-blue-300 bg-white text-xs font-medium text-slate-700"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={importing || (catImportPreview.toInsert.length === 0 && catImportPreview.toUpdate.length === 0)}
                onClick={() => void applyCatalogImport()}
                className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {importing ? 'Đang import...' : 'Xác nhận áp dụng'}
              </button>
            </div>
          </div>
          <p className="text-xs text-blue-900 tabular-nums">
            Thêm mới: <strong>{catImportPreview.toInsert.length}</strong> · Cập nhật:{' '}
            <strong>{catImportPreview.toUpdate.length}</strong> · Bỏ qua (không đổi):{' '}
            <strong>{catImportPreview.skippedCount}</strong> · Lỗi:{' '}
            <strong>{catImportPreview.errors.length}</strong>
          </p>
          {catImportPreview.errors.length > 0 && (
            <p className="text-xs text-red-700">{catImportPreview.errors.slice(0, 3).join(' | ')}</p>
          )}
        </div>
      )}

      {subTab === 'policies' && polImportPreview && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-bold text-blue-950">
              Xem trước Import Chính sách đổi trả NCC
            </h4>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPolImportPreview(null)}
                className="px-3 py-1.5 rounded-lg border border-blue-300 bg-white text-xs font-medium text-slate-700"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={importing || (polImportPreview.toInsert.length === 0 && polImportPreview.toUpdate.length === 0)}
                onClick={() => void applyPolicyImport()}
                className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {importing ? 'Đang import...' : 'Xác nhận áp dụng'}
              </button>
            </div>
          </div>
          <p className="text-xs text-blue-900 tabular-nums">
            Thêm mới: <strong>{polImportPreview.toInsert.length}</strong> · Cập nhật:{' '}
            <strong>{polImportPreview.toUpdate.length}</strong> · Bỏ qua:{' '}
            <strong>{polImportPreview.skippedCount}</strong> · Lỗi:{' '}
            <strong>{polImportPreview.errors.length}</strong>
          </p>
        </div>
      )}

      {/* Add Forms */}
      {subTab === 'catalog' && showCatForm && (
        <form
          onSubmit={handleCreateCatalog}
          className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3"
        >
          <input
            type="text"
            required
            placeholder="Mã hàng *"
            value={catForm.productCode}
            onChange={(e) => setCatForm((p) => ({ ...p, productCode: e.target.value }))}
            className="min-h-[40px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
          />
          <input
            type="text"
            placeholder="Mã vạch"
            value={catForm.barcode}
            onChange={(e) => setCatForm((p) => ({ ...p, barcode: e.target.value }))}
            className="min-h-[40px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
          />
          <input
            type="text"
            required
            placeholder="Tên hàng *"
            value={catForm.name}
            onChange={(e) => setCatForm((p) => ({ ...p, name: e.target.value }))}
            className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg sm:col-span-2"
          />
          <input
            type="text"
            placeholder="ĐVT"
            value={catForm.unit}
            onChange={(e) => setCatForm((p) => ({ ...p, unit: e.target.value }))}
            className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
          />
          <input
            type="number"
            min={0}
            placeholder="Giá bán"
            value={catForm.price}
            onChange={(e) => setCatForm((p) => ({ ...p, price: Number(e.target.value) }))}
            className="min-h-[40px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
          />
          <input
            type="text"
            placeholder="Nhà cung cấp (Tên NCC HT)"
            value={catForm.supplierName}
            onChange={(e) => setCatForm((p) => ({ ...p, supplierName: e.target.value }))}
            className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg sm:col-span-2"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="min-h-[40px] px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
            >
              Lưu mã hàng
            </button>
          </div>
        </form>
      )}

      {subTab === 'policies' && showPolForm && (
        <form
          onSubmit={handleCreatePolicy}
          className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
        >
          <input
            type="text"
            placeholder="Ngành hàng"
            value={polForm.category}
            onChange={(e) => setPolForm((p) => ({ ...p, category: e.target.value }))}
            className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
          />
          <input
            type="text"
            placeholder="Tên NCC"
            value={polForm.supplierName}
            onChange={(e) => setPolForm((p) => ({ ...p, supplierName: e.target.value }))}
            className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
          />
          <input
            type="text"
            required
            placeholder="Tên NCC HT *"
            value={polForm.supplierSystemName}
            onChange={(e) => setPolForm((p) => ({ ...p, supplierSystemName: e.target.value }))}
            className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
          />
          <input
            type="text"
            placeholder="Tên hàng hóa (mặc định Tất cả)"
            value={polForm.productName}
            onChange={(e) => setPolForm((p) => ({ ...p, productName: e.target.value }))}
            className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
          />
          <input
            type="text"
            required
            placeholder="Chính sách đổi trả SP *"
            value={polForm.returnPolicy}
            onChange={(e) => setPolForm((p) => ({ ...p, returnPolicy: e.target.value }))}
            className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
          />
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={36}
              value={polForm.warnMonthsBefore}
              onChange={(e) =>
                setPolForm((p) => ({ ...p, warnMonthsBefore: Number(e.target.value) }))
              }
              title="Số tháng báo trước"
              className="w-24 min-h-[40px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
            />
            <span className="text-xs text-slate-500">tháng</span>
            <button
              type="submit"
              className="ml-auto min-h-[40px] px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
            >
              Lưu chính sách
            </button>
          </div>
        </form>
      )}

      {/* Search + Batch Delete Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="relative max-w-sm w-full">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder={
                subTab === 'catalog'
                  ? 'Tìm mã hàng, mã vạch, tên hàng, NCC...'
                  : 'Tìm Tên NCC HT, ngành hàng, sản phẩm...'
              }
              className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          {canEdit &&
            ((subTab === 'catalog' && selectedCatIds.size > 0) ||
              (subTab === 'policies' && selectedPolIds.size > 0)) && (
              <button
                type="button"
                onClick={() => setConfirmBatchDelete(true)}
                className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700 inline-flex items-center gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>
                  Xóa đã chọn (
                  {subTab === 'catalog' ? selectedCatIds.size : selectedPolIds.size})
                </span>
              </button>
            )}
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          {subTab === 'catalog' ? (
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                  {canEdit && (
                    <th className="py-3 px-3 w-10">
                      <CheckSquare className="h-4 w-4 text-slate-400" />
                    </th>
                  )}
                  <th className="py-3 px-3">STT</th>
                  <th className="py-3 px-3">Mã hàng</th>
                  <th className="py-3 px-3">Mã vạch</th>
                  <th className="py-3 px-3">Tên hàng</th>
                  <th className="py-3 px-3">ĐVT</th>
                  <th className="py-3 px-3 text-right">Giá bán</th>
                  <th className="py-3 px-3">Nhà cung cấp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={canEdit ? 8 : 7} className="py-8 text-center text-slate-500">
                      Đang tải danh mục hàng...
                    </td>
                  </tr>
                ) : catalogRows.length === 0 ? (
                  <tr>
                    <td colSpan={canEdit ? 8 : 7} className="py-10 text-center text-slate-500">
                      Chưa có mặt hàng nào trong kho dữ liệu.
                    </td>
                  </tr>
                ) : (
                  catalogRows.map((item, idx) => (
                    <tr key={item.id} className="hover:bg-slate-50/60">
                      {canEdit && (
                        <td className="py-2.5 px-3">
                          <input
                            type="checkbox"
                            checked={selectedCatIds.has(item.id)}
                            onChange={(e) => {
                              setSelectedCatIds((prev) => {
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
                      <td className="py-2.5 px-3 font-mono text-xs font-bold text-slate-900">
                        {item.productCode}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs text-slate-600">
                        {item.barcode || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-slate-900">{item.name}</td>
                      <td className="py-2.5 px-3 text-xs text-slate-600">{item.unit}</td>
                      <td className="py-2.5 px-3 font-mono text-xs text-right tabular-nums text-slate-900">
                        {item.price.toLocaleString('vi-VN')}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-700">{item.supplierName}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                  {canEdit && (
                    <th className="py-3 px-3 w-10">
                      <CheckSquare className="h-4 w-4 text-slate-400" />
                    </th>
                  )}
                  <th className="py-3 px-3">STT</th>
                  <th className="py-3 px-3">Ngành hàng</th>
                  <th className="py-3 px-3">Tên NCC</th>
                  <th className="py-3 px-3">Tên NCC HT</th>
                  <th className="py-3 px-3">Tên hàng hóa</th>
                  <th className="py-3 px-3">Đổi trả SP</th>
                  <th className="py-3 px-3 text-right">Báo trước</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={canEdit ? 8 : 7} className="py-8 text-center text-slate-500">
                      Đang tải chính sách NCC...
                    </td>
                  </tr>
                ) : policyRows.length === 0 ? (
                  <tr>
                    <td colSpan={canEdit ? 8 : 7} className="py-10 text-center text-slate-500">
                      Chưa có chính sách đổi trả NCC nào.
                    </td>
                  </tr>
                ) : (
                  policyRows.map((item, idx) => (
                    <tr key={item.id} className="hover:bg-slate-50/60">
                      {canEdit && (
                        <td className="py-2.5 px-3">
                          <input
                            type="checkbox"
                            checked={selectedPolIds.has(item.id)}
                            onChange={(e) => {
                              setSelectedPolIds((prev) => {
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
                      <td className="py-2.5 px-3 text-xs text-slate-700">{item.category}</td>
                      <td className="py-2.5 px-3 text-slate-800">{item.supplierName}</td>
                      <td className="py-2.5 px-3 font-bold text-slate-900">
                        {item.supplierSystemName}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700">{item.productName}</td>
                      <td className="py-2.5 px-3 text-slate-800">{item.returnPolicy}</td>
                      <td className="py-2.5 px-3 font-mono text-xs text-right tabular-nums">
                        {item.warnMonthsBefore} tháng
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={subTab === 'catalog' ? catalogTotal : policyTotal}
          onPageChange={setPage}
          onPageSizeChange={(sz) => {
            setPageSize(sz);
            setPage(1);
          }}
        />
      </div>

      <ConfirmDialog
        open={confirmBatchDelete}
        title="Xác nhận xóa hàng loạt"
        description={
          subTab === 'catalog'
            ? `Xóa ${selectedCatIds.size} mặt hàng đã chọn? Hệ thống sẽ giữ lại những mã đang liên kết với Hạn sử dụng hoặc Khuyến mãi.`
            : `Xóa ${selectedPolIds.size} chính sách đổi trả đã chọn?`
        }
        confirmLabel="Xóa đã chọn"
        danger
        onConfirm={handleConfirmBatchDelete}
        onCancel={() => setConfirmBatchDelete(false)}
      />
    </div>
  );
}
