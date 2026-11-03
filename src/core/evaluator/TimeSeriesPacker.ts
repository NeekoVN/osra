import { ReplayFrame } from '../types/replay.ts';
import { TimedHitEvent, HitJudgement } from '../types/telemetry.ts';
import { calculateUnstableRate, calculateRollingMeanOffset } from '../math/UnstableRate.ts';
import { calculateRollingAccuracy } from '../math/RollingAccuracy.ts';
import { KinematicsResult } from '../math/Kinematics.ts';

export interface TimeSeriesBuffers {
  timePoints: Float64Array;
  hitOffsets: Float64Array;
  rollingUR: Float64Array;
  cumulativeUR: Float64Array;
  rollingMean: Float64Array;
  rollingAcc: Float64Array;
  cumulativeAcc: Float64Array;
  k1Held: Float64Array;
  k2Held: Float64Array;
  rollingAccArr: Float32Array;
}

export function buildHitTimeSeriesBuffers(
  hitEvents: TimedHitEvent[],
  gameplayRate: number
): TimeSeriesBuffers {
  const nHits = hitEvents.length;
  const timePoints = new Float64Array(nHits);
  const hitOffsets = new Float64Array(nHits);
  const rollingUR = new Float64Array(nHits);
  const cumulativeUR = new Float64Array(nHits);
  const rollingMean = new Float64Array(nHits);
  const rollingAcc = new Float64Array(nHits);
  const cumulativeAcc = new Float64Array(nHits);
  const k1Held = new Float64Array(nHits);
  const k2Held = new Float64Array(nHits);

  const windowSize = 20;
  for (let i = 0; i < nHits; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const validWindowOffsets: number[] = [];
    for (let j = start; j <= i; j++) {
      if (hitEvents[j].judgement !== HitJudgement.Miss) {
        validWindowOffsets.push(hitEvents[j].timeOffset);
      }
    }
    if (validWindowOffsets.length >= 2) {
      rollingUR[i] = calculateUnstableRate(validWindowOffsets, gameplayRate);
    } else if (i > 0) {
      rollingUR[i] = rollingUR[i - 1];
    } else {
      rollingUR[i] = 0;
    }
  }

  const rollingMeanArr = calculateRollingMeanOffset(hitEvents.map(e => e.timeOffset), 20);
  const rollingAccArr = calculateRollingAccuracy(
    hitEvents.map(e => ({ time: e.targetTime, judgement: e.judgement })),
    2000
  );

  let c300 = 0;
  let c100 = 0;
  let c50 = 0;
  let cMiss = 0;

  let urCount = 0;
  let urMean = 0;
  let urM2 = 0;

  for (let i = 0; i < nHits; i++) {
    const ev = hitEvents[i];
    timePoints[i] = ev.targetTime;
    hitOffsets[i] = ev.timeOffset;
    rollingMean[i] = rollingMeanArr[i];
    rollingAcc[i] = rollingAccArr[i];
    k1Held[i] = ev.key === 'K1' ? 1 : 0;
    k2Held[i] = ev.key === 'K2' ? 1 : 0;

    if (ev.judgement === HitJudgement.Great) c300++;
    else if (ev.judgement === HitJudgement.Ok) c100++;
    else if (ev.judgement === HitJudgement.Meh) c50++;
    else if (ev.judgement === HitJudgement.Miss) cMiss++;

    const totalCount = c300 + c100 + c50 + cMiss;
    cumulativeAcc[i] = totalCount > 0
      ? ((300 * c300 + 100 * c100 + 50 * c50) / (300 * totalCount)) * 100
      : 100.0;

    if (ev.judgement !== HitJudgement.Miss) {
      urCount++;
      const x = ev.timeOffset / gameplayRate;
      const delta = x - urMean;
      urMean += delta / urCount;
      const delta2 = x - urMean;
      urM2 += delta * delta2;
    }
    const curVar = urCount > 1 ? urM2 / urCount : 0;
    cumulativeUR[i] = urCount > 1 ? 10.0 * Math.sqrt(curVar) : 0;
  }

  return {
    timePoints,
    hitOffsets,
    rollingUR,
    cumulativeUR,
    rollingMean,
    rollingAcc,
    cumulativeAcc,
    k1Held,
    k2Held,
    rollingAccArr
  };
}

export function buildFrameLevelKinematics(
  frames: ReplayFrame[],
  kinematics: KinematicsResult,
  keyTimes: Float64Array,
  timePoints: Float64Array,
  strains: Float64Array
): { frameVelocities: Float64Array; frameTurnAngles: Float64Array; frameStrains: Float64Array } {
  const nFrames = frames.length;
  const nHits = timePoints.length;
  const frameVelocities = new Float64Array(nFrames);
  const frameTurnAngles = new Float64Array(nFrames);
  const frameStrains = new Float64Array(nFrames);

  for (let i = 0; i < nFrames; i++) {
    frameVelocities[i] = kinematics.velocities[i] || 0;
    frameTurnAngles[i] = kinematics.snapAngles[i] || 0;
  }

  let hitIdx = 0;
  for (let i = 0; i < nFrames; i++) {
    const t = keyTimes[i];
    while (hitIdx < nHits - 1 && timePoints[hitIdx + 1] <= t) {
      hitIdx++;
    }
    if (nHits === 0) {
      frameStrains[i] = 0;
    } else if (hitIdx >= nHits - 1 || t >= timePoints[nHits - 1]) {
      frameStrains[i] = strains[nHits - 1] || 0;
    } else if (t <= timePoints[0]) {
      frameStrains[i] = strains[0] || 0;
    } else {
      const t0 = timePoints[hitIdx];
      const t1 = timePoints[hitIdx + 1];
      const s0 = strains[hitIdx];
      const s1 = strains[hitIdx + 1];
      const alpha = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      frameStrains[i] = s0 + (s1 - s0) * alpha;
    }
  }

  return { frameVelocities, frameTurnAngles, frameStrains };
}
