import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileSpreadsheet,
  MessageSquarePlus,
  Trash2,
  X,
} from 'lucide-react';
import { exportCustomerFeedbackToExcel } from '../../lib/excel';
import { compressImageToWebP } from '../../lib/media';
import { formatViDate, formatViDateTime, formatYmd, getWeekBoundsYmd, parseYmd } from '../../lib/scheduleMeta';
import {
  createCustomerFeedback,
  deleteCustomerFeedback,
  fetchAllFeedbackForExport,
  fetchFeedbackPage,
  uploadMediaPairToStorage,
  useScopedRealtime,
} from '../../lib/supabaseOps';
import type { AuthenticatedUser, CustomerFeedback } from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import { PaginationBar } from '../PaginationBar';
import { SignedMediaThumb } from '../SignedMediaThumb';

interface CustomerFeedbackTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  canDeleteAny: boolean;
  canExport?: boolean;
  defaultPageSize: 20 | 50 | 100;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  onLogActivity: (
    action: 'create' | 'delete' | 'export',
    targetId: string,
    summary: string
  ) => void;
}

export function CustomerFeedbackTab({
  client,
  user,
  canDeleteAny,
  canExport = true,
  defaultPageSize,
  onNotify,
  onLogActivity,
}: CustomerFeedbackTabProps) {
  const todayStr = formatYmd(new Date());
  const [rows, setRows] = useState<CustomerFeedback[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(defaultPageSize);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Filters
  const [dateScope, setDateScope] = useState<'day' | 'week' | 'month' | 'all'>('day');
  const [dateValue, setDateValue] = useState(todayStr);
  const [selectedStaffEmail, setSelectedStaffEmail] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | 'product' | 'service'>('ALL');

  // Form (collapsible when user wants compact "Gửi thêm")
  const [formOpen, setFormOpen] = useState(true);
  const [category, setCategory] = useState<'product' | 'service'>('product');
  const [productName, setProductName] = useState('');
  const [content, setContent] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Lightbox & delete confirm
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomerFeedback | null>(null);

  const weekBounds = useMemo(
    () => getWeekBoundsYmd(dateValue || todayStr),
    [dateValue, todayStr]
  );

  const datePrefix = useMemo(() => {
    if (dateScope === 'all' || dateScope === 'week') return '';
    if (dateScope === 'day') return dateValue.slice(0, 10);
    return dateValue.slice(0, 7);
  }, [dateScope, dateValue]);

  const loadRows = useCallback(async () => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await fetchFeedbackPage(client, {
      page,
      pageSize,
      datePrefix,
      dateFrom: dateScope === 'week' ? weekBounds.mon : undefined,
      dateTo: dateScope === 'week' ? weekBounds.sun : undefined,
      ownerFilter: selectedStaffEmail || undefined,
      categoryFilter,
    });
    if (res.error) {
      onNotify('error', res.error);
    } else {
      setRows(res.rows);
      setTotal(res.total);
    }
    setLoading(false);
  }, [
    client,
    page,
    pageSize,
    dateScope,
    datePrefix,
    weekBounds.mon,
    weekBounds.sun,
    selectedStaffEmail,
    categoryFilter,
    onNotify,
  ]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  useScopedRealtime(client, Boolean(client), ['customer_feedbacks'], () => {
    void loadRows();
  });

  const shiftFilterWeek = (deltaDays: number) => {
    const base = parseYmd(dateValue || todayStr);
    base.setDate(base.getDate() + deltaDays);
    setDateValue(formatYmd(base));
    setPage(1);
  };

  const myTodayCount = useMemo(() => {
    return rows.filter(
      (r) =>
        r.feedbackDate === todayStr &&
        r.ownerEmail.toLowerCase() === user.email.toLowerCase()
    ).length;
  }, [rows, todayStr, user.email]);

  // Group summary by employee on current loaded result
  const staffSummary = useMemo(() => {
    const map = new Map<string, { email: string; name: string; count: number }>();
    for (const r of rows) {
      const key = r.ownerEmail.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, {
          email: key,
          name: r.employeeName || key,
          count: 1,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [rows]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) {
      onNotify('error', 'Cần kết nối Supabase Auth để gửi ý kiến khách hàng.');
      return;
    }
    if (!content.trim()) {
      onNotify('error', 'Vui lòng nhập nội dung ý kiến khách hàng.');
      return;
    }

    setSubmitting(true);
    try {
      let imagePath = '';
      let imageThumbPath = '';
      if (category === 'product' && photoFile) {
        const compressed = await compressImageToWebP(photoFile, {
          maxDim: 1280,
          thumbDim: 240,
          quality: 0.78,
        });
        const uploaded = await uploadMediaPairToStorage(
          client,
          user.uid,
          'feedback',
          compressed.mainBlob,
          compressed.thumbBlob
        );
        if (uploaded.error) {
          onNotify('error', `Lỗi tải ảnh lên Storage: ${uploaded.error}`);
          setSubmitting(false);
          return;
        }
        imagePath = uploaded.path;
        imageThumbPath = uploaded.thumbPath;
      }

      const res = await createCustomerFeedback(client, {
        ownerId: user.uid,
        ownerEmail: user.email,
        employeeName: user.displayName,
        category,
        productName: category === 'product' ? productName : '',
        content: content.trim(),
        imagePath,
        imageThumbPath,
      });

      if (res.error) {
        onNotify('error', res.error);
      } else {
        setContent('');
        setProductName('');
        setPhotoFile(null);
        setFormOpen(false);
        onNotify('success', 'Đã ghi nhận ý kiến khách hàng (theo giờ máy chủ).');
        if (res.data) {
          onLogActivity('create', res.data.id, `Ghi nhận ý kiến khách hàng (${category})`);
        }
        void loadRows();
      }
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Không thể xử lý ảnh hoặc gửi ý kiến.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!client || !deleteTarget) return;
    const res = await deleteCustomerFeedback(client, deleteTarget.id);
    if (res.error) {
      onNotify('error', res.error);
    } else {
      onNotify('success', 'Đã xóa ý kiến khách hàng.');
      onLogActivity('delete', deleteTarget.id, `Xóa ý kiến khách hàng của ${deleteTarget.employeeName}`);
      void loadRows();
    }
    setDeleteTarget(null);
  };

  const handleExportExcel = async () => {
    if (!canExport || !client) return;
    setExporting(true);
    try {
      const res = await fetchAllFeedbackForExport(client, {
        datePrefix,
        dateFrom: dateScope === 'week' ? weekBounds.mon : undefined,
        dateTo: dateScope === 'week' ? weekBounds.sun : undefined,
        ownerFilter: selectedStaffEmail || undefined,
        categoryFilter,
      });
      if (res.error) {
        onNotify('error', res.error);
        return;
      }
      if (res.rows.length === 0) {
        onNotify('info', 'Không có dữ liệu phù hợp bộ lọc để xuất Excel.');
        return;
      }
      const fileName = await exportCustomerFeedbackToExcel(res.rows);
      onNotify('success', `Đã xuất tệp ${fileName} (${res.rows.length} dòng).`);
      onLogActivity('export', fileName, `Xuất Excel ý kiến khách hàng (${res.rows.length} dòng)`);
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Không thể xuất file Excel ý kiến khách hàng.'
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Daily Target Banner & Quick Collapse */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-slate-500">Chỉ tiêu tối thiểu mỗi ngày</p>
          <p className="mt-1 text-lg font-bold text-slate-900 tabular-nums">
            Hôm nay bạn đã gửi:{' '}
            <span className={myTodayCount >= 2 ? 'text-emerald-600' : 'text-amber-600'}>
              {myTodayCount} / 2 ý kiến
            </span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => setFormOpen((v) => !v)}
          className="min-h-[42px] px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span>{formOpen ? 'Thu gọn biểu mẫu' : 'Gửi thêm ý kiến'}</span>
          {formOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {/* Collapsible Submit Form */}
      {formOpen && (
        <form
          onSubmit={handleSubmit}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Nhóm góp ý</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setCategory('product')}
                  className={`min-h-[40px] px-3 py-2 text-sm font-medium rounded-lg border ${
                    category === 'product'
                      ? 'bg-blue-50 border-blue-600 text-blue-700'
                      : 'border-slate-300 text-slate-700'
                  }`}
                >
                  Sản phẩm (có ảnh)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCategory('service');
                    setPhotoFile(null);
                  }}
                  className={`min-h-[40px] px-3 py-2 text-sm font-medium rounded-lg border ${
                    category === 'service'
                      ? 'bg-blue-50 border-blue-600 text-blue-700'
                      : 'border-slate-300 text-slate-700'
                  }`}
                >
                  Dịch vụ
                </button>
              </div>
            </div>

            {category === 'product' && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Tên sản phẩm / Mã hàng liên quan
                </label>
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="VD: Vitamin C 500mg..."
                  className="w-full min-h-[40px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Nội dung ý kiến khách hàng *
            </label>
            <textarea
              required
              rows={3}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Ghi nhận phản hồi thực tế của khách hàng..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          {category === 'product' && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-slate-50 text-xs font-medium text-slate-700 hover:bg-slate-100 inline-flex items-center gap-2 cursor-pointer">
                <Camera className="h-4 w-4 text-blue-600" />
                <span>{photoFile ? photoFile.name : 'Đính kèm ảnh sản phẩm (tự nén WebP)'}</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setPhotoFile(e.target.files?.[0] || null)}
                  className="hidden"
                />
              </label>
              {photoFile && (
                <button
                  type="button"
                  onClick={() => setPhotoFile(null)}
                  className="text-xs text-red-600 hover:underline"
                >
                  Gỡ ảnh
                </button>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting || !client}
              className="min-h-[42px] px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Đang gửi...' : 'Gửi ý kiến khách hàng'}
            </button>
          </div>
        </form>
      )}

      {/* Summary by Staff */}
      {staffSummary.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Tổng hợp theo nhân sự (nhấp tên để lọc)
            </h3>
            {selectedStaffEmail && (
              <button
                type="button"
                onClick={() => {
                  setSelectedStaffEmail('');
                  setPage(1);
                }}
                className="text-xs font-medium text-blue-600 hover:underline"
              >
                Xem tất cả nhân sự
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {staffSummary.map((st) => {
              const active = selectedStaffEmail === st.email;
              return (
                <button
                  key={st.email}
                  type="button"
                  onClick={() => {
                    setSelectedStaffEmail(active ? '' : st.email);
                    setPage(1);
                  }}
                  className={`min-h-[38px] px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors tabular-nums ${
                    active
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-slate-50 text-slate-800 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {st.name} · <strong>{st.count}</strong>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* List & Filters */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={dateScope}
              onChange={(e) => {
                setDateScope(e.target.value as typeof dateScope);
                setPage(1);
              }}
              className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="day">Theo ngày</option>
              <option value="week">Theo tuần</option>
              <option value="month">Theo tháng</option>
              <option value="all">Tất cả thời gian</option>
            </select>

            {dateScope === 'week' && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => shiftFilterWeek(-7)}
                  className="min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                  title="Tuần trước"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <input
                  type="date"
                  value={dateValue.slice(0, 10)}
                  onChange={(e) => {
                    if (e.target.value) {
                      setDateValue(e.target.value);
                      setPage(1);
                    }
                  }}
                  className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg font-mono"
                />
                <button
                  type="button"
                  onClick={() => shiftFilterWeek(7)}
                  className="min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                  title="Tuần sau"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <span className="px-2.5 py-1.5 rounded-lg bg-slate-100 text-xs font-semibold font-mono text-slate-800 tabular-nums">
                  {formatViDate(weekBounds.mon)} – {formatViDate(weekBounds.sun)}
                </span>
              </div>
            )}

            {(dateScope === 'day' || dateScope === 'month') && (
              <input
                type={dateScope === 'day' ? 'date' : 'month'}
                value={dateScope === 'day' ? dateValue.slice(0, 10) : dateValue.slice(0, 7)}
                onChange={(e) => {
                  setDateValue(e.target.value);
                  setPage(1);
                }}
                className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg font-mono"
              />
            )}

            <select
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value as typeof categoryFilter);
                setPage(1);
              }}
              className="min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">Tất cả nhóm</option>
              <option value="product">Sản phẩm</option>
              <option value="service">Dịch vụ</option>
            </select>
          </div>

          {canExport && (
            <button
              type="button"
              onClick={() => void handleExportExcel()}
              disabled={exporting || total === 0 || !client}
              className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
              <span>{exporting ? 'Đang xuất...' : 'Xuất Excel'}</span>
            </button>
          )}
        </div>

        <div className="divide-y divide-slate-100">
          {loading ? (
            <div className="p-6 text-sm text-slate-500">Đang tải danh sách ý kiến...</div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              Chưa có ý kiến khách hàng nào trong khoảng thời gian đã chọn.
            </div>
          ) : (
            rows.map((item, idx) => {
              const canDelete =
                canDeleteAny || item.ownerEmail.toLowerCase() === user.email.toLowerCase();
              return (
                <div key={item.id} className="p-4 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <span className="text-xs font-mono text-slate-400 pt-1 tabular-nums">
                      #{(page - 1) * pageSize + idx + 1}
                    </span>
                    {item.imageThumbPath && (
                      <SignedMediaThumb
                        client={client}
                        thumbPath={item.imageThumbPath}
                        fullPath={item.imagePath}
                        alt={item.productName || 'Ảnh sản phẩm'}
                        onOpenFull={(url) => setLightboxUrl(url)}
                      />
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-bold text-slate-900">{item.employeeName}</span>
                        <span className="text-slate-400">·</span>
                        <span className="font-mono text-slate-500 tabular-nums">
                          {formatViDateTime(item.createdAt, false)}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded font-medium ${
                            item.category === 'product'
                              ? 'bg-blue-50 text-blue-700'
                              : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          {item.category === 'product' ? 'Sản phẩm' : 'Dịch vụ'}
                        </span>
                        {item.productName && (
                          <span className="font-medium text-slate-700">· {item.productName}</span>
                        )}
                      </div>
                      <p className="mt-1.5 text-sm text-slate-800 whitespace-pre-wrap">{item.content}</p>
                    </div>
                  </div>

                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(item)}
                      className="min-h-[36px] min-w-[36px] p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 shrink-0"
                      title="Xóa ý kiến"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
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

      {/* Lightbox Modal */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
          onClick={() => setLightboxUrl(null)}
        >
          <div className="relative max-w-3xl max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setLightboxUrl(null)}
              className="absolute -top-3 -right-3 h-9 w-9 rounded-full bg-white text-slate-900 shadow flex items-center justify-center"
              aria-label="Đóng ảnh"
            >
              <X className="h-5 w-5" />
            </button>
            <img
              src={lightboxUrl}
              alt="Ảnh chi tiết"
              className="max-h-[82vh] max-w-full rounded-xl object-contain bg-white"
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Xóa ý kiến khách hàng"
        description="Bạn có chắc chắn muốn xóa phản hồi khách hàng này?"
        confirmLabel="Xóa"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
