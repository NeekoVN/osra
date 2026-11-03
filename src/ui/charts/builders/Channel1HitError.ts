import uPlot from 'uplot';
import { EvaluationResult } from '../../../core/evaluator/types.ts';
import { HitJudgement, DesyncType } from '../../../core/types/telemetry.ts';
import { TimeBus } from '../../TimeBus.ts';

export interface Channel1Config {
  evalResult: EvaluationResult;
  width: number;
  minTime: number;
  maxTime: number;
  syncKey: string;
  od: number;
  timeBus: TimeBus;
  chartBody: HTMLElement;
}

export function buildHitErrorChannel(config: Channel1Config): uPlot {
  const { evalResult, width, minTime, maxTime, syncKey, od, timeBus, chartBody } = config;

  const w300 = Math.floor(80 - 6 * od) - 0.5;
  const w100 = Math.floor(140 - 8 * od) - 0.5;
  const w50 = Math.floor(200 - 10 * od) - 0.5;

  const sync = uPlot.sync(syncKey);

  const ch1Data: uPlot.AlignedData = [
    evalResult.timePoints,
    evalResult.hitOffsets,
    evalResult.rollingMean
  ];

  return new uPlot(
    {
      width,
      height: 100,
      legend: { show: false },
      cursor: { sync: { key: sync.key, setSeries: true } },
      scales: {
        x: { time: false, min: minTime, max: maxTime },
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

            u.ctx.fillStyle = '#262010';
            u.ctx.fillRect(left, y50Top, w, Math.max(0, y50Bot - y50Top));

            u.ctx.fillStyle = '#122616';
            u.ctx.fillRect(left, y100Top, w, Math.max(0, y100Bot - y100Top));

            u.ctx.fillStyle = '#101E2E';
            u.ctx.fillRect(left, y300Top, w, Math.max(0, y300Bot - y300Top));

            u.ctx.strokeStyle = '#263B4D';
            u.ctx.lineWidth = 1;
            u.ctx.beginPath();
            u.ctx.moveTo(left, yZero);
            u.ctx.lineTo(left + w, yZero);
            u.ctx.stroke();

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
              const fillColor = isStream ? 'rgba(124, 58, 237, 0.20)' : 'rgba(225, 29, 72, 0.24)';
              const borderColor = isStream ? 'rgba(124, 58, 237, 0.70)' : 'rgba(225, 29, 72, 0.80)';
              const tagColor = isStream ? '#C4B5FD' : '#FDA4AF';

              u.ctx.fillStyle = fillColor;
              u.ctx.fillRect(x1, chartTop, spanW, chartHeight);

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

              u.ctx.fillStyle = borderColor;
              u.ctx.fillRect(x1, chartTop, spanW, 2.5);

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
            const curTime = timeBus.getCurrentTime();
            const hits = evalResult.hitEvents;
            const yZero = u.valToPos(0, 'y', true);
            const top = u.bbox.top;
            const bot = top + u.bbox.height;

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
              const minVisibleTime = u.scales.x?.min ?? minTime;
              const maxVisibleTime = u.scales.x?.max ?? maxTime;

              let startIdx = 0;
              while (startIdx < timePts.length - 1 && timePts[startIdx + 1] < minVisibleTime) {
                startIdx++;
              }
              let endIdx = startIdx;
              while (endIdx < timePts.length - 1 && timePts[endIdx] < maxVisibleTime) {
                endIdx++;
              }

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

              const lastK = timePts.length - 1;
              const xLast = u.valToPos(timePts[lastK], 'x', true);
              const yLast = u.valToPos(rMean[lastK], 'y', true);
              if (xLast < chartRight && endIdx === lastK) {
                u.ctx.lineTo(chartRight, yLast);
              }

              u.ctx.stroke();
              u.ctx.restore();
            }

            for (let i = 0; i < hits.length; i++) {
              const ev = hits[i];
              const px = u.valToPos(ev.targetTime, 'x', true);
              if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue;

              const isCurrent = Math.abs(ev.targetTime - curTime) < 80;
              const isDesync = ev.desyncType === DesyncType.EarlyTap || ev.desyncType === DesyncType.LateTap || ev.desyncType === DesyncType.SpeedMiss;

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

              const py = u.valToPos(ev.timeOffset, 'y', true);

              let col = '#66CCFF';
              if (ev.judgement === HitJudgement.Ok) {
                col = '#99EB47';
              } else if (ev.judgement === HitJudgement.Meh) {
                col = '#EBC247';
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
    chartBody
  );
}
