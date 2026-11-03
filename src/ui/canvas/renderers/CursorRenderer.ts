import cursorImgUrl from '../../../assets/skin/cursor@2x.png';
import cursorTrailImgUrl from '../../../assets/skin/cursortrail@2x.png';
import { OsrReplay } from '../../../core/types/replay.ts';
import { TimedHitEvent, HitJudgement, DesyncType } from '../../../core/types/telemetry.ts';

export class CursorRenderer {
  private cursorImg: HTMLImageElement | null = null;
  private cursorTrailImg: HTMLImageElement | null = null;
  private trailSprite: HTMLCanvasElement | null = null;
  private cursorSprite: HTMLCanvasElement | null = null;
  private onTextureLoaded?: () => void;

  constructor(onTextureLoaded?: () => void) {
    this.onTextureLoaded = onTextureLoaded;
    this.initCursorTextures();
    this.initCursorSprites();
  }

  private initCursorTextures(): void {
    const cImg = new Image();
    cImg.src = cursorImgUrl;
    cImg.onload = () => {
      this.cursorImg = cImg;
      this.onTextureLoaded?.();
    };

    const tImg = new Image();
    tImg.src = cursorTrailImgUrl;
    tImg.onload = () => {
      this.cursorTrailImg = tImg;
      this.onTextureLoaded?.();
    };
  }

  private initCursorSprites(): void {
    const tCanvas = document.createElement('canvas');
    tCanvas.width = 32;
    tCanvas.height = 32;
    const tCtx = tCanvas.getContext('2d');
    if (tCtx) {
      const grad = tCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
      grad.addColorStop(0.28, 'rgba(255, 255, 255, 0.75)');
      grad.addColorStop(0.65, 'rgba(255, 255, 255, 0.25)');
      grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
      tCtx.fillStyle = grad;
      tCtx.beginPath();
      tCtx.arc(16, 16, 16, 0, Math.PI * 2);
      tCtx.fill();
    }
    this.trailSprite = tCanvas;

    const cCanvas = document.createElement('canvas');
    cCanvas.width = 64;
    cCanvas.height = 64;
    const cCtx = cCanvas.getContext('2d');
    if (cCtx) {
      const glowGrad = cCtx.createRadialGradient(32, 32, 8, 32, 32, 26);
      glowGrad.addColorStop(0, 'rgba(0, 240, 150, 0.35)');
      glowGrad.addColorStop(0.55, 'rgba(0, 229, 153, 0.15)');
      glowGrad.addColorStop(1.0, 'rgba(0, 229, 153, 0.0)');
      cCtx.fillStyle = glowGrad;
      cCtx.beginPath();
      cCtx.arc(32, 32, 26, 0, Math.PI * 2);
      cCtx.fill();

      const bodyGrad = cCtx.createRadialGradient(30, 30, 0, 32, 32, 14);
      bodyGrad.addColorStop(0, '#38FFB8');
      bodyGrad.addColorStop(0.35, '#00E599');
      bodyGrad.addColorStop(0.75, '#00B86C');
      bodyGrad.addColorStop(0.90, 'rgba(0, 184, 108, 0.85)');
      bodyGrad.addColorStop(1.0, 'rgba(0, 200, 120, 0.0)');
      cCtx.fillStyle = bodyGrad;
      cCtx.beginPath();
      cCtx.arc(32, 32, 14, 0, Math.PI * 2);
      cCtx.fill();
    }
    this.cursorSprite = cCanvas;
  }

  public renderCursorTrail(ctx: CanvasRenderingContext2D, replay: OsrReplay | null, currentTimeMs: number): void {
    if (!replay) return;
    const trailImg = (this.cursorTrailImg && this.cursorTrailImg.complete) ? this.cursorTrailImg : this.trailSprite;
    if (!trailImg) return;

    const frames = replay.frames;
    if (frames.length === 0) return;

    const trailDuration = 120;
    const startTime = currentTimeMs - trailDuration;

    let left = 0;
    let right = frames.length - 1;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (frames[mid].time < startTime) left = mid + 1;
      else right = mid;
    }
    const startIndex = Math.max(0, left - 1);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const step = 4;

    for (let i = startIndex; i < frames.length; i++) {
      const f1 = frames[i];
      if (f1.time > currentTimeMs) break;

      const f0 = i > 0 ? frames[i - 1] : f1;
      if (f1.time - f0.time > 250) continue;

      const dx = f1.x - f0.x;
      const dy = f1.y - f0.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.floor(dist / step));

