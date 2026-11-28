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

function wrapCanvasLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const effectiveMax = Math.max(24, maxWidth);
  const paragraphs = raw.split(/\r?\n/);
  const lines: string[] = [];

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= effectiveMax) {
        current = candidate;
      } else {
        if (current) {
          lines.push(current);
          current = '';
        }
        if (ctx.measureText(word).width <= effectiveMax) {
          current = word;
        } else {
          let chunk = '';
          for (const ch of word) {
            if (ctx.measureText(chunk + ch).width > effectiveMax && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          current = chunk;
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines;
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

  const measureCanvas = document.createElement('canvas');
  const mCtx = measureCanvas.getContext('2d');
  if (!mCtx) throw new Error('Không thể khởi tạo Canvas.');

  if (layout === 'desktop') {
    const padX = 28;
    const padY = 24;
    const bannerH = 78;
    const headerRowH = 52;
    const staffColW = 216;
    const dayColW = 164;
    const tableW = staffColW + dayColW * 7;
    const canvasW = tableW + padX * 2;
    const cardGap = 6;
    const cellPadY = 8;

    const rowLayouts = rows.map((row) => {
      mCtx.font = '700 13px Roboto, sans-serif';
      const nameLines = wrapCanvasLines(mCtx, row.staff.name, staffColW - 24);
      mCtx.font = '400 11.5px Roboto, sans-serif';
      const deptLines = wrapCanvasLines(
        mCtx,
        row.staff.department || 'Nhân viên',
        staffColW - 24
      );
      const staffBlockH =
        12 + nameLines.length * 17 + deptLines.length * 15 + 10;

      const dayCards = weekDays.map((d) => {
        const items = row.byDate.get(d.ymd) || [];
        return items.map((shift) => {
          const meta = getShiftMeta(shift.shiftType);
          const sw = dayColW - 12;
          mCtx.font = '700 11.5px Roboto, sans-serif';
          const titleMaxW = shift.isTrucDam ? sw - 42 : sw - 14;
          const titleLines = wrapCanvasLines(mCtx, meta.shortLabel, titleMaxW);
          mCtx.font = '400 10.5px Roboto, sans-serif';
          const noteLines =
            showNotes && shift.note
              ? wrapCanvasLines(mCtx, shift.note, sw - 14)
              : [];
          const cardH =
            8 +
            Math.max(1, titleLines.length) * 14 +
            14 +
            (noteLines.length > 0 ? 4 + noteLines.length * 13 : 0) +
            6;
          return { shift, meta, titleLines, noteLines, cardH };
        });
      });

      const maxDayColH = Math.max(
        0,
        ...dayCards.map(
          (cards) =>
            cards.reduce((s, c) => s + c.cardH, 0) +
            Math.max(0, cards.length - 1) * cardGap +
            cellPadY * 2
        )
      );
      const height = Math.max(58, staffBlockH, maxDayColH);
      return { nameLines, deptLines, dayCards, height };
    });

    const footerSummaries = weekDays.map((d) => {
      const sum = computeDailySummary(rows, d.ymd);
      mCtx.font = '600 11px Roboto, sans-serif';
      const wrapped = sum.parts
        .join(' · ')
        .split(' · ');
      const lines: string[] = [];
      let cur = '';
      for (const token of wrapped) {
        const cand = cur ? `${cur} · ${token}` : token;
        if (mCtx.measureText(cand).width <= dayColW - 14) {
          cur = cand;
        } else {
          if (cur) lines.push(cur);
          cur = token;
        }
      }
      if (cur) lines.push(cur);
      return lines.length > 0 ? lines : ['0 ca'];
    });

    const maxFooterLines = Math.max(1, ...footerSummaries.map((l) => l.length));
    const footerRowH = Math.max(46, 18 + maxFooterLines * 15);
    const totalRowsH =
      rows.length > 0 ? rowLayouts.reduce((a, b) => a + b.height, 0) : 64;
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
    ctx.font = '400 11.5px Roboto, sans-serif';
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
    ctx.fillText('Họ và tên / Chức vụ', padX + 14, tableY + 31);

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
      ctx.fillText(d.weekday, cx + dayColW / 2, tableY + 22);

      ctx.fillStyle = d.isWeekend ? '#B45309' : '#64748B';
      ctx.font = '500 11.5px Roboto, sans-serif';
      ctx.fillText(d.ddMm, cx + dayColW / 2, tableY + 40);
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
      rows.forEach((_, rIdx) => {
        const layoutRow = rowLayouts[rIdx];
        const rh = layoutRow.height;
        ctx.fillStyle = rIdx % 2 === 1 ? '#F8FAFC' : '#FFFFFF';
        ctx.fillRect(padX, curY, tableW, rh);
        ctx.strokeStyle = '#E2E8F0';
        ctx.strokeRect(padX, curY, tableW, rh);

        // Staff column (wrapped cleanly)
        let syText = curY + 22;
        ctx.fillStyle = '#0F172A';
        ctx.font = '700 13px Roboto, sans-serif';
        layoutRow.nameLines.forEach((line) => {
          ctx.fillText(line, padX + 12, syText);
          syText += 17;
        });
        ctx.fillStyle = '#64748B';
        ctx.font = '400 11.5px Roboto, sans-serif';
        layoutRow.deptLines.forEach((line) => {
          ctx.fillText(line, padX + 12, syText);
          syText += 15;
        });

        weekDays.forEach((_, dIdx) => {
          const cx = padX + staffColW + dIdx * dayColW;
          ctx.beginPath();
          ctx.moveTo(cx, curY);
          ctx.lineTo(cx, curY + rh);
          ctx.strokeStyle = '#E2E8F0';
          ctx.stroke();

          const cards = layoutRow.dayCards[dIdx];
          let cardTop = curY + cellPadY;
          cards.forEach((c) => {
            const { shift, meta, titleLines, noteLines, cardH } = c;
            const sx = cx + 6;
            const sy = cardTop;
            const sw = dayColW - 12;

            drawRoundRect(ctx, sx, sy, sw, cardH, 6);
            ctx.fillStyle = meta.hexBg;
            ctx.fill();
            ctx.strokeStyle = meta.hexBorder;
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = meta.hexText;
            ctx.font = '700 11.5px Roboto, sans-serif';
            let innerY = sy + 16;
            titleLines.forEach((tl) => {
              ctx.fillText(tl, sx + 7, innerY);
              innerY += 14;
            });

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
            ctx.font = '500 10.5px Roboto, sans-serif';
            const timeText = meta.isOffDay
              ? 'Nghỉ'
              : `${shift.startTime}–${shift.endTime}`;
            ctx.fillText(timeText, sx + 7, innerY);
            innerY += 14;

            if (noteLines.length > 0) {
              ctx.fillStyle = '#334155';
              ctx.font = '400 10.5px Roboto, sans-serif';
              noteLines.forEach((nl) => {
                ctx.fillText(nl, sx + 7, innerY);
                innerY += 13;
              });
            }

            cardTop += cardH + cardGap;
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
    ctx.font = '700 12.5px Roboto, sans-serif';
    ctx.fillText('Tổng hợp trong ngày', padX + 12, curY + 26);

    weekDays.forEach((_, idx) => {
      const cx = padX + staffColW + idx * dayColW;
      ctx.beginPath();
      ctx.moveTo(cx, curY);
      ctx.lineTo(cx, curY + footerRowH);
      ctx.strokeStyle = '#CBD5E1';
      ctx.stroke();

      const lines = footerSummaries[idx];
      ctx.textAlign = 'center';
      ctx.fillStyle = '#1E293B';
      ctx.font = '600 11px Roboto, sans-serif';
      const startLineY = curY + (footerRowH - (lines.length - 1) * 15) / 2 + 4;
      lines.forEach((line, lIdx) => {
        ctx.fillText(line, cx + dayColW / 2, startLineY + lIdx * 15);
      });
    });
    ctx.textAlign = 'left';

    return canvas;
  }

  // Mobile vertical card layout (wrapped, zero truncation)
  const padX = 20;
  const padY = 20;
  const canvasW = 580;
  const innerW = canvasW - padX * 2;
  const bannerH = 84;
  const cardGap = 14;

  const dayLayouts = weekDays.map((d) => {
    const entries: Array<{
      staff: ScheduleStaffMember;
      shift: OfficialWorkSchedule;
      meta: ReturnType<typeof getShiftMeta>;
      noteLines: string[];
      cardH: number;
    }> = [];

    const rw = innerW - 24;
    for (const row of rows) {
      const items = row.byDate.get(d.ymd) || [];
      for (const s of items) {
        const meta = getShiftMeta(s.shiftType);
        mCtx.font = '400 11px Roboto, sans-serif';
        const noteLines =
          showNotes && s.note
            ? wrapCanvasLines(mCtx, `Ghi chú: ${s.note}`, rw - 20)
            : [];
        const cardH = 38 + (noteLines.length > 0 ? noteLines.length * 14 + 6 : 0);
        entries.push({ staff: row.staff, shift: s, meta, noteLines, cardH });
      }
    }

    const sum = computeDailySummary(rows, d.ymd);
    mCtx.font = '600 11px Roboto, sans-serif';
    const sumLines = wrapCanvasLines(mCtx, sum.parts.join(' · '), innerW - 28);
    const headerH = 32 + sumLines.length * 15 + 6;
    const entriesH =
      entries.length === 0
        ? 38
        : entries.reduce((acc, e) => acc + e.cardH, 0) +
          Math.max(0, entries.length - 1) * 6;
    const totalH = headerH + 10 + entriesH + 14;
    return { entries, sumLines, headerH, totalH };
  });

  const canvasH =
    padY +
    bannerH +
    16 +
    dayLayouts.reduce((a, b) => a + b.totalH, 0) +
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
  ctx.font = '700 17.5px Roboto, sans-serif';
  ctx.fillText('LỊCH LÀM VIỆC TUẦN CHÍNH THỨC', padX + 16, padY + 30);

  ctx.fillStyle = '#CBD5E1';
  ctx.font = '400 12.5px Roboto, sans-serif';
  ctx.fillText(`Tuần: ${weekRangeLabel} · ${rows.length} nhân sự`, padX + 16, padY + 52);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '400 10.5px Roboto, sans-serif';
  ctx.fillText(`Cập nhật: ${generatedLabel}`, padX + 16, padY + 71);

  let curY = padY + bannerH + 16;

  weekDays.forEach((d, dIdx) => {
    const dl = dayLayouts[dIdx];
    const dh = dl.totalH;
    drawRoundRect(ctx, padX, curY, innerW, dh, 10);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Day Header (multi-line safe so summary never overlaps weekday)
    drawRoundRect(ctx, padX, curY, innerW, dl.headerH, 10);
    ctx.fillStyle = d.isWeekend ? '#FEF3C7' : '#EFF6FF';
    ctx.fill();

    ctx.fillStyle = d.isWeekend ? '#92400E' : '#0F172A';
    ctx.font = '700 13.5px Roboto, sans-serif';
    ctx.fillText(`${d.weekday} · ${formatViDate(d.ymd)}`, padX + 14, curY + 23);

    ctx.fillStyle = '#475569';
    ctx.font = '600 11px Roboto, sans-serif';
    dl.sumLines.forEach((sl, sIdx) => {
      ctx.fillText(sl, padX + 14, curY + 41 + sIdx * 15);
    });

    if (dl.entries.length === 0) {
      ctx.fillStyle = '#94A3B8';
      ctx.font = '400 12.5px Roboto, sans-serif';
      ctx.fillText('Không có lịch phân công', padX + 14, curY + dl.headerH + 25);
    } else {
      let entryY = curY + dl.headerH + 10;
      dl.entries.forEach((entry) => {
        const { meta, noteLines, cardH } = entry;
        const rx = padX + 12;
        const ry = entryY;
        const rw = innerW - 24;

        drawRoundRect(ctx, rx, ry, rw, cardH, 8);
        ctx.fillStyle = meta.hexBg;
        ctx.fill();
        ctx.strokeStyle = meta.hexBorder;
        ctx.stroke();

        const timeLabel = meta.isOffDay
          ? meta.shortLabel
          : `${meta.shortLabel} (${entry.shift.startTime}–${entry.shift.endTime})`;
        ctx.font = '700 11.5px Roboto, sans-serif';
        const timeW = ctx.measureText(timeLabel).width;
        const badgeOffset = entry.shift.isTrucDam ? 36 : 0;
        const maxNameW = rw - timeW - badgeOffset - 28;

        ctx.fillStyle = '#0F172A';
        ctx.font = '700 12.5px Roboto, sans-serif';
        const nameLines = wrapCanvasLines(ctx, entry.staff.name, Math.max(100, maxNameW));
        ctx.fillText(nameLines[0] || entry.staff.name, rx + 10, ry + 23);

        ctx.textAlign = 'right';
        ctx.fillStyle = meta.hexText;
        ctx.font = '700 11.5px Roboto, sans-serif';
        ctx.fillText(timeLabel, rx + rw - 10 - badgeOffset, ry + 23);
        ctx.textAlign = 'left';

        if (entry.shift.isTrucDam) {
          drawRoundRect(ctx, rx + rw - 38, ry + 10, 28, 17, 4);
          ctx.fillStyle = '#EA580C';
          ctx.fill();
          ctx.fillStyle = '#FFFFFF';
          ctx.font = '700 9.5px Roboto, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('TĐ', rx + rw - 24, ry + 22);
          ctx.textAlign = 'left';
        }

        if (noteLines.length > 0) {
          ctx.fillStyle = '#334155';
          ctx.font = '400 11px Roboto, sans-serif';
          noteLines.forEach((nl, nIdx) => {
            ctx.fillText(nl, rx + 10, ry + 41 + nIdx * 14);
          });
        }

        entryY += cardH + 6;
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
