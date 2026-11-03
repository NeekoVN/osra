import uPlot from 'uplot';
import { EvaluationResult } from '../../../core/evaluator/types.ts';

export interface ChannelKinematicsConfig {
  evalResult: EvaluationResult;
  width: number;
  minTime: number;
  maxTime: number;
  syncKey: string;
  chartBody: HTMLElement;
}

export function buildKinematicsChannel(config: ChannelKinematicsConfig): uPlot {
  const { evalResult, width, minTime, maxTime, syncKey, chartBody } = config;
  const sync = uPlot.sync(syncKey);

  const ch4Data: uPlot.AlignedData = [
    evalResult.keyTimes,
    evalResult.frameVelocities,
    evalResult.frameStrains,
    evalResult.frameTurnAngles
  ];

  return new uPlot(
    {
      width,
      height: 100,
      legend: { show: false },
      cursor: { sync: { key: sync.key, setSeries: true } },
      scales: {
        x: { time: false, min: minTime, max: maxTime },
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
        // Floating turn-angle ticks (0-180°) pinned to the plot's right edge
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
    chartBody
  );
}
