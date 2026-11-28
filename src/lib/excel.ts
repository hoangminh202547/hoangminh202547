import { readSheet } from 'read-excel-file/browser';
import writeXlsxFile, { type Row } from 'write-excel-file/browser';
import { extractNoticeMonthsFromPolicy } from './permissions';
import type {
  AttendanceNoteEntry,
  AttendanceRecord,
  BarcodeScan,
  CustomerFeedback,
  ExpiryTrackingItem,
  ProductCatalogItem,
  PromotionItem,
  ReturnRecordItem,
  ScheduleStatus,
  ShiftType,
  SupplierPolicyItem,
  WorkSchedule,
} from '../types';

import { formatViDate } from './scheduleMeta';

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
}

const HEADER_STYLE = {
  fontWeight: 'bold' as const,
  backgroundColor: '#F1F5F9',
  color: '#0F172A',
};

/**
 * Strips ONLY trailing "(B)" suffix from product name and sets hasBBadge flag.
 * Keeps productCode completely untouched.
 */
export function parseTrailingBadgeB(rawName: string): {
  cleanName: string;
  hasBBadge: boolean;
} {
  const trimmed = String(rawName || '').trim();
  const match = /\s*\(B\)\s*$/i.exec(trimmed);
  if (!match) {
    return { cleanName: trimmed, hasBBadge: false };
  }
  return {
    cleanName: trimmed.slice(0, match.index).trim(),
    hasBBadge: true,
  };
}

export function normalizeCellString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

export function normalizeExcelDate(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return s;
}

export function normalizeCellNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const cleaned = String(v ?? '')
    .replace(/[^\d.,-]/g, '')
    .replace(/,/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : fallback;
}

export async function readExcelSheetRows(file: File): Promise<unknown[][]> {
  const rows = await readSheet(file);
  return rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : cell)));
}

// ============================================================================
// Barcode & Schedule Exports (Preserved)
// ============================================================================
export async function exportBarcodesToExcel(
  scans: BarcodeScan[],
  sessionLabel = 'TatCa'
): Promise<string> {
  const detailHeader: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Mã vạch', ...HEADER_STYLE },
    { value: 'Định dạng', ...HEADER_STYLE },
    { value: 'Phiên quét', ...HEADER_STYLE },
    { value: 'Số lượng', ...HEADER_STYLE },
    { value: 'Ghi chú', ...HEADER_STYLE },
    { value: 'Thời gian quét', ...HEADER_STYLE },
    { value: 'Người quét (Gmail)', ...HEADER_STYLE },
    { value: 'Phiên bản', ...HEADER_STYLE },
    { value: 'Đồng bộ Supabase', ...HEADER_STYLE },
  ];

  const detailRows: Row[] = scans.map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: item.code },
    { type: String, value: item.format },
    { type: String, value: item.sessionName },
    { type: Number, value: item.quantity },
    { type: String, value: item.note || '' },
    { type: String, value: formatDateTime(item.scannedAt) },
    { type: String, value: item.ownerEmail },
    { type: Number, value: item.version || 1 },
    {
      type: String,
      value: item.syncedToSupabase ? 'Đã đồng bộ' : 'Chưa đồng bộ',
    },
  ]);

  const summaryMap = new Map<
    string,
    { code: string; format: string; sessionName: string; totalQty: number; entries: number }
  >();
  for (const s of scans) {
    const key = `${s.code}__${s.sessionName}`;
    const existing = summaryMap.get(key);
    if (existing) {
      existing.totalQty += s.quantity;
      existing.entries += 1;
    } else {
      summaryMap.set(key, {
        code: s.code,
        format: s.format,
        sessionName: s.sessionName,
        totalQty: s.quantity,
        entries: 1,
      });
    }
  }

  const summaryHeader: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Mã vạch', ...HEADER_STYLE },
    { value: 'Định dạng', ...HEADER_STYLE },
    { value: 'Phiên quét', ...HEADER_STYLE },
    { value: 'Tổng số lượng', ...HEADER_STYLE },
    { value: 'Số lần quét', ...HEADER_STYLE },
  ];

  const summaryRows: Row[] = Array.from(summaryMap.values()).map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: item.code },
    { type: String, value: item.format },
    { type: String, value: item.sessionName },
    { type: Number, value: item.totalQty },
    { type: Number, value: item.entries },
  ]);

  const dateStamp = new Date().toISOString().slice(0, 10);
  const safeSession =
    sessionLabel.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) || 'PhienQuet';
  const fileName = `MaVach_${safeSession}_${dateStamp}.xlsx`;

  await writeXlsxFile(
    [
      {
        sheet: 'Chi tiết quét',
        data: [detailHeader, ...detailRows],
        columns: [
          { width: 6 },
          { width: 24 },
          { width: 14 },
          { width: 22 },
          { width: 12 },
          { width: 28 },
          { width: 22 },
          { width: 28 },
          { width: 10 },
          { width: 18 },
        ],
      },
      {
        sheet: 'Tổng hợp mã vạch',
        data: [summaryHeader, ...summaryRows],
        columns: [
          { width: 6 },
          { width: 24 },
          { width: 14 },
          { width: 22 },
          { width: 16 },
          { width: 14 },
        ],
      },
    ],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);

  return fileName;
}

