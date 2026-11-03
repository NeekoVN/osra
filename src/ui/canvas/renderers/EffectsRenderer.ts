import { OsrReplay } from '../../../core/types/replay.ts';

export function renderGrid(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = '#1D1F27';
  ctx.lineWidth = 1;

  ctx.strokeRect(0, 0, 512, 384);

  for (let x = 128; x < 512; x += 128) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 384);
    ctx.stroke();
  }

  for (let y = 128; y < 384; y += 128) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }
}

export function renderHitExplosion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  R: number,
  comboColor: string,
  elapsed: number,
  baseAlpha: number = 1.0,
  isHD: boolean = false
): void {
  if (isHD || elapsed < 0 || elapsed > 240) return;
  const progress = elapsed / 240;
  const easeOut = 1.0 - Math.pow(1.0 - progress, 2);
  const scale = 1.0 + 0.45 * easeOut;
  const alpha = Math.max(0, (1.0 - progress) * baseAlpha);

  ctx.save();
  ctx.globalAlpha = Math.max(0.01, alpha);

  // Expanding white ring
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, R * (1.0 + 0.5 * easeOut)), 0, Math.PI * 2);
  ctx.stroke();

  // Combo color explosion
  ctx.fillStyle = comboColor;
  ctx.globalAlpha = alpha * 0.35;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, R * scale), 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = comboColor;
  ctx.lineWidth = 2.5;
  ctx.globalAlpha = alpha;
  ctx.stroke();

  ctx.restore();
}

export function renderCirclePiece(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  R: number,
  comboColor: string,
  comboIndex: number,
  timeDiff: number,
  baseAlpha: number,
  isMiss: boolean = false,
  showApproachCircle: boolean = true,
  isHD: boolean = false,
  isTC: boolean = false,
  preemptMs: number = 600,
  playbackRate: number = 1.0
): void {
  if (timeDiff <= 0) {
    if (isHD) return;

    const visualElapsed = (-timeDiff) / playbackRate;

    if (isMiss) {
      if (visualElapsed <= 100) {
        const missAlpha = Math.max(0, 1.0 - visualElapsed / 100);
        ctx.save();
        ctx.globalAlpha = missAlpha * 0.35;
        ctx.fillStyle = '#101217';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, R), 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#ED1121';
        ctx.lineWidth = 2.0;
        ctx.stroke();
        ctx.restore();
      }
      return;
    }

    renderHitExplosion(ctx, x, y, R, comboColor, visualElapsed, 1.0, isHD);

    if (visualElapsed < 40) {
      ctx.save();
      const numAlpha = Math.max(0, 1.0 - (visualElapsed / 40));
      ctx.globalAlpha = numAlpha;
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 15px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(comboIndex), x, y);
      ctx.restore();
    }
    return;
  }

  if (baseAlpha <= 0.001 && !showApproachCircle) {
    return;
  }

  if (!isTC && baseAlpha > 0.001) {
    ctx.save();
    ctx.fillStyle = '#101217';
    ctx.globalAlpha = Math.max(0.01, baseAlpha);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, R), 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = comboColor;
    ctx.globalAlpha = baseAlpha * 0.25;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, R), 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = baseAlpha;

    ctx.strokeStyle = comboColor;
    ctx.lineWidth = 2.8;
    ctx.stroke();

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, R - 1.5), 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 15px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(comboIndex), x, y);
    ctx.restore();
  }

  if (showApproachCircle) {
    const approachProgress = Math.max(0, timeDiff / preemptMs);
    const approachRadius = Math.max(1, R + (R * 2.0 * approachProgress));
    const approachAlpha = Math.min(0.9, (preemptMs - timeDiff) / Math.min(preemptMs, 300));

    ctx.save();
    ctx.globalAlpha = approachAlpha;
    ctx.strokeStyle = comboColor;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(x, y, approachRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

export function renderFlashlight(
  ctx: CanvasRenderingContext2D,
  replay: OsrReplay | null,
  w: number,
  h: number,
  currentTimeMs: number,
  offsetX: number,
  offsetY: number,
  scale: number
): void {
  if (!replay) return;
  const frames = replay.frames;
  if (frames.length === 0) return;

  let left = 0;
  let right = frames.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (frames[mid].time < currentTimeMs) left = mid + 1;
    else right = mid;
  }
  const curFrame = frames[left] || frames[0];

  const cursorScreenX = offsetX + curFrame.x * scale;
  const cursorScreenY = offsetY + curFrame.y * scale;

  const flRadiusPx = 220 * scale;

  const grad = ctx.createRadialGradient(cursorScreenX, cursorScreenY, 0, cursorScreenX, cursorScreenY, flRadiusPx);
  grad.addColorStop(0.0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0)');
  grad.addColorStop(0.75, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0.97)');

  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(0,0,0,0.97)';
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.arc(cursorScreenX, cursorScreenY, flRadiusPx * 1.05, 0, Math.PI * 2, true);
  ctx.fill('evenodd');

  ctx.restore();
}

export function renderBreakTimer(
  ctx: CanvasRenderingContext2D,
  breakSections: Array<{ start: number; end: number }>,
  w: number,
  h: number,
  currentTimeMs: number
): void {
  const activeBreak = breakSections.find(b => currentTimeMs >= b.start && currentTimeMs <= b.end);
  if (!activeBreak) return;

  const duration = Math.max(1, activeBreak.end - activeBreak.start);
  const elapsed = currentTimeMs - activeBreak.start;
  const remaining = Math.max(0, activeBreak.end - currentTimeMs);

  const fadeIn = Math.min(1.0, elapsed / 350);
  const fadeOut = Math.min(1.0, remaining / 350);
  const alpha = Math.max(0, Math.min(1.0, Math.min(fadeIn, fadeOut)));
  if (alpha <= 0.01) return;

  const cx = w / 2;
  const cy = h / 2;

  const maxBarW = Math.min(260, w * 0.4);
  const progressRatio = Math.max(0, Math.min(1.0, remaining / duration));
  const curBarW = maxBarW * progressRatio;
  const barH = 6;

  ctx.save();
  ctx.globalAlpha = alpha;

  const secondsRemaining = Math.ceil(remaining / 1000);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 36px "Torus", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(String(secondsRemaining), cx, cy - 14);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
  const trackX = cx - maxBarW / 2;
  const barY = cy - barH / 2;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(trackX, barY, maxBarW, barH, barH / 2);
    ctx.fill();
  } else {
    ctx.fillRect(trackX, barY, maxBarW, barH);
  }

  if (curBarW > 1) {
    ctx.fillStyle = '#FFFFFF';
    const curBarX = cx - curBarW / 2;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(curBarX, barY, curBarW, barH, barH / 2);
      ctx.fill();
    } else {
      ctx.fillRect(curBarX, barY, curBarW, barH);
    }
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const leftX = cx - maxBarW / 2 - 28;
  ctx.beginPath();
  ctx.moveTo(leftX - 6, cy - 9);
  ctx.lineTo(leftX + 4, cy);
  ctx.lineTo(leftX - 6, cy + 9);
  ctx.stroke();

  const rightX = cx + maxBarW / 2 + 28;
  ctx.beginPath();
  ctx.moveTo(rightX + 6, cy - 9);
  ctx.lineTo(rightX - 4, cy);
  ctx.lineTo(rightX + 6, cy + 9);
  ctx.stroke();

  ctx.restore();
}
