import { HitJudgement } from '../types/telemetry.ts';

export interface JudgedEvent {
  time: number;
  judgement: HitJudgement;
}

/**
 * Computes standard osu! accuracy percentage (0.0 - 100.0)
 */
export function calculateAccuracy(
  count300: number,
  count100: number,
  count50: number,
  countMiss: number
): number {
  const totalNotes = count300 + count100 + count50 + countMiss;
  if (totalNotes === 0) return 100.0;
  return ((300 * count300 + 100 * count100 + 50 * count50) / (300 * totalNotes)) * 100.0;
}

/**
 * Computes official osu!lazer ruleset accuracy (including slider ticks and slider tails)
 * Reference: osu.Game/Rulesets/Scoring/ScoreProcessor.cs GetBaseScoreForResult
 * Great = 300, Ok = 100, Meh = 50, LargeTickHit = 30, SliderTailHit = 150
 */
export function calculateLazerAccuracy(
  count300: number,
  count100: number,
  count50: number,
  countMiss: number,
  sliderTicksHit: number = 0,
  maxSliderTicks: number = 0,
  sliderEndsHit: number = 0,
  maxSliderEnds: number = 0
): number {
  if (maxSliderTicks === 0 && maxSliderEnds === 0) {
    return calculateAccuracy(count300, count100, count50, countMiss);
  }
  const baseScore = 300 * count300 + 100 * count100 + 50 * count50 + 30 * sliderTicksHit + 150 * sliderEndsHit;
  const totalObjects = count300 + count100 + count50 + countMiss;
  const maxBaseScore = 300 * totalObjects + 30 * maxSliderTicks + 150 * maxSliderEnds;
  if (maxBaseScore === 0) return 100.0;
  return (baseScore / maxBaseScore) * 100.0;
}

/**
 * Computes continuous rolling window accuracy based on time window (e.g. 4 beats in ms)
 */
export function calculateRollingAccuracy(
  events: JudgedEvent[],
  windowDurationMs: number
): Float32Array {
  const n = events.length;
  const result = new Float32Array(n);

  let left = 0;
  let count300 = 0;
  let count100 = 0;
  let count50 = 0;
  let countMiss = 0;

  for (let right = 0; right < n; right++) {
    const current = events[right];
    if (current.judgement === HitJudgement.Great) count300++;
    else if (current.judgement === HitJudgement.Ok) count100++;
    else if (current.judgement === HitJudgement.Meh) count50++;
    else countMiss++;

    // Slide left boundary
    const windowStart = current.time - windowDurationMs;
    while (left < right && events[left].time < windowStart) {
      const leftEvent = events[left];
      if (leftEvent.judgement === HitJudgement.Great) count300--;
      else if (leftEvent.judgement === HitJudgement.Ok) count100--;
      else if (leftEvent.judgement === HitJudgement.Meh) count50--;
      else countMiss--;
      left++;
    }

    result[right] = calculateAccuracy(count300, count100, count50, countMiss);
  }

  return result;
}