const SHIFT_LABELS: Record<ShiftType, string> = {
  morning: 'Ca sáng',
  afternoon: 'Ca chiều',
  evening: 'Ca tối',
  full_day: 'Cả ngày',
  custom: 'Tùy chỉnh',
};

const STATUS_LABELS: Record<ScheduleStatus, string> = {
  registered: 'Đã đăng ký',
  confirmed: 'Đã xác nhận',
  completed: 'Hoàn thành',
  cancelled: 'Đã hủy',
};

export async function exportSchedulesToExcel(
  schedules: WorkSchedule[]
): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Ngày làm việc', ...HEADER_STYLE },
    { value: 'Tên công việc / Ca làm', ...HEADER_STYLE },
    { value: 'Nhân sự', ...HEADER_STYLE },
    { value: 'Loại ca', ...HEADER_STYLE },
    { value: 'Giờ bắt đầu', ...HEADER_STYLE },
    { value: 'Giờ kết thúc', ...HEADER_STYLE },
    { value: 'Địa điểm', ...HEADER_STYLE },
    { value: 'Trạng thái', ...HEADER_STYLE },
    { value: 'Người phê duyệt', ...HEADER_STYLE },
    { value: 'Ghi chú', ...HEADER_STYLE },
    { value: 'Email đăng ký', ...HEADER_STYLE },
    { value: 'Đồng bộ Supabase', ...HEADER_STYLE },
  ];

  const rows: Row[] = schedules.map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: formatViDate(item.workDate) },
    { type: String, value: item.title },
    { type: String, value: item.employeeName },
    { type: String, value: item.isDayOff ? 'Nghỉ DO' : SHIFT_LABELS[item.shiftType] || item.shiftType },
    { type: String, value: item.startTime },
    { type: String, value: item.endTime },
    { type: String, value: item.location || '' },
    { type: String, value: STATUS_LABELS[item.status] || item.status },
    { type: String, value: item.approvedBy || '' },
    { type: String, value: item.note || '' },
    { type: String, value: item.ownerEmail },
    {
      type: String,
      value: item.syncedToSupabase ? 'Đã đồng bộ' : 'Chưa đồng bộ',
    },
  ]);

  const dateStamp = new Date().toISOString().slice(0, 10);
  const fileName = `LichLamViec_${dateStamp}.xlsx`;

  await writeXlsxFile(
    [
      {
        sheet: 'Lịch làm việc',
        data: [header, ...rows],
        columns: [
          { width: 6 },
          { width: 14 },
          { width: 28 },
          { width: 22 },
          { width: 14 },
          { width: 12 },
          { width: 12 },
          { width: 22 },
          { width: 16 },
          { width: 24 },
          { width: 28 },
          { width: 28 },
          { width: 18 },
        ],
      },
    ],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);

  return fileName;
}

// ============================================================================
// Attendance Excel Export
// ============================================================================
const ATTENDANCE_STATUS_VI: Record<AttendanceRecord['status'], string> = {
  checked_in: 'Đã xác nhận ca',
  checked_out: 'Đã xác nhận ca',
  early_leave: 'Về sớm',
  overtime: 'Tăng ca',
  clear_time: 'Clear giờ',
};

