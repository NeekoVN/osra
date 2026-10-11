import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { EvaluationResult, KeyInterval } from '../../core/evaluator/ReplayEvaluator.ts';
import { Beatmap } from '../../core/types/beatmap.ts';
import { HitJudgement, DesyncType } from '../../core/types/telemetry.ts';
import { TimeBus } from '../TimeBus.ts';
import { TapPatternClassifier } from '../../core/evaluator/TapPatternClassifier.ts';
import { getDiffColor, getDiffTextColor, getDifficultyStrokeColor } from '../../core/math/ColorHelper.ts';
import {
  calculateRollingDifficulty,
  getDifficultyAtTime,
  RollingDifficultyResult
} from '../../core/math/RollingDifficulty.ts';

const CHART_ICONS = {
  zoomIn: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>`,
  zoomOut: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>`,
  reset: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg>`,
  lock: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
  pin: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>`,
  expand: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>`,
  collapse: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="10" y1="14" x2="3" y2="21"></line></svg>`
};

export interface ChannelRegistration {
  wrap: HTMLElement;
  chart: uPlot;
  defaultHeight: number;
  expandedHeight: number;
}

export class TelemetryCharts {
  private container: HTMLElement;
  private timeBus: TimeBus;
  private syncKey: string = 'osraTimelineSync';
  public readonly charts: uPlot[] = [];
  private channels: ChannelRegistration[] = [];
  public onExpandStateChange?: (allExpanded: boolean) => void;
  private playheadEl: HTMLElement | null = null;
  private playheadBadge: HTMLElement | null = null;
  private evalResult: EvaluationResult | null = null;
  private unsubscribeTimeBus: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Zoom & Pan & Scrubber Lock State
  private followScrubber: boolean = false;
  private scrollWindowMs: number = 8000;
  private minTime: number = 0;
  private maxTime: number = 1000;
  private currentMin: number = 0;
  private currentMax: number = 1000;
  private btnLock: HTMLElement | null = null;

  // Key Overlay State
  private keyTileK1: HTMLElement | null = null;
  private keyTileK2: HTMLElement | null = null;
  private keyCountK1: HTMLElement | null = null;
  private keyCountK2: HTMLElement | null = null;
  private keyBpmK1: HTMLElement | null = null;
  private keyBpmK2: HTMLElement | null = null;
  private keyLiveBpm: HTMLElement | null = null;
  private k1CumulativeTaps: Uint32Array | null = null;
  private k2CumulativeTaps: Uint32Array | null = null;
  private firstRowEl: HTMLElement | null = null;
  private rollingResult: RollingDifficultyResult | null = null;
  private diffChipEl: HTMLElement | null = null;
  private diffChipStarEl: HTMLElement | null = null;
  private diffChipValEl: HTMLElement | null = null;
  private diffAimValEl: HTMLElement | null = null;
  private diffSpeedValEl: HTMLElement | null = null;
  private diffReadingValEl: HTMLElement | null = null;

  constructor(container: HTMLElement, timeBus: TimeBus) {
    this.container = container;
    this.timeBus = timeBus;
  }

  public setFollowScrubber(follow: boolean): void {
    this.followScrubber = follow;
    if (this.btnLock) {
      this.btnLock.setAttribute('aria-pressed', String(follow));
      this.btnLock.classList.toggle('is-active', follow);
      const iconSpan = this.btnLock.querySelector('.lock-icon') as HTMLElement | null;
      if (iconSpan) {
        iconSpan.innerHTML = follow ? CHART_ICONS.pin : CHART_ICONS.lock;
      }
      this.btnLock.title = follow
        ? 'Scrubber Locked (Click to Unlock)'
        : 'Lock playhead centered while timeline scrolls smoothly';
    }
  }

  public isFollowScrubber(): boolean {
    return this.followScrubber;
  }

