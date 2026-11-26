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

function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  const raw = String(text ?? '');
  if (ctx.measureText(raw).width <= maxWidth) return raw;
  let clipped = raw;
  while (clipped.length > 0 && ctx.measureText(`${clipped}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return clipped ? `${clipped}…` : '';
}

function buildTablePageCanvases(
  title: string,
  subtitle: string,
  columns: CanvasTableColumn[],
  rows: Array<Array<string | number>>,
  rowsPerPage = 24
): HTMLCanvasElement[] {
  const paddingX = 32;
  const paddingTop = 28;
  const paddingBottom = 24;
  const headerBlockH = 68;
  const tableHeaderH = 38;
  const rowH = 34;
  const totalTableW = columns.reduce((acc, c) => acc + c.width, 0);
  const canvasW = Math.max(960, totalTableW + paddingX * 2);
  const scale = 2;

  const chunks: Array<Array<Array<string | number>>> = [];
  for (let i = 0; i < Math.max(1, rows.length); i += rowsPerPage) {
    chunks.push(rows.slice(i, i + rowsPerPage));
  }

  return chunks.map((chunk, pageIdx) => {
    const contentRows = Math.max(1, chunk.length);
    const canvasH =
      paddingTop + headerBlockH + tableHeaderH + contentRows * rowH + paddingBottom + 28;
    const canvas = document.createElement('canvas');
    canvas.width = canvasW * scale;
    canvas.height = canvasH * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Không thể khởi tạo canvas xuất tệp.');
    ctx.scale(scale, scale);

    // Background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Header
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 20px Roboto, Arial, sans-serif';
    ctx.fillText(title, paddingX, paddingTop + 20);

    ctx.fillStyle = '#475569';
    ctx.font = '13px Roboto, Arial, sans-serif';
    const pageSuffix = chunks.length > 1 ? ` · Trang ${pageIdx + 1}/${chunks.length}` : '';
    ctx.fillText(`${subtitle}${pageSuffix}`, paddingX, paddingTop + 44);

    const tableY = paddingTop + headerBlockH;
    const tableW = canvasW - paddingX * 2;
    const scaleX = tableW / totalTableW;

    // Table header
    drawRoundedRect(ctx, paddingX, tableY, tableW, tableHeaderH, 6);
    ctx.fillStyle = '#F1F5F9';
    ctx.fill();
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 12px Roboto, Arial, sans-serif';
    let curX = paddingX;
    for (const col of columns) {
      const colW = col.width * scaleX;
      const label = truncateText(ctx, col.header, colW - 14);
      if (col.align === 'right') {
        ctx.textAlign = 'right';
        ctx.fillText(label, curX + colW - 8, tableY + 23);
      } else if (col.align === 'center') {
        ctx.textAlign = 'center';
        ctx.fillText(label, curX + colW / 2, tableY + 23);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(label, curX + 8, tableY + 23);
      }
      curX += colW;
    }

    // Rows
    ctx.font = '12px Roboto, Arial, sans-serif';
    if (chunk.length === 0) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#64748B';
      ctx.fillText('Không có dữ liệu', paddingX + tableW / 2, tableY + tableHeaderH + 22);
    } else {
      chunk.forEach((row, rIdx) => {
        const ry = tableY + tableHeaderH + rIdx * rowH;
        if (rIdx % 2 === 1) {
          ctx.fillStyle = '#F8FAFC';
          ctx.fillRect(paddingX, ry, tableW, rowH);
        }
        ctx.strokeStyle = '#E2E8F0';
        ctx.beginPath();
        ctx.moveTo(paddingX, ry + rowH);
        ctx.lineTo(paddingX + tableW, ry + rowH);
        ctx.stroke();

        let cellX = paddingX;
        columns.forEach((col, cIdx) => {
          const colW = col.width * scaleX;
          const cellStr = truncateText(ctx, String(row[cIdx] ?? ''), colW - 14);
          ctx.fillStyle = '#0F172A';
          if (col.align === 'right') {
            ctx.textAlign = 'right';
            ctx.fillText(cellStr, cellX + colW - 8, ry + 21);
          } else if (col.align === 'center') {
            ctx.textAlign = 'center';
            ctx.fillText(cellStr, cellX + colW / 2, ry + 21);
          } else {
            ctx.textAlign = 'left';
            ctx.fillText(cellStr, cellX + 8, ry + 21);
          }
          cellX += colW;
        });
      });
    }

    // Footer timestamp
    ctx.textAlign = 'left';
    ctx.fillStyle = '#94A3B8';
    ctx.font = '11px Roboto, Arial, sans-serif';
    ctx.fillText(
      `Xuất lúc ${new Intl.DateTimeFormat('vi-VN', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date())}`,
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
  const canvases = buildTablePageCanvases(title, subtitle, columns, rows, 80);
  const canvas = canvases[0];
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Không thể tạo ảnh PNG.'))),
      'image/png'
    );
  });
  triggerDownloadBlob(blob, filename);
  return filename;
}

export async function exportTableToPdf(
  title: string,
  subtitle: string,
  columns: CanvasTableColumn[],
  rows: Array<Array<string | number>>,
  filename: string
): Promise<string> {
  const canvases = buildTablePageCanvases(title, subtitle, columns, rows, 22);
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
