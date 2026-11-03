import uPlot from 'uplot';
import { EvaluationResult } from '../../../core/evaluator/types.ts';

export interface ChannelAccuracyConfig {
  evalResult: EvaluationResult;
  width: number;
  minTime: number;
  maxTime: number;
  syncKey: string;
  chartBody: HTMLElement;
}

export function buildAccuracyChannel(config: ChannelAccuracyConfig): uPlot {
  const { evalResult, width, minTime, maxTime, syncKey, chartBody } = config;
  const sync = uPlot.sync(syncKey);

  const ch3Data: uPlot.AlignedData = [
    evalResult.timePoints,
    evalResult.cumulativeAcc,
    evalResult.rollingAcc
  ];

  return new uPlot(
    {
      width,
      height: 85,
      legend: { show: false },
      cursor: { sync: { key: sync.key, setSeries: true } },
      scales: {
        x: { time: false, min: minTime, max: maxTime },
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
    chartBody
  );
}
