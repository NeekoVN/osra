import { OsrReplay } from '../../core/types/replay.ts';
import { Beatmap } from '../../core/types/beatmap.ts';
import { evaluateReplaySession, EvaluationResult } from '../../core/evaluator/ReplayEvaluator.ts';
import { PerformancePoints, PerformanceBreakdown, DifficultyAttributes } from '../../core/math/PerformancePoints.ts';
import {
  calculateLazerDifficulty,
  createLazerGradualPerformance,
  LazerDifficultyAttributes,
  LazerPerformanceBreakdown
} from '../../core/math/LazerDifficulty.ts';
import { calculateEffectiveDifficulty, getGameplayRateFromMods } from '../../core/math/HitWindows.ts';
import { PrefixHitStat } from '../stats/LiveStatsManager.ts';

export interface EvaluationPipelineResult {
  evalResult: EvaluationResult;
  gameplayRate: number;
  totalDuration: number;
  firstTime: number;
  firstFrameTime: number;
  lazerDiff: LazerDifficultyAttributes | null;
  diffAttributes: DifficultyAttributes;
  maxPossiblePP: PerformanceBreakdown;
  precomputedLivePP: LazerPerformanceBreakdown[];
}

export async function runEvaluationPipeline(
  replay: OsrReplay,
  beatmap: Beatmap,
  beatmapStarRating: number | undefined,
  prefixStats: PrefixHitStat[],
  isCancelled: () => boolean
): Promise<EvaluationPipelineResult | null> {
  const evalResult = evaluateReplaySession(replay, beatmap);
  const gameplayRate = getGameplayRateFromMods(replay.soloScoreInfo?.mods, replay.mods);

  const firstFrameTime = replay.frames[0]?.time || 0;
  const lastFrameTime = replay.frames[replay.frames.length - 1]?.time || 0;
  const lastObjTime = beatmap.hitObjects[beatmap.hitObjects.length - 1]?.time || 0;
  const totalDuration = Math.max(lastFrameTime, lastObjTime) + 1500;
  const firstTime = beatmap.hitObjects[0]?.time || 0;

  let lazerDiff: LazerDifficultyAttributes | null = null;
  let diffAttributes: DifficultyAttributes;
  let maxPossiblePP: PerformanceBreakdown;
  const precomputedLivePP: LazerPerformanceBreakdown[] = [];

  try {
    lazerDiff = await calculateLazerDifficulty(beatmap, replay.mods, gameplayRate);
    if (isCancelled()) return null;

    const circles = beatmap.hitObjects.filter((o) => !(o.type & 2) && !(o.type & 8)).length;
    const sliders = beatmap.hitObjects.filter((o) => o.type & 2).length;
    const spinners = beatmap.hitObjects.filter((o) => o.type & 8).length;
    const eff = calculateEffectiveDifficulty(beatmap.difficulty, replay.mods, gameplayRate);
    const rawEstimatedSR = PerformancePoints.estimateDifficultyAttributes(beatmap, replay.mods).starRating;
    const effectiveSR = Math.max(rawEstimatedSR, beatmapStarRating || 0, lazerDiff.starRating || 0);
    const diffAttrs4Skill = PerformancePoints.estimateDifficultyAttributes(beatmap, replay.mods, effectiveSR);

    diffAttrs4Skill.aimDifficulty = lazerDiff.aimDifficulty || diffAttrs4Skill.aimDifficulty;
    diffAttrs4Skill.speedDifficulty = lazerDiff.speedDifficulty || diffAttrs4Skill.speedDifficulty;
    diffAttrs4Skill.starRating = lazerDiff.starRating || diffAttrs4Skill.starRating;
    diffAttrs4Skill.maxCombo = lazerDiff.maxCombo || diffAttrs4Skill.maxCombo;
    diffAttrs4Skill.readingDifficulty = lazerDiff.readingDifficulty || diffAttrs4Skill.readingDifficulty;
    diffAttrs4Skill.readingDifficultNoteCount =
      lazerDiff.readingDifficultNoteCount || diffAttrs4Skill.readingDifficultNoteCount;
    diffAttributes = diffAttrs4Skill;

    maxPossiblePP = PerformancePoints.calculate(
      {
        aimDifficulty: diffAttrs4Skill.aimDifficulty,
        speedDifficulty: diffAttrs4Skill.speedDifficulty,
        readingDifficulty: diffAttrs4Skill.readingDifficulty,
        overallDifficulty: eff.od,
        approachRate: eff.ar,
        circleSize: eff.cs,
        hitCircleCount: circles,
        sliderCount: sliders,
        spinnerCount: spinners,
        totalHits: beatmap.hitObjects.length,
        maxCombo: diffAttrs4Skill.maxCombo,
        currentCombo: diffAttrs4Skill.maxCombo,
        count300: beatmap.hitObjects.length,
        count100: 0,
        count50: 0,
        countMiss: 0,
        mods: replay.mods
      },
      diffAttrs4Skill
    );

    const isStable = !replay.soloScoreInfo;
    const stepper = await createLazerGradualPerformance(beatmap, replay.mods, gameplayRate, !isStable);
    if (isCancelled()) {
      stepper.free();
      return null;
    }

    const totalEvents = prefixStats.length;
    let lastPP: LazerPerformanceBreakdown | null = null;
    for (let i = 0; i < totalEvents; i++) {
      const stat = prefixStats[i];
      if (stat.ppStep) {
        const stepPP = stepper.next({
          maxCombo: stat.maxComboSoFar,
          count300: stat.c300,
          count100: stat.c100,
          count50: stat.c50,
          countMiss: stat.cMiss,
          sliderEndHits: stat.endsHit,
          largeTickHits: stat.ticksHit
        });
        if (stepPP) {
          lastPP = {
            totalPP: stepPP.totalPP,
            aimPP: stepPP.aimPP,
            speedPP: stepPP.speedPP,
            accPP: stepPP.accPP,
            readingPP: stepPP.readingPP,
            flashlightPP: stepPP.flashlightPP,
            effectiveMissCount: stepPP.effectiveMissCount
          };
        }
      }
      precomputedLivePP.push(
        lastPP ?? {
          totalPP: 0,
          aimPP: 0,
          speedPP: 0,
          accPP: 0,
          readingPP: 0,
          flashlightPP: 0,
          effectiveMissCount: 0
        }
      );
      if ((i & 255) === 255) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (isCancelled()) {
          stepper.free();
          return null;
        }
      }
    }
    stepper.free();
  } catch (err) {
    console.warn('Rosu-pp calculation error, falling back to JS heuristic:', err);
    const rawEstimatedSR = PerformancePoints.estimateDifficultyAttributes(beatmap, replay.mods).starRating;
    const effectiveSR = Math.max(rawEstimatedSR, beatmapStarRating || 0);
    diffAttributes = PerformancePoints.estimateDifficultyAttributes(beatmap, replay.mods, effectiveSR);
    const eff = calculateEffectiveDifficulty(beatmap.difficulty, replay.mods, gameplayRate);
    const circles = beatmap.hitObjects.filter((o) => !(o.type & 2) && !(o.type & 8)).length;
    const sliders = beatmap.hitObjects.filter((o) => o.type & 2).length;
    const spinners = beatmap.hitObjects.filter((o) => o.type & 8).length;

    maxPossiblePP = PerformancePoints.calculate(
      {
        aimDifficulty: diffAttributes.aimDifficulty,
        speedDifficulty: diffAttributes.speedDifficulty,
        readingDifficulty: diffAttributes.readingDifficulty,
        overallDifficulty: eff.od,
        approachRate: eff.ar,
        circleSize: eff.cs,
        hitCircleCount: circles,
        sliderCount: sliders,
        spinnerCount: spinners,
        totalHits: beatmap.hitObjects.length,
        maxCombo: diffAttributes.maxCombo,
        currentCombo: diffAttributes.maxCombo,
        count300: beatmap.hitObjects.length,
        count100: 0,
        count50: 0,
        countMiss: 0,
        mods: replay.mods
      },
      diffAttributes
    );
  }

  return {
    evalResult,
    gameplayRate,
    totalDuration,
    firstTime,
    firstFrameTime,
    lazerDiff,
    diffAttributes,
    maxPossiblePP,
    precomputedLivePP
  };
}
