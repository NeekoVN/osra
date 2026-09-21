import { Beatmap } from '../types/beatmap.ts';
import { OsuMods } from '../types/replay.ts';

export interface PerformanceInput {
  aimDifficulty: number;
  speedDifficulty: number;
  readingDifficulty: number;
  overallDifficulty: number;
  approachRate: number;
  circleSize: number;
  hitCircleCount: number;
  sliderCount: number;
  spinnerCount: number;
  totalHits: number;
  maxCombo: number;
  currentCombo: number;
  count300: number;
  count100: number;
  count50: number;
  countMiss: number;
  mods?: number;
}

export interface PerformanceBreakdown {
  totalPP: number;
  aimPP: number;
  speedPP: number;
  accPP: number;
  readingPP: number;
  effectiveMissCount: number;
  speedDeviation?: number;
}

export interface DifficultyAttributes {
  starRating: number;
  aimDifficulty: number;
  speedDifficulty: number;
  readingDifficulty: number;
  aimDifficultStrainCount: number;
  speedDifficultStrainCount: number;
  readingDifficultNoteCount: number;
  sliderFactor: number;
  maxCombo: number;
}

/**
 * Modern osu! Performance Points Calculator
 * Architected directly against osu!lazer (osu.Game.Rulesets.Osu.Difficulty.OsuPerformanceCalculator)
 * incorporating the modern 4-skill model (Aim, Speed, Accuracy, Reading),
 * tap deviation speed scaling, and Combo Scaling Removal (CSR).
 */
export class PerformancePoints {
  public static readonly BASE_MULTIPLIER = 1.12;
  public static readonly NORM_EXPONENT = 1.1;

  public static difficultyToPerformance(difficulty: number): number {
    return 4.0 * Math.pow(Math.max(0, difficulty), 3);
  }

  /**
   * Miss penalty function from osu! CSR rework:
   * 0.93 / (missCount / (4 * ln(max(1, difficultStrainCount))) + 1)
   */
  public static calculateMissPenalty(missCount: number, difficultStrainCount: number): number {
    if (missCount <= 0) return 1.0;
    const strains = Math.max(1, difficultStrainCount);
    const denom = (missCount / (4.0 * Math.log(strains))) + 1.0;
    return Math.max(0, 0.93 / denom);
  }

