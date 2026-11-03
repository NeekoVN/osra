import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { EvaluationResult } from '../../core/evaluator/ReplayEvaluator.ts';
import { Beatmap } from '../../core/types/beatmap.ts';
import { TimeBus } from '../TimeBus.ts';
import {
  calculateRollingDifficulty,
  RollingDifficultyResult
} from '../../core/math/RollingDifficulty.ts';

import { CHART_ICONS, ChannelRegistration, ChannelRowElements } from './types.ts';
import { buildHitErrorChannel } from './builders/Channel1HitError.ts';
import { buildDifficultyChannel } from './builders/ChannelDifficulty.ts';
import { buildKeysChannel } from './builders/ChannelKeys.ts';
import { buildAccuracyChannel } from './builders/ChannelAccuracy.ts';
import { buildKinematicsChannel } from './builders/ChannelKinematics.ts';
import { buildTappingChannel } from './builders/ChannelTapping.ts';
import { KeyOverlayHud } from './components/KeyOverlayHud.ts';
import { DifficultyHud } from './components/DifficultyHud.ts';
import { PlayheadOverlay } from './components/PlayheadOverlay.ts';
import { TimelineToolbar } from './components/TimelineToolbar.ts';

export type { ChannelRegistration };

export class TelemetryCharts {
  private container: HTMLElement;
  private timeBus: TimeBus;
  private syncKey: string = 'osraTimelineSync';
  public readonly charts: uPlot[] = [];
  private channels: ChannelRegistration[] = [];
  public onExpandStateChange?: (allExpanded: boolean) => void;

  private evalResult: EvaluationResult | null = null;
  private unsubscribeTimeBus: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Components
  private toolbar: TimelineToolbar;
  private playhead: PlayheadOverlay;
  private keyHud: KeyOverlayHud;
  private diffHud: DifficultyHud;

  // Zoom & Pan & Scrubber Lock State
  private followScrubber: boolean = false;
  private scrollWindowMs: number = 8000;
  private minTime: number = 0;
  private maxTime: number = 1000;
  private currentMin: number = 0;
  private currentMax: number = 1000;

  // Cached state for real-time HUDs
  private k1CumulativeTaps: Uint32Array | null = null;
  private k2CumulativeTaps: Uint32Array | null = null;
  private firstRowEl: HTMLElement | null = null;
  private rollingResult: RollingDifficultyResult | null = null;

  constructor(container: HTMLElement, timeBus: TimeBus) {
    this.container = container;
    this.timeBus = timeBus;
    this.toolbar = new TimelineToolbar(container);
    this.playhead = new PlayheadOverlay(container);
    this.keyHud = new KeyOverlayHud();
    this.diffHud = new DifficultyHud();
  }

