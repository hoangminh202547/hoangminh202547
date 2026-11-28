import { jsPDF } from 'jspdf';

export interface CompressedImageBundle {
  mainBlob: Blob;
  thumbBlob: Blob;
  width: number;
  height: number;
  sizeBytes: number;
  thumbSizeBytes: number;
  mimeType: string;
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Không thể đọc tệp ảnh. Vui lòng chọn ảnh PNG, JPG hoặc WebP hợp lệ.'));
    };
    img.src = url;
  });
}

function renderScaledWebP(
  img: HTMLImageElement,
  maxDimension: number,
  quality: number
): Promise<{ blob: Blob; width: number; height: number }> {
  const ratio = Math.min(1, maxDimension / Math.max(img.width, img.height));
  const targetW = Math.max(1, Math.round(img.width * ratio));
  const targetH = Math.max(1, Math.round(img.height * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Trình duyệt không hỗ trợ Canvas nén ảnh.');
  }
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(img, 0, 0, targetW, targetH);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          canvas.toBlob(
            (jpgBlob) => {
              if (!jpgBlob) {
                reject(new Error('Không thể nén ảnh trước khi tải lên.'));
                return;
              }
              resolve({ blob: jpgBlob, width: targetW, height: targetH });
            },
            'image/jpeg',
            quality
          );
          return;
        }
        resolve({ blob, width: targetW, height: targetH });
      },
      'image/webp',
      quality
    );
  });
}

export async function compressImageToWebP(
  file: File,
  options?: { maxDim?: number; thumbDim?: number; quality?: number }
): Promise<CompressedImageBundle> {
  const img = await loadImageElement(file);
  const maxDim = options?.maxDim ?? 1280;
  const thumbDim = options?.thumbDim ?? 260;
  const baseQuality = options?.quality ?? 0.78;

  let main = await renderScaledWebP(img, maxDim, baseQuality);
  // Step down quality slightly if still large (>280KB)
  if (main.blob.size > 280 * 1024) {
    main = await renderScaledWebP(img, 1024, 0.68);
  }
  const thumb = await renderScaledWebP(img, thumbDim, 0.7);

  return {
    mainBlob: main.blob,
    thumbBlob: thumb.blob,
    width: main.width,
    height: main.height,
    sizeBytes: main.blob.size,
    thumbSizeBytes: thumb.blob.size,
    mimeType: main.blob.type || 'image/webp',
  };
}

