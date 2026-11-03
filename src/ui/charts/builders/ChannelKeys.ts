import uPlot from 'uplot';
import { EvaluationResult } from '../../../core/evaluator/types.ts';
import { TimeBus } from '../../TimeBus.ts';

export interface ChannelKeysConfig {
  evalResult: EvaluationResult;
  width: number;
  minTime: number;
  maxTime: number;
  syncKey: string;
  timeBus: TimeBus;
  chartBody: HTMLElement;
}

export function buildKeysChannel(config: ChannelKeysConfig): uPlot {
  const { evalResult, width, minTime, maxTime, syncKey, timeBus, chartBody } = config;
  const sync = uPlot.sync(syncKey);

  const dummyData = new Float64Array(evalResult.keyTimes.length);
  const ch2Data: uPlot.AlignedData = [
    evalResult.keyTimes,
    dummyData
  ];

  return new uPlot(
    {
      width,
      height: 90,
      legend: { show: false },
      cursor: { sync: { key: sync.key, setSeries: true } },
      scales: {
        x: { time: false, min: minTime, max: maxTime },
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
            const curTime = timeBus.getCurrentTime();

            const laneGap = 6;
            const lanePad = 4;
            const availableH = h - 2 * lanePad - laneGap;
            const laneH = Math.max(16, Math.floor(availableH / 2));

            const k1Y = top + lanePad;
            const k2Y = k1Y + laneH + laneGap;

            const xMin = u.scales.x.min ?? minTime;
            const xMax = u.scales.x.max ?? maxTime;

            u.ctx.save();
            u.ctx.beginPath();
            u.ctx.rect(left, top, w, h);
            u.ctx.clip();

            // Lane 1 (K1) Track
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

            // Lane 2 (K2) Track
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

            // Draw K1 Horizontal Mania Notes
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

                u.ctx.fillStyle = '#FFFFFF';
                u.ctx.fillRect(xStart, noteY1, 2, noteH);
              }
            }

            // Draw K2 Horizontal Mania Notes
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

                u.ctx.fillStyle = '#FFFFFF';
                u.ctx.fillRect(xStart, noteY2, 2, noteH);
              }
            }

            // Draw Finger Lock Incidents
            const fingerLocks = evalResult.fingerLockEvents;
            for (let i = 0; i < fingerLocks.length; i++) {
              const fl = fingerLocks[i];
              if (fl.time < xMin || fl.time > xMax) continue;

              const px = u.valToPos(fl.time, 'x', true);
              if (px < left || px > left + w) continue;

              const isCurrent = Math.abs(fl.time - curTime) < 120;

              u.ctx.strokeStyle = isCurrent ? '#FDE047' : 'rgba(245, 158, 11, 0.85)';
              u.ctx.lineWidth = isCurrent ? 1.5 : 1.0;
              u.ctx.beginPath();
              u.ctx.moveTo(px, top);
              u.ctx.lineTo(px, top + h);
              u.ctx.stroke();

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

            // Lane Badges
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
    chartBody
  );
}
