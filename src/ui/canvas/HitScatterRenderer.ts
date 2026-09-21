import { TimedHitEvent, HitJudgement, DesyncType } from '../../core/types/telemetry.ts';

export class HitScatterRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private offscreenCanvas: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private isCacheValid: boolean = false;
  private hitEvents: TimedHitEvent[] = [];
  private activeEventIndex: number = -1;
  private resizeObserver: ResizeObserver | null = null;
  private lastRenderTime: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Failed to acquire Canvas 2D context for Hit Scatter');
    this.ctx = context;

    this.offscreenCanvas = document.createElement('canvas');
    const offContext = this.offscreenCanvas.getContext('2d');
    if (!offContext) throw new Error('Failed to acquire offscreen Canvas 2D context for Hit Scatter');
    this.offCtx = offContext;

    this.handleResize();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.handleResize();
        this.render(this.lastRenderTime);
      });
      this.resizeObserver.observe(this.canvas);
    }
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  public setData(hitEvents: TimedHitEvent[]): void {
    this.hitEvents = hitEvents;
    this.isCacheValid = false;
    this.handleResize();
  }

  public handleResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
      this.offscreenCanvas.width = targetW;
      this.offscreenCanvas.height = targetH;
      this.isCacheValid = false;
    }
  }

  public render(currentTimeMs: number): void {
    this.lastRenderTime = currentTimeMs;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w <= 60 || h <= 60) return;

    // Find active hit event within [-30, 250] ms of currentTimeMs
    this.activeEventIndex = -1;
    let closestTimeDelta = Infinity;
    let activeAlpha = 1.0;

    for (let i = 0; i < this.hitEvents.length; i++) {
      const delta = currentTimeMs - this.hitEvents[i].targetTime;
      if (delta >= -30 && delta <= 250) {
        const absDelta = Math.abs(delta);
        if (absDelta < closestTimeDelta) {
          closestTimeDelta = absDelta;
          this.activeEventIndex = i;
          if (delta > 80) {
            // Smooth fade-out from 80ms to 250ms
            activeAlpha = Math.max(0, 1.0 - (delta - 80) / 170);
          } else if (delta < 0) {
            activeAlpha = Math.max(0.3, 1 + delta / 30);
          } else {
            activeAlpha = 1.0;
          }
        }
      }
    }

    // Rebuild offscreen cache if needed (only on resize or new data)
    if (!this.isCacheValid) {
      this.renderOffscreenBackground();
      this.isCacheValid = true;
    }

    // 1. Blit cached 10% opacity background (instantaneous O(1) draw call)
    this.ctx.drawImage(this.offscreenCanvas, 0, 0);

    // 2. If an active note exists, render it on top with smooth fade
    if (this.activeEventIndex >= 0 && activeAlpha > 0.01) {
      const headerHeight = 44;
      const footerHeight = 48;
      const availH = Math.max(40, h - headerHeight - footerHeight);
      const availW = Math.max(40, w / 2 - 64);
      const radius = Math.max(12, Math.min(availW / 2.3, availH / 2.3));
      const leftCenterX = w * 0.25;
      const rightCenterX = w * 0.75;
      const centerY = headerHeight + availH / 2;

      this.renderActiveHitNote(this.ctx, leftCenterX, rightCenterX, centerY, radius, activeAlpha);
    }

    // 3. Render dynamic footer metrics with smooth fade
    this.renderMetricsFooter(this.ctx, w, h, activeAlpha);
  }

  /**
   * Pre-renders the static background, graph frames, and all scatter dots at 10% opacity into offscreen canvas.
   */
  private renderOffscreenBackground(): void {
    const ctx = this.offCtx;
    const w = this.offscreenCanvas.width;
    const h = this.offscreenCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#14151B';
    ctx.fillRect(0, 0, w, h);

    const headerHeight = 44;
    const footerHeight = 48;
    const availH = Math.max(40, h - headerHeight - footerHeight);
    const availW = Math.max(40, w / 2 - 64);
    const radius = Math.max(12, Math.min(availW / 2.3, availH / 2.3));
    const leftCenterX = w * 0.25;
    const rightCenterX = w * 0.75;
    const centerY = headerHeight + availH / 2;

    // 1. Draw Left Graph: ABSOLUTE (Screen Space)
    this.renderAbsoluteGraphBackground(ctx, leftCenterX, centerY, radius);

    // 2. Draw Right Graph: RELATIVE (Jump Aligned)
    this.renderRelativeGraphBackground(ctx, rightCenterX, centerY, radius);

    // 3. Draw All Scatter Dots at 10% Opacity
    ctx.save();
    ctx.globalAlpha = 0.12;

    for (let i = 0; i < this.hitEvents.length; i++) {
      const e = this.hitEvents[i];
      if (e.judgement === HitJudgement.Miss && e.desyncType === DesyncType.TrueAimMiss) continue;

      const dotColor = this.getHitColor(e);
      ctx.fillStyle = dotColor;

      // Absolute dot
      const normX = e.rawErrorX / e.circleRadius;
      const normY = e.rawErrorY / e.circleRadius;
      const absPx = leftCenterX + normX * radius;
      const absPy = centerY + normY * radius;
      ctx.beginPath();
      ctx.arc(absPx, absPy, 1.8, 0, Math.PI * 2);
      ctx.fill();

      // Relative dot
      const normLong = e.longitudinalError / e.circleRadius;
      const normLat = e.lateralError / e.circleRadius;
      const relPx = rightCenterX + normLong * radius;
      const relPy = centerY + normLat * radius;
      ctx.beginPath();
      ctx.arc(relPx, relPy, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // 4. Draw Permanent Legend at the bottom of the offscreen canvas
    this.renderPermanentLegend(ctx, w, h);
  }

  private renderAbsoluteGraphBackground(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number
  ): void {
    ctx.save();

    // Header Title & Subtitle
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ABSOLUTE (Screen Space)', cx, 20);

    ctx.fillStyle = '#6E7687';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText('Solid: 1.0R Hitcircle Boundary • Dashed: 80% Normal Aim Zone', cx, 34);

    // Outer boundary disc background (for out-of-circle stray misses)
    ctx.fillStyle = '#0E0F14';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius * 1.15), 0, Math.PI * 2);
    ctx.fill();

    // 80% Normal Aim Zone (Dashed subtle guide)
    ctx.strokeStyle = '#2E3548';
    ctx.lineWidth = 1.0;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius * 0.80), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 1.0 R Actual Hitcircle Boundary (Solid white perimeter ring)
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius), 0, Math.PI * 2);
    ctx.stroke();

    // Cross Axes
    ctx.strokeStyle = '#232632';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(cx - radius * 1.15, cy);
    ctx.lineTo(cx + radius * 1.15, cy);
    ctx.moveTo(cx, cy - radius * 1.15);
    ctx.lineTo(cx, cy + radius * 1.15);
    ctx.stroke();

    // Center Cross Dot
    ctx.fillStyle = '#6E7687';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Axis Labels
    ctx.fillStyle = '#6E7687';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('-Y (Top)', cx, cy - radius * 1.15 - 5);
    ctx.fillText('+Y (Bottom)', cx, cy + radius * 1.15 + 12);

    ctx.textAlign = 'right';
    ctx.fillText('-X', cx - radius * 1.15 - 6, cy + 3);
    ctx.textAlign = 'left';
    ctx.fillText('+X', cx + radius * 1.15 + 6, cy + 3);

    ctx.restore();
  }

  private renderRelativeGraphBackground(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number
  ): void {
    ctx.save();

    // Header Title & Subtitle
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('RELATIVE (Jump Aligned)', cx, 20);

    ctx.fillStyle = '#6E7687';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText('Jump-Aligned • Overaim / Underaim evaluated outside 80% Normal Aim Zone', cx, 34);

    // Outer boundary disc background (for out-of-circle stray misses)
    ctx.fillStyle = '#0E0F14';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius * 1.15), 0, Math.PI * 2);
    ctx.fill();

    // 80% Normal Aim Zone (Dashed subtle guide)
    ctx.strokeStyle = '#2E3548';
    ctx.lineWidth = 1.0;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius * 0.80), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 1.0 R Actual Hitcircle Boundary (Solid white perimeter ring)
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius), 0, Math.PI * 2);
    ctx.stroke();

    // Cross Axes
    ctx.strokeStyle = '#232632';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(cx - radius * 1.15, cy);
    ctx.lineTo(cx + radius * 1.15, cy);
    ctx.moveTo(cx, cy - radius * 1.15);
    ctx.lineTo(cx, cy + radius * 1.15);
    ctx.stroke();

    // Center Cross Dot
    ctx.fillStyle = '#6E7687';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Axis Labels
    ctx.font = 'bold 9px -apple-system, sans-serif';
    ctx.fillStyle = '#FF66AB';
    ctx.textAlign = 'right';
    ctx.fillText('← Underaim', cx - radius * 1.15 - 6, cy + 3);

    ctx.fillStyle = '#4AA4FF';
    ctx.textAlign = 'left';
    ctx.fillText('Overaim →', cx + radius * 1.15 + 6, cy + 3);

    ctx.fillStyle = '#6E7687';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Lateral Wobble', cx, cy - radius * 1.15 - 5);

    ctx.restore();
  }

  /**
   * Renders the active hit note at 100% opacity on top of both graphs with an eye-catching halo.
   */
  private renderActiveHitNote(
    ctx: CanvasRenderingContext2D,
    leftCenterX: number,
    rightCenterX: number,
    centerY: number,
    radius: number,
    alpha: number = 1.0
  ): void {
    const e = this.hitEvents[this.activeEventIndex];
    if (!e || alpha <= 0.01) return;
    if (e.judgement === HitJudgement.Miss && e.desyncType === DesyncType.TrueAimMiss) return;

    ctx.save();

    const dotColor = this.getHitColor(e);

    // 1. Absolute Active Note
    const normX = e.rawErrorX / e.circleRadius;
    const normY = e.rawErrorY / e.circleRadius;
    const absPx = leftCenterX + normX * radius;
    const absPy = centerY + normY * radius;

    // Glowing halo
    ctx.strokeStyle = dotColor;
    ctx.lineWidth = 3.0;
    ctx.globalAlpha = 0.35 * alpha;
    ctx.beginPath();
    ctx.arc(absPx, absPy, 6.5, 0, Math.PI * 2);
    ctx.stroke();

    // Core dot
    ctx.globalAlpha = alpha;
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(absPx, absPy, 4.0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // 2. Relative Active Note
    const normLong = e.longitudinalError / e.circleRadius;
    const normLat = e.lateralError / e.circleRadius;
    const relPx = rightCenterX + normLong * radius;
    const relPy = centerY + normLat * radius;

    ctx.strokeStyle = dotColor;
    ctx.lineWidth = 3.0;
    ctx.globalAlpha = 0.35 * alpha;
    ctx.beginPath();
    ctx.arc(relPx, relPy, 6.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = alpha;
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(relPx, relPy, 4.0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Permanent Color Legend drawn cleanly across the bottom bar.
   */
  private renderPermanentLegend(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.save();
    ctx.fillStyle = '#1D202B';
    ctx.fillRect(16, h - 18, w - 32, 1);

    ctx.font = 'bold 9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const items = [
      { color: '#4AA4FF', label: '300 (Great)' },
      { color: '#74D128', label: '100 (Ok)' },
      { color: '#FFCC22', label: '50 (Meh)' },
      { color: '#ED1121', label: 'Miss (Aim / Timing)' },
      { color: '#B87BFF', label: 'Desync Miss (Tapped outside)' }
    ];

    const spacing = Math.min(140, (w - 40) / items.length);
    const startX = w / 2 - ((items.length - 1) * spacing) / 2;
    const legendY = h - 8;

    items.forEach((item, idx) => {
      const itemX = startX + idx * spacing;

      // Colored bullet dot
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(itemX - 35, legendY, 3.2, 0, Math.PI * 2);
      ctx.fill();

      // Label
      ctx.fillStyle = '#A0A8B8';
      ctx.textAlign = 'left';
      ctx.fillText(item.label, itemX - 28, legendY);
    });

    ctx.restore();
  }

  private renderMetricsFooter(ctx: CanvasRenderingContext2D, _w: number, h: number, alpha: number = 1.0): void {
    ctx.save();
    const active = this.activeEventIndex >= 0 ? this.hitEvents[this.activeEventIndex] : null;

    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.textAlign = 'left';

    if (active && alpha > 0.05) {
      let judgeText = `Judgement: ${active.judgement}`;
      if (active.desyncType === DesyncType.EarlyTap) {
        judgeText = 'Judgement: Miss (Early Tap Desync - tapped before cursor reached circle)';
      } else if (active.desyncType === DesyncType.LateTap) {
        judgeText = 'Judgement: Miss (Late Tap Desync - tapped after cursor left circle)';
      } else if (active.judgement === HitJudgement.Miss) {
        if (active.key === 'NONE') {
          judgeText = 'Judgement: Miss (No Tap - cursor was inside circle but no key pressed)';
        } else if (active.distanceToCenter <= active.circleRadius) {
          judgeText = `Judgement: Miss (Timing Miss - tapped inside circle but ${Math.abs(active.timeOffset).toFixed(0)}ms ${active.timeOffset < 0 ? 'too early' : 'too late'} for hit window)`;
        } else {
          judgeText = 'Judgement: Miss (Aim Miss - cursor outside circle)';
        }
      }

      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#4AA4FF';
      ctx.fillText(`HIT #${active.objectIndex}: `, 20, h - 26);

      const offset = ctx.measureText(`HIT #${active.objectIndex}: `).width + 20;
      ctx.fillStyle = '#8A92A0';

      const longErr = active.longitudinalError;
      const marginPct = active.marginUsagePercent;
      const isMiss = active.judgement === HitJudgement.Miss;

      // Inside 80% radius is considered normal aim. Overaim/Underaim only affects play when outside 80% (near miss / miss)
      let aimBias = '';
      if (marginPct > 80 || isMiss) {
        const longRatio = longErr / active.circleRadius;
        if (longRatio > 0.4) {
          aimBias = isMiss ? 'Overaim (Miss)' : 'Overaim (Near Miss)';
        } else if (longRatio < -0.4) {
          aimBias = isMiss ? 'Underaim (Miss)' : 'Underaim (Near Miss)';
        } else {
          aimBias = isMiss ? 'Off Target (Lateral Miss)' : 'Edge Hit (Lateral)';
        }
      }

      const biasTag = aimBias ? ` (${aimBias})` : '';

      ctx.fillText(
        `Margin: ${active.marginUsagePercent.toFixed(1)}% | ` +
        `Longitudinal: ${longErr > 0 ? '+' : ''}${longErr.toFixed(1)}px${biasTag} | ` +
        `Lateral: ±${Math.abs(active.lateralError).toFixed(1)}px | ${judgeText}`,
        offset,
        h - 26
      );
    } else {
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = '#5A6272';
      ctx.fillText(
        `HIT SCATTER: Showing ${this.hitEvents.length} hit objects • Play replay or scrub to inspect individual notes`,
        20,
        h - 26
      );
    }
    ctx.restore();
  }

  /**
   * Default osu! skin judgement color mapping:
   * 300 (Great): Blue
   * 100 (Ok): Green
   * 50 (Meh): Yellow
   * Desync: Lavender/Purple
   * Miss: Red
   */
  private getHitColor(e: TimedHitEvent): string {
    if (e.desyncType === DesyncType.EarlyTap || e.desyncType === DesyncType.LateTap || e.desyncType === DesyncType.SpeedMiss) {
      return '#B87BFF'; // Lavender (desync)
    }
    if (e.judgement === HitJudgement.Great) return '#4AA4FF'; // osu! Blue (300)
    if (e.judgement === HitJudgement.Ok) return '#74D128';    // osu! Green (100)
    if (e.judgement === HitJudgement.Meh) return '#FFCC22';   // osu! Yellow (50)
    return '#ED1121'; // osu! Red (Miss)
  }
}
