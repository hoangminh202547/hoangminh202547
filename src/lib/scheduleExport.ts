import writeXlsxFile, { type Row } from 'write-excel-file/browser';
import {
  SHIFT_ORDER,
  formatViDate,
  getShiftMeta,
  type WeekDayInfo,
} from './scheduleMeta';
import type {
  OfficialWorkSchedule,
  ScheduleShiftCode,
  ScheduleStaffMember,
} from '../types';

export interface MatrixExportRow {
  staff: ScheduleStaffMember;
  byDate: Map<string, OfficialWorkSchedule[]>;
}

const EXCEL_HEADER_STYLE = {
  fontWeight: 'bold' as const,
  backgroundColor: '#EFF6FF',
  color: '#0F172A',
};

export async function exportWeeklyMatrixToExcel(params: {
  rows: MatrixExportRow[];
  weekDays: WeekDayInfo[];
}): Promise<{ fileName: string; rowCount: number }> {
  const { rows, weekDays } = params;
  const header: Row = [
    { value: 'Ngày', ...EXCEL_HEADER_STYLE },
    { value: 'Họ và tên', ...EXCEL_HEADER_STYLE },
    { value: 'Chức vụ', ...EXCEL_HEADER_STYLE },
    { value: 'Ca làm việc', ...EXCEL_HEADER_STYLE },
    { value: 'Trực đàm (TĐ)', ...EXCEL_HEADER_STYLE },
    { value: 'Giờ bắt đầu', ...EXCEL_HEADER_STYLE },
    { value: 'Giờ kết thúc', ...EXCEL_HEADER_STYLE },
    { value: 'Trạng thái', ...EXCEL_HEADER_STYLE },
    { value: 'Ghi chú', ...EXCEL_HEADER_STYLE },
  ];

  const excelRows: Row[] = [];
  for (const row of rows) {
    for (const day of weekDays) {
      const items = row.byDate.get(day.ymd) || [];
      for (const s of items) {
        const meta = getShiftMeta(s.shiftType);
        excelRows.push([
          { type: String, value: `${day.weekday} (${formatViDate(day.ymd)})` },
          { type: String, value: row.staff.name },
          { type: String, value: row.staff.department || 'Nhân viên' },
          { type: String, value: meta.label },
          { type: String, value: s.isTrucDam ? 'TĐ' : '' },
          { type: String, value: meta.isOffDay ? '—' : s.startTime },
          { type: String, value: meta.isOffDay ? '—' : s.endTime },
          {
            type: String,
            value: meta.isOffDay
              ? 'Nghỉ'
              : s.isPublished
                ? 'Đã xuất bản'
                : 'Nháp',
          },
          { type: String, value: s.note || '' },
        ]);
      }
    }
  }

  const fileName = `LichTuan_${weekDays[0]?.ymd || 'Tuan'}.xlsx`;
  await writeXlsxFile(
    [
      {
        sheet: 'Lịch tuần chính thức',
        data: [header, ...excelRows],
        columns: [
          { width: 18 },
          { width: 24 },
          { width: 20 },
          { width: 22 },
          { width: 14 },
          { width: 13 },
          { width: 13 },
          { width: 15 },
          { width: 30 },
        ],
      },
    ],
    { fontFamily: 'Roboto', fontSize: 11 }
  ).toFile(fileName);

  return { fileName, rowCount: excelRows.length };
}

export type ExportCanvasLayout = 'desktop' | 'mobile';

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clipText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 0 && ctx.measureText(`${s}…`).width > maxWidth) {
    s = s.slice(0, -1);
  }
  return s ? `${s}…` : '';
}

function computeDailySummary(
  rows: MatrixExportRow[],
  ymd: string
): { work: number; trucDam: number; off: number; parts: string[]; lines: string[] } {
  let work = 0;
  let trucDam = 0;
  let off = 0;
  const byShift: Partial<Record<ScheduleShiftCode, number>> = {};
  for (const row of rows) {
    const items = row.byDate.get(ymd) || [];
    for (const s of items) {
      byShift[s.shiftType] = (byShift[s.shiftType] || 0) + 1;
      const meta = getShiftMeta(s.shiftType);
      if (meta.isOffDay) {
        off += 1;
      } else {
        work += 1;
        if (s.isTrucDam) trucDam += 1;
      }
    }
  }
  const parts: string[] = [];
  for (const code of SHIFT_ORDER) {
    const c = byShift[code] || 0;
    if (c > 0) {
      parts.push(`${getShiftMeta(code).shortLabel}:${c}`);
    }
  }
  if (trucDam > 0) parts.push(`TĐ:${trucDam}`);
  if (parts.length === 0) parts.push('0 ca');

  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts.slice(i, i + 2).join(' · '));
  }
  return { work, trucDam, off, parts, lines };
}