const ATTENDANCE_NOTE_VI: Record<AttendanceNoteEntry['type'], string> = {
  overtime: 'Tăng ca',
  early_leave: 'Về sớm',
  clear_time: 'Clear giờ',
  incident: 'Phát sinh',
  note: 'Ghi chú',
};

export async function exportAttendanceToExcel(records: AttendanceRecord[]): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Ngày làm việc', ...HEADER_STYLE },
    { value: 'Nhân viên', ...HEADER_STYLE },
    { value: 'Email', ...HEADER_STYLE },
    { value: 'Ca làm', ...HEADER_STYLE },
    { value: 'Loại', ...HEADER_STYLE },
    { value: 'Thời gian xác nhận ca', ...HEADER_STYLE },
    { value: 'Giờ điều chỉnh / ra', ...HEADER_STYLE },
    { value: 'Trạng thái', ...HEADER_STYLE },
    { value: 'Lịch sử ghi chú', ...HEADER_STYLE },
  ];

  const rows: Row[] = records.map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: formatViDate(item.workDate) },
    { type: String, value: item.employeeName },
    { type: String, value: item.ownerEmail },
    { type: String, value: item.shiftName },
    { type: String, value: item.isUnscheduled ? 'Ngoài lịch' : 'Theo lịch' },
    { type: String, value: formatDateTime(item.checkInAt) },
    { type: String, value: formatDateTime(item.checkOutAt) },
    { type: String, value: ATTENDANCE_STATUS_VI[item.status] || item.status },
    {
      type: String,
      value: item.notesHistory
        .map((n) => `[${ATTENDANCE_NOTE_VI[n.type] || n.type}] ${n.content}`)
        .join(' | '),
    },
  ]);

  const fileName = `ChamCong_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await writeXlsxFile(
    [{ sheet: 'Chấm công', data: [header, ...rows], columns: Array(10).fill({ width: 20 }) }],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}

// ============================================================================
// Customer Feedback Excel Export
// ============================================================================
export async function exportCustomerFeedbackToExcel(
  items: CustomerFeedback[]
): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Ngày ghi nhận', ...HEADER_STYLE },
    { value: 'Thời gian gửi', ...HEADER_STYLE },
    { value: 'Nhân sự ghi nhận', ...HEADER_STYLE },
    { value: 'Email', ...HEADER_STYLE },
    { value: 'Nhóm góp ý', ...HEADER_STYLE },
    { value: 'Tên sản phẩm', ...HEADER_STYLE },
    { value: 'Nội dung ý kiến khách hàng', ...HEADER_STYLE },
    { value: 'Ảnh đính kèm', ...HEADER_STYLE },
  ];

  const rows: Row[] = items.map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: formatViDate(item.feedbackDate) },
    { type: String, value: formatDateTime(item.createdAt) },
    { type: String, value: item.employeeName },
    { type: String, value: item.ownerEmail },
    { type: String, value: item.category === 'product' ? 'Sản phẩm' : 'Dịch vụ' },
    { type: String, value: item.productName || '' },
    { type: String, value: item.content },
    { type: String, value: item.imagePath ? 'Có ảnh' : 'Không' },
  ]);

  const fileName = `YKienKhachHang_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await writeXlsxFile(
    [
      {
        sheet: 'Ý kiến khách hàng',
        data: [header, ...rows],
        columns: [
          { width: 6 },
          { width: 14 },
          { width: 20 },
          { width: 24 },
          { width: 26 },
          { width: 14 },
          { width: 26 },
          { width: 48 },
          { width: 14 },
        ],
      },
    ],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}

// ============================================================================
// Warehouse Catalog: Template + Export
// ============================================================================
export async function downloadCatalogTemplate(): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Mã hàng', ...HEADER_STYLE },
    { value: 'Mã vạch', ...HEADER_STYLE },
    { value: 'Tên hàng', ...HEADER_STYLE },
    { value: 'ĐVT', ...HEADER_STYLE },
    { value: 'Giá bán', ...HEADER_STYLE },
    { value: 'Nhà cung cấp', ...HEADER_STYLE },
  ];
  const sample: Row = [
    { type: Number, value: 1 },
    { type: String, value: 'SP001' },
    { type: String, value: '8935001234567' },
    { type: String, value: 'Viên uống Vitamin C 500mg' },
    { type: String, value: 'Hộp' },
    { type: Number, value: 145000 },
    { type: String, value: 'NCC Dược Phẩm A' },
  ];
  const fileName = 'Mau_DanhMucHang.xlsx';
  await writeXlsxFile(
    [{ sheet: 'Danh mục hàng', data: [header, sample], columns: [{ width: 6 }, { width: 16 }, { width: 20 }, { width: 32 }, { width: 12 }, { width: 14 }, { width: 24 }] }],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}

