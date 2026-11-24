import writeXlsxFile, { type Row } from 'write-excel-file/browser';
import type { BarcodeScan, ScheduleStatus, ShiftType, WorkSchedule } from '../types';

function formatDateTime(date: Date | null): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

const HEADER_STYLE = {
  fontWeight: 'bold' as const,
  backgroundColor: '#F1F5F9',
  color: '#0F172A',
};

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
    { value: 'Đồng bộ Supabase', ...HEADER_STYLE },
  ];

  const detailRows: Row[] = scans.map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: item.code },
    { type: String, value: item.format },
    { type: String, value: item.sessionName },
    { type: Number, value: item.quantity },
    { type: String, value: item.note || '' },
    {
      type: String,
      value: formatDateTime(item.scannedAt ? item.scannedAt.toDate() : null),
    },
    { type: String, value: item.ownerEmail },
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
    {
      fontFamily: 'Roboto',
      fontSize: 11,
    }
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
    { value: 'Ghi chú', ...HEADER_STYLE },
    { value: 'Email đăng ký', ...HEADER_STYLE },
    { value: 'Đồng bộ Supabase', ...HEADER_STYLE },
  ];

  const rows: Row[] = schedules.map((item, idx) => [
    { type: Number, value: idx + 1 },
    { type: String, value: item.workDate },
    { type: String, value: item.title },
    { type: String, value: item.employeeName },
    { type: String, value: SHIFT_LABELS[item.shiftType] || item.shiftType },
    { type: String, value: item.startTime },
    { type: String, value: item.endTime },
    { type: String, value: item.location || '' },
    { type: String, value: STATUS_LABELS[item.status] || item.status },
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
          { width: 28 },
          { width: 28 },
          { width: 18 },
        ],
      },
    ],
    {
      fontFamily: 'Roboto',
      fontSize: 11,
    }
  ).toFile(fileName);

  return fileName;
}