  public destroy(): void {
    if (this.unsubscribeTimeBus) {
      this.unsubscribeTimeBus();
      this.unsubscribeTimeBus = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.charts.forEach(c => c.destroy());
    this.charts.length = 0;
    this.channels = [];
    this.playheadEl = null;
    this.playheadBadge = null;
    this.keyTileK1 = null;
    this.keyTileK2 = null;
    this.keyCountK1 = null;
    this.keyCountK2 = null;
    this.keyBpmK1 = null;
    this.keyBpmK2 = null;
    this.keyLiveBpm = null;
    this.k1CumulativeTaps = null;
    this.k2CumulativeTaps = null;
    this.firstRowEl = null;
    this.rollingResult = null;
    this.diffChipEl = null;
    this.diffChipStarEl = null;
    this.diffChipValEl = null;
    this.diffAimValEl = null;
    this.diffSpeedValEl = null;
    this.diffReadingValEl = null;
    this.scrollWindowMs = 8000;
    this.followScrubber = false;
    this.btnLock = null;
  }

  public async setData(
    evalResult: EvaluationResult,
    beatmap?: Beatmap,
    mods: number = 0,
    clockRate: number = 1.0
  ): Promise<void> {
    this.destroy();
    this.evalResult = evalResult;
    this.container.innerHTML = '';

    if (beatmap) {
      try {
        this.rollingResult = await calculateRollingDifficulty(beatmap, {
          mods,
          clockRate,
          stepMs: 400,
          windowDurationMs: 4000
        });
      } catch (err) {
        console.warn('Failed to calculate rolling difficulty:', err);
      }
    }

    const getAvailableWidth = () => Math.max(300, (this.container.clientWidth || 1200) - 58);
    const width = getAvailableWidth();

    // OD Windows calculation
    const od = beatmap ? beatmap.difficulty.overallDifficulty : 9.0;
    const w300 = Math.floor(80 - 6 * od) - 0.5;
    const w100 = Math.floor(140 - 8 * od) - 0.5;
    const w50 = Math.floor(200 - 10 * od) - 0.5;

    // Common timeline bounds
    this.minTime = Math.min(
      evalResult.timePoints[0] ?? 0,
      evalResult.keyTimes[0] ?? 0
    );
    this.maxTime = Math.max(
      evalResult.timePoints[evalResult.timePoints.length - 1] ?? 1,
      evalResult.keyTimes[evalResult.keyTimes.length - 1] ?? 1
    );
    this.currentMin = this.minTime;
    this.currentMax = this.maxTime;

    // Precompute cumulative tap counts for real-time key overlay HUD
    const nFrames = evalResult.k1Frames.length;
    this.k1CumulativeTaps = new Uint32Array(nFrames);
    this.k2CumulativeTaps = new Uint32Array(nFrames);
    let c1 = 0;
    let c2 = 0;
    for (let i = 0; i < nFrames; i++) {
      if (evalResult.k1Frames[i] === 1 && (i === 0 || evalResult.k1Frames[i - 1] === 0)) c1++;
      if (evalResult.k2Frames[i] === 1 && (i === 0 || evalResult.k2Frames[i - 1] === 0)) c2++;
      this.k1CumulativeTaps[i] = c1;
      this.k2CumulativeTaps[i] = c2;
    }

    // -------------------------------------------------------------
    // Top Navigation & Control Toolbar
    // -------------------------------------------------------------
    this.renderToolbar();

    // Build uPlot sync group
    const sync = uPlot.sync(this.syncKey);

    // -------------------------------------------------------------
    // 1. Channel 1: Hit Error & OD Windows (osu! default colors)
    // -------------------------------------------------------------
    const ch1Row = this.createChannelContainer(
      'Hit Error',
      '<span style="color:#FF6666;">― Miss</span> • <span style="color:#B87BFF;">― Desync</span> • <span style="color:#8B5CF6;">▮ Stream</span> • <span style="color:#F43F5E;">▮ Deathstream</span> • <span style="color:#FFFFFF;">― Rolling Mean</span>',
      'ch1'
    );
    this.firstRowEl = ch1Row.wrap;

    const ch1Data: uPlot.AlignedData = [
      evalResult.timePoints,
      evalResult.hitOffsets,
      evalResult.rollingMean
    ];

    const ch1Chart = new uPlot(
      {
        width,
        height: 100,
        legend: { show: false },
        cursor: { sync: { key: sync.key, setSeries: true } },
        scales: {
          x: { time: false, min: this.minTime, max: this.maxTime },
          y: { range: [-120, 120] }
        },
        axes: [
          { show: false },
          { stroke: '#A68E99', label: 'Δt (ms)', size: 50, grid: { stroke: '#33272D' } }
        ],
        series: [
          {},
          {
            label: 'Hit Offset',
            stroke: 'transparent',
            points: { show: false }
          },
          {
            label: 'Rolling Mean',
            stroke: 'transparent',
            width: 0.75,
            points: { show: false }
          }
        ],
        hooks: {
          drawClear: [
            (u) => {
              const left = u.bbox.left;
              const w = u.bbox.width;

              const y50Top = u.valToPos(w50, 'y', true);
              const y50Bot = u.valToPos(-w50, 'y', true);
              const y100Top = u.valToPos(w100, 'y', true);
              const y100Bot = u.valToPos(-w100, 'y', true);
              const y300Top = u.valToPos(w300, 'y', true);
              const y300Bot = u.valToPos(-w300, 'y', true);
              const yZero = u.valToPos(0, 'y', true);

              // 50 Band (subtle dark amber/yellow)
              u.ctx.fillStyle = '#262010';
              u.ctx.fillRect(left, y50Top, w, Math.max(0, y50Bot - y50Top));

              // 100 Band (subtle dark green)
              u.ctx.fillStyle = '#122616';
              u.ctx.fillRect(left, y100Top, w, Math.max(0, y100Bot - y100Top));

              // 300 Band (subtle dark blue)
              u.ctx.fillStyle = '#101E2E';
              u.ctx.fillRect(left, y300Top, w, Math.max(0, y300Bot - y300Top));

              // Zero center line
              u.ctx.strokeStyle = '#263B4D';
              u.ctx.lineWidth = 1;
              u.ctx.beginPath();
              u.ctx.moveTo(left, yZero);
              u.ctx.lineTo(left + w, yZero);
              u.ctx.stroke();

              // Stream and Deathstream Range Overlays
              // Purple for streams (distinct from desync #B87BFF) and Red for deathstreams (distinct from miss #FF6666)
              const patterns = evalResult.tapPatterns || [];
              const chartTop = u.bbox.top;
              const chartHeight = u.bbox.height;
              const chartRight = left + w;

              for (let p = 0; p < patterns.length; p++) {
                const pat = patterns[p];
                if (pat.type !== 'stream' && pat.type !== 'deathstream') continue;

                const startPx = u.valToPos(pat.startTime, 'x', true);
                const endPx = u.valToPos(pat.endTime, 'x', true);

                if (endPx < left || startPx > chartRight) continue;

                const x1 = Math.max(left, startPx);
                const x2 = Math.min(chartRight, endPx);
                const spanW = Math.max(2, x2 - x1);

                const isStream = pat.type === 'stream';
                // Distinct stream purple / deathstream red
                const fillColor = isStream ? 'rgba(124, 58, 237, 0.20)' : 'rgba(225, 29, 72, 0.24)';
                const borderColor = isStream ? 'rgba(124, 58, 237, 0.70)' : 'rgba(225, 29, 72, 0.80)';
                const tagColor = isStream ? '#C4B5FD' : '#FDA4AF';

                // Shaded duration overlay
                u.ctx.fillStyle = fillColor;
                u.ctx.fillRect(x1, chartTop, spanW, chartHeight);

                // Subtle vertical boundary edges
                u.ctx.strokeStyle = borderColor;
                u.ctx.lineWidth = 1;
                if (startPx >= left && startPx <= chartRight) {
                  u.ctx.beginPath();
                  u.ctx.moveTo(startPx, chartTop);
                  u.ctx.lineTo(startPx, chartTop + chartHeight);
                  u.ctx.stroke();
                }
                if (endPx >= left && endPx <= chartRight) {
                  u.ctx.beginPath();
                  u.ctx.moveTo(endPx, chartTop);
                  u.ctx.lineTo(endPx, chartTop + chartHeight);
                  u.ctx.stroke();
                }

                // Top accent stripe
                u.ctx.fillStyle = borderColor;
                u.ctx.fillRect(x1, chartTop, spanW, 2.5);

                // Label badge if span has enough space
                if (spanW > 35) {
                  u.ctx.fillStyle = tagColor;
                  u.ctx.font = 'bold 9px -apple-system, sans-serif';
                  u.ctx.textAlign = 'left';
                  u.ctx.textBaseline = 'top';
                  const label = isStream ? `STREAM (${pat.noteCount})` : `DEATHSTREAM (${pat.noteCount})`;
                  u.ctx.fillText(label, x1 + 4, chartTop + 4);
                }
              }
            }
          ],
          draw: [
            (u) => {
              const curTime = this.timeBus.getCurrentTime();
              const hits = evalResult.hitEvents;
              const yZero = u.valToPos(0, 'y', true);
              const top = u.bbox.top;
              const bot = top + u.bbox.height;

              // 1. Draw Rolling Mean line UNDER the dots (0.75 width, subtle white)
              const timePts = evalResult.timePoints;
              const rMean = evalResult.rollingMean;
              if (timePts && rMean && timePts.length > 0) {
                u.ctx.save();
                u.ctx.beginPath();
                u.ctx.rect(u.bbox.left, top, u.bbox.width, u.bbox.height);
                u.ctx.clip();

                u.ctx.strokeStyle = 'rgba(255, 255, 255, 0.70)';
                u.ctx.lineWidth = 0.75;
                u.ctx.beginPath();

                const chartLeft = u.bbox.left;
                const chartRight = chartLeft + u.bbox.width;
                const minVisibleTime = u.scales.x?.min ?? this.minTime;
                const maxVisibleTime = u.scales.x?.max ?? this.maxTime;

                // Find indices spanning the visible window plus 1 point on each side to prevent clipping drops
                let startIdx = 0;
                while (startIdx < timePts.length - 1 && timePts[startIdx + 1] < minVisibleTime) {
                  startIdx++;
                }
                let endIdx = startIdx;
                while (endIdx < timePts.length - 1 && timePts[endIdx] < maxVisibleTime) {
                  endIdx++;
                }

                // If first hit is after chartLeft, lead in with horizontal line at initial mean
                const x0 = u.valToPos(timePts[0], 'x', true);
                const y0 = u.valToPos(rMean[0], 'y', true);
                if (x0 > chartLeft && startIdx === 0) {
                  u.ctx.moveTo(chartLeft, y0);
                  u.ctx.lineTo(x0, y0);
                } else {
                  u.ctx.moveTo(u.valToPos(timePts[startIdx], 'x', true), u.valToPos(rMean[startIdx], 'y', true));
                }

                for (let k = startIdx; k <= endIdx; k++) {
                  const x = u.valToPos(timePts[k], 'x', true);
                  const y = u.valToPos(rMean[k], 'y', true);
                  u.ctx.lineTo(x, y);
                }

                // If last hit is before chartRight, extend to chartRight with last mean
                const lastK = timePts.length - 1;
                const xLast = u.valToPos(timePts[lastK], 'x', true);
                const yLast = u.valToPos(rMean[lastK], 'y', true);
                if (xLast < chartRight && endIdx === lastK) {
                  u.ctx.lineTo(chartRight, yLast);
                }

                u.ctx.stroke();
                u.ctx.restore();
              }

              // 2. Draw Hit dots on top of the rolling mean line
              for (let i = 0; i < hits.length; i++) {
                const ev = hits[i];
                const px = u.valToPos(ev.targetTime, 'x', true);
                if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue;

                const isCurrent = Math.abs(ev.targetTime - curTime) < 80;
                const isDesync = ev.desyncType === DesyncType.EarlyTap || ev.desyncType === DesyncType.LateTap || ev.desyncType === DesyncType.SpeedMiss;

                // Desync notes (Early/Late Tap) indicated by a thin lavender line across chart and purple dot
                if (isDesync) {
                  u.ctx.strokeStyle = isCurrent ? '#F3E8FF' : 'rgba(184, 123, 255, 0.55)';
                  u.ctx.lineWidth = 1;
                  u.ctx.beginPath();
                  u.ctx.moveTo(px, top);
                  u.ctx.lineTo(px, bot);
                  u.ctx.stroke();

                  const py = ev.key !== 'NONE'
                    ? Math.max(top + 3, Math.min(bot - 3, u.valToPos(ev.timeOffset, 'y', true)))
                    : yZero;

                  u.ctx.fillStyle = '#B87BFF';
                  u.ctx.beginPath();
                  u.ctx.arc(px, py, isCurrent ? 3.2 : 1.8, 0, Math.PI * 2);
                  u.ctx.fill();

                  if (isCurrent) {
                    u.ctx.strokeStyle = '#FFFFFF';
                    u.ctx.lineWidth = 1.0;
                    u.ctx.stroke();
                  }
                  continue;
                }

                // Genuine Aim Miss notes indicated by a thin red line with a red dot at 0ms mark
                if (ev.judgement === HitJudgement.Miss) {
                  u.ctx.strokeStyle = isCurrent ? '#FF3344' : 'rgba(255, 102, 102, 0.7)';
                  u.ctx.lineWidth = 1;
                  u.ctx.beginPath();
                  u.ctx.moveTo(px, top);
                  u.ctx.lineTo(px, bot);
                  u.ctx.stroke();

                  u.ctx.fillStyle = '#FF6666';
                  u.ctx.beginPath();
                  u.ctx.arc(px, yZero, isCurrent ? 3.2 : 1.8, 0, Math.PI * 2);
                  u.ctx.fill();

                  if (isCurrent) {
                    u.ctx.strokeStyle = '#FFFFFF';
                    u.ctx.lineWidth = 1.0;
                    u.ctx.stroke();
                  }
                  continue;
                }

                // Regular Hit dot (300, 100, 50)
                const py = u.valToPos(ev.timeOffset, 'y', true);

                let col = '#66CCFF'; // osu! 300 Blue
                if (ev.judgement === HitJudgement.Ok) {
                  col = '#99EB47'; // osu! 100 Green
                } else if (ev.judgement === HitJudgement.Meh) {
                  col = '#EBC247'; // osu! 50 Yellow
                }

                u.ctx.fillStyle = col;
                u.ctx.beginPath();
                u.ctx.arc(px, py, isCurrent ? 3.2 : 1.8, 0, Math.PI * 2);
                u.ctx.fill();

                if (isCurrent) {
                  u.ctx.strokeStyle = '#FFFFFF';
                  u.ctx.lineWidth = 1.0;
                  u.ctx.stroke();
                }
              }
            }
          ]
        }
      },
      ch1Data,
      ch1Row.chartBody
    );
    this.charts.push(ch1Chart);
    this.channels.push({
      wrap: ch1Row.wrap,
      chart: ch1Chart,
      defaultHeight: 100,
      expandedHeight: 260
    });
    if (ch1Row.expandBtn) {
      ch1Row.expandBtn.onclick = (e) => {
        e.stopPropagation();
        this.toggleChannelExpand(ch1Row.wrap, ch1Chart, 100, 260);
        this.notifyExpandStateChange();
      };
    }

    // Helpers for dynamic Star Rating scale line spacing and grid calculation
    const computeDifficultyYMax = (peakSR: number): number => {
      const target = Math.max(4.0, peakSR * 1.12);
      if (target > 16) {
        return Math.ceil(target / 4) * 4;
      } else if (target > 10) {
        return Math.ceil(target / 2) * 2;
      } else if (target > 6) {
        return Math.ceil(target / 2) * 2;
      } else {
        return Math.ceil(target);
      }
    };

    const getDifficultyStep = (maxVal: number, plotHeight: number): number => {
      if (plotHeight < 120) {
        // Compact mode (85px total height, plot height ~60-65px)
        if (maxVal > 16) return 5;
        if (maxVal > 10) return 4;
        if (maxVal > 5) return 2;
        return 1;
      } else {
        // Expanded mode (240px total height, plot height ~215px)
        if (maxVal > 24) return 5;
        if (maxVal > 16) return 4;
        return 2;
      }
    };

    // -------------------------------------------------------------
    // Channel: Rolling Difficulty (Directly below Hit Error)
    // -------------------------------------------------------------
    let diffRowWrap: HTMLElement | null = null;
    if (this.rollingResult && this.rollingResult.points.length > 0) {
      const rollingResult = this.rollingResult;
      const peakSR = rollingResult.maxStarRating || 5.0;
      const meanSR = rollingResult.averageStarRating || 0.0;
      const yMax = computeDifficultyYMax(peakSR);

      const diffRow = this.createChannelContainer(
        'Difficulty',
        '',
        'ch-diff'
      );
      diffRowWrap = diffRow.wrap;

      // Create persistent live Difficulty HUD with 200ms color transition chip
      const diffHud = document.createElement('div');
      diffHud.className = 'diff-header-hud';
      diffHud.style.display = 'inline-flex';
      diffHud.style.alignItems = 'center';
      diffHud.style.gap = '8px';

      diffHud.innerHTML = `
        <span class="sr-pill diff-sr-chip" id="diff-live-sr-chip">
          <i id="diff-live-sr-star" class="sr-star fa-solid fa-star"></i>
          <span id="diff-live-sr-val">0.00</span>
        </span>
        <span class="telemetry-subtitle" id="diff-live-stats" style="margin-left: 2px;">
          Aim <span id="diff-live-aim" style="color:#FF8068;font-weight:600;">0.00</span>
          &nbsp;•&nbsp; Spd <span id="diff-live-speed" style="color:#4FFFD5;font-weight:600;">0.00</span>
          &nbsp;•&nbsp; Read <span id="diff-live-reading" style="color:#C645B8;font-weight:600;">0.00</span>
          &nbsp;•&nbsp; Peak <span style="color:#FFFFFF;font-weight:600;">${peakSR.toFixed(2)}★</span>
          &nbsp;•&nbsp; Mean <span style="color:#A68E99;">${meanSR.toFixed(2)}★</span>
        </span>
      `;

      const oldSubtitle = diffRow.headerLeft.querySelector('.telemetry-subtitle');
      if (oldSubtitle) oldSubtitle.remove();
      diffRow.headerLeft.appendChild(diffHud);

      this.diffChipEl = diffHud.querySelector('#diff-live-sr-chip');
      this.diffChipStarEl = diffHud.querySelector('#diff-live-sr-star');
      this.diffChipValEl = diffHud.querySelector('#diff-live-sr-val');
      this.diffAimValEl = diffHud.querySelector('#diff-live-aim');
      this.diffSpeedValEl = diffHud.querySelector('#diff-live-speed');
      this.diffReadingValEl = diffHud.querySelector('#diff-live-reading');

      const diffTimes = rollingResult.points.map(p => p.timeMs);
      const diffStars = rollingResult.points.map(p => p.starRating);

      // Pad boundary times if needed to match timeline range
      if (diffTimes[0] > this.minTime) {
        diffTimes.unshift(this.minTime);
        diffStars.unshift(0);
      }
      if (diffTimes[diffTimes.length - 1] < this.maxTime) {
        diffTimes.push(this.maxTime);
        diffStars.push(0);
      }

      const diffData: uPlot.AlignedData = [
        new Float64Array(diffTimes),
        new Float64Array(diffStars)
      ];

      const diffChart = new uPlot(
        {
          width,
          height: 85,
          legend: { show: false },
          cursor: { sync: { key: sync.key, setSeries: true } },
          scales: {
            x: { time: false, min: this.minTime, max: this.maxTime },
            y: { range: [0, yMax] }
          },
          axes: [
            { show: false },
            {
              stroke: '#A68E99',
              label: '★ Stars',
              size: 50,
              grid: { show: false },
              splits: (u: uPlot) => {
                const h = u.bbox.height;
                const max = u.scales.y.max ?? yMax;
                const step = getDifficultyStep(max, h);
                const splits: number[] = [];
                for (let s = 0; s <= max + 0.001; s += step) {
                  splits.push(s);
                }
                return splits;
              },
              values: (_u, vals) => vals.map(v => `${v}★`)
            }
          ],
          series: [
            {},
            {
              label: 'Rolling Difficulty',
              stroke: 'transparent',
              fill: 'transparent',
              points: { show: false }
            }
          ],
          hooks: {
            drawClear: [
              (u) => {
                const left = u.bbox.left;
                const top = u.bbox.top;
                const w = u.bbox.width;
                const h = u.bbox.height;
                const yBottom = u.valToPos(0, 'y', true);
                const yTop = u.valToPos(yMax, 'y', true);

                u.ctx.save();
                // 1. Rounded corner clip for chart area (specs: rounded corners)
                u.ctx.beginPath();
                u.ctx.roundRect(left, top, w, h, 8);
                u.ctx.clip();

                // 2. Official Difficulty Gradient (vertical: 0★ at bottom to yMax at top)
                const vertGrad = u.ctx.createLinearGradient(0, yBottom, 0, yTop);
                const gradientSteps = 30;
                for (let s = 0; s <= gradientSteps; s++) {
                  const ratio = s / gradientSteps;
                  const rating = ratio * yMax;
                  vertGrad.addColorStop(ratio, getDiffColor(rating));
                }

                // 3. Low-opacity gradient background (gray at bottom, black top)
                u.ctx.globalAlpha = 0.16;
                u.ctx.fillStyle = vertGrad;
                u.ctx.fillRect(left, top, w, h);

                // 4. Subtle star threshold guidelines synchronized with axis step
                const step = getDifficultyStep(yMax, h);
                u.ctx.lineWidth = 1;
                for (let s = step; s < yMax; s += step) {
                  const sy = u.valToPos(s, 'y', true);
                  if (sy >= top && sy <= yBottom) {
                    u.ctx.globalAlpha = 0.08;
                    u.ctx.strokeStyle = '#FFFFFF';
                    u.ctx.beginPath();
                    u.ctx.moveTo(left, sy);
                    u.ctx.lineTo(left + w, sy);
                    u.ctx.stroke();
                  }
                }

                // 5. Map data points to screen coordinates
                const rawPoints = rollingResult.points;
                const screenPts: { x: number; y: number; rating: number }[] = [];
                for (let i = 0; i < rawPoints.length; i++) {
                  const pt = rawPoints[i];
                  const px = u.valToPos(pt.timeMs, 'x', true);
                  const py = u.valToPos(pt.starRating, 'y', true);
                  screenPts.push({ x: px, y: py, rating: pt.starRating });
                }

                if (screenPts.length >= 2) {
                  // 6. Chart fill itself in full opacity, masked per calculated rolling difficulty
                  u.ctx.save();
                  u.ctx.beginPath();
                  u.ctx.moveTo(screenPts[0].x, yBottom);
                  u.ctx.lineTo(screenPts[0].x, screenPts[0].y);
                  this.traceMonotoneSpline(u.ctx, screenPts);
                  u.ctx.lineTo(screenPts[screenPts.length - 1].x, yBottom);
                  u.ctx.closePath();
                  u.ctx.clip();

                  u.ctx.globalAlpha = 0.88;
                  u.ctx.fillStyle = vertGrad;
                  u.ctx.fillRect(left, top, w, h);
                  u.ctx.restore();

                  // 7. Thin line to add contrast (white if < 6.5*, mirroring ColorHelper if >= 6.5*)
                  u.ctx.save();
                  u.ctx.beginPath();
                  u.ctx.moveTo(screenPts[0].x, screenPts[0].y);
                  this.traceMonotoneSpline(u.ctx, screenPts);

                  const strokeGrad = u.ctx.createLinearGradient(left, 0, left + w, 0);
                  let lastStop = 0;
                  const firstColor = getDifficultyStrokeColor(screenPts[0].rating);
                  strokeGrad.addColorStop(0, firstColor);

                  for (let i = 0; i < screenPts.length; i++) {
                    const stop = Math.max(0, Math.min(1, (screenPts[i].x - left) / w));
                    if (stop >= lastStop) {
                      strokeGrad.addColorStop(stop, getDifficultyStrokeColor(screenPts[i].rating));
                      lastStop = stop;
                    }
                  }
                  if (lastStop < 1) {
                    strokeGrad.addColorStop(1, getDifficultyStrokeColor(screenPts[screenPts.length - 1].rating));
                  }

                  u.ctx.globalAlpha = 1.0;
                  u.ctx.strokeStyle = strokeGrad;
                  u.ctx.lineWidth = 3;
                  u.ctx.stroke();
                  u.ctx.restore();
                }

                u.ctx.restore(); // restores rounded clip
              }
            ]
          }
        },
        diffData,
        diffRow.chartBody
      );

      this.charts.push(diffChart);
      this.channels.push({
        wrap: diffRow.wrap,
        chart: diffChart,
        defaultHeight: 85,
        expandedHeight: 240
      });

      if (diffRow.expandBtn) {
        diffRow.expandBtn.onclick = (e) => {
          e.stopPropagation();
          this.toggleChannelExpand(diffRow.wrap, diffChart, 85, 240);
          this.notifyExpandStateChange();
        };
      }

      this.updateDifficultyHud(this.minTime);
    }

    // -------------------------------------------------------------
    // 2. Channel 2: Tapping Dynamics (2K osu!mania Flipped Horizontal)
    // -------------------------------------------------------------
    const ch2Row = this.createChannelContainer(
      'Tapping',
      '<span style="color:#00D8FF;">■ Lane 1 (K1)</span> &nbsp;•&nbsp; <span style="color:#FF66AB;">■ Lane 2 (K2)</span> &nbsp;•&nbsp; <span style="color:#F59E0B;">― Finger Lock</span>',
      'ch2',
      false
    );

    // Add Live Key Overlay Tile Display into the Channel 2 Header
    this.attachKeyOverlayHud(ch2Row.headerLeft);

    const dummyData = new Float64Array(evalResult.keyTimes.length);
    const ch2Data: uPlot.AlignedData = [
      evalResult.keyTimes,
      dummyData
    ];
    const ch2Chart = new uPlot(
      {
        width,
        height: 90,
        legend: { show: false },
        cursor: { sync: { key: sync.key, setSeries: true } },
        scales: {
          x: { time: false, min: this.minTime, max: this.maxTime },
          y: { range: [0, 2] }
        },
        axes: [
          { show: false },
          {
            stroke: '#A68E99',
            label: 'Lanes',
            size: 50,
            grid: { show: false },
            ticks: { show: false },
            splits: [0.5, 1.5],
            values: (_u, vals) => vals.map(v => (v === 1.5 ? 'K1' : v === 0.5 ? 'K2' : ''))
          }
        ],
        series: [
          {},
          {
            label: 'Mania',
            stroke: 'transparent',
            points: { show: false }
          }
        ],
        hooks: {
          draw: [
            (u) => {
              const left = u.bbox.left;
              const top = u.bbox.top;
              const w = u.bbox.width;
              const h = u.bbox.height;
              const curTime = this.timeBus.getCurrentTime();

              const laneGap = 6;
              const lanePad = 4;
              const availableH = h - 2 * lanePad - laneGap;
              const laneH = Math.max(16, Math.floor(availableH / 2));

              const k1Y = top + lanePad;
              const k2Y = k1Y + laneH + laneGap;

              const xMin = u.scales.x.min ?? this.minTime;
              const xMax = u.scales.x.max ?? this.maxTime;

              u.ctx.save();
              u.ctx.beginPath();
              u.ctx.rect(left, top, w, h);
              u.ctx.clip();

              // --- Lane 1 (K1) Background Track ---
              u.ctx.fillStyle = '#090E17';
              u.ctx.fillRect(left, k1Y, w, laneH);
              u.ctx.strokeStyle = 'rgba(0, 216, 255, 0.2)';
              u.ctx.lineWidth = 1;
              u.ctx.strokeRect(left, k1Y, w, laneH);

              u.ctx.strokeStyle = 'rgba(0, 216, 255, 0.06)';
              u.ctx.beginPath();
              u.ctx.moveTo(left, k1Y + laneH / 2);
              u.ctx.lineTo(left + w, k1Y + laneH / 2);
              u.ctx.stroke();

              // --- Lane 2 (K2) Background Track ---
              u.ctx.fillStyle = '#140914';
              u.ctx.fillRect(left, k2Y, w, laneH);
              u.ctx.strokeStyle = 'rgba(255, 102, 171, 0.2)';
              u.ctx.lineWidth = 1;
              u.ctx.strokeRect(left, k2Y, w, laneH);

              u.ctx.strokeStyle = 'rgba(255, 102, 171, 0.06)';
              u.ctx.beginPath();
              u.ctx.moveTo(left, k2Y + laneH / 2);
              u.ctx.lineTo(left + w, k2Y + laneH / 2);
              u.ctx.stroke();

              // --- Draw K1 Horizontal Mania Notes ---
              const k1Ints = evalResult.k1Intervals;
              const notePadY = 3;
              const noteH = laneH - 2 * notePadY;
              const noteY1 = k1Y + notePadY;

              for (let i = 0; i < k1Ints.length; i++) {
                const item = k1Ints[i];
                if (item.releaseTime < xMin || item.pressTime > xMax) continue;

                const xStart = u.valToPos(item.pressTime, 'x', true);
                const xEnd = u.valToPos(item.releaseTime, 'x', true);
                const barW = Math.max(5, xEnd - xStart);
                const isHeld = curTime >= item.pressTime && curTime <= item.releaseTime;

                if (isHeld) {
                  u.ctx.fillStyle = '#00D8FF';
                  u.ctx.fillRect(xStart, noteY1, barW, noteH);
                  u.ctx.strokeStyle = '#FFFFFF';
                  u.ctx.lineWidth = 1.5;
                  u.ctx.strokeRect(xStart, noteY1, barW, noteH);
                } else {
                  u.ctx.fillStyle = 'rgba(0, 216, 255, 0.75)';
                  u.ctx.fillRect(xStart, noteY1, barW, noteH);
                  u.ctx.strokeStyle = '#00D8FF';
                  u.ctx.lineWidth = 1;
                  u.ctx.strokeRect(xStart, noteY1, barW, noteH);

                  // White mania strike head on leading edge
                  u.ctx.fillStyle = '#FFFFFF';
                  u.ctx.fillRect(xStart, noteY1, 2, noteH);
                }
              }

              // --- Draw K2 Horizontal Mania Notes ---
              const k2Ints = evalResult.k2Intervals;
              const noteY2 = k2Y + notePadY;

              for (let i = 0; i < k2Ints.length; i++) {
                const item = k2Ints[i];
                if (item.releaseTime < xMin || item.pressTime > xMax) continue;

                const xStart = u.valToPos(item.pressTime, 'x', true);
                const xEnd = u.valToPos(item.releaseTime, 'x', true);
                const barW = Math.max(5, xEnd - xStart);
                const isHeld = curTime >= item.pressTime && curTime <= item.releaseTime;

                if (isHeld) {
                  u.ctx.fillStyle = '#FF66AB';
                  u.ctx.fillRect(xStart, noteY2, barW, noteH);
                  u.ctx.strokeStyle = '#FFFFFF';
                  u.ctx.lineWidth = 1.5;
                  u.ctx.strokeRect(xStart, noteY2, barW, noteH);
                } else {
                  u.ctx.fillStyle = 'rgba(255, 102, 171, 0.75)';
                  u.ctx.fillRect(xStart, noteY2, barW, noteH);
                  u.ctx.strokeStyle = '#FF66AB';
                  u.ctx.lineWidth = 1;
                  u.ctx.strokeRect(xStart, noteY2, barW, noteH);

                  // White mania strike head on leading edge
                  u.ctx.fillStyle = '#FFFFFF';
                  u.ctx.fillRect(xStart, noteY2, 2, noteH);
                }
              }

              // --- Draw Finger Lock Incidents on Timeline ---
              // Just like the miss indicator in Channel 1: thin vertical amber/gold indicator line across both lanes at the incident timestamp
              const fingerLocks = evalResult.fingerLockEvents;
              for (let i = 0; i < fingerLocks.length; i++) {
                const fl = fingerLocks[i];
                if (fl.time < xMin || fl.time > xMax) continue;

                const px = u.valToPos(fl.time, 'x', true);
                if (px < left || px > left + w) continue;

                const isCurrent = Math.abs(fl.time - curTime) < 120;

                // Thin vertical line spanning across both lanes from top to bot
                u.ctx.strokeStyle = isCurrent ? '#FDE047' : 'rgba(245, 158, 11, 0.85)';
                u.ctx.lineWidth = isCurrent ? 1.5 : 1.0;
                u.ctx.beginPath();
                u.ctx.moveTo(px, top);
                u.ctx.lineTo(px, top + h);
                u.ctx.stroke();

                // Small accent marker dot at the boundary between K1 and K2
                const midY = k1Y + laneH + laneGap / 2;
                u.ctx.fillStyle = isCurrent ? '#FFFFFF' : '#F59E0B';
                u.ctx.beginPath();
                u.ctx.arc(px, midY, isCurrent ? 3.5 : 2.2, 0, Math.PI * 2);
                u.ctx.fill();

                if (isCurrent) {
                  u.ctx.strokeStyle = '#F59E0B';
                  u.ctx.lineWidth = 1.2;
                  u.ctx.stroke();
                }
              }

              // --- Lane Badges on Left (Drawn AFTER notes with solid backing to prevent notes showing over badges) ---
              const badgeW = 28;
              const badgeH = laneH - 6;
              const badgeX = left + 6;

              // K1 Badge
              u.ctx.fillStyle = '#0c101c';
              u.ctx.fillRect(badgeX - 1, k1Y + 2, badgeW + 2, badgeH + 2);
              u.ctx.fillStyle = 'rgba(0, 216, 255, 0.16)';
              u.ctx.fillRect(badgeX, k1Y + 3, badgeW, badgeH);
              u.ctx.strokeStyle = 'rgba(0, 216, 255, 0.7)';
              u.ctx.lineWidth = 1;
              u.ctx.strokeRect(badgeX, k1Y + 3, badgeW, badgeH);
              u.ctx.fillStyle = '#00D8FF';
              u.ctx.font = 'bold 10px monospace';
              u.ctx.textAlign = 'center';
              u.ctx.textBaseline = 'middle';
              u.ctx.fillText('K1', badgeX + badgeW / 2, k1Y + laneH / 2);

              // K2 Badge
              u.ctx.fillStyle = '#1c0c16';
              u.ctx.fillRect(badgeX - 1, k2Y + 2, badgeW + 2, badgeH + 2);
              u.ctx.fillStyle = 'rgba(255, 102, 171, 0.16)';
              u.ctx.fillRect(badgeX, k2Y + 3, badgeW, badgeH);
              u.ctx.strokeStyle = 'rgba(255, 102, 171, 0.7)';
              u.ctx.lineWidth = 1;
              u.ctx.strokeRect(badgeX, k2Y + 3, badgeW, badgeH);
              u.ctx.fillStyle = '#FF66AB';
              u.ctx.font = 'bold 10px monospace';
              u.ctx.textAlign = 'center';
              u.ctx.textBaseline = 'middle';
              u.ctx.fillText('K2', badgeX + badgeW / 2, k2Y + laneH / 2);

              u.ctx.restore();
            }
          ]
        }
      },
      ch2Data,
      ch2Row.chartBody
    );
    this.charts.push(ch2Chart);
    // Channel 2 (Tapping) has a fixed height and is not expandable

    // -------------------------------------------------------------
    // 3. Channel 3: Accuracy Curves
    // -------------------------------------------------------------
    const ch3Row = this.createChannelContainer(
      'Accuracy Curves',
      '<span style="color:#99EB47;">― Cumulative Acc</span> &nbsp;•&nbsp; <span style="color:#66CCFF;">― Rolling (2s Window)</span>',
      'ch3'
    );
    const ch3Data: uPlot.AlignedData = [
      evalResult.timePoints,
      evalResult.cumulativeAcc,
      evalResult.rollingAcc
    ];
    const ch3Chart = new uPlot(
      {
        width,
        height: 85,
        legend: { show: false },
        cursor: { sync: { key: sync.key, setSeries: true } },
        scales: {
          x: { time: false, min: this.minTime, max: this.maxTime },
          y: {
            range: (_u, dataMin, dataMax) => {
              const lo = Math.max(0, Math.floor((dataMin ?? 90) - 2));
              const hi = Math.min(100, Math.ceil((dataMax ?? 100) + 0.5));
              return [lo, hi];
            }
          }
        },
        axes: [
          { show: false },
          { stroke: '#A68E99', label: 'Acc %', size: 50, grid: { stroke: '#33272D' } }
        ],
        series: [
          {},
          {
            label: 'Cumulative Acc',
            stroke: '#99EB47',
            width: 2.2,
            points: { show: false }
          },
          {
            label: 'Rolling Acc (2s)',
            stroke: '#66CCFF',
            width: 1.5,
            points: { show: false }
          }
        ],
        hooks: {
          drawClear: [
            (u) => {
              // 100% reference line
              const y100 = u.valToPos(100, 'y', true);
              u.ctx.strokeStyle = '#1D2520';
              u.ctx.lineWidth = 1;
              u.ctx.beginPath();
              u.ctx.moveTo(u.bbox.left, y100);
              u.ctx.lineTo(u.bbox.left + u.bbox.width, y100);
              u.ctx.stroke();
            }
          ]
        }
      },
      ch3Data,
      ch3Row.chartBody
    );
    this.charts.push(ch3Chart);
    this.channels.push({
      wrap: ch3Row.wrap,
      chart: ch3Chart,
      defaultHeight: 85,
      expandedHeight: 240
    });
    if (ch3Row.expandBtn) {
      ch3Row.expandBtn.onclick = (e) => {
        e.stopPropagation();
        this.toggleChannelExpand(ch3Row.wrap, ch3Chart, 85, 240);
        this.notifyExpandStateChange();
      };
    }

    // -------------------------------------------------------------
    // 4. Channel 4: Kinematics & Strain (Frame-by-Frame, Raw Velocity)
    // -------------------------------------------------------------
    const ch4Row = this.createChannelContainer(
      'Velocity / Strain / Turn Angle',
      '<span class="chart-legend-item" id="legend-ch4-vel" style="color:#66CCFF; cursor:pointer;" title="Click to toggle Velocity">― Velocity (px/ms)</span> &nbsp;•&nbsp; <span class="chart-legend-item" id="legend-ch4-strain" style="color:#FF66AB; cursor:pointer;" title="Click to toggle Aim Strain">■ Aim Strain</span> &nbsp;•&nbsp; <span class="chart-legend-item" id="legend-ch4-angle" style="color:#F59E0B; cursor:pointer;" title="Click to toggle Turn Angle">― Turn Angle (deg)</span>',
      'ch4'
    );

    const ch4Data: uPlot.AlignedData = [
      evalResult.keyTimes,
      evalResult.frameVelocities,
      evalResult.frameStrains,
      evalResult.frameTurnAngles
    ];

    const ch4Chart = new uPlot(
      {
        width,
        height: 100,
        legend: { show: false },
        cursor: { sync: { key: sync.key, setSeries: true } },
        scales: {
          x: { time: false, min: this.minTime, max: this.maxTime },
          vel: {
            auto: true,
            range: (_u, _min, dataMax) => [0, Math.max(1.5, Math.ceil((dataMax ?? 1.5) * 1.15 * 10) / 10)]
          },
          strain: {
            auto: true,
            range: (_u, _min, dataMax) => [0, Math.max(10, Math.ceil((dataMax ?? 10) * 1.15))]
          },
          angle: {
            range: [0, 180]
          }
        },
        axes: [
          { show: false },
          {
            scale: 'vel',
            side: 3,
            stroke: '#66CCFF',
            label: 'px/ms',
            size: 50,
            grid: { stroke: '#33272D' }
          }
        ],
        series: [
          {},
          {
            scale: 'vel',
            label: 'Velocity',
            stroke: '#66CCFF',
            width: 1.5,
            fill: 'rgba(102, 204, 255, 0.08)',
            points: { show: false },
            value: (_u, v) => v == null ? '--' : `${v.toFixed(2)} px/ms`
          },
          {
            scale: 'strain',
            label: 'Aim Strain',
            stroke: 'rgba(255, 102, 171, 0.85)',
            width: 1.2,
            fill: 'rgba(255, 102, 171, 0.15)',
            points: { show: false },
            value: (_u, v) => v == null ? '--' : `${v.toFixed(1)} strain`
          },
          {
            scale: 'angle',
            label: 'Turn Angle',
            stroke: 'rgba(245, 158, 11, 0.75)',
            width: 1.0,
            fill: 'rgba(245, 158, 11, 0.05)',
            points: { show: false },
            value: (_u, v) => v == null ? '--' : `${Math.round(v)}°`
          }
        ],
        hooks: {
          // Floating turn-angle ticks (0-180°) pinned to the plot's right
          // edge: the scale reference survives without a layout axis, so
          // this plot keeps full width and identical geometry with the rest.
          draw: [
            (u) => {
              const right = u.bbox.left + u.bbox.width;
              const top = u.bbox.top;
              const bot = top + u.bbox.height;
              u.ctx.save();
              u.ctx.font = '9px monospace';
              u.ctx.textAlign = 'right';
              u.ctx.textBaseline = 'middle';
              u.ctx.fillStyle = 'rgba(245, 158, 11, 0.75)';
              for (const v of [0, 45, 90, 135, 180]) {
                const y = u.valToPos(v, 'angle', true);
                if (y < top || y > bot) continue;
                u.ctx.fillText(`${v}°`, right - 4, y);
              }
              u.ctx.restore();
            }
          ]
        }
      },
      ch4Data,
      ch4Row.chartBody
    );
    this.charts.push(ch4Chart);
    this.channels.push({
      wrap: ch4Row.wrap,
      chart: ch4Chart,
      defaultHeight: 100,
      expandedHeight: 240
    });
    if (ch4Row.expandBtn) {
      ch4Row.expandBtn.onclick = (e) => {
        e.stopPropagation();
        this.toggleChannelExpand(ch4Row.wrap, ch4Chart, 100, 240);
        this.notifyExpandStateChange();
      };
    }

    // -------------------------------------------------------------
    // 5. Channel 5: Tapping Speed & Stamina Strain (True Unscaled Metrics)
    // -------------------------------------------------------------
    const ch5Row = this.createChannelContainer(
      'Tapping Speed & Stamina Strain',
      '<span class="chart-legend-item" id="legend-ch5-tap" style="color:#66FF73; cursor:pointer;" title="Click to toggle Tap BPM">― Tap BPM</span> &nbsp;•&nbsp; <span class="chart-legend-item" id="legend-ch5-target" style="color:#64748B; cursor:pointer;" title="Click to toggle Target BPM">┆ Target BPM</span> &nbsp;•&nbsp; <span class="chart-legend-item" id="legend-ch5-stamina" style="color:#FF6666; cursor:pointer;" title="Click to toggle Stamina Strain">■ Stamina Strain</span> &nbsp;•&nbsp; <span class="chart-legend-item" id="legend-ch5-control" style="color:#A78BFA; cursor:pointer;" title="Click to toggle Finger Control">― Finger Control</span>',
      'ch5'
    );

    let peakBpm = 0;
    for (let i = 0; i < evalResult.tapBpm.length; i++) {
      if (evalResult.tapBpm[i] > peakBpm) peakBpm = evalResult.tapBpm[i];
      if (evalResult.targetBpm[i] > peakBpm) peakBpm = evalResult.targetBpm[i];
    }
    if (peakBpm < 60) peakBpm = 180;

    const ch5Data: uPlot.AlignedData = [
      evalResult.timePoints,
      evalResult.tapBpm,
      evalResult.targetBpm,
      evalResult.staminaStrains,
      evalResult.fingerControlScores
    ];

    const ch5Chart = new uPlot(
      {
        width,
        height: 100,
        legend: { show: false },
        cursor: { sync: { key: sync.key, setSeries: true } },
        scales: {
          x: { time: false, min: this.minTime, max: this.maxTime },
          bpm: {
            range: (_u, dataMin, dataMax) => {
              const maxVal = Math.max(120, dataMax ?? peakBpm);
              const hi = Math.ceil((maxVal * 1.1) / 20) * 20;
              const minVal = dataMin ?? 0;
              const lo = Math.max(0, Math.floor(minVal / 20) * 20);
              return [lo, Math.max(hi, lo + 60)];
            }
          },
          stamina: {
            auto: true,
            range: (_u, _min, max) => [0, Math.max(10, Math.ceil((max ?? 10) * 1.15))]
          },
          control: {
            range: [0, 100]
          }
        },
        axes: [
          { show: false },
          {
            scale: 'bpm',
            side: 3,
            stroke: '#66FF73',
            label: 'BPM',
            size: 50,
            grid: { stroke: '#33272D' }
          }
        ],
        series: [
          {},
          {
            scale: 'bpm',
            label: 'Tap BPM',
            stroke: '#66FF73',
            width: 1.8,
            fill: 'rgba(102, 255, 115, 0.08)',
            points: { show: false },
            value: (_u, v) => v == null ? '--' : `${Math.round(v)} BPM`
          },
          {
            scale: 'bpm',
            label: 'Target BPM',
            stroke: 'rgba(148, 163, 184, 0.7)',
            width: 1.2,
            dash: [4, 4],
            points: { show: false },
            value: (_u, v) => v == null ? '--' : `${Math.round(v)} BPM`
          },
          {
            scale: 'stamina',
            label: 'Stamina Strain',
            stroke: 'rgba(255, 102, 102, 0.85)',
            width: 1,
            fill: 'rgba(255, 102, 102, 0.18)',
            points: { show: false },
            value: (_u, v) => v == null ? '--' : `${v.toFixed(1)} strain`
          },
          {
            scale: 'control',
            label: 'Finger Control',
            stroke: 'rgba(167, 139, 250, 0.85)',
            width: 1.2,
            dash: [4, 4],
            fill: 'rgba(167, 139, 250, 0.05)',
            points: { show: false },
            value: (_u, v) => v == null ? '--' : `${Math.round(v)} / 100`
          }
        ],
        hooks: {
          // Floating control ticks (0-100) pinned to the plot's right edge:
          // same treatment as ch4's turn angles — reference without layout.
          draw: [
            (u) => {
              const right = u.bbox.left + u.bbox.width;
              const top = u.bbox.top;
              const bot = top + u.bbox.height;
              u.ctx.save();
              u.ctx.font = '9px monospace';
              u.ctx.textAlign = 'right';
              u.ctx.textBaseline = 'middle';
              u.ctx.fillStyle = 'rgba(167, 139, 250, 0.75)';
              for (const v of [0, 25, 50, 75, 100]) {
                const y = u.valToPos(v, 'control', true);
                if (y < top || y > bot) continue;
                u.ctx.fillText(`${v}`, right - 4, y);
              }
              u.ctx.restore();
            }
          ]
        }
      },
      ch5Data,
      ch5Row.chartBody
    );
    this.charts.push(ch5Chart);
    this.channels.push({
      wrap: ch5Row.wrap,
      chart: ch5Chart,
      defaultHeight: 100,
      expandedHeight: 240
    });
    if (ch5Row.expandBtn) {
      ch5Row.expandBtn.onclick = (e) => {
        e.stopPropagation();
        this.toggleChannelExpand(ch5Row.wrap, ch5Chart, 100, 240);
        this.notifyExpandStateChange();
      };
    }

    // Bind click-to-toggle series visibility on legend items
    const bindToggle = (elId: string, chart: uPlot, seriesIdx: number) => {
      const el = document.getElementById(elId);
      if (!el) return;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const isShown = chart.series[seriesIdx].show ?? true;
        chart.setSeries(seriesIdx, { show: !isShown });
        el.style.opacity = isShown ? '0.35' : '1.0';
        el.style.textDecoration = isShown ? 'line-through' : 'none';
      });
    };
    bindToggle('legend-ch4-vel', ch4Chart, 1);
    bindToggle('legend-ch4-strain', ch4Chart, 2);
    bindToggle('legend-ch4-angle', ch4Chart, 3);
    bindToggle('legend-ch5-tap', ch5Chart, 1);
    bindToggle('legend-ch5-target', ch5Chart, 2);
    bindToggle('legend-ch5-stamina', ch5Chart, 3);
    bindToggle('legend-ch5-control', ch5Chart, 4);