export async function exportCatalogToExcel(items: ProductCatalogItem[]): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Mã hàng', ...HEADER_STYLE },
    { value: 'Mã vạch', ...HEADER_STYLE },
    { value: 'Tên hàng', ...HEADER_STYLE },
    { value: 'ĐVT', ...HEADER_STYLE },
    { value: 'Giá bán', ...HEADER_STYLE },
    { value: 'Nhà cung cấp', ...HEADER_STYLE },
  ];
  const rows: Row[] = items.map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: item.productCode },
    { type: String, value: item.barcode },
    { type: String, value: item.name },
    { type: String, value: item.unit },
    { type: Number, value: item.price },
    { type: String, value: item.supplierName },
  ]);
  const fileName = `DanhMucHang_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await writeXlsxFile(
    [{ sheet: 'Danh mục hàng', data: [header, ...rows], columns: [{ width: 6 }, { width: 16 }, { width: 20 }, { width: 32 }, { width: 12 }, { width: 14 }, { width: 24 }] }],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}

// ============================================================================
// Supplier Return Policies: Template + Export
// ============================================================================
export async function downloadPolicyTemplate(): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Ngành hàng', ...HEADER_STYLE },
    { value: 'Tên NCC', ...HEADER_STYLE },
    { value: 'Tên NCC HT', ...HEADER_STYLE },
    { value: 'Tên hàng hóa', ...HEADER_STYLE },
    { value: 'Đổi trả SP', ...HEADER_STYLE },
  ];
  const sample: Row = [
    { type: Number, value: 1 },
    { type: String, value: 'TPCN' },
    { type: String, value: 'Công ty TNHH Dược A' },
    { type: String, value: 'NCC_DUOC_A' },
    { type: String, value: 'Tất cả' },
    { type: String, value: 'Đổi trả trước HSD 3 tháng' },
  ];
  const fileName = 'Mau_ChinhSachDoiTraNCC.xlsx';
  await writeXlsxFile(
    [{ sheet: 'Chính sách NCC', data: [header, sample], columns: [{ width: 6 }, { width: 16 }, { width: 24 }, { width: 20 }, { width: 24 }, { width: 32 }] }],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}

export async function exportPoliciesToExcel(items: SupplierPolicyItem[]): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Ngành hàng', ...HEADER_STYLE },
    { value: 'Tên NCC', ...HEADER_STYLE },
    { value: 'Tên NCC HT', ...HEADER_STYLE },
    { value: 'Tên hàng hóa', ...HEADER_STYLE },
    { value: 'Đổi trả SP', ...HEADER_STYLE },
  ];
  const rows: Row[] = items.map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: item.category },
    { type: String, value: item.supplierName },
    { type: String, value: item.supplierSystemName },
    { type: String, value: item.productName },
    { type: String, value: item.returnPolicy },
  ]);
  const fileName = `ChinhSachDoiTraNCC_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await writeXlsxFile(
    [{ sheet: 'Chính sách NCC', data: [header, ...rows], columns: Array(6).fill({ width: 22 }) }],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}

