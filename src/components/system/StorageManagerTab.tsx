import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CheckSquare,
  Eye,
  FileSearch,
  HardDrive,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { formatBytes } from '../../lib/media';
import { formatViDate } from '../../lib/scheduleMeta';
import {
  STORAGE_BUCKET,
  createSignedMediaUrl,
  deleteStorageFiles,
  getReferencedStoragePaths,
  listAllStorageObjectsRecursive,
} from '../../lib/supabaseOps';
import type { AuthenticatedUser, StorageFileEntry } from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { PaginationBar } from '../PaginationBar';

interface StorageManagerTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  canManageAll: boolean;
  defaultPageSize: 20 | 50 | 100;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onLogActivity: (action: 'delete', targetId: string, summary: string) => void;
}

export function StorageManagerTab({
  client,
  user,
  canManageAll,
  defaultPageSize,
  onNotify,
  onLogActivity,
}: StorageManagerTabProps) {
  const [files, setFiles] = useState<StorageFileEntry[]>([]);
  const [referencedPaths, setReferencedPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | StorageFileEntry['category']>('ALL');
  const [onlyOrphans, setOnlyOrphans] = useState(false);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(defaultPageSize);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const loadStorage = useCallback(async () => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [listRes, refs] = await Promise.all([
      listAllStorageObjectsRecursive(client, STORAGE_BUCKET),
      getReferencedStoragePaths(client),
    ]);
    if (listRes.error) {
      onNotify('error', `Lỗi đọc Storage: ${listRes.error}`);
    } else {
      setFiles(listRes.files);
    }
    setReferencedPaths(refs);
    setLoading(false);
  }, [client, onNotify]);

  useEffect(() => {
    void loadStorage();
  }, [loadStorage]);

  const stats = useMemo(() => {
    let totalBytes = 0;
    let imgCount = 0;
    let pdfCount = 0;
    let excelCount = 0;
    let otherCount = 0;
    let orphanCount = 0;
    let orphanBytes = 0;

    for (const f of files) {
      totalBytes += f.sizeBytes;
      if (f.category === 'image') imgCount += 1;
      else if (f.category === 'pdf') pdfCount += 1;
      else if (f.category === 'excel') excelCount += 1;
      else otherCount += 1;

      if (!referencedPaths.has(f.path)) {
        orphanCount += 1;
        orphanBytes += f.sizeBytes;
      }
    }
    return {
      totalCount: files.length,
      totalBytes,
      imgCount,
      pdfCount,
      excelCount,
      otherCount,
      orphanCount,
      orphanBytes,
    };
  }, [files, referencedPaths]);

  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return files.filter((f) => {
      if (typeFilter !== 'ALL' && f.category !== typeFilter) return false;
      if (onlyOrphans && referencedPaths.has(f.path)) return false;
      if (q && !f.path.toLowerCase().includes(q) && !f.name.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [files, typeFilter, onlyOrphans, referencedPaths, search]);

  const pagedFiles = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredFiles.slice(start, start + pageSize);
  }, [filteredFiles, page, pageSize]);

  const selectedBytes = useMemo(() => {
    let sum = 0;
    for (const f of files) {
      if (selectedPaths.has(f.path)) sum += f.sizeBytes;
    }
    return sum;
  }, [files, selectedPaths]);

  const handleOpenPreview = async (f: StorageFileEntry) => {
    if (!client) return;
    const url = await createSignedMediaUrl(client, f.path);
    if (!url) {
      onNotify('error', 'Không thể tạo liên kết xem trước.');
      return;
    }
    setPreviewUrl(url);
  };

  const handleConfirmDelete = async () => {
    if (!client) return;
    const paths = Array.from(selectedPaths);
    const blockedRef = paths.filter((p) => referencedPaths.has(p));
    if (blockedRef.length > 0) {
      onNotify(
        'error',
        `Không thể xóa ${blockedRef.length} tệp đang được liên kết trong Hồ sơ nhân sự hoặc Ý kiến khách hàng.`
      );
      setConfirmDelete(false);
      return;
    }

    const forbidden = files.filter(
      (f) => selectedPaths.has(f.path) && !canManageAll && f.ownerFolder !== user.uid
    );
    if (forbidden.length > 0) {
      onNotify('error', 'Bạn không có quyền xóa tệp của nhân sự khác.');
      setConfirmDelete(false);
      return;
    }

    const res = await deleteStorageFiles(client, STORAGE_BUCKET, paths);
    if (res.error) {
      onNotify('error', res.error);
    } else {
      onNotify(
        'success',
        `Đã xóa ${paths.length} tệp rác, giải phóng ${formatBytes(selectedBytes)}.`
      );
      onLogActivity(
        'delete',
        STORAGE_BUCKET,
        `Xóa ${paths.length} tệp Storage (${formatBytes(selectedBytes)})`
      );
      setSelectedPaths(new Set());
      void loadStorage();
    }
    setConfirmDelete(false);
  };

  return (
    <div className="space-y-6">
      {/* KPI Dashboard */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Tổng tệp ({STORAGE_BUCKET})</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{stats.totalCount}</p>
          <p className="text-xs text-slate-500 mt-0.5 tabular-nums">{formatBytes(stats.totalBytes)}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Phân loại tệp</p>
          <p className="mt-1 text-sm font-bold text-slate-900 tabular-nums">
            Ảnh: {stats.imgCount} · PDF: {stats.pdfCount}
          </p>
          <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
            Excel: {stats.excelCount} · Khác: {stats.otherCount}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Tệp rác (không còn tham chiếu DB)</p>
          <p className="mt-1 text-2xl font-bold text-amber-700 tabular-nums">{stats.orphanCount}</p>
          <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
            Có thể thu hồi {formatBytes(stats.orphanBytes)}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Quét tệp rác</span>
            <HardDrive className="h-4 w-4 text-blue-600" />
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setOnlyOrphans((v) => !v);
                setPage(1);
              }}
              className={`flex-1 min-h-[36px] px-3 py-1 rounded-lg border text-xs font-medium inline-flex items-center justify-center gap-1 ${
                onlyOrphans
                  ? 'bg-amber-600 text-white border-amber-600'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <FileSearch className="h-3.5 w-3.5" />
              <span>{onlyOrphans ? 'Đang lọc file rác' : 'Lọc file rác'}</span>
            </button>
            <button
              type="button"
              onClick={() => void loadStorage()}
              className="min-h-[36px] px-2.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              title="Làm mới"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Tìm tên tệp hoặc đường dẫn..."
                className="min-h-[38px] pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg w-60"
              />
            </div>

            <select
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value as typeof typeFilter);
                setPage(1);
              }}
              className="min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">Mọi định dạng</option>
              <option value="image">Ảnh</option>
              <option value="pdf">PDF</option>
              <option value="excel">Excel</option>
              <option value="other">Khác</option>
            </select>
          </div>

          {selectedPaths.size > 0 && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="min-h-[38px] px-4 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700 inline-flex items-center gap-1.5 tabular-nums"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>
                Xóa {selectedPaths.size} tệp ({formatBytes(selectedBytes)})
              </span>
            </button>
          )}
        </div>

        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                <th className="py-3 px-3 w-8">
                  <CheckSquare className="h-4 w-4 text-slate-400" />
                </th>
                <th className="py-3 px-3">Đường dẫn tệp</th>
                <th className="py-3 px-3">Loại</th>
                <th className="py-3 px-3 text-right">Dung lượng</th>
                <th className="py-3 px-3">Tham chiếu DB</th>
                <th className="py-3 px-3">Ngày tải</th>
                <th className="py-3 px-3 text-right">Xem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    Đang đọc metadata bucket {STORAGE_BUCKET}...
                  </td>
                </tr>
              ) : pagedFiles.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    Không có tệp nào khớp điều kiện lọc.
                  </td>
                </tr>
              ) : (
                pagedFiles.map((f) => {
                  const isReferenced = referencedPaths.has(f.path);
                  const canDeleteThis = canManageAll || f.ownerFolder === user.uid;
                  return (
                    <tr key={f.path} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-3">
                        <input
                          type="checkbox"
                          disabled={isReferenced || !canDeleteThis}
                          checked={selectedPaths.has(f.path)}
                          onChange={(e) => {
                            setSelectedPaths((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(f.path);
                              else next.delete(f.path);
                              return next;
                            });
                          }}
                          className="h-4 w-4 rounded border-slate-300 disabled:opacity-35"
                        />
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs text-slate-800 max-w-xs truncate">
                        {f.path}
                      </td>
                      <td className="py-2.5 px-3 text-xs uppercase text-slate-600">{f.category}</td>
                      <td className="py-2.5 px-3 font-mono text-xs text-right tabular-nums text-slate-800">
                        {formatBytes(f.sizeBytes)}
                      </td>
                      <td className="py-2.5 px-3 text-xs">
                        {isReferenced ? (
                          <span className="text-emerald-700 font-medium">Đang dùng (bảo vệ)</span>
                        ) : (
                          <span className="text-amber-700 font-medium">Không còn tham chiếu</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                        {formatViDate(f.createdAt)}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        {f.category === 'image' && (
                          <button
                            type="button"
                            onClick={() => void handleOpenPreview(f)}
                            className="p-1.5 rounded text-slate-500 hover:text-blue-600 hover:bg-blue-50"
                            title="Xem ảnh (tải theo yêu cầu)"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="md:hidden divide-y divide-slate-200">
          {loading ? (
            <div className="p-6 text-center text-sm text-slate-500">
              Đang đọc metadata bucket {STORAGE_BUCKET}...
            </div>
          ) : pagedFiles.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Không có tệp nào khớp điều kiện lọc.
            </div>
          ) : (
            pagedFiles.map((f) => {
              const isReferenced = referencedPaths.has(f.path);
              const canDeleteThis = canManageAll || f.ownerFolder === user.uid;
              return (
                <div key={f.path} className="p-4 space-y-2 text-[15px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <input
                        type="checkbox"
                        disabled={isReferenced || !canDeleteThis}
                        checked={selectedPaths.has(f.path)}
                        onChange={(e) => {
                          setSelectedPaths((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(f.path);
                            else next.delete(f.path);
                            return next;
                          });
                        }}
                        className="mt-1 h-4 w-4 rounded border-slate-300 disabled:opacity-35 shrink-0"
                      />
                      <span className="font-mono text-xs text-slate-900 break-all">{f.path}</span>
                    </div>
                    {f.category === 'image' && (
                      <button
                        type="button"
                        onClick={() => void handleOpenPreview(f)}
                        className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:text-blue-600 shrink-0"
                        title="Xem ảnh"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="rounded-lg bg-slate-50 p-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="uppercase font-semibold text-slate-700">
                      {f.category} · {formatBytes(f.sizeBytes)} · {formatViDate(f.createdAt)}
                    </span>
                    <span className={isReferenced ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                      {isReferenced ? 'Đang dùng (bảo vệ)' : 'Không còn tham chiếu'}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={filteredFiles.length}
          onPageChange={setPage}
          onPageSizeChange={(sz) => {
            setPageSize(sz);
            setPage(1);
          }}
        />
      </div>

      {previewUrl && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
          onClick={() => setPreviewUrl(null)}
        >
          <div className="relative max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setPreviewUrl(null)}
              className="absolute -top-3 -right-3 h-9 w-9 rounded-full bg-white text-slate-900 shadow flex items-center justify-center"
            >
              <X className="h-5 w-5" />
            </button>
            <img src={previewUrl} alt="Xem trước tệp" className="max-h-[80vh] rounded-xl bg-white" />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Xóa tệp khỏi Supabase Storage"
        description={`Xác nhận xóa vĩnh viễn ${selectedPaths.size} tệp không còn tham chiếu (${formatBytes(
          selectedBytes
        )})?`}
        confirmLabel="Xóa vĩnh viễn"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