    // -------------------------------------------------------------
    // Global Playhead Vertical Line with Time Badge
    // -------------------------------------------------------------
    this.playheadEl = document.createElement('div');
    this.playheadEl.className = 'telemetry-playhead';
    this.playheadEl.innerHTML = `
      <div class="playhead-badge" id="playhead-badge">00:00.00</div>
      <div class="playhead-line"></div>
    `;
    this.container.appendChild(this.playheadEl);
    this.playheadBadge = this.playheadEl.querySelector('#playhead-badge') as HTMLElement;
    if (this.firstRowEl) {
      this.playheadEl.style.top = `${this.firstRowEl.offsetTop}px`;
    }

    // TimeBus subscription for synchronized rendering
    this.unsubscribeTimeBus = this.timeBus.subscribe((t) => {
      this.updatePlayhead(t);
      this.updateKeyOverlayHud(t);
      ch1Chart.redraw(false);
      ch2Chart.redraw(false);
    });

    // ResizeObserver to automatically resize all charts when container bounds change
    this.resizeObserver = new ResizeObserver(() => {
      const newWidth = getAvailableWidth();
      for (const c of this.charts) {
        if (Math.abs(c.width - newWidth) > 2) {
          c.setSize({ width: newWidth, height: c.height });
        }
      }
      if (this.firstRowEl && this.playheadEl) {
        this.playheadEl.style.top = `${this.firstRowEl.offsetTop}px`;
      }
    });
    this.resizeObserver.observe(this.container);