// ============================================================================
// Expiry Control: Template + Export
// ============================================================================
export async function downloadExpiryTemplate(): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Tên NCC HT', ...HEADER_STYLE },
    { value: 'Mã hàng', ...HEADER_STYLE },
    { value: 'Mã vạch', ...HEADER_STYLE },
    { value: 'Tên hàng', ...HEADER_STYLE },
    { value: 'ĐVT', ...HEADER_STYLE },
    { value: 'Ngày sản xuất', ...HEADER_STYLE },
    { value: 'Hạn sử dụng', ...HEADER_STYLE },
    { value: 'Đổi trả SP', ...HEADER_STYLE },
    { value: 'Ghi chú & cảnh báo', ...HEADER_STYLE },
    { value: 'PT', ...HEADER_STYLE },
  ];
  const sample: Row = [
    { type: Number, value: 1 },
    { type: String, value: 'NCC_DUOC_A' },
    { type: String, value: 'SP001' },
    { type: String, value: '8935001234567' },
    { type: String, value: 'Viên uống Vitamin C 500mg' },
    { type: String, value: 'Hộp' },
    { type: String, value: '15/01/2025' },
    { type: String, value: '15/01/2027' },
    { type: String, value: 'Đổi trả trước HSD 3 tháng' },
    { type: String, value: 'Quầy kệ 1' },
    { type: String, value: 'PT01' },
  ];
  const fileName = 'Mau_KiemSoatHSD.xlsx';
  await writeXlsxFile(
    [{ sheet: 'Kiểm soát HSD', data: [header, sample], columns: Array(11).fill({ width: 18 }) }],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}

export async function exportExpiryToExcel(items: ExpiryTrackingItem[]): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Tên NCC HT', ...HEADER_STYLE },
    { value: 'Mã hàng', ...HEADER_STYLE },
    { value: 'Mã vạch', ...HEADER_STYLE },
    { value: 'Tên hàng', ...HEADER_STYLE },
    { value: 'ĐVT', ...HEADER_STYLE },
    { value: 'Ngày sản xuất', ...HEADER_STYLE },
    { value: 'Hạn sử dụng', ...HEADER_STYLE },
    { value: 'Đổi trả SP', ...HEADER_STYLE },
    { value: 'Cảnh báo đổi trả NCC', ...HEADER_STYLE },
    { value: 'Ghi chú', ...HEADER_STYLE },
    { value: 'PT', ...HEADER_STYLE },
  ];
  const todayMs = new Date().setHours(0, 0, 0, 0);
  const rows: Row[] = items.map((item, idx) => {
    const months = extractNoticeMonthsFromPolicy(item.returnPolicy, item.warnMonthsBefore);
    let noticeStatus = '—';
    if (item.expDate && months > 0) {
      const expMs = new Date(`${item.expDate}T00:00:00`).getTime();
      if (Number.isFinite(expMs)) {
        const deadlineMs = expMs - months * 30 * 86_400_000;
        const daysToNotify = Math.ceil((deadlineMs - todayMs) / 86_400_000);
        const deadlineDt = new Date(deadlineMs);
        const deadlineStr = `${String(deadlineDt.getDate()).padStart(2, '0')}/${String(
          deadlineDt.getMonth() + 1
        ).padStart(2, '0')}/${deadlineDt.getFullYear()}`;
        noticeStatus =
          daysToNotify < 0
            ? `Quá hạn báo NCC ${Math.abs(daysToNotify)} ngày (Hạn ${deadlineStr})`
            : daysToNotify === 0
              ? `Hôm nay là hạn báo NCC (${deadlineStr})`
              : `Còn ${daysToNotify} ngày báo NCC (Hạn ${deadlineStr})`;
      }
    }
    return [
      { type: Number, value: idx + 1 },
      { type: String, value: item.supplierSystemName },
      { type: String, value: item.productCode },
      { type: String, value: item.barcode },
      { type: String, value: item.productName },
      { type: String, value: item.unit },
      { type: String, value: item.mfgDate ? formatViDate(item.mfgDate) : '' },
      { type: String, value: item.expDate ? formatViDate(item.expDate) : '' },
      { type: String, value: item.returnPolicy },
      { type: String, value: noticeStatus },
      { type: String, value: item.note },
      { type: String, value: item.ptCode },
    ];
  });
  const fileName = `KiemSoatHSD_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await writeXlsxFile(
    [{ sheet: 'Kiểm soát HSD', data: [header, ...rows], columns: Array(12).fill({ width: 20 }) }],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}

// ============================================================================
// Returns Export
// ============================================================================
export async function exportReturnsToExcel(items: ReturnRecordItem[]): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'PT', ...HEADER_STYLE },
    { value: 'Tên NCC HT', ...HEADER_STYLE },
    { value: 'Hàng đổi trả', ...HEADER_STYLE },
    { value: 'Hình thức', ...HEADER_STYLE },
    { value: 'Tiến độ', ...HEADER_STYLE },
    { value: 'Ngày xử lý', ...HEADER_STYLE },
    { value: 'Báo đổi trả', ...HEADER_STYLE },
    { value: 'Cập nhật cuối', ...HEADER_STYLE },
  ];
  const rows: Row[] = items.map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: item.ptCode },
    { type: String, value: item.supplierSystemName },
    { type: String, value: item.productSummary },
    { type: String, value: item.returnMethod },
    { type: String, value: item.progress === 'completed' ? 'Đã xử lý' : 'Đang xử lý' },
    { type: String, value: item.completedDate ? formatViDate(item.completedDate) : '' },
    { type: String, value: item.reportedDate ? formatViDate(item.reportedDate) : '' },
    { type: String, value: item.lastUpdateNote },
  ]);
  const fileName = `DoiTraHangHoa_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await writeXlsxFile(
    [{ sheet: 'Đổi trả hàng hóa', data: [header, ...rows], columns: Array(9).fill({ width: 20 }) }],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}

