import uPlot from 'uplot';
import { RollingDifficultyResult } from '../../../core/math/RollingDifficulty.ts';
import { getDiffColor, getDifficultyStrokeColor } from '../../../core/math/ColorHelper.ts';
import { traceMonotoneSpline } from './SplineHelper.ts';

export function computeDifficultyYMax(peakSR: number): number {
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
}

export function getDifficultyStep(maxVal: number, plotHeight: number): number {
  if (plotHeight < 120) {
    if (maxVal > 16) return 5;
    if (maxVal > 10) return 4;
    if (maxVal > 5) return 2;
    return 1;
  } else {
    if (maxVal > 24) return 5;
    if (maxVal > 16) return 4;
    return 2;
  }
}

export interface DifficultyChannelConfig {
  rollingResult: RollingDifficultyResult;
  width: number;
  minTime: number;
  maxTime: number;
  syncKey: string;
  chartBody: HTMLElement;
}

export function buildDifficultyChannel(config: DifficultyChannelConfig): uPlot {
  const { rollingResult, width, minTime, maxTime, syncKey, chartBody } = config;
  const peakSR = rollingResult.maxStarRating || 5.0;
  const yMax = computeDifficultyYMax(peakSR);
  const sync = uPlot.sync(syncKey);

  const diffTimes = rollingResult.points.map(p => p.timeMs);
  const diffStars = rollingResult.points.map(p => p.starRating);

  if (diffTimes[0] > minTime) {
    diffTimes.unshift(minTime);
    diffStars.unshift(0);
  }
  if (diffTimes[diffTimes.length - 1] < maxTime) {
    diffTimes.push(maxTime);
    diffStars.push(0);
  }

  const diffData: uPlot.AlignedData = [
    new Float64Array(diffTimes),
    new Float64Array(diffStars)
  ];

  return new uPlot(
    {
      width,
      height: 85,
      legend: { show: false },
      cursor: { sync: { key: sync.key, setSeries: true } },
      scales: {
        x: { time: false, min: minTime, max: maxTime },
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
            u.ctx.beginPath();
            u.ctx.roundRect(left, top, w, h, 8);
            u.ctx.clip();

            const vertGrad = u.ctx.createLinearGradient(0, yBottom, 0, yTop);
            const gradientSteps = 30;
            for (let s = 0; s <= gradientSteps; s++) {
              const ratio = s / gradientSteps;
              const rating = ratio * yMax;
              vertGrad.addColorStop(ratio, getDiffColor(rating));
            }

            u.ctx.globalAlpha = 0.16;
            u.ctx.fillStyle = vertGrad;
            u.ctx.fillRect(left, top, w, h);

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

            const rawPoints = rollingResult.points;
            const screenPts: { x: number; y: number; rating: number }[] = [];
            for (let i = 0; i < rawPoints.length; i++) {
              const pt = rawPoints[i];
              const px = u.valToPos(pt.timeMs, 'x', true);
              const py = u.valToPos(pt.starRating, 'y', true);
              screenPts.push({ x: px, y: py, rating: pt.starRating });
            }

            if (screenPts.length >= 2) {
              u.ctx.save();
              u.ctx.beginPath();
              u.ctx.moveTo(screenPts[0].x, yBottom);
              u.ctx.lineTo(screenPts[0].x, screenPts[0].y);
              traceMonotoneSpline(u.ctx, screenPts);
              u.ctx.lineTo(screenPts[screenPts.length - 1].x, yBottom);
              u.ctx.closePath();
              u.ctx.clip();

              u.ctx.globalAlpha = 0.88;
              u.ctx.fillStyle = vertGrad;
              u.ctx.fillRect(left, top, w, h);
              u.ctx.restore();

              u.ctx.save();
              u.ctx.beginPath();
              u.ctx.moveTo(screenPts[0].x, screenPts[0].y);
              traceMonotoneSpline(u.ctx, screenPts);

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

            u.ctx.restore();
          }
        ]
      }
    },
    diffData,
    chartBody
  );
}
