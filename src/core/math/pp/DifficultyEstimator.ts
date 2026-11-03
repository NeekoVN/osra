import { Beatmap } from '../../types/beatmap.ts';
import { OsuMods } from '../../types/replay.ts';
import { DifficultyAttributes } from './types.ts';
import { difficultyToPerformance } from './PerformanceMath.ts';

const BASE_MULTIPLIER = 1.12;
const NORM_EXPONENT = 1.1;

/**
 * Analyzes beatmap hitobjects to estimate Aim, Speed, and Reading difficulty ratings
 */
export function estimateDifficultyAttributes(
  beatmap: Beatmap,
  mods: number = 0,
  knownStarRating?: number
): DifficultyAttributes {
  const objects = beatmap.hitObjects || [];
  const totalHits = objects.length;
  if (totalHits === 0) {
    return {
      starRating: 0,
      aimDifficulty: 0,
      speedDifficulty: 0,
      readingDifficulty: 0,
      aimDifficultStrainCount: 1,
      speedDifficultStrainCount: 1,
      readingDifficultNoteCount: 1,
      sliderFactor: 1,
      maxCombo: 0
    };
  }

  let clockRate = 1.0;
  if (mods & (OsuMods.DoubleTime | OsuMods.Nightcore)) clockRate = 1.5;
  else if (mods & OsuMods.HalfTime) clockRate = 0.75;

  let cs = beatmap.difficulty.circleSize;
  let od = beatmap.difficulty.overallDifficulty;
  let ar = beatmap.difficulty.approachRate;

  if (mods & OsuMods.HardRock) {
    cs = Math.min(10.0, cs * 1.3);
    od = Math.min(10.0, od * 1.4);
    ar = Math.min(10.0, ar * 1.4);
  } else if (mods & OsuMods.Easy) {
    cs *= 0.5;
    od *= 0.5;
    ar *= 0.5;
  }

  // Preempt time (ms) based on AR
  const preempt = ar < 5 ? 1200 + 600 * (5 - ar) / 5 : 1200 - 750 * (ar - 5) / 5;
  const effectivePreempt = preempt / clockRate;

  // Calculate aim, speed, and reading strains
  const aimStrains: number[] = [];
  const speedStrains: number[] = [];
  const readingStrains: number[] = [];

  // Circle radius scaling
  const circleRadius = 54.4 - 4.48 * cs;
  const radiusScale = 32.0 / Math.max(1, circleRadius);

  for (let i = 1; i < totalHits; i++) {
    const prev = objects[i - 1];
    const curr = objects[i];

    const dt = Math.max(25, (curr.time - prev.time) / clockRate);
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const jumpDistance = Math.hypot(dx, dy) * radiusScale;

    // Aim strain: jump distance / dt
    const aimStrain = Math.pow(jumpDistance / dt, 1.25) * 42.0;
    aimStrains.push(aimStrain);

    // Speed strain: based on pure tempo (dt) and rhythm
    const speedStrain = Math.pow(150.0 / dt, 1.35) * 38.0;
    speedStrains.push(speedStrain);

    // Reading strain: density (notes visible within preempt window) + low/high AR difficulty
    let visibleNotes = 1;
    for (let j = Math.max(0, i - 12); j < i; j++) {
      if ((curr.time - objects[j].time) / clockRate <= effectivePreempt) {
        visibleNotes++;
      }
    }

    let arReadingFactor = 1.0;
    if (effectivePreempt < 450) {
      arReadingFactor += (450 - effectivePreempt) / 300.0;
    } else if (effectivePreempt > 800) {
      arReadingFactor += (effectivePreempt - 800) / 400.0 * (visibleNotes * 0.15);
    }

    if (mods & OsuMods.Hidden) {
      arReadingFactor *= 1.25 + (visibleNotes * 0.05);
    }

    const readingStrain = Math.pow(visibleNotes, 1.1) * arReadingFactor * 8.5;
    readingStrains.push(readingStrain);
  }

  // Top-weighted strain aggregation for Aim (decay-based VariableLengthStrainSkill)
  const aggregateAimSkill = (strains: number[], decay: number = 0.88): number => {
    if (strains.length === 0) return 0;
    const sorted = [...strains].sort((a, b) => b - a);
    let sum = 0;
    let weight = 1.0;
    for (let i = 0; i < sorted.length; i++) {
      sum += sorted[i] * weight;
      weight *= decay;
    }
    return sum * (1 - decay);
  };

  // Harmonic summation (HarmonicSkill in modern osu! lazer)
  const calculateHarmonicSkill = (
    strains: number[],
    harmonicScale: number,
    decayExponent: number
  ): { difficulty: number; weightSum: number } => {
    const positive = strains.filter(v => v > 0).sort((a, b) => b - a);
    let difficulty = 0;
    let weightSum = 0;
    for (let index = 0; index < positive.length; index++) {
      const h = harmonicScale / (1 + index);
      const weight = (1 + h) / (Math.pow(index, decayExponent) + 1 + h);
      weightSum += weight;
      difficulty += positive[index] * weight;
    }
    return { difficulty, weightSum };
  };

  // Logistic function matching DiffUtils.Logistic(x, midpointOffset, multiplier, maxValue)
  const logistic = (x: number, midpointOffset: number, multiplier: number, maxValue: number = 1.0): number => {
    return maxValue / (1.0 + Math.exp(multiplier * (midpointOffset - x)));
  };

  const rawAim = aggregateAimSkill(aimStrains, 0.88);
  const { difficulty: rawSpeed, weightSum: speedWeightSum } = calculateHarmonicSkill(speedStrains, 20.0, 0.90);
  const { difficulty: rawReading, weightSum: readingWeightSum } = calculateHarmonicSkill(readingStrains, 1.0, 0.90);

  // Scale to standard osu! star ratings
  let aimDifficulty = Math.pow(rawAim, 0.63) * 0.18;
  let speedDifficulty = Math.sqrt(rawSpeed) * 0.075;
  let readingDifficulty = Math.sqrt(rawReading) * 0.095;

  // Modern July 2026 rework: Stream stamina scaling & high note count flow aim
  const streamDensity = speedStrains.filter(s => s >= 45).length;
  if (streamDensity > 200) {
    const staminaScaling = 1.0 + 0.20 * Math.min(1.0, (streamDensity - 200) / 1000);
    speedDifficulty *= staminaScaling;
  }
  if (totalHits > 1500) {
    const flowAimBonus = 1.0 + 0.08 * Math.min(1.0, (totalHits - 1500) / 1500);
    aimDifficulty *= flowAimBonus;
  }

  const aimThreshold = rawAim * 0.25;
  const aimDifficultStrainCount = Math.max(1, aimStrains.filter(s => s >= aimThreshold).length);

  const consistentTopSpeed = speedWeightSum > 0 ? rawSpeed / speedWeightSum : 0;
  const speedDifficultStrainCount = consistentTopSpeed > 0
    ? Math.max(1, speedStrains.reduce((sum, s) => sum + logistic(s / consistentTopSpeed, 0.88, 10, 1.1), 0))
    : 1;

  const consistentTopReading = readingWeightSum > 0 ? rawReading / readingWeightSum : 0;
  const readingDifficultNoteCount = consistentTopReading > 0
    ? Math.max(1, readingStrains.reduce((sum, s) => sum + logistic(s / consistentTopReading, 1.15, 5, 1.1), 0))
    : 1;

  let maxCombo = totalHits;
  for (const o of objects) {
    if (o.type & 2) {
      const spans = Math.max(1, (o as any).repeatCount || 1);
      maxCombo += spans;
    }
  }

  let safeAim = Math.max(0.1, aimDifficulty);
  let safeSpeed = Math.max(0.1, speedDifficulty);
  let safeReading = Math.max(0.1, readingDifficulty);

  // Star Rating calculation: Math.cbrt(basePerformance * PERFORMANCE_BASE_MULTIPLIER)
  const baseAimPerformance = difficultyToPerformance(safeAim);
  const baseSpeedPerformance = difficultyToPerformance(safeSpeed);
  const baseReadingPerformance = difficultyToPerformance(safeReading);
  const basePerformance = Math.pow(
    Math.pow(baseAimPerformance, NORM_EXPONENT) +
    Math.pow(baseSpeedPerformance, NORM_EXPONENT) +
    Math.pow(baseReadingPerformance, NORM_EXPONENT),
    1.0 / NORM_EXPONENT
  );
  let starRating = Math.cbrt(basePerformance * BASE_MULTIPLIER);

  if (knownStarRating && knownStarRating > 0 && starRating > 0) {
    const scale = knownStarRating / starRating;
    safeAim *= scale;
    safeSpeed *= scale;
    safeReading *= scale;
    starRating = knownStarRating;
  }

  return {
    starRating: Math.round(starRating * 100) / 100,
    aimDifficulty: safeAim,
    speedDifficulty: safeSpeed,
    readingDifficulty: safeReading,
    aimDifficultStrainCount: Math.max(1, Math.round(aimDifficultStrainCount)),
    speedDifficultStrainCount: Math.max(1, Math.round(speedDifficultStrainCount)),
    readingDifficultNoteCount: Math.max(1, Math.round(readingDifficultNoteCount)),
    sliderFactor: 0.85,
    maxCombo
  };
}