  public setFollowScrubber(follow: boolean): void {
    this.followScrubber = follow;
    this.toolbar.setLockState(follow);
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

    this.playhead.destroy();
    this.keyHud.destroy();
    this.diffHud.destroy();
    this.toolbar.destroy();

    this.k1CumulativeTaps = null;
    this.k2CumulativeTaps = null;
    this.firstRowEl = null;
    this.rollingResult = null;
    this.scrollWindowMs = 8000;
    this.followScrubber = false;
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

    const od = beatmap ? beatmap.difficulty.overallDifficulty : 9.0;

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

    // 1. Toolbar
    this.toolbar.render({
      onZoom: (factor) => this.zoom(factor),
      onReset: () => {
        this.scrollWindowMs = 8000;
        this.setFollowScrubber(false);
        this.applyXScaleToAllCharts(this.minTime, this.maxTime);
      },
      onToggleLock: (nextLocked) => {
        this.setFollowScrubber(nextLocked);
        if (nextLocked) {
          const cur = this.timeBus.getCurrentTime();
          const half = this.scrollWindowMs / 2;
          this.applyXScaleToAllCharts(cur - half, cur + half);
        } else {
          this.applyXScaleToAllCharts(this.minTime, this.maxTime);
        }
      }
    });

    // 2. Channel 1: Hit Error & OD Windows
    const ch1Row = this.createChannelContainer(
      'Hit Error',
      '<span style="color:#FF6666;">― Miss</span> • <span style="color:#B87BFF;">― Desync</span> • <span style="color:#8B5CF6;">▮ Stream</span> • <span style="color:#F43F5E;">▮ Deathstream</span> • <span style="color:#FFFFFF;">― Rolling Mean</span>',
      'ch1'
    );
    this.firstRowEl = ch1Row.wrap;

    const ch1Chart = buildHitErrorChannel({
      evalResult,
      width,
      minTime: this.minTime,
      maxTime: this.maxTime,
      syncKey: this.syncKey,
      od,
      timeBus: this.timeBus,
      chartBody: ch1Row.chartBody
    });
    this.registerChannel(ch1Row, ch1Chart, 100, 260);

    // 3. Channel: Rolling Difficulty (if beatmap available)
    let diffRowWrap: HTMLElement | null = null;
    if (this.rollingResult && this.rollingResult.points.length > 0) {
      const diffRow = this.createChannelContainer('Difficulty', '', 'diff');
      diffRowWrap = diffRow.wrap;

      const peakSR = this.rollingResult.maxStarRating || 5.0;
      const sumSR = this.rollingResult.points.reduce((acc, p) => acc + p.starRating, 0);
      const meanSR = sumSR / (this.rollingResult.points.length || 1);

      this.diffHud.attach(diffRow.headerLeft, peakSR, meanSR);

      const diffChart = buildDifficultyChannel({
        rollingResult: this.rollingResult,
        width,
        minTime: this.minTime,
        maxTime: this.maxTime,
        syncKey: this.syncKey,
        chartBody: diffRow.chartBody
      });
      this.registerChannel(diffRow, diffChart, 85, 220);
    }

    // 4. Channel 2: Tapping Dynamics (2K osu!mania Flipped Horizontal)
    const ch2Row = this.createChannelContainer(
      'Keys (2K Mania)',
      '<span style="color:#00E5FF;">Lane 1 (K1)</span> &nbsp;•&nbsp; <span style="color:#FF1493;">Lane 2 (K2)</span>',
      'ch2',
      false
    );
    this.keyHud.attach(ch2Row.headerLeft);

    const ch2Chart = buildKeysChannel({
      evalResult,
      width,
      minTime: this.minTime,
      maxTime: this.maxTime,
      syncKey: this.syncKey,
      timeBus: this.timeBus,
      chartBody: ch2Row.chartBody
    });
    this.registerChannel(ch2Row, ch2Chart, 90, 90);

    // 5. Channel 3: Accuracy Curves
    const ch3Row = this.createChannelContainer(
      'Accuracy Curves',
      '<span style="color:#99EB47;">― Cumulative Acc</span> &nbsp;•&nbsp; <span style="color:#66CCFF;">― Rolling (2s Window)</span>',
      'ch3'
    );
    const ch3Chart = buildAccuracyChannel({
      evalResult,
      width,
      minTime: this.minTime,
      maxTime: this.maxTime,
      syncKey: this.syncKey,
      chartBody: ch3Row.chartBody
    });
    this.registerChannel(ch3Row, ch3Chart, 85, 240);

    // 6. Channel 4: Kinematics & Strain
    const ch4Row = this.createChannelContainer(
      'Velocity / Strain / Turn Angle',
      '<span class="chart-legend-item" id="legend-ch4-vel" style="color:#66CCFF; cursor:pointer;" title="Click to toggle Velocity">― Velocity (px/ms)</span> &nbsp;•&nbsp; <span class="chart-legend-item" id="legend-ch4-strain" style="color:#FF66AB; cursor:pointer;" title="Click to toggle Aim Strain">■ Aim Strain</span> &nbsp;•&nbsp; <span class="chart-legend-item" id="legend-ch4-angle" style="color:#F59E0B; cursor:pointer;" title="Click to toggle Turn Angle">― Turn Angle (deg)</span>',
      'ch4'
    );
    const ch4Chart = buildKinematicsChannel({
      evalResult,
      width,
      minTime: this.minTime,
      maxTime: this.maxTime,
      syncKey: this.syncKey,
      chartBody: ch4Row.chartBody
    });
    this.registerChannel(ch4Row, ch4Chart, 100, 240);

    // 7. Channel 5: Tapping Speed & Stamina Strain
    const ch5Row = this.createChannelContainer(
      'Tapping Speed & Stamina Strain',
      '<span class="chart-legend-item" id="legend-ch5-tap" style="color:#66FF73; cursor:pointer;" title="Click to toggle Tap BPM">― Tap BPM</span> &nbsp;•&nbsp; <span class="chart-legend-item" id="legend-ch5-target" style="color:#64748B; cursor:pointer;" title="Click to toggle Target BPM">┆ Target BPM</span> &nbsp;•&nbsp; <span class="chart-legend-item" id="legend-ch5-stamina" style="color:#FF6666; cursor:pointer;" title="Click to toggle Stamina Strain">■ Stamina Strain</span> &nbsp;•&nbsp; <span class="chart-legend-item" id="legend-ch5-control" style="color:#A78BFA; cursor:pointer;" title="Click to toggle Finger Control">― Finger Control</span>',
      'ch5'
    );
    const ch5Chart = buildTappingChannel({
      evalResult,
      width,
      minTime: this.minTime,
      maxTime: this.maxTime,
      syncKey: this.syncKey,
      chartBody: ch5Row.chartBody
    });
    this.registerChannel(ch5Row, ch5Chart, 100, 240);

    // Bind series visibility toggles
    this.bindToggle('legend-ch4-vel', ch4Chart, 1);
    this.bindToggle('legend-ch4-strain', ch4Chart, 2);
    this.bindToggle('legend-ch4-angle', ch4Chart, 3);
    this.bindToggle('legend-ch5-tap', ch5Chart, 1);
    this.bindToggle('legend-ch5-target', ch5Chart, 2);
    this.bindToggle('legend-ch5-stamina', ch5Chart, 3);
    this.bindToggle('legend-ch5-control', ch5Chart, 4);

    // 8. Playhead Overlay
    this.playhead.create(this.firstRowEl);

    // TimeBus subscription
    this.unsubscribeTimeBus = this.timeBus.subscribe((t) => {
      this.playhead.update(
        t,
        this.charts[0],
        this.firstRowEl,
        this.followScrubber,
        this.currentMin,
        this.currentMax,
        this.scrollWindowMs,
        (min, max) => this.applyXScaleToAllCharts(min, max)
      );
      this.diffHud.update(t, this.rollingResult);
      this.keyHud.update(t, this.evalResult, this.k1CumulativeTaps, this.k2CumulativeTaps);
      ch1Chart.redraw(false);
      ch2Chart.redraw(false);
    });

    // ResizeObserver
    this.resizeObserver = new ResizeObserver(() => {
      const newWidth = getAvailableWidth();
      for (const c of this.charts) {
        if (Math.abs(c.width - newWidth) > 2) {
          c.setSize({ width: newWidth, height: c.height });
        }
      }
      this.playhead.updateTop(this.firstRowEl);
    });
    this.resizeObserver.observe(this.container);

    // Setup Interactive Zoom, Pan, and Click-Seek Handlers
    const interactiveRows = [ch1Row.wrap, ch2Row.wrap, ch3Row.wrap, ch4Row.wrap, ch5Row.wrap];
    if (diffRowWrap) {
      interactiveRows.push(diffRowWrap);
    }
    this.setupInteractivity(...interactiveRows);
  }

  private registerChannel(
    row: ChannelRowElements,
    chart: uPlot,
    defaultHeight: number,
    expandedHeight: number
  ): void {
    this.charts.push(chart);
    this.channels.push({
      wrap: row.wrap,
      chart,
      defaultHeight,
      expandedHeight
    });
    if (row.expandBtn) {
      row.expandBtn.onclick = (e) => {
        e.stopPropagation();
        this.toggleChannelExpand(row.wrap, chart, defaultHeight, expandedHeight);
        this.notifyExpandStateChange();
      };
    }
  }

  private bindToggle(elId: string, chart: uPlot, seriesIdx: number): void {
    const el = document.getElementById(elId);
    if (!el) return;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const isShown = chart.series[seriesIdx].show ?? true;
      chart.setSeries(seriesIdx, { show: !isShown });
      el.style.opacity = isShown ? '0.35' : '1.0';
      el.style.textDecoration = isShown ? 'line-through' : 'none';
    });
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

  private createChannelContainer(
    title: string,
    subtitle: string,
    id: string,
    expandable: boolean = true
  ): ChannelRowElements {
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
}