export function renderScheduleMatrixCanvas(params: {
  rows: MatrixExportRow[];
  weekDays: WeekDayInfo[];
  layout: ExportCanvasLayout;
  showNotes: boolean;
}): HTMLCanvasElement {
  const { rows, weekDays, layout, showNotes } = params;
  const scale = 2;
  const weekRangeLabel = `${formatViDate(weekDays[0].ymd)} – ${formatViDate(
    weekDays[6].ymd
  )}`;
  const generatedLabel = new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date());

  if (layout === 'desktop') {
    const padX = 28;
    const padY = 24;
    const bannerH = 78;
    const headerRowH = 50;
    const staffColW = 196;
    const dayColW = 152;
    const tableW = staffColW + dayColW * 7;
    const canvasW = tableW + padX * 2;
    const cardH = showNotes ? 50 : 36;
    const cardGap = 6;
    const cellPadY = 8;

    const rowHeights = rows.map((row) => {
      let maxCards = 1;
      for (const d of weekDays) {
        const count = (row.byDate.get(d.ymd) || []).length;
        if (count > maxCards) maxCards = count;
      }
      return Math.max(58, maxCards * cardH + Math.max(0, maxCards - 1) * cardGap + cellPadY * 2);
    });

    const maxFooterLines = Math.max(
      1,
      ...weekDays.map((d) => computeDailySummary(rows, d.ymd).lines.length)
    );
    const footerRowH = Math.max(44, 16 + maxFooterLines * 15);
    const totalRowsH =
      rows.length > 0 ? rowHeights.reduce((a, b) => a + b, 0) : 64;
    const canvasH =
      padY + bannerH + 16 + headerRowH + totalRowsH + footerRowH + padY + 24;

    const canvas = document.createElement('canvas');
    canvas.width = canvasW * scale;
    canvas.height = canvasH * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Không thể khởi tạo Canvas.');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Header Banner
    drawRoundRect(ctx, padX, padY, tableW, bannerH, 12);
    ctx.fillStyle = '#0F172A';
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 20px Roboto, sans-serif';
    ctx.fillText('LỊCH LÀM VIỆC TUẦN CHÍNH THỨC', padX + 20, padY + 32);

    ctx.fillStyle = '#CBD5E1';
    ctx.font = '400 13px Roboto, sans-serif';
    ctx.fillText(
      `Tuần: ${weekRangeLabel}   ·   Hiển thị: ${rows.length} nhân sự`,
      padX + 20,
      padY + 56
    );

    ctx.textAlign = 'right';
    ctx.fillStyle = '#94A3B8';
    ctx.font = '400 11px Roboto, sans-serif';
    ctx.fillText(`Cập nhật: ${generatedLabel}`, padX + tableW - 18, padY + 56);
    ctx.textAlign = 'left';

    const tableY = padY + bannerH + 16;

    // Table Header
    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(padX, tableY, tableW, headerRowH);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    ctx.strokeRect(padX, tableY, tableW, headerRowH);

    ctx.fillStyle = '#0F172A';
    ctx.font = '700 13px Roboto, sans-serif';
    ctx.fillText('Họ và tên / Chức vụ', padX + 14, tableY + 30);

    weekDays.forEach((d, idx) => {
      const cx = padX + staffColW + idx * dayColW;
      ctx.beginPath();
      ctx.moveTo(cx, tableY);
      ctx.lineTo(cx, tableY + headerRowH);
      ctx.strokeStyle = '#CBD5E1';
      ctx.stroke();

      if (d.isWeekend) {
        ctx.fillStyle = '#FEF3C7';
        ctx.fillRect(cx + 1, tableY + 1, dayColW - 2, headerRowH - 2);
      }

      ctx.textAlign = 'center';
      ctx.fillStyle = d.isWeekend ? '#92400E' : '#0F172A';
      ctx.font = '700 13px Roboto, sans-serif';
      ctx.fillText(d.weekday, cx + dayColW / 2, tableY + 21);

      ctx.fillStyle = d.isWeekend ? '#B45309' : '#64748B';
      ctx.font = '500 11px Roboto, sans-serif';
      ctx.fillText(d.ddMm, cx + dayColW / 2, tableY + 38);
    });
    ctx.textAlign = 'left';

    // Body rows
    let curY = tableY + headerRowH;
    if (rows.length === 0) {
      ctx.strokeStyle = '#E2E8F0';
      ctx.strokeRect(padX, curY, tableW, 64);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#64748B';
      ctx.font = '400 13px Roboto, sans-serif';
      ctx.fillText('Không có nhân sự phù hợp bộ lọc', padX + tableW / 2, curY + 36);
      ctx.textAlign = 'left';
      curY += 64;
    } else {
      rows.forEach((row, rIdx) => {
        const rh = rowHeights[rIdx];
        ctx.fillStyle = rIdx % 2 === 1 ? '#F8FAFC' : '#FFFFFF';
        ctx.fillRect(padX, curY, tableW, rh);
        ctx.strokeStyle = '#E2E8F0';
        ctx.strokeRect(padX, curY, tableW, rh);

        // Staff column
        ctx.fillStyle = '#0F172A';
        ctx.font = '700 13px Roboto, sans-serif';
        ctx.fillText(clipText(ctx, row.staff.name, staffColW - 22), padX + 12, curY + 24);
        ctx.fillStyle = '#64748B';
        ctx.font = '400 11px Roboto, sans-serif';
        ctx.fillText(
          clipText(ctx, row.staff.department || 'Nhân viên', staffColW - 22),
          padX + 12,
          curY + 42
        );

        weekDays.forEach((d, dIdx) => {
          const cx = padX + staffColW + dIdx * dayColW;
          ctx.beginPath();
          ctx.moveTo(cx, curY);
          ctx.lineTo(cx, curY + rh);
          ctx.strokeStyle = '#E2E8F0';
          ctx.stroke();

          const items = row.byDate.get(d.ymd) || [];
          items.forEach((shift, sIdx) => {
            const meta = getShiftMeta(shift.shiftType);
            const sx = cx + 6;
            const sy = curY + cellPadY + sIdx * (cardH + cardGap);
            const sw = dayColW - 12;

            drawRoundRect(ctx, sx, sy, sw, cardH, 6);
            ctx.fillStyle = meta.hexBg;
            ctx.fill();
            ctx.strokeStyle = meta.hexBorder;
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = meta.hexText;
            ctx.font = '700 11px Roboto, sans-serif';
            const titleMaxW = shift.isTrucDam ? sw - 42 : sw - 14;
            ctx.fillText(clipText(ctx, meta.shortLabel, titleMaxW), sx + 7, sy + 15);

            if (shift.isTrucDam) {
              drawRoundRect(ctx, sx + sw - 31, sy + 4, 25, 15, 4);
              ctx.fillStyle = '#EA580C';
              ctx.fill();
              ctx.fillStyle = '#FFFFFF';
              ctx.font = '700 9px Roboto, sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText('TĐ', sx + sw - 18.5, sy + 14.5);
              ctx.textAlign = 'left';
            }

            ctx.fillStyle = meta.hexAccent;
            ctx.font = '500 10px Roboto, sans-serif';
            const timeText = meta.isOffDay
              ? 'Nghỉ'
              : `${shift.startTime}–${shift.endTime}`;
            ctx.fillText(timeText, sx + 7, sy + 29);

            if (showNotes && shift.note) {
              ctx.fillStyle = '#475569';
              ctx.font = '400 10px Roboto, sans-serif';
              ctx.fillText(clipText(ctx, shift.note, sw - 14), sx + 7, sy + 43);
            }
          });
        });

        curY += rh;
      });
    }

    // Footer summary row
    ctx.fillStyle = '#F1F5F9';
    ctx.fillRect(padX, curY, tableW, footerRowH);
    ctx.strokeStyle = '#CBD5E1';
    ctx.strokeRect(padX, curY, tableW, footerRowH);

    ctx.fillStyle = '#0F172A';
    ctx.font = '700 12px Roboto, sans-serif';
    ctx.fillText('Tổng hợp trong ngày', padX + 12, curY + 26);

    weekDays.forEach((d, idx) => {
      const cx = padX + staffColW + idx * dayColW;
      ctx.beginPath();
      ctx.moveTo(cx, curY);
      ctx.lineTo(cx, curY + footerRowH);
      ctx.strokeStyle = '#CBD5E1';
      ctx.stroke();

      const sum = computeDailySummary(rows, d.ymd);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#334155';
      ctx.font = '600 10.5px Roboto, sans-serif';
      const startLineY = curY + (footerRowH - (sum.lines.length - 1) * 14) / 2 + 4;
      sum.lines.forEach((line, lIdx) => {
        ctx.fillText(clipText(ctx, line, dayColW - 10), cx + dayColW / 2, startLineY + lIdx * 14);
      });
    });
    ctx.textAlign = 'left';

    return canvas;
  }

  // Mobile vertical card layout
  const padX = 20;
  const padY = 20;
  const canvasW = 540;
  const innerW = canvasW - padX * 2;
  const bannerH = 82;
  const cardGap = 14;

  const dayHeights = weekDays.map((d) => {
    const entries: Array<{ staff: ScheduleStaffMember; shift: OfficialWorkSchedule }> = [];
    for (const row of rows) {
      const items = row.byDate.get(d.ymd) || [];
      for (const s of items) entries.push({ staff: row.staff, shift: s });
    }
    const rowH = showNotes ? 50 : 36;
    return 44 + Math.max(1, entries.length) * (rowH + 6) + 14;
  });

  const canvasH =
    padY +
    bannerH +
    16 +
    dayHeights.reduce((a, b) => a + b, 0) +
    (weekDays.length - 1) * cardGap +
    padY;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW * scale;
  canvas.height = canvasH * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Không thể khởi tạo Canvas.');
  ctx.scale(scale, scale);

  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Header Banner
  drawRoundRect(ctx, padX, padY, innerW, bannerH, 12);
  ctx.fillStyle = '#0F172A';
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 17px Roboto, sans-serif';
  ctx.fillText('LỊCH LÀM VIỆC TUẦN CHÍNH THỨC', padX + 16, padY + 30);

  ctx.fillStyle = '#CBD5E1';
  ctx.font = '400 12px Roboto, sans-serif';
  ctx.fillText(`Tuần: ${weekRangeLabel} · ${rows.length} nhân sự`, padX + 16, padY + 52);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '400 10px Roboto, sans-serif';
  ctx.fillText(`Cập nhật: ${generatedLabel}`, padX + 16, padY + 70);

  let curY = padY + bannerH + 16;

  weekDays.forEach((d, dIdx) => {
    const dh = dayHeights[dIdx];
    drawRoundRect(ctx, padX, curY, innerW, dh, 10);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Day Header
    drawRoundRect(ctx, padX, curY, innerW, 38, 10);
    ctx.fillStyle = d.isWeekend ? '#FEF3C7' : '#F1F5F9';
    ctx.fill();

    ctx.fillStyle = d.isWeekend ? '#92400E' : '#0F172A';
    ctx.font = '700 13px Roboto, sans-serif';
    ctx.fillText(`${d.weekday} · ${formatViDate(d.ymd)}`, padX + 14, curY + 24);

    const sum = computeDailySummary(rows, d.ymd);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#475569';
    ctx.font = '600 10.5px Roboto, sans-serif';
    ctx.fillText(
      clipText(ctx, sum.parts.join(' · '), innerW - 150),
      padX + innerW - 14,
      curY + 24
    );
    ctx.textAlign = 'left';

    const entries: Array<{ staff: ScheduleStaffMember; shift: OfficialWorkSchedule }> = [];
    for (const row of rows) {
      const items = row.byDate.get(d.ymd) || [];
      for (const s of items) entries.push({ staff: row.staff, shift: s });
    }

    const rowH = showNotes ? 50 : 36;
    if (entries.length === 0) {
      ctx.fillStyle = '#94A3B8';
      ctx.font = '400 12px Roboto, sans-serif';
      ctx.fillText('Không có lịch phân công', padX + 14, curY + 64);
    } else {
      entries.forEach((entry, idx) => {
        const meta = getShiftMeta(entry.shift.shiftType);
        const rx = padX + 12;
        const ry = curY + 46 + idx * (rowH + 6);
        const rw = innerW - 24;

        drawRoundRect(ctx, rx, ry, rw, rowH, 8);
        ctx.fillStyle = meta.hexBg;
        ctx.fill();
        ctx.strokeStyle = meta.hexBorder;
        ctx.stroke();

        ctx.fillStyle = '#0F172A';
        ctx.font = '700 12px Roboto, sans-serif';
        ctx.fillText(clipText(ctx, entry.staff.name, 185), rx + 10, ry + 22);

        const timeLabel = meta.isOffDay
          ? meta.shortLabel
          : `${meta.shortLabel} (${entry.shift.startTime}–${entry.shift.endTime})`;
        ctx.textAlign = 'right';
        ctx.fillStyle = meta.hexText;
        ctx.font = '700 11px Roboto, sans-serif';
        const badgeOffset = entry.shift.isTrucDam ? 36 : 0;
        ctx.fillText(timeLabel, rx + rw - 10 - badgeOffset, ry + 22);
        ctx.textAlign = 'left';

        if (entry.shift.isTrucDam) {
          drawRoundRect(ctx, rx + rw - 38, ry + 10, 28, 16, 4);
          ctx.fillStyle = '#EA580C';
          ctx.fill();
          ctx.fillStyle = '#FFFFFF';
          ctx.font = '700 9px Roboto, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('TĐ', rx + rw - 24, ry + 21);
          ctx.textAlign = 'left';
        }

        if (showNotes && entry.shift.note) {
          ctx.fillStyle = '#475569';
          ctx.font = '400 10px Roboto, sans-serif';
          ctx.fillText(
            clipText(ctx, `Ghi chú: ${entry.shift.note}`, rw - 20),
            rx + 10,
            ry + 40
          );
        }
      });
    }

    curY += dh + cardGap;
  });

  return canvas;
}

export async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Không thể tạo ảnh PNG.'))),
      'image/png'
    );
  });
}

export function downloadPngBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
