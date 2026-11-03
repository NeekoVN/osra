import { Beatmap } from '../types/beatmap.ts';
import { OsuMods } from '../types/replay.ts';
import { PerformanceInput, PerformanceBreakdown, DifficultyAttributes } from './pp/types.ts';
import {
  difficultyToPerformance,
  calculateMissPenalty,
  erf,
  erfInv,
  calculateDeviation
} from './pp/PerformanceMath.ts';
import { estimateDifficultyAttributes } from './pp/DifficultyEstimator.ts';

export type { PerformanceInput, PerformanceBreakdown, DifficultyAttributes };
export { difficultyToPerformance, calculateMissPenalty, erf, erfInv, calculateDeviation, estimateDifficultyAttributes };

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
    return difficultyToPerformance(difficulty);
  }

  public static calculateMissPenalty(missCount: number, difficultStrainCount: number): number {
    return calculateMissPenalty(missCount, difficultStrainCount);
  }

  public static erf(x: number): number {
    return erf(x);
  }

  public static erfInv(x: number): number {
    return erfInv(x);
  }

  public static calculateDeviation(
    relevantCountGreat: number,
    relevantCountOk: number,
    relevantCountMeh: number,
    greatHitWindow: number,
    okHitWindow: number,
    mehHitWindow: number
  ): number | null {
    return calculateDeviation(
      relevantCountGreat,
      relevantCountOk,
      relevantCountMeh,
      greatHitWindow,
      okHitWindow,
      mehHitWindow
    );
  }

  public static estimateDifficultyAttributes(
    beatmap: Beatmap,
    mods: number = 0,
    knownStarRating?: number
  ): DifficultyAttributes {
    return estimateDifficultyAttributes(beatmap, mods, knownStarRating);
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

    // 1. Aim PP
    let aimPP = difficultyToPerformance(aimDifficulty);
    const lengthBonus = 0.95 + 0.35 * Math.min(1.0, totalHits / 2000.0) +
      (totalHits > 2000 ? Math.log10(totalHits / 2000.0) * 0.5 : 0.0);
    aimPP *= lengthBonus;

    if (effectiveMissCount > 0) {
      aimPP *= calculateMissPenalty(effectiveMissCount, aimStrainCount);
    }
    aimPP *= accuracy;

    // 2. Speed PP
    let speedPP = difficultyToPerformance(speedDifficulty);
    const speedLengthBonus = 0.95 + 0.20 * Math.min(1.0, totalHits / 2000.0) +
      (totalHits > 2000 ? Math.log10(totalHits / 2000.0) * 0.2 : 0.0);
    speedPP *= speedLengthBonus;

    if (effectiveMissCount > 0) {
      speedPP *= calculateMissPenalty(effectiveMissCount, speedStrainCount);
    }

    const greatHitWindow = 80 - 6 * od;
    const okHitWindow = 140 - 8 * od;
    const mehHitWindow = 200 - 10 * od;

    const speedDeviation = calculateDeviation(
      count300,
      count100,
      count50,
      greatHitWindow,
      okHitWindow,
      mehHitWindow
    );

    if (speedDeviation !== null && speedDeviation > 0) {
      const excessSpeedDifficultyCutoff = 100 + 220 * Math.pow(22 / speedDeviation, 6.5);
      if (speedPP > excessSpeedDifficultyCutoff) {
        const scale = 50;
        const adjustedSpeedValue = scale * (Math.log((speedPP - excessSpeedDifficultyCutoff) / scale + 1) + excessSpeedDifficultyCutoff / scale);
        const lerp = 1 - Math.max(0, Math.min(1, (speedDeviation - 22.0) / (27.0 - 22.0)));
        speedPP = adjustedSpeedValue + (speedPP - adjustedSpeedValue) * lerp;
      }

      const effectiveHitWindow = 20 * Math.pow(4 / Math.max(0.1, speedDifficulty), 0.35);
      const effectiveAccuracy = erf(effectiveHitWindow / speedDeviation);
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

    // 4. Reading PP
    let readingPP = difficultyToPerformance(readingDifficulty);
    if (effectiveMissCount > 0) {
      readingPP *= calculateMissPenalty(effectiveMissCount, readingNoteCount);
    }
    readingPP *= Math.pow(accuracy, 3);

    // Mod multipliers
    let multiplier = PerformancePoints.BASE_MULTIPLIER;
    if (mods & OsuMods.NoFail) {
      multiplier *= Math.max(0.90, 1.0 - 0.02 * effectiveMissCount);
    }
    if (mods & OsuMods.SpunOut && totalHits > 0) {
      multiplier *= 1.0 - Math.pow(input.spinnerCount / totalHits, 0.85);
    }

    // Combine 4 skills using p-norm
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
}