export interface CanvasTableColumn {
  header: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

function drawRoundedRect(
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

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const raw = String(text ?? '').trim();
  if (!raw) return ['—'];
  const effectiveMax = Math.max(24, maxWidth);
  const paragraphs = raw.split(/\r?\n/);
  const lines: string[] = [];

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let currentLine = '';
    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(candidate).width <= effectiveMax) {
        currentLine = candidate;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = '';
        }
        if (ctx.measureText(word).width <= effectiveMax) {
          currentLine = word;
        } else {
          // Break very long continuous token (e.g. long barcode/product code)
          let chunk = '';
          for (const ch of word) {
            if (ctx.measureText(chunk + ch).width > effectiveMax && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          currentLine = chunk;
        }
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  return lines.length > 0 ? lines : ['—'];
}

function buildTablePageCanvases(
  title: string,
  subtitle: string,
  columns: CanvasTableColumn[],
  rows: Array<Array<string | number>>,
  rowsPerPage = 24
): HTMLCanvasElement[] {
  const paddingX = 28;
  const paddingTop = 26;
  const paddingBottom = 26;
  const lineH = 17;
  const cellPadX = 10;
  const cellPadY = 9;
  const totalTableW = columns.reduce((acc, c) => acc + c.width, 0);
  const canvasW = Math.max(1040, totalTableW + paddingX * 2);
  const tableW = canvasW - paddingX * 2;
  const scaleX = tableW / totalTableW;
  const scale = 2;

  const measureCanvas = document.createElement('canvas');
  const mCtx = measureCanvas.getContext('2d');
  if (!mCtx) throw new Error('Không thể khởi tạo canvas xuất tệp.');

  // Wrap title & subtitle cleanly
  mCtx.font = 'bold 20px Roboto, Arial, sans-serif';
  const titleLines = wrapCanvasText(mCtx, title, tableW - 8);
  mCtx.font = '13px Roboto, Arial, sans-serif';
  const subtitleLines = wrapCanvasText(mCtx, subtitle, tableW - 8);
  const headerBlockH =
    titleLines.length * 25 + subtitleLines.length * 18 + 18;

  // Wrap table header labels
  mCtx.font = 'bold 12px Roboto, Arial, sans-serif';
  const wrappedHeaders = columns.map((col) =>
    wrapCanvasText(mCtx, col.header, col.width * scaleX - cellPadX * 2)
  );
  const maxHeaderLines = Math.max(1, ...wrappedHeaders.map((l) => l.length));
  const tableHeaderH = Math.max(40, maxHeaderLines * lineH + cellPadY * 2);

  const chunks: Array<Array<Array<string | number>>> = [];
  for (let i = 0; i < Math.max(1, rows.length); i += rowsPerPage) {
    chunks.push(rows.slice(i, i + rowsPerPage));
  }

  return chunks.map((chunk, pageIdx) => {
    mCtx.font = '12.5px Roboto, Arial, sans-serif';
    const rowLayouts = chunk.map((row) => {
      const cells = columns.map((col, cIdx) => {
        const colW = col.width * scaleX;
        const lines = wrapCanvasText(
          mCtx,
          String(row[cIdx] ?? ''),
          colW - cellPadX * 2
        );
        return lines;
      });
      const maxLines = Math.max(1, ...cells.map((l) => l.length));
      const height = Math.max(38, maxLines * lineH + cellPadY * 2);
      return { cells, height };
    });

    const totalBodyH =
      chunk.length === 0
        ? 48
        : rowLayouts.reduce((sum, r) => sum + r.height, 0);

    const canvasH =
      paddingTop + headerBlockH + tableHeaderH + totalBodyH + paddingBottom + 28;
    const canvas = document.createElement('canvas');
    canvas.width = canvasW * scale;
    canvas.height = canvasH * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Không thể khởi tạo canvas xuất tệp.');
    ctx.scale(scale, scale);

    // Background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Title & Subtitle
    let curHeaderY = paddingTop + 18;
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 20px Roboto, Arial, sans-serif';
    ctx.textAlign = 'left';
    for (const line of titleLines) {
      ctx.fillText(line, paddingX, curHeaderY);
      curHeaderY += 25;
    }

    ctx.fillStyle = '#475569';
    ctx.font = '13px Roboto, Arial, sans-serif';
    const pageSuffix =
      chunks.length > 1 ? ` · Trang ${pageIdx + 1}/${chunks.length}` : '';
    const subWithPage =
      pageSuffix && subtitleLines.length > 0
        ? [
            ...subtitleLines.slice(0, -1),
            `${subtitleLines[subtitleLines.length - 1]}${pageSuffix}`,
          ]
        : subtitleLines;
    for (const line of subWithPage) {
      ctx.fillText(line, paddingX, curHeaderY);
      curHeaderY += 18;
    }

    const tableY = paddingTop + headerBlockH;

    // Table header background
    drawRoundedRect(ctx, paddingX, tableY, tableW, tableHeaderH, 6);
    ctx.fillStyle = '#EFF6FF';
    ctx.fill();
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Header cells + vertical dividers
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 12px Roboto, Arial, sans-serif';
    let curX = paddingX;
    columns.forEach((col, colIdx) => {
      const colW = col.width * scaleX;
      if (colIdx > 0) {
        ctx.beginPath();
        ctx.moveTo(curX, tableY);
        ctx.lineTo(curX, tableY + tableHeaderH);
        ctx.strokeStyle = '#CBD5E1';
        ctx.stroke();
      }
      const lines = wrappedHeaders[colIdx];
      const blockH = lines.length * lineH;
      const startY = tableY + (tableHeaderH - blockH) / 2 + 13;
      lines.forEach((line, lIdx) => {
        if (col.align === 'right') {
          ctx.textAlign = 'right';
          ctx.fillText(line, curX + colW - cellPadX, startY + lIdx * lineH);
        } else if (col.align === 'center') {
          ctx.textAlign = 'center';
          ctx.fillText(line, curX + colW / 2, startY + lIdx * lineH);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(line, curX + cellPadX, startY + lIdx * lineH);
        }
      });
      curX += colW;
    });

    // Body rows
    let curRowY = tableY + tableHeaderH;
    if (chunk.length === 0) {
      ctx.strokeStyle = '#E2E8F0';
      ctx.strokeRect(paddingX, curRowY, tableW, 48);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#64748B';
      ctx.font = '13px Roboto, Arial, sans-serif';
      ctx.fillText('Không có dữ liệu', paddingX + tableW / 2, curRowY + 29);
    } else {
      rowLayouts.forEach((layout, rIdx) => {
        const ry = curRowY;
        const rh = layout.height;
        if (rIdx % 2 === 1) {
          ctx.fillStyle = '#F8FAFC';
          ctx.fillRect(paddingX, ry, tableW, rh);
        }
        ctx.strokeStyle = '#E2E8F0';
        ctx.lineWidth = 1;
        ctx.strokeRect(paddingX, ry, tableW, rh);

        let cellX = paddingX;
        ctx.font = '12.5px Roboto, Arial, sans-serif';
        columns.forEach((col, cIdx) => {
          const colW = col.width * scaleX;
          if (cIdx > 0) {
            ctx.beginPath();
            ctx.moveTo(cellX, ry);
            ctx.lineTo(cellX, ry + rh);
            ctx.strokeStyle = '#E2E8F0';
            ctx.stroke();
          }
          const lines = layout.cells[cIdx];
          const textStartY = ry + cellPadY + 13;
          ctx.fillStyle = '#0F172A';
          lines.forEach((line, lIdx) => {
            if (col.align === 'right') {
              ctx.textAlign = 'right';
              ctx.fillText(line, cellX + colW - cellPadX, textStartY + lIdx * lineH);
            } else if (col.align === 'center') {
              ctx.textAlign = 'center';
              ctx.fillText(line, cellX + colW / 2, textStartY + lIdx * lineH);
            } else {
              ctx.textAlign = 'left';
              ctx.fillText(line, cellX + cellPadX, textStartY + lIdx * lineH);
            }
          });
          cellX += colW;
        });

        curRowY += rh;
      });
    }

    // Footer timestamp
    ctx.textAlign = 'left';
    ctx.fillStyle = '#64748B';
    ctx.font = '11.5px Roboto, Arial, sans-serif';
    ctx.fillText(
      `Xuất lúc ${new Intl.DateTimeFormat('vi-VN', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date())} · Tổng hiển thị: ${rows.length} dòng`,
      paddingX,
      canvasH - 12
    );

    return canvas;
  });
}

function triggerDownloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportTableToPng(
  title: string,
  subtitle: string,
  columns: CanvasTableColumn[],
  rows: Array<Array<string | number>>,
  filename: string
): Promise<string> {
  if (typeof document !== 'undefined' && 'fonts' in document) {
    await document.fonts.ready;
  }
  const perImageLimit = 220;
  const canvases = buildTablePageCanvases(
    title,
    subtitle,
    columns,
    rows,
    perImageLimit
  );
  for (let idx = 0; idx < canvases.length; idx += 1) {
    const canvas = canvases[idx];
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Không thể tạo ảnh PNG.'))),
        'image/png'
      );
    });
    const outName =
      canvases.length === 1
        ? filename
        : filename.replace(/\.png$/i, `_P${idx + 1}.png`);
    triggerDownloadBlob(blob, outName);
  }
  return filename;
}

export async function exportTableToPdf(
  title: string,
  subtitle: string,
  columns: CanvasTableColumn[],
  rows: Array<Array<string | number>>,
  filename: string
): Promise<string> {
  if (typeof document !== 'undefined' && 'fonts' in document) {
    await document.fonts.ready;
  }
  const canvases = buildTablePageCanvases(title, subtitle, columns, rows, 20);
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'pt',
    format: 'a4',
  });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20;

  canvases.forEach((canvas, idx) => {
    if (idx > 0) doc.addPage();
    const imgData = canvas.toDataURL('image/png');
    const availW = pageW - margin * 2;
    const availH = pageH - margin * 2;
    const ratio = Math.min(availW / canvas.width, availH / canvas.height);
    const drawW = canvas.width * ratio;
    const drawH = canvas.height * ratio;
    doc.addImage(imgData, 'PNG', margin, margin, drawW, drawH);
  });

  doc.save(filename);
  return filename;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}
