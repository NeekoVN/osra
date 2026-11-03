import uPlot from 'uplot';
import { EvaluationResult } from '../../../core/evaluator/types.ts';

export interface ChannelTappingConfig {
  evalResult: EvaluationResult;
  width: number;
  minTime: number;
  maxTime: number;
  syncKey: string;
  chartBody: HTMLElement;
}

export function buildTappingChannel(config: ChannelTappingConfig): uPlot {
  const { evalResult, width, minTime, maxTime, syncKey, chartBody } = config;
  const sync = uPlot.sync(syncKey);

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

  return new uPlot(
    {
      width,
      height: 100,
      legend: { show: false },
      cursor: { sync: { key: sync.key, setSeries: true } },
      scales: {
        x: { time: false, min: minTime, max: maxTime },
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
          value: (_u, v) => (v == null ? '--' : `${Math.round(v)} BPM`)
        },
        {
          scale: 'bpm',
          label: 'Target BPM',
          stroke: 'rgba(148, 163, 184, 0.7)',
          width: 1.2,
          dash: [4, 4],
          points: { show: false },
          value: (_u, v) => (v == null ? '--' : `${Math.round(v)} BPM`)
        },
        {
          scale: 'stamina',
          label: 'Stamina Strain',
          stroke: 'rgba(255, 102, 102, 0.85)',
          width: 1,
          fill: 'rgba(255, 102, 102, 0.18)',
          points: { show: false },
          value: (_u, v) => (v == null ? '--' : `${v.toFixed(1)} strain`)
        },
        {
          scale: 'control',
          label: 'Finger Control',
          stroke: 'rgba(167, 139, 250, 0.85)',
          width: 1.2,
          dash: [4, 4],
          fill: 'rgba(167, 139, 250, 0.05)',
          points: { show: false },
          value: (_u, v) => (v == null ? '--' : `${Math.round(v)} / 100`)
        }
      ],
      hooks: {
        // Floating control ticks (0-100) pinned to the plot's right edge
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
    chartBody
  );
}