  /**
   * Error function approximation (Abramowitz and Stegun 7.1.26)
   */
  public static erf(x: number): number {
    if (x === 0) return 0;
    const t = 1.0 / (1.0 + 0.3275911 * Math.abs(x));
    const tau =
      t *
      (0.254829592 +
        t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const erfVal = 1.0 - tau * Math.exp(-x * x);
    return x >= 0 ? erfVal : -erfVal;
  }

  /**
   * Inverse error function approximation
   */
  public static erfInv(x: number): number {
    if (x <= -1) return -Infinity;
    if (x >= 1) return Infinity;
    if (x === 0) return 0;
    const a = 0.147;
    const sgn = Math.sign(x);
    const absX = Math.abs(x);
    const ln = Math.log(1 - absX * absX);
    const t1 = 2 / (Math.PI * a) + ln / 2;
    const t2 = ln / a;
    const baseApprox = Math.sqrt(t1 * t1 - t2) - t1;
    const c = absX >= 0.85 ? Math.pow((absX - 0.85) / 0.293, 8) : 0;
    return sgn * (Math.sqrt(baseApprox) + c);
  }

  /**
   * Estimates player tap deviation from hit judgements and OD windows
   * (OsuPerformanceCalculator.calculateDeviation)
   */
  public static calculateDeviation(
    relevantCountGreat: number,
    relevantCountOk: number,
    relevantCountMeh: number,
    greatHitWindow: number,
    okHitWindow: number,
    mehHitWindow: number
  ): number | null {
    if (relevantCountGreat + relevantCountOk + relevantCountMeh <= 0) return null;

    const n = Math.max(1, relevantCountGreat + relevantCountOk);
    const p = relevantCountGreat / n;
    const z = 2.32634787404; // 99% critical value

    const pLowerBound = Math.min(
      p,
      (n * p + (z * z) / 2) / (n + z * z) - (z / (n + z * z)) * Math.sqrt(n * p * (1 - p) + (z * z) / 4)
    );

    let deviation: number;
    if (pLowerBound > 0.01) {
      deviation = greatHitWindow / (Math.SQRT2 * PerformancePoints.erfInv(pLowerBound));

      const okTailAmount =
        (Math.sqrt(2 / Math.PI) *
          okHitWindow *
          Math.exp(-0.5 * Math.pow(okHitWindow / deviation, 2))) /
        (deviation * PerformancePoints.erf(okHitWindow / (Math.SQRT2 * deviation)));

      if (okTailAmount < 1) {
        deviation *= Math.sqrt(1 - okTailAmount);
      }
    } else {
      deviation = okHitWindow / Math.sqrt(3);
    }

    const mehVariance = (mehHitWindow * mehHitWindow + okHitWindow * mehHitWindow + okHitWindow * okHitWindow) / 3;
    const totalSuccessful = relevantCountGreat + relevantCountOk + relevantCountMeh;
    deviation = Math.sqrt(
      ((relevantCountGreat + relevantCountOk) * Math.pow(deviation, 2) + relevantCountMeh * mehVariance) /
        totalSuccessful
    );

    return deviation;
  }

  /**
   * Calculates 4-skill Performance Points with modern osu! ruleset formulas
   */
  public static calculate(input: PerformanceInput, attributes?: Partial<DifficultyAttributes>): PerformanceBreakdown {
    const totalHits = input.totalHits || (input.count300 + input.count100 + input.count50 + input.countMiss) || 1;
    const count300 = input.count300;
    const count100 = input.count100;
    const count50 = input.count50;
    const countMiss = input.countMiss;
    const mods = input.mods || 0;

    // Combo-based effective miss count (CSR matching osu!lazer OsuPerformanceCalculator)
    let effectiveMissCount = countMiss;
    const totalImperfectHits = count100 + count50 + countMiss;

    if (input.maxCombo > 0 && input.currentCombo < input.maxCombo && totalImperfectHits > countMiss) {
      const sliderCount = input.sliderCount || 0;
      const fullComboThreshold = input.maxCombo - Math.min(4 + 0.1 * sliderCount, sliderCount);
      if (input.currentCombo < fullComboThreshold) {
        const comboBasedMisses = fullComboThreshold / Math.max(1.0, input.currentCombo);
        effectiveMissCount = Math.max(countMiss, Math.min(totalImperfectHits, comboBasedMisses));
      }
    }
    effectiveMissCount = Math.min(totalHits, Math.max(0, effectiveMissCount));

    const totalPassedHits = count300 + count100 + count50 + countMiss;
    const accuracy = totalPassedHits > 0
      ? Math.max(0, Math.min(1, (count300 * 300 + count100 * 100 + count50 * 50) / (totalPassedHits * 300)))
      : 1.0;

    const aimDifficulty = input.aimDifficulty;
    const speedDifficulty = input.speedDifficulty;
    const readingDifficulty = input.readingDifficulty;
    const od = input.overallDifficulty;

    const aimStrainCount = attributes?.aimDifficultStrainCount ?? Math.max(1, totalHits * 0.35);
    const speedStrainCount = attributes?.speedDifficultStrainCount ?? Math.max(1, totalHits * 0.35);
    const readingNoteCount = attributes?.readingDifficultNoteCount ?? Math.max(1, totalHits * 0.4);

    // 1. Aim PP (Length bonus, Miss penalty, Acc scaling; no static AR scaling)
    let aimPP = PerformancePoints.difficultyToPerformance(aimDifficulty);
    const lengthBonus = 0.95 + 0.35 * Math.min(1.0, totalHits / 2000.0) +
      (totalHits > 2000 ? Math.log10(totalHits / 2000.0) * 0.5 : 0.0);
    aimPP *= lengthBonus;

    if (effectiveMissCount > 0) {
      aimPP *= PerformancePoints.calculateMissPenalty(effectiveMissCount, aimStrainCount);
    }
    aimPP *= accuracy;

    // 2. Speed PP (Harmonic sum with modern length & stamina bonus; Speed Deviation scaling)
    let speedPP = PerformancePoints.difficultyToPerformance(speedDifficulty);
    const speedLengthBonus = 0.95 + 0.20 * Math.min(1.0, totalHits / 2000.0) +
      (totalHits > 2000 ? Math.log10(totalHits / 2000.0) * 0.2 : 0.0);
    speedPP *= speedLengthBonus;

    if (effectiveMissCount > 0) {
      speedPP *= PerformancePoints.calculateMissPenalty(effectiveMissCount, speedStrainCount);
    }

    const greatHitWindow = 80 - 6 * od;
    const okHitWindow = 140 - 8 * od;
    const mehHitWindow = 200 - 10 * od;

    const speedDeviation = PerformancePoints.calculateDeviation(
      count300,
      count100,
      count50,
      greatHitWindow,
      okHitWindow,
      mehHitWindow
    );

    if (speedDeviation !== null && speedDeviation > 0) {
      // Speed high deviation nerf
      const excessSpeedDifficultyCutoff = 100 + 220 * Math.pow(22 / speedDeviation, 6.5);
      if (speedPP > excessSpeedDifficultyCutoff) {
        const scale = 50;
        let adjustedSpeedValue = scale * (Math.log((speedPP - excessSpeedDifficultyCutoff) / scale + 1) + excessSpeedDifficultyCutoff / scale);
        const lerp = 1 - Math.max(0, Math.min(1, (speedDeviation - 22.0) / (27.0 - 22.0)));
        speedPP = adjustedSpeedValue + (speedPP - adjustedSpeedValue) * lerp;
      }

      const effectiveHitWindow = 20 * Math.pow(4 / Math.max(0.1, speedDifficulty), 0.35);
      const effectiveAccuracy = PerformancePoints.erf(effectiveHitWindow / speedDeviation);
      speedPP *= Math.pow(effectiveAccuracy, 2);
    } else {
      speedPP *= Math.pow(accuracy, 2);
    }

    // 3. Accuracy PP
    const amountHitObjectsWithAccuracy = input.hitCircleCount + input.sliderCount;
    let betterAccuracyPercentage = 0;
    if (amountHitObjectsWithAccuracy > 0) {
      betterAccuracyPercentage = Math.max(
        0,
        ((count300 - Math.max(0, totalHits - amountHitObjectsWithAccuracy)) * 6 + count100 * 2 + count50) /
          (amountHitObjectsWithAccuracy * 6)
      );
    } else {
      betterAccuracyPercentage = accuracy;
    }

    let accPP = Math.pow(1.52163, od) * Math.pow(betterAccuracyPercentage, 24) * 2.83;
    accPP *= amountHitObjectsWithAccuracy < 1000
      ? Math.pow(amountHitObjectsWithAccuracy / 1000.0, 0.3)
      : Math.pow(amountHitObjectsWithAccuracy / 1000.0, 0.1);

    // 4. Reading PP (kwotaq Reading skill)
    let readingPP = PerformancePoints.difficultyToPerformance(readingDifficulty);
    if (effectiveMissCount > 0) {
      readingPP *= PerformancePoints.calculateMissPenalty(effectiveMissCount, readingNoteCount);
    }
    readingPP *= Math.pow(accuracy, 3);

    // Mod multipliers (NoFail & SpunOut)
    let multiplier = PerformancePoints.BASE_MULTIPLIER;
    if (mods & OsuMods.NoFail) {
      multiplier *= Math.max(0.90, 1.0 - 0.02 * effectiveMissCount);
    }
    if (mods & OsuMods.SpunOut && totalHits > 0) {
      multiplier *= 1.0 - Math.pow(input.spinnerCount / totalHits, 0.85);
    }

    // Combine 4 skills using p-norm (p = 1.1)
    const p = PerformancePoints.NORM_EXPONENT;
    const combinedNorm = Math.pow(
      Math.pow(Math.max(0, aimPP), p) +
      Math.pow(Math.max(0, speedPP), p) +
      Math.pow(Math.max(0, accPP), p) +
      Math.pow(Math.max(0, readingPP), p),
      1.0 / p
    );

    const totalPP = combinedNorm * multiplier;

    return {
      totalPP: isNaN(totalPP) ? 0 : Math.round(totalPP * 100) / 100,
      aimPP: isNaN(aimPP) ? 0 : Math.round(aimPP * 100) / 100,
      speedPP: isNaN(speedPP) ? 0 : Math.round(speedPP * 100) / 100,
      accPP: isNaN(accPP) ? 0 : Math.round(accPP * 100) / 100,
      readingPP: isNaN(readingPP) ? 0 : Math.round(readingPP * 100) / 100,
      effectiveMissCount,
      speedDeviation: speedDeviation ?? undefined
    };
  }

  /**
   * Analyzes beatmap hitobjects to estimate Aim, Speed, and Reading difficulty ratings
   */
  public static estimateDifficultyAttributes(beatmap: Beatmap, mods: number = 0, knownStarRating?: number): DifficultyAttributes {
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
        // High AR reaction reading
        arReadingFactor += (450 - effectivePreempt) / 300.0;
      } else if (effectivePreempt > 800) {
        // Low AR clutter reading
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

    // Scale to standard osu! star ratings (calibrated against official osu! difficulty calculator)
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

    // Count top weighted strain counts for CSR miss penalty
    const aimThreshold = rawAim * 0.25;
    const aimDifficultStrainCount = Math.max(1, aimStrains.filter(s => s >= aimThreshold).length);

    // CountTopWeightedObjectDifficulties using DiffUtils.Logistic
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
      if (o.type & 2) { // Slider
        const spans = Math.max(1, (o as any).repeatCount || 1);
        maxCombo += spans; // slider head, repeats, and end
      }
    }

    let safeAim = Math.max(0.1, aimDifficulty);
    let safeSpeed = Math.max(0.1, speedDifficulty);
    let safeReading = Math.max(0.1, readingDifficulty);

    // Star Rating calculation: Math.cbrt(basePerformance * PERFORMANCE_BASE_MULTIPLIER)
    const baseAimPerformance = PerformancePoints.difficultyToPerformance(safeAim);
    const baseSpeedPerformance = PerformancePoints.difficultyToPerformance(safeSpeed);
    const baseReadingPerformance = PerformancePoints.difficultyToPerformance(safeReading);
    const basePerformance = Math.pow(
      Math.pow(baseAimPerformance, PerformancePoints.NORM_EXPONENT) +
      Math.pow(baseSpeedPerformance, PerformancePoints.NORM_EXPONENT) +
      Math.pow(baseReadingPerformance, PerformancePoints.NORM_EXPONENT),
      1.0 / PerformancePoints.NORM_EXPONENT
    );
    let starRating = Math.cbrt(basePerformance * PerformancePoints.BASE_MULTIPLIER);

    // Anchor to known official star rating if available
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
}