      for (let s = 1; s <= steps; s++) {
        const ratio = s / steps;
        const ptTime = f0.time + (f1.time - f0.time) * ratio;
        if (ptTime < startTime || ptTime > currentTimeMs) continue;

        const age = currentTimeMs - ptTime;
        const progress = age / trailDuration;
        const alpha = Math.pow(1.0 - progress, 1.3) * 0.75;
        const size = 38 * (1.0 - progress * 0.32);
        const half = size / 2;

        const px = f0.x + dx * ratio;
        const py = f0.y + dy * ratio;

        ctx.globalAlpha = alpha;
        ctx.drawImage(trailImg, px - half, py - half, size, size);
      }
    }

    ctx.restore();
  }

  public renderPathTrail(
    ctx: CanvasRenderingContext2D,
    replay: OsrReplay | null,
    currentTimeMs: number,
    pathTrailDurationMs: number = 1200
  ): void {
    if (!replay) return;
    const frames = replay.frames;
    if (frames.length === 0) return;

    const trailDuration = pathTrailDurationMs;
    const startTime = currentTimeMs - trailDuration;

    let left = 0;
    let right = frames.length - 1;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (frames[mid].time < startTime) left = mid + 1;
      else right = mid;
    }
    const startIndex = Math.max(0, left - 1);

    const points: Array<{ x: number; y: number; age: number }> = [];
    const step = 4;

    for (let i = startIndex; i < frames.length; i++) {
      const f1 = frames[i];
      if (f1.time > currentTimeMs) break;

      const f0 = i > 0 ? frames[i - 1] : f1;
      if (f1.time - f0.time > 250) continue;

      const dx = f1.x - f0.x;
      const dy = f1.y - f0.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.floor(dist / step));

      for (let s = 1; s <= steps; s++) {
        const ratio = s / steps;
        const ptTime = f0.time + (f1.time - f0.time) * ratio;
        if (ptTime < startTime || ptTime > currentTimeMs) continue;
        points.push({
          x: f0.x + dx * ratio,
          y: f0.y + dy * ratio,
          age: currentTimeMs - ptTime
        });
      }
    }

    if (points.length < 2) return;

    const passes: Array<{ maxAgeFrac: number; color: string; width: number; alpha: number }> = [
      { maxAgeFrac: 1.0, color: 'rgba(0, 229, 153, 1)', width: 5.5, alpha: 0.10 },
      { maxAgeFrac: 0.7, color: 'rgba(56, 255, 184, 1)', width: 3.2, alpha: 0.26 },
      { maxAgeFrac: 0.35, color: 'rgba(200, 255, 232, 1)', width: 2.3, alpha: 0.55 },
      { maxAgeFrac: 0.12, color: '#FFFFFF', width: 3.4, alpha: 0.9 }
    ];

    const lastIdx = points.length - 1;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const pass of passes) {
      const maxAge = pass.maxAgeFrac * trailDuration;
      let from = lastIdx;
      while (from > 0 && points[from - 1].age <= maxAge) from--;
      if (lastIdx - from < 1) continue;

      ctx.strokeStyle = pass.color;
      ctx.lineWidth = pass.width;
      ctx.globalAlpha = pass.alpha;
      ctx.beginPath();
      ctx.moveTo(points[from].x, points[from].y);
      for (let i = from + 1; i <= lastIdx; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  public renderActiveCursor(
    ctx: CanvasRenderingContext2D,
    replay: OsrReplay | null,
    hitEvents: TimedHitEvent[],
    currentTimeMs: number,
    showErrorVectors: boolean,
    playbackRate: number
  ): void {
    if (!replay) return;
    const frames = replay.frames;
    if (frames.length === 0) return;

    const inSkipGap = replay.skipGaps?.some(g => currentTimeMs >= g.from && currentTimeMs < g.to);
    if (inSkipGap) return;

    let left = 0;
    let right = frames.length - 1;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (frames[mid].time < currentTimeMs) left = mid + 1;
      else right = mid;
    }

    const curFrame = frames[left] || frames[0];
    const cx = curFrame.x;
    const cy = curFrame.y;

    if (showErrorVectors) {
      const activeHits = hitEvents.filter(e => {
        const visualAge = (currentTimeMs - e.targetTime) / playbackRate;
        return visualAge >= -30 && visualAge <= 700;
      });

      for (let i = 0; i < activeHits.length; i++) {
        const hit = activeHits[i];
        const age = (currentTimeMs - hit.targetTime) / playbackRate;

        let alpha = 1.0;
        if (age < 0) {
          alpha = Math.max(0.2, 1 + age / 30);
        } else if (age <= 500) {
          alpha = 1.0;
        } else {
          alpha = Math.max(0, 1.0 - (age - 500) / 200);
        }

        const isDesync = hit.desyncType === DesyncType.EarlyTap || hit.desyncType === DesyncType.LateTap || hit.desyncType === DesyncType.SpeedMiss;
        const isMiss = hit.judgement === HitJudgement.Miss;

        let col = '#4AA4FF';
        if (isDesync) col = '#B87BFF';
        else if (isMiss) col = '#ED1121';
        else if (hit.judgement === HitJudgement.Ok) col = '#74D128';
        else if (hit.judgement === HitJudgement.Meh) col = '#FFCC22';

        const hasTapAttribution = hit.key !== 'NONE';

        ctx.save();
        ctx.globalAlpha = alpha;

        if (hasTapAttribution) {
          ctx.strokeStyle = col;
          ctx.lineWidth = 2.0;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(hit.tapX, hit.tapY);
          ctx.lineTo(hit.targetX, hit.targetY);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(hit.tapX, hit.tapY, 4.5, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 1.0;
          ctx.beginPath();
          ctx.arc(hit.tapX, hit.tapY, 5.5, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          const xSize = 5;
          const nx = hit.targetX;
          const ny = hit.targetY;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(nx - xSize, ny - xSize);
          ctx.lineTo(nx + xSize, ny + xSize);
          ctx.moveTo(nx + xSize, ny - xSize);
          ctx.lineTo(nx - xSize, ny + xSize);
          ctx.stroke();
        }

        if (age >= -30 && age <= 150) {
          let tooltipAlpha = 1.0;
          if (age < 0) {
            tooltipAlpha = Math.max(0.2, 1 + age / 30);
          } else {
            tooltipAlpha = Math.max(0, 1.0 - (age / 150));
          }

          ctx.save();
          ctx.globalAlpha = alpha * tooltipAlpha;

          const isTap = hit.key !== 'NONE';
          let label: string;
          if (isDesync) {
            const desyncName = hit.desyncType === DesyncType.EarlyTap ? 'EARLY TAP'
              : hit.desyncType === DesyncType.LateTap ? 'LATE TAP'
              : 'CURSOR DESYNC';
            label = isTap
              ? `${desyncName}: ${hit.timeOffset > 0 ? '+' : ''}${hit.timeOffset.toFixed(0)}ms (Δ ${hit.distanceToCenter.toFixed(1)}px)`
              : `${desyncName}: No tap`;
          } else if (isMiss) {
            label = hit.desyncType === DesyncType.MisaimInWindow
              ? `MISAIM (Δ ${hit.distanceToCenter.toFixed(1)}px)`
              : `MISS (Δ ${hit.distanceToCenter.toFixed(1)}px)`;
          } else {
            label = `${hit.judgement} (${hit.timeOffset > 0 ? '+' : ''}${hit.timeOffset.toFixed(0)}ms, Δ ${hit.distanceToCenter.toFixed(1)}px)`;
          }

          ctx.font = 'bold 10px -apple-system, sans-serif';
          const textWidth = ctx.measureText(label).width;
          const boxW = textWidth + 14;
          const boxH = 20;
          const tooltipAnchorX = hasTapAttribution ? hit.tapX : hit.targetX;
          const tooltipAnchorY = hasTapAttribution ? hit.tapY : hit.targetY;
          const boxX = Math.max(4, Math.min(512 - boxW - 4, tooltipAnchorX - boxW / 2));
          const boxY = Math.max(4, tooltipAnchorY - 26);

          ctx.fillStyle = 'rgba(14, 16, 22, 0.92)';
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(boxX, boxY, boxW, boxH, 4);
          } else {
            ctx.rect(boxX, boxY, boxW, boxH);
          }
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, boxX + boxW / 2, boxY + boxH / 2);

          ctx.restore();
        }

        ctx.restore();
      }
    }

    const cursorImg = (this.cursorImg && this.cursorImg.complete) ? this.cursorImg : this.cursorSprite;
    if (cursorImg) {
      ctx.save();
      const size = 120;
      const half = size / 2;
      ctx.drawImage(cursorImg, cx - half, cy - half, size, size);
      ctx.restore();
    }
  }
}