    // Setup Interactive Zoom, Pan, and Click-Seek Handlers
    const interactiveRows = [ch1Row.wrap, ch2Row.wrap, ch3Row.wrap, ch4Row.wrap, ch5Row.wrap];
    if (diffRowWrap) {
      interactiveRows.push(diffRowWrap);
    }
    this.setupInteractivity(...interactiveRows);
  }

  private renderToolbar(): void {
    const toolbar = document.createElement('div');
    toolbar.className = 'telemetry-toolbar';
    toolbar.innerHTML = `
      <div class="telemetry-toolbar-left">
        <span class="telemetry-toolbar-label">TELEMETRY TIMELINE</span>
        <span class="telemetry-toolbar-hint">Ctrl + Scroll to Zoom • Shift + Scroll to Pan • Double-Click to Reset</span>
      </div>
      <div class="telemetry-toolbar-right">
        <div class="btn-group-segmented" role="group" aria-label="Timeline zoom controls">
          <button class="btn-tool-segment" id="btn-zoom-out" title="Zoom Out (Ctrl + Scroll Down)">${CHART_ICONS.zoomOut}<span>Out</span></button>
          <button class="btn-tool-segment" id="btn-zoom-in" title="Zoom In (Ctrl + Scroll Up)">${CHART_ICONS.zoomIn}<span>In</span></button>
        </div>
        <button class="btn-tool" id="btn-zoom-reset" title="Reset Zoom to Full Extent">${CHART_ICONS.reset}<span>Reset</span></button>
        <div class="toolbar-separator"></div>
        <button class="osu-switch cyan btn-lock" id="btn-lock-scrubber" aria-pressed="false" title="Lock playhead centered while timeline scrolls smoothly">
          <span class="lock-icon">${CHART_ICONS.lock}</span>
          <span class="switch-label">Lock Scrubber</span>
          <span class="switch-nub"><span class="nub-fill"></span></span>
        </button>
      </div>
    `;
    this.container.appendChild(toolbar);

    const btnZoomIn = toolbar.querySelector('#btn-zoom-in') as HTMLButtonElement;
    const btnZoomOut = toolbar.querySelector('#btn-zoom-out') as HTMLButtonElement;
    const btnReset = toolbar.querySelector('#btn-zoom-reset') as HTMLButtonElement;
    const btnLock = toolbar.querySelector('#btn-lock-scrubber') as HTMLButtonElement;

    this.btnLock = btnLock;
    this.setFollowScrubber(false);

    btnZoomIn.onclick = () => this.zoom(0.7);
    btnZoomOut.onclick = () => this.zoom(1.4);
    btnReset.onclick = () => {
      this.scrollWindowMs = 8000;
      this.setFollowScrubber(false);
      this.applyXScaleToAllCharts(this.minTime, this.maxTime);
    };

    btnLock.onclick = () => {
      const nextLocked = !this.followScrubber;
      this.setFollowScrubber(nextLocked);
      if (nextLocked) {
        const cur = this.timeBus.getCurrentTime();
        const half = this.scrollWindowMs / 2;
        this.applyXScaleToAllCharts(cur - half, cur + half);
      } else {
        this.applyXScaleToAllCharts(this.minTime, this.maxTime);
      }
    };
  }

  private attachKeyOverlayHud(parent: HTMLElement): void {
    const hud = document.createElement('div');
    hud.className = 'key-overlay-hud';
    hud.innerHTML = `
      <div class="argon-key argon-key-k1" id="key-tile-k1" title="K1 Keypress Counter (Cyan)">
        <div class="argon-key-indicator"></div>
        <span class="argon-key-count" id="key-count-k1">0</span>
      </div>
      <div class="argon-key argon-key-k2" id="key-tile-k2" title="K2 Keypress Counter (Pink)">
        <div class="argon-key-indicator"></div>
        <span class="argon-key-count" id="key-count-k2">0</span>
      </div>
      <div class="argon-bpm-badge" id="key-live-bpm">-- Stream BPM</div>
    `;
    parent.appendChild(hud);

    this.keyTileK1 = hud.querySelector('#key-tile-k1');
    this.keyTileK2 = hud.querySelector('#key-tile-k2');
    this.keyCountK1 = hud.querySelector('#key-count-k1');
    this.keyCountK2 = hud.querySelector('#key-count-k2');
    this.keyBpmK1 = hud.querySelector('#key-bpm-k1');
    this.keyBpmK2 = hud.querySelector('#key-bpm-k2');
    this.keyLiveBpm = hud.querySelector('#key-live-bpm');
  }

  private updateKeyOverlayHud(currentTimeMs: number): void {
    if (!this.evalResult || !this.keyTileK1 || !this.keyTileK2) return;
    const keyTimes = this.evalResult.keyTimes;
    if (keyTimes.length === 0) return;

    // Binary search for frame at or just before currentTimeMs
    let low = 0;
    let high = keyTimes.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (keyTimes[mid] <= currentTimeMs) low = mid + 1;
      else high = mid - 1;
    }
    const idx = Math.max(0, Math.min(keyTimes.length - 1, low - 1));

    const isK1 = this.evalResult.k1Frames[idx] === 1;
    const isK2 = this.evalResult.k2Frames[idx] === 1;

    this.keyTileK1.classList.toggle('is-pressed', isK1);
    this.keyTileK2.classList.toggle('is-pressed', isK2);

    if (this.keyCountK1 && this.k1CumulativeTaps) {
      this.keyCountK1.textContent = (this.k1CumulativeTaps[idx] || 0).toLocaleString();
    }
    if (this.keyCountK2 && this.k2CumulativeTaps) {
      this.keyCountK2.textContent = (this.k2CumulativeTaps[idx] || 0).toLocaleString();
    }

    const clockRate = this.evalResult?.gameplayRate || 1.0;

    // Per-key BPM calculation from discrete keypress intervals
    const getRecentKeyBpm = (intervals: KeyInterval[]): number => {
      if (!intervals || intervals.length < 2) return 0;
      let l = 0;
      let h = intervals.length - 1;
      while (l <= h) {
        const m = (l + h) >> 1;
        if (intervals[m].pressTime <= currentTimeMs) l = m + 1;
        else h = m - 1;
      }
      const currIdx = l - 1;
      if (currIdx < 1) return 0;

      const curr = intervals[currIdx];
      if (currentTimeMs - curr.pressTime > 650) return 0;

      const count = Math.min(currIdx, 3);
      const oldest = intervals[currIdx - count];
      const dtAudio = (curr.pressTime - oldest.pressTime) / count;
      const dtReal = dtAudio / clockRate;

      if (dtReal >= 30 && dtReal <= 750) {
        // Stream equivalent BPM: alternating keys hit every 2nd note of stream
        return Math.round(30000 / dtReal);
      }
      return 0;
    };

    const k1Bpm = getRecentKeyBpm(this.evalResult.k1Intervals);
    const k2Bpm = getRecentKeyBpm(this.evalResult.k2Intervals);

    if (this.keyBpmK1) {
      this.keyBpmK1.textContent = k1Bpm > 0 ? `${k1Bpm} BPM` : '-- BPM';
    }
    if (this.keyBpmK2) {
      this.keyBpmK2.textContent = k2Bpm > 0 ? `${k2Bpm} BPM` : '-- BPM';
    }

    // Overall Stream BPM: strictly only display "Stream BPM" when actually in a stream / burst cadence
    if (this.keyLiveBpm) {
      const activePattern = this.evalResult?.tapPatterns
        ? TapPatternClassifier.findPatternAt(this.evalResult.tapPatterns, currentTimeMs)
        : null;

      if (activePattern) {
        const typePrefix = activePattern.type === 'tech_alt' ? 'Tech Alt' : activePattern.type === 'alt' ? 'Alt' : 'Stream';
        this.keyLiveBpm.textContent = `${activePattern.estimatedBpm} ${typePrefix} BPM`;
      } else if (k1Bpm > 140 && k2Bpm > 140) {
        const avgStreamBpm = Math.round((k1Bpm + k2Bpm) / 2);
        this.keyLiveBpm.textContent = `${avgStreamBpm} Stream BPM`;
      } else {
        this.keyLiveBpm.textContent = '-- Stream BPM';
      }
    }
  }

  private applyXScaleToAllCharts(min: number, max: number): void {
    this.currentMin = min;
    this.currentMax = max;
    for (const c of this.charts) {
      c.setScale('x', { min, max });
    }
  }

  private zoom(factor: number, centerRatio: number = 0.5): void {
    if (this.followScrubber) {
      this.scrollWindowMs = Math.max(1000, Math.min(60000, this.scrollWindowMs * factor));
      const cur = this.timeBus.getCurrentTime();
      const half = this.scrollWindowMs / 2;
      this.applyXScaleToAllCharts(cur - half, cur + half);
      return;
    }

    const curSpan = this.currentMax - this.currentMin;
    const fullSpan = this.maxTime - this.minTime;
    const newSpan = Math.max(500, Math.min(fullSpan, curSpan * factor));
    const focusTime = this.currentMin + centerRatio * curSpan;

    let newMin = focusTime - centerRatio * newSpan;
    let newMax = newMin + newSpan;

    if (newMin < this.minTime) {
      newMin = this.minTime;
      newMax = Math.min(this.maxTime, newMin + newSpan);
    }
    if (newMax > this.maxTime) {
      newMax = this.maxTime;
      newMin = Math.max(this.minTime, newMax - newSpan);
    }

    this.applyXScaleToAllCharts(newMin, newMax);
  }

  private pan(panAmountMs: number): void {
    if (this.followScrubber) return;
    const curSpan = this.currentMax - this.currentMin;
    let newMin = this.currentMin + panAmountMs;
    let newMax = this.currentMax + panAmountMs;

    if (newMin < this.minTime) {
      newMin = this.minTime;
      newMax = newMin + curSpan;
    }
    if (newMax > this.maxTime) {
      newMax = this.maxTime;
      newMin = newMax - curSpan;
    }

    this.applyXScaleToAllCharts(newMin, newMax);
  }

  private setupInteractivity(...rows: HTMLElement[]): void {
    // Zoom with Ctrl + Wheel; Pan with Shift + Wheel
    const wheelHandler = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const chart = this.charts[0];
        if (!chart) return;
        const rect = chart.over.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, mouseX / rect.width));
        const factor = e.deltaY < 0 ? 0.75 : 1.3;
        this.zoom(factor, ratio);
      } else if (e.shiftKey) {
        e.preventDefault();
        const curSpan = this.currentMax - this.currentMin;
        const panDelta = (e.deltaY || e.deltaX) * (curSpan / 800);
        this.pan(panDelta);
      }
    };

    // Seek on click handler using exact plot bounds
    const seekHandler = (e: MouseEvent) => {
      const chart = this.charts[0];
      if (!chart) return;
      const overRect = chart.over.getBoundingClientRect();
      const clickX = e.clientX - overRect.left;
      if (clickX >= 0 && clickX <= overRect.width) {
        const ratio = clickX / overRect.width;
        const targetTime = this.currentMin + ratio * (this.currentMax - this.currentMin);
        this.timeBus.seek(targetTime);
      }
    };

    // Double-click to reset zoom
    const dblClickHandler = () => {
      this.scrollWindowMs = 8000;
      this.setFollowScrubber(false);
      this.applyXScaleToAllCharts(this.minTime, this.maxTime);
    };

    rows.forEach(row => {
      row.addEventListener('wheel', wheelHandler, { passive: false });
      row.addEventListener('click', seekHandler);
      row.addEventListener('dblclick', dblClickHandler);
    });
  }

  private updatePlayhead(currentTimeMs: number): void {
    if (!this.playheadEl || !this.playheadBadge || this.charts.length === 0) return;

    this.updateDifficultyHud(currentTimeMs);

    if (this.firstRowEl && (!this.playheadEl.style.top || this.playheadEl.style.top === '')) {
      this.playheadEl.style.top = `${this.firstRowEl.offsetTop}px`;
    }

    const chart = this.charts[0];
    if (!chart || !this.evalResult) return;

    // Handle Scrubber Centered Lock mode
    if (this.followScrubber) {
      const half = this.scrollWindowMs / 2;
      this.applyXScaleToAllCharts(currentTimeMs - half, currentTimeMs + half);

      const overRect = chart.over.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      const playheadLeft = (overRect.left - containerRect.left) + overRect.width / 2;

      this.playheadEl.style.display = 'block';
      this.playheadEl.style.left = `${playheadLeft}px`;

      const mins = Math.floor(Math.abs(currentTimeMs) / 60000);
      const secs = ((Math.abs(currentTimeMs) % 60000) / 1000).toFixed(2);
      const sign = currentTimeMs < 0 ? '-' : '';
      this.playheadBadge.textContent = `${sign}${mins}:${secs.padStart(5, '0')}`;
      return;
    }

    // Standard Free Playhead mode
    if (currentTimeMs < this.currentMin || currentTimeMs > this.currentMax) {
      this.playheadEl.style.display = 'none';
      return;
    }

    // Exact pixel position from left of plot area
    const px = chart.valToPos(currentTimeMs, 'x');
    const plotWidth = chart.bbox.width / (window.devicePixelRatio || 1);

    if (isNaN(px) || px < 0 || px > plotWidth) {
      this.playheadEl.style.display = 'none';
      return;
    }

    // Exact offset relative to container using interactive plot element (chart.over)
    const overRect = chart.over.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const playheadLeft = (overRect.left - containerRect.left) + px;

    this.playheadEl.style.display = 'block';
    this.playheadEl.style.left = `${playheadLeft}px`;

    const mins = Math.floor(Math.abs(currentTimeMs) / 60000);
    const secs = ((Math.abs(currentTimeMs) % 60000) / 1000).toFixed(2);
    const sign = currentTimeMs < 0 ? '-' : '';
    this.playheadBadge.textContent = `${sign}${mins}:${secs.padStart(5, '0')}`;
  }

  private createChannelContainer(
    title: string,
    subtitle: string,
    id: string,
    expandable: boolean = true
  ): { wrap: HTMLElement; chartBody: HTMLElement; expandBtn: HTMLButtonElement | null; headerLeft: HTMLElement } {
    const wrap = document.createElement('div');
    wrap.className = 'telemetry-row';
    wrap.id = `row-${id}`;

    const header = document.createElement('div');
    header.className = 'telemetry-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'telemetry-header-left';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'telemetry-title';
    titleSpan.textContent = title;

    const subSpan = document.createElement('span');
    subSpan.className = 'telemetry-subtitle';
    subSpan.innerHTML = subtitle;

    headerLeft.appendChild(titleSpan);
    headerLeft.appendChild(subSpan);
    header.appendChild(headerLeft);

    let expandBtn: HTMLButtonElement | null = null;
    if (expandable) {
      expandBtn = document.createElement('button');
      expandBtn.className = 'btn-expand';
      expandBtn.innerHTML = CHART_ICONS.expand;
      expandBtn.title = 'Expand chart height vertically';
      header.appendChild(expandBtn);
    }

    wrap.appendChild(header);

    const chartBody = document.createElement('div');
    chartBody.className = 'chart-body';
    wrap.appendChild(chartBody);

    this.container.appendChild(wrap);
    return { wrap, chartBody, expandBtn, headerLeft };
  }

  private toggleChannelExpand(
    rowEl: HTMLElement,
    chart: uPlot,
    defaultHeight: number,
    expandedHeight: number = 260
  ): void {
    const isExpanded = rowEl.classList.toggle('is-expanded');
    const expandBtn = rowEl.querySelector('.btn-expand') as HTMLButtonElement | null;
    if (expandBtn) {
      expandBtn.innerHTML = isExpanded ? CHART_ICONS.collapse : CHART_ICONS.expand;
      expandBtn.title = isExpanded ? 'Collapse chart height' : 'Expand chart height vertically';
    }
    const targetHeight = isExpanded ? expandedHeight : defaultHeight;
    chart.setSize({ width: chart.width, height: targetHeight });
  }

  public areAllExpanded(): boolean {
    return this.channels.length > 0 && this.channels.every(ch => ch.wrap.classList.contains('is-expanded'));
  }

  public setAllExpanded(expand: boolean): void {
    for (const ch of this.channels) {
      const isCurrentlyExpanded = ch.wrap.classList.contains('is-expanded');
      if (isCurrentlyExpanded !== expand) {
        this.toggleChannelExpand(ch.wrap, ch.chart, ch.defaultHeight, ch.expandedHeight);
      }
    }
    this.notifyExpandStateChange();
  }

  public toggleExpandAll(): boolean {
    const target = !this.areAllExpanded();
    this.setAllExpanded(target);
    return target;
  }

  private notifyExpandStateChange(): void {
    if (this.onExpandStateChange) {
      this.onExpandStateChange(this.areAllExpanded());
    }
  }

  private updateDifficultyHud(currentTimeMs: number): void {
    if (!this.rollingResult || !this.diffChipValEl) return;
    const cur = getDifficultyAtTime(this.rollingResult, currentTimeMs);
    if (!cur) return;

    const starBg = getDiffColor(cur.starRating);
    const starText = getDiffTextColor(cur.starRating);

    if (this.diffChipEl) {
      this.diffChipEl.style.backgroundColor = starBg;
      this.diffChipEl.style.color = starText;
    }
    if (this.diffChipStarEl) {
      this.diffChipStarEl.style.color = starText;
    }
    this.diffChipValEl.textContent = cur.starRating.toFixed(2);

    if (this.diffAimValEl) this.diffAimValEl.textContent = cur.aim.toFixed(2);
    if (this.diffSpeedValEl) this.diffSpeedValEl.textContent = cur.speed.toFixed(2);
    if (this.diffReadingValEl) this.diffReadingValEl.textContent = cur.reading.toFixed(2);
  }

  private traceMonotoneSpline(
    ctx: CanvasRenderingContext2D,
    pts: { x: number; y: number }[]
  ): void {
    const n = pts.length;
    if (n < 2) return;
    if (n === 2) {
      ctx.lineTo(pts[1].x, pts[1].y);
      return;
    }

    const dx = new Float64Array(n - 1);
    const dy = new Float64Array(n - 1);
    const slope = new Float64Array(n - 1);

    for (let i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1].x - pts[i].x;
      dy[i] = pts[i + 1].y - pts[i].y;
      slope[i] = dx[i] !== 0 ? dy[i] / dx[i] : 0;
    }

    const m = new Float64Array(n);
    m[0] = slope[0];
    m[n - 1] = slope[n - 2];

    for (let i = 1; i < n - 1; i++) {
      if (slope[i - 1] * slope[i] <= 0) {
        m[i] = 0;
      } else {
        m[i] = (2 * slope[i - 1] * slope[i]) / (slope[i - 1] + slope[i]);
      }
    }

    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const segDx = dx[i];

      const cp1x = p0.x + segDx / 3;
      const cp1y = p0.y + (m[i] * segDx) / 3;
      const cp2x = p1.x - segDx / 3;
      const cp2y = p1.y - (m[i + 1] * segDx) / 3;

      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p1.x, p1.y);
    }
  }
}

