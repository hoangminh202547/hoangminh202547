import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationBarProps {
  page: number;
  pageSize: 20 | 50 | 100;
  total: number;
  onPageChange: (nextPage: number) => void;
  onPageSizeChange: (nextSize: 20 | 50 | 100) => void;
}

export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: PaginationBarProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-t border-slate-200 bg-slate-50/70 text-xs text-slate-600">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="tabular-nums">
          Hiển thị <strong className="text-slate-900">{startRow}–{endRow}</strong> /{' '}
          <strong className="text-slate-900">{total}</strong> bản ghi
        </span>
        <label className="inline-flex items-center gap-1.5">
          <span>Số dòng:</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value) as 20 | 50 | 100)}
            className="min-h-[34px] px-2 py-1 rounded-md border border-slate-300 bg-white text-slate-800 font-medium"
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="min-h-[36px] min-w-[36px] px-2.5 inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-45"
          aria-label="Trang trước"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-2.5 font-medium text-slate-800 tabular-nums">
          Trang {page} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="min-h-[36px] min-w-[36px] px-2.5 inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-45"
          aria-label="Trang sau"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