// ============================================================================
// Promotions: Template + Export
// ============================================================================
export async function downloadPromotionTemplate(): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Mã hàng', ...HEADER_STYLE },
    { value: 'Mã vạch', ...HEADER_STYLE },
    { value: 'Tên hàng', ...HEADER_STYLE },
    { value: 'ĐVT', ...HEADER_STYLE },
    { value: 'HSD', ...HEADER_STYLE },
    { value: 'Số lượng', ...HEADER_STYLE },
    { value: 'Tỷ lệ KM (%)', ...HEADER_STYLE },
    { value: 'Giá bán', ...HEADER_STYLE },
    { value: 'PT', ...HEADER_STYLE },
    { value: 'Trạng thái', ...HEADER_STYLE },
  ];
  const sample: Row = [
    { type: Number, value: 1 },
    { type: String, value: 'SP001' },
    { type: String, value: '8935001234567' },
    { type: String, value: 'Viên uống Vitamin C 500mg (B)' },
    { type: String, value: 'Hộp' },
    { type: String, value: '31/12/2026' },
    { type: Number, value: 12 },
    { type: Number, value: 20 },
    { type: Number, value: 150000 },
    { type: String, value: 'PT01' },
    { type: String, value: 'active' },
  ];
  const fileName = 'Mau_KhuyenMai.xlsx';
  await writeXlsxFile(
    [{ sheet: 'Khuyến mãi', data: [header, sample], columns: Array(11).fill({ width: 18 }) }],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}

export async function exportPromotionsToExcel(items: PromotionItem[]): Promise<string> {
  const header: Row = [
    { value: 'STT', ...HEADER_STYLE },
    { value: 'Mã hàng', ...HEADER_STYLE },
    { value: 'Mã vạch', ...HEADER_STYLE },
    { value: 'Tên hàng', ...HEADER_STYLE },
    { value: 'Biểu tượng B', ...HEADER_STYLE },
    { value: 'ĐVT', ...HEADER_STYLE },
    { value: 'HSD', ...HEADER_STYLE },
    { value: 'Số lượng', ...HEADER_STYLE },
    { value: 'Tỷ lệ KM (%)', ...HEADER_STYLE },
    { value: 'Giá bán', ...HEADER_STYLE },
    { value: 'Giá KM', ...HEADER_STYLE },
    { value: 'Trạng thái', ...HEADER_STYLE },
  ];
  const rows: Row[] = items.map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: item.productCode },
    { type: String, value: item.barcode },
    { type: String, value: item.productName },
    { type: String, value: item.hasBBadge ? 'B' : '' },
    { type: String, value: item.unit },
    { type: String, value: item.expDate ? formatViDate(item.expDate) : '' },
    { type: Number, value: item.quantity },
    { type: Number, value: item.discountRate },
    { type: Number, value: item.regularPrice },
    { type: Number, value: item.promoPrice },
    {
      type: String,
      value:
        item.status === 'active'
          ? 'Đang áp dụng'
          : item.status === 'scheduled'
            ? 'Sắp diễn ra'
            : 'Đã kết thúc',
    },
  ]);
  const fileName = `KhuyenMai_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await writeXlsxFile(
    [{ sheet: 'Khuyến mãi', data: [header, ...rows], columns: Array(12).fill({ width: 16 }) }],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);
  return fileName;
}
