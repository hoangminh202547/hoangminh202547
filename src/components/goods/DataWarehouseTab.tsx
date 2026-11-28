import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BellRing,
  CheckSquare,
  ChevronDown,
  ChevronUp,
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
import { extractNoticeMonthsFromPolicy } from '../../lib/permissions';
import {
  batchDeleteCatalogWithCheck,
  deletePoliciesBatch,
  fetchAllCatalogForCache,
  fetchAllPoliciesForCache,
  fetchCatalogPage,
  fetchPoliciesPage,
  fetchRecentWarehouseUpdates,
  upsertCatalogItem,
  upsertPolicyItem,
  useScopedRealtime,
  type WarehouseUpdateEntry,
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
  onLogActivity: (
    action: 'create' | 'update' | 'delete' | 'export',
    targetId: string,
    summary: string
  ) => void;
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

function formatDateTimeVi(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
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

  // Recent updates notification table
  const [recentUpdates, setRecentUpdates] = useState<WarehouseUpdateEntry[]>([]);
  const [updatesPanelOpen, setUpdatesPanelOpen] = useState(false);
  const [sessionUpdateBanner, setSessionUpdateBanner] = useState<string | null>(null);

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

  // Policy state (removed "Báo trước" column from UI; warnMonthsBefore auto-inferred from policy text)
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
  });
  const [polImportPreview, setPolImportPreview] = useState<PolicyImportPreview | null>(null);

  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [importing, setImporting] = useState(false);

  const loadRecentUpdates = useCallback(async () => {
    if (!client) return;
    const list = await fetchRecentWarehouseUpdates(client, 15);
    setRecentUpdates(list);
  }, [client]);

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
    void loadRecentUpdates();
  }, [loadData, loadRecentUpdates]);

  useScopedRealtime(
    client,
    Boolean(client),
    ['product_catalog', 'supplier_policies'],
    () => {
      void loadData();
      void loadRecentUpdates();
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
      setSessionUpdateBanner(`Vừa bổ sung mã hàng mới: ${code} — ${catForm.name}`);
      setUpdatesPanelOpen(true);
      setCatForm({
        productCode: '',
        barcode: '',
        name: '',
        unit: 'Hộp',
        price: 0,
        supplierName: '',
      });
      setShowCatForm(false);
      void loadData();
      void loadRecentUpdates();
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
    const inferredMonths = extractNoticeMonthsFromPolicy(polForm.returnPolicy);
    const res = await upsertPolicyItem(client, {
      ...polForm,
      warnMonthsBefore: inferredMonths,
      updatedBy: user.email,
    });
    if (res.error) {
      onNotify('error', res.error);
    } else {
      onNotify('success', `Đã lưu chính sách NCC ${polForm.supplierSystemName}`);
      onLogActivity(
        'create',
        polForm.supplierSystemName,
        `Thêm chính sách đổi trả ${polForm.supplierSystemName}`
      );
      setSessionUpdateBanner(
        `Vừa bổ sung chính sách đổi trả NCC: ${polForm.supplierSystemName} (${polForm.returnPolicy})`
      );
      setUpdatesPanelOpen(true);
      setPolForm({
        category: 'TPCN',
        supplierName: '',
        supplierSystemName: '',
        productName: 'Tất cả',
        returnPolicy: '',
      });
      setShowPolForm(false);
      void loadData();
      void loadRecentUpdates();
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
        void loadRecentUpdates();
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
        void loadRecentUpdates();
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
          const legacyColMonths = normalizeCellNumber(row[6], 0);
          const warnMonthsBefore =
            extractNoticeMonthsFromPolicy(returnPolicy, legacyColMonths);

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
    const summaryMsg = `Import danh mục hàng: +${catImportPreview.toInsert.length} mới, cập nhật ${catImportPreview.toUpdate.length} dòng (bỏ qua ${catImportPreview.skippedCount} dòng không đổi).`;
    onNotify('success', `Import hoàn tất (${ok} bản ghi đã lưu).`);
    onLogActivity('update', 'catalog_import', summaryMsg);
    setSessionUpdateBanner(summaryMsg);
    setUpdatesPanelOpen(true);
    setCatImportPreview(null);
    void loadData();
    void loadRecentUpdates();
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
    const summaryMsg = `Import chính sách NCC: +${polImportPreview.toInsert.length} mới, cập nhật ${polImportPreview.toUpdate.length} dòng (bỏ qua ${polImportPreview.skippedCount}).`;
    onNotify('success', `Import chính sách NCC hoàn tất (${ok} bản ghi).`);
    onLogActivity('update', 'policy_import', summaryMsg);
    setSessionUpdateBanner(summaryMsg);
    setUpdatesPanelOpen(true);
    setPolImportPreview(null);
    void loadData();
    void loadRecentUpdates();
  };

  const latestUpdate = recentUpdates[0] || null;

  return (
    <div className="space-y-4">
      {/* Warehouse Recent Updates Notification Banner & Table */}
      {(latestUpdate || sessionUpdateBanner) && (
        <div className="bg-blue-50/90 border border-blue-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
            <div className="flex items-start sm:items-center gap-2.5 min-w-0">
              <BellRing className="h-4 w-4 text-blue-600 shrink-0 mt-0.5 sm:mt-0" />
              <div className="min-w-0 text-sm text-blue-950">
                {sessionUpdateBanner ? (
                  <p className="font-semibold text-blue-900">{sessionUpdateBanner}</p>
                ) : latestUpdate ? (
                  <p className="truncate">
                    <span className="font-bold">Cập nhật mới nhất kho dữ liệu:</span>{' '}
                    <span className="font-semibold text-blue-800">
                      [{latestUpdate.source === 'catalog' ? 'Danh mục hàng' : 'Chính sách NCC'}]
                    </span>{' '}
                    {latestUpdate.codeOrSystem} — {latestUpdate.title}{' '}
                    <span className="text-xs text-slate-600">
                      ({formatDateTimeVi(latestUpdate.updatedAt || latestUpdate.createdAt)})
                    </span>
                  </p>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setUpdatesPanelOpen((v) => !v)}
              className="min-h-[36px] px-3 py-1.5 rounded-lg bg-white border border-blue-300 text-xs font-semibold text-blue-800 hover:bg-blue-100 inline-flex items-center gap-1.5 self-start sm:self-auto whitespace-nowrap shrink-0"
            >
              <span>
                {updatesPanelOpen ? 'Ẩn bảng cập nhật' : `Xem bảng thông báo (${recentUpdates.length})`}
              </span>
              {updatesPanelOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          {updatesPanelOpen && (
            <div className="border-t border-blue-200 bg-white">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
                <p className="text-xs sm:text-sm font-bold text-slate-900">
                  Bảng thông báo bổ sung &amp; cập nhật mới Kho dữ liệu (Danh mục hàng &amp; Chính sách NCC)
                </p>
                <span className="text-xs text-slate-500 tabular-nums">
                  {recentUpdates.length} mục gần nhất
                </span>
              </div>

              {/* Desktop updates table */}
              <div className="hidden md:block overflow-x-auto max-h-72">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                      <th className="py-2.5 px-3">Loại</th>
                      <th className="py-2.5 px-3">Phân hệ</th>
                      <th className="py-2.5 px-3">Mã hàng / Tên NCC HT</th>
                      <th className="py-2.5 px-3">Tên hàng / Sản phẩm</th>
                      <th className="py-2.5 px-3">Chi tiết cập nhật</th>
                      <th className="py-2.5 px-3">Người cập nhật</th>
                      <th className="py-2.5 px-3">Thời gian</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {recentUpdates.map((u) => (
                      <tr key={u.id} className="hover:bg-slate-50/70">
                        <td className="py-2 px-3 whitespace-nowrap">
                          <span
                            className={`inline-block px-2 py-0.5 rounded border text-xs font-semibold ${
                              u.isNew
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                : 'bg-blue-50 border-blue-200 text-blue-700'
                            }`}
                          >
                            {u.isNew ? 'Bổ sung mới' : 'Cập nhật'}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-xs font-medium text-slate-700 whitespace-nowrap">
                          {u.source === 'catalog' ? 'Danh mục hàng' : 'Chính sách NCC'}
                        </td>
                        <td className="py-2 px-3 font-mono text-xs font-bold text-slate-900">
                          {u.codeOrSystem}
                        </td>
                        <td className="py-2 px-3 text-slate-900 font-medium">{u.title}</td>
                        <td className="py-2 px-3 text-xs text-slate-700">{u.detail}</td>
                        <td className="py-2 px-3 text-xs text-slate-600 font-mono">
                          {u.updatedBy || '—'}
                        </td>
                        <td className="py-2 px-3 text-xs text-slate-500 font-mono whitespace-nowrap tabular-nums">
                          {formatDateTimeVi(u.updatedAt || u.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile portrait cards for warehouse updates */}
              <div className="md:hidden divide-y divide-slate-100 max-h-80 overflow-y-auto">
                {recentUpdates.map((u) => (
                  <div key={u.id} className="p-3.5 space-y-1.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`inline-block px-2 py-0.5 rounded border text-xs font-semibold ${
                          u.isNew
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                            : 'bg-blue-50 border-blue-200 text-blue-700'
                        }`}
                      >
                        {u.isNew ? 'Bổ sung mới' : 'Cập nhật'} ·{' '}
                        {u.source === 'catalog' ? 'Danh mục hàng' : 'Chính sách NCC'}
                      </span>
                      <span className="text-xs text-slate-500 font-mono tabular-nums">
                        {formatDateTimeVi(u.updatedAt || u.createdAt)}
                      </span>
                    </div>
                    <p className="font-bold text-slate-900">
                      {u.codeOrSystem} — {u.title}
                    </p>
                    <p className="text-xs text-slate-700">{u.detail}</p>
                    <p className="text-xs text-slate-500 font-mono">
                      Người cập nhật: {u.updatedBy || '—'}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sub-tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="inline-flex p-1 bg-slate-100 rounded-lg border border-slate-200 self-start">
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
            className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <Download className="h-4 w-4" />
            <span>Tải file mẫu</span>
          </button>

          {canEdit && (
            <label className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 cursor-pointer">
              <Upload className="h-4 w-4 text-blue-600" />
              <span>Import Excel</span>
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
              className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
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
              className="min-h-[40px] px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs sm:text-sm font-medium hover:bg-blue-700 inline-flex items-center gap-1.5"
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
                disabled={
                  importing ||
                  (catImportPreview.toInsert.length === 0 &&
                    catImportPreview.toUpdate.length === 0)
                }
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
                disabled={
                  importing ||
                  (polImportPreview.toInsert.length === 0 &&
                    polImportPreview.toUpdate.length === 0)
                }
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
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
        >
          <p className="text-sm font-bold text-slate-900">Bổ sung mặt hàng vào kho dữ liệu</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Mã hàng *</label>
              <input
                type="text"
                required
                placeholder="VD: SP001"
                value={catForm.productCode}
                onChange={(e) => setCatForm((p) => ({ ...p, productCode: e.target.value }))}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Mã vạch</label>
              <input
                type="text"
                placeholder="Barcode"
                value={catForm.barcode}
                onChange={(e) => setCatForm((p) => ({ ...p, barcode: e.target.value }))}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-600 mb-1">Tên hàng *</label>
              <input
                type="text"
                required
                placeholder="Tên đầy đủ sản phẩm"
                value={catForm.name}
                onChange={(e) => setCatForm((p) => ({ ...p, name: e.target.value }))}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">ĐVT</label>
              <input
                type="text"
                placeholder="Hộp"
                value={catForm.unit}
                onChange={(e) => setCatForm((p) => ({ ...p, unit: e.target.value }))}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Giá bán</label>
              <input
                type="number"
                min={0}
                placeholder="0"
                value={catForm.price}
                onChange={(e) => setCatForm((p) => ({ ...p, price: Number(e.target.value) }))}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Nhà cung cấp (Tên NCC HT)
              </label>
              <input
                type="text"
                placeholder="Tên NCC theo hệ thống"
                value={catForm.supplierName}
                onChange={(e) => setCatForm((p) => ({ ...p, supplierName: e.target.value }))}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div className="sm:col-span-2 flex items-end justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCatForm(false)}
                className="min-h-[42px] px-4 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
              >
                Đóng
              </button>
              <button
                type="submit"
                className="min-h-[42px] px-5 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
              >
                Lưu mã hàng
              </button>
            </div>
          </div>
        </form>
      )}

      {subTab === 'policies' && showPolForm && (
        <form
          onSubmit={handleCreatePolicy}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
        >
          <p className="text-sm font-bold text-slate-900">Bổ sung chính sách đổi trả NCC</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Ngành hàng</label>
              <input
                type="text"
                placeholder="VD: TPCN"
                value={polForm.category}
                onChange={(e) => setPolForm((p) => ({ ...p, category: e.target.value }))}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Tên NCC</label>
              <input
                type="text"
                placeholder="Tên nhà cung cấp"
                value={polForm.supplierName}
                onChange={(e) => setPolForm((p) => ({ ...p, supplierName: e.target.value }))}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Tên NCC HT *</label>
              <input
                type="text"
                required
                placeholder="Tên NCC theo hệ thống *"
                value={polForm.supplierSystemName}
                onChange={(e) =>
                  setPolForm((p) => ({ ...p, supplierSystemName: e.target.value }))
                }
                className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Tên hàng hóa áp dụng
              </label>
              <input
                type="text"
                placeholder="Mặc định: Tất cả"
                value={polForm.productName}
                onChange={(e) => setPolForm((p) => ({ ...p, productName: e.target.value }))}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Chính sách đổi trả SP * (VD: Báo trước 3 tháng trước HSD)
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  required
                  placeholder="VD: Đổi trả trước 3 tháng"
                  value={polForm.returnPolicy}
                  onChange={(e) => setPolForm((p) => ({ ...p, returnPolicy: e.target.value }))}
                  className="flex-1 min-h-[42px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                />
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowPolForm(false)}
                    className="min-h-[42px] px-4 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    Đóng
                  </button>
                  <button
                    type="submit"
                    className="min-h-[42px] px-5 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 whitespace-nowrap"
                  >
                    Lưu chính sách
                  </button>
                </div>
              </div>
            </div>
          </div>
        </form>
      )}

      {/* Search + Batch Delete Toolbar + Desktop Table + Mobile Portrait Cards */}
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
              className="w-full min-h-[42px] pl-9 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          {canEdit &&
            ((subTab === 'catalog' && selectedCatIds.size > 0) ||
              (subTab === 'policies' && selectedPolIds.size > 0)) && (
              <button
                type="button"
                onClick={() => setConfirmBatchDelete(true)}
                className="min-h-[40px] px-3.5 py-1.5 rounded-lg bg-red-600 text-white text-xs sm:text-sm font-medium hover:bg-red-700 inline-flex items-center gap-1.5"
              >
                <Trash2 className="h-4 w-4" />
                <span>
                  Xóa đã chọn (
                  {subTab === 'catalog' ? selectedCatIds.size : selectedPolIds.size})
                </span>
              </button>
            )}
        </div>

        {/* Desktop Table */}
        <div className="hidden md:block overflow-x-auto">
          {subTab === 'catalog' ? (
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
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
                        <td className="py-3 px-3">
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
                      <td className="py-3 px-3 font-mono text-xs text-slate-500 tabular-nums">
                        {(page - 1) * pageSize + idx + 1}
                      </td>
                      <td className="py-3 px-3 font-mono text-xs font-bold text-slate-900">
                        {item.productCode}
                      </td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-600">
                        {item.barcode || '—'}
                      </td>
                      <td className="py-3 px-3 text-slate-900 font-medium">{item.name}</td>
                      <td className="py-3 px-3 text-xs text-slate-700">{item.unit}</td>
                      <td className="py-3 px-3 font-mono text-xs text-right tabular-nums font-semibold text-slate-900">
                        {item.price.toLocaleString('vi-VN')}
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-700">{item.supplierName}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
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
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={canEdit ? 7 : 6} className="py-8 text-center text-slate-500">
                      Đang tải chính sách NCC...
                    </td>
                  </tr>
                ) : policyRows.length === 0 ? (
                  <tr>
                    <td colSpan={canEdit ? 7 : 6} className="py-10 text-center text-slate-500">
                      Chưa có chính sách đổi trả NCC nào.
                    </td>
                  </tr>
                ) : (
                  policyRows.map((item, idx) => (
                    <tr key={item.id} className="hover:bg-slate-50/60">
                      {canEdit && (
                        <td className="py-3 px-3">
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
                      <td className="py-3 px-3 font-mono text-xs text-slate-500 tabular-nums">
                        {(page - 1) * pageSize + idx + 1}
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-700">{item.category}</td>
                      <td className="py-3 px-3 text-slate-800">{item.supplierName}</td>
                      <td className="py-3 px-3 font-bold text-slate-900">
                        {item.supplierSystemName}
                      </td>
                      <td className="py-3 px-3 text-slate-700">{item.productName}</td>
                      <td className="py-3 px-3 text-slate-900 font-medium">{item.returnPolicy}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Mobile Portrait Vertical Cards */}
        <div className="md:hidden divide-y divide-slate-200">
          {loading ? (
            <div className="p-6 text-center text-sm text-slate-500">Đang tải dữ liệu...</div>
          ) : subTab === 'catalog' ? (
            catalogRows.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Chưa có mặt hàng nào trong kho dữ liệu.
              </div>
            ) : (
              catalogRows.map((item, idx) => (
                <div key={item.id} className="p-4 space-y-2.5 text-[15px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {canEdit && (
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
                    <span className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                      {item.price.toLocaleString('vi-VN')} đ
                    </span>
                  </div>

                  <p className="font-semibold text-slate-900 leading-snug">{item.name}</p>

                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm bg-slate-50 rounded-lg p-2.5">
                    <div>
                      <span className="text-xs text-slate-500 block">Mã vạch</span>
                      <span className="font-mono text-slate-800">{item.barcode || '—'}</span>
                    </div>
                    <div>
                      <span className="text-xs text-slate-500 block">ĐVT</span>
                      <span className="text-slate-800">{item.unit || '—'}</span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-xs text-slate-500 block">Nhà cung cấp</span>
                      <span className="text-slate-800 font-medium">{item.supplierName || '—'}</span>
                    </div>
                  </div>
                </div>
              ))
            )
          ) : policyRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Chưa có chính sách đổi trả NCC nào.
            </div>
          ) : (
            policyRows.map((item, idx) => (
              <div key={item.id} className="p-4 space-y-2.5 text-[15px]">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {canEdit && (
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
                        className="h-4 w-4 rounded border-slate-300 shrink-0"
                      />
                    )}
                    <span className="font-mono text-xs text-slate-500 tabular-nums">
                      #{(page - 1) * pageSize + idx + 1}
                    </span>
                    <span className="font-bold text-slate-900 truncate">
                      {item.supplierSystemName}
                    </span>
                  </div>
                  <span className="text-xs font-medium text-slate-600 shrink-0">
                    {item.category || '—'}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-2 text-sm bg-slate-50 rounded-lg p-2.5">
                  {item.supplierName && (
                    <div>
                      <span className="text-xs text-slate-500 block">Tên NCC</span>
                      <span className="text-slate-800">{item.supplierName}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-xs text-slate-500 block">Tên hàng hóa áp dụng</span>
                    <span className="text-slate-800 font-medium">{item.productName || 'Tất cả'}</span>
                  </div>
                  <div>
                    <span className="text-xs text-slate-500 block">Chính sách đổi trả SP</span>
                    <span className="text-slate-900 font-semibold">{item.returnPolicy}</span>
                  </div>
                </div>
              </div>
            ))
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
        variant="danger"
        onConfirm={handleConfirmBatchDelete}
        onCancel={() => setConfirmBatchDelete(false)}
      />
    </div>
  );
}
