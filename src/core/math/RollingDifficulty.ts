import {
  Beatmap as RosuBeatmap,
  Difficulty as RosuDifficulty
} from '../../vendor/rosu-pp/rosu_pp_js.js';
import { Beatmap, HitObject } from '../types/beatmap.ts';
import { parseOsuBeatmap } from '../binary/OsuParser.ts';
import { ensureRosuInitialized, LazerDifficultyAttributes } from './LazerDifficulty.ts';
import { getGameplayRate } from './HitWindows.ts';

export interface RollingDifficultyPoint {
  /** Timestamp in milliseconds for this window center */
  timeMs: number;
  /** Combined rolling star rating */
  starRating: number;
  /** Aim difficulty component */
  aim: number;
  /** Speed difficulty component */
  speed: number;
  /** Reading difficulty component (from custom rosu-pp fork) */
  reading: number;
  /** Flashlight difficulty component */
  flashlight: number;
  /** Number of hitobjects present in this time window */
  objectCount: number;
}

export interface RollingDifficultyOptions {
  /** Mod bitflags (e.g. DT = 64, HR = 16) */
  mods?: number;
  /** Custom playback rate multiplier (e.g. 1.5 for DT) */
  clockRate?: number;
  /** Sampling step in milliseconds (default: 400ms) */
  stepMs?: number;
  /** Window span in milliseconds (default: 4000ms = 4.0s) */
  windowDurationMs?: number;
  /** Whether to evaluate with osu!lazer ruleset (default: true) */
  lazer?: boolean;
  /**
   * Whether to compensate for finite-window geometric strain decay truncation (default: true).
   * Scales slice difficulties by the steady-state infinite series factor 1 / (1 - 0.9^K),
   * where K is the number of 400ms sections in the window. This allows genuine local
   * difficulty spikes to be evaluated at their true physical intensity without being
   * compressed by full-map averaging.
   */
  steadyStateCompensation?: boolean;
}

export interface RollingDifficultyResult {
  stepMs: number;
  windowDurationMs: number;
  points: RollingDifficultyPoint[];
  maxStarRating: number;
  averageStarRating: number;
  overallAttributes?: LazerDifficultyAttributes;
}

/**
 * Binary search to find the lower bound index of hitobjects by time.
 */
function lowerBound(objects: HitObject[], targetTime: number): number {
  let low = 0;
  let high = objects.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (objects[mid].time < targetTime) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Binary search to find the upper bound index of hitobjects by time.
 */
function upperBound(objects: HitObject[], targetTime: number): number {
  let low = 0;
  let high = objects.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (objects[mid].time <= targetTime) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Reconstructs a minimal .osu string for a sub-slice of hit objects.
 */
export function buildSliceOsuContent(beatmap: Beatmap, sliceObjects: HitObject[]): string {
  const b = beatmap;
  let out = `osu file format v${b.formatVersion || 14}\n\n`;
  out += '[General]\nMode: 0\n\n';
  out += '[Difficulty]\n';
  out += `HPDrainRate:${b.difficulty.hpDrainRate}\n`;
  out += `CircleSize:${b.difficulty.circleSize}\n`;
  out += `OverallDifficulty:${b.difficulty.overallDifficulty}\n`;
  out += `ApproachRate:${b.difficulty.approachRate}\n`;
  out += `SliderMultiplier:${b.difficulty.sliderMultiplier}\n`;
  out += `SliderTickRate:${b.difficulty.sliderTickRate}\n\n`;

  out += '[TimingPoints]\n';
  if (b.timingPoints && b.timingPoints.length > 0) {
    for (const tp of b.timingPoints) {
      out += `${tp.time},${tp.beatLength},${tp.meter},${tp.sampleSet},${tp.sampleIndex},${tp.volume},${tp.uninherited ? 1 : 0},${tp.effects}\n`;
    }
  } else {
    out += '0,500,4,1,0,100,1,0\n';
  }

  out += '\n[HitObjects]\n';
  for (const obj of sliceObjects) {
    if (obj.objectType === 'circle') {
      out += `${obj.x},${obj.y},${obj.time},1,0,0:0:0:0:\n`;
    } else if (obj.objectType === 'slider') {
      const end = obj.sliderEnd || { x: obj.x, y: obj.y };
      out += `${obj.x},${obj.y},${obj.time},2,0,${obj.curveType || 'L'}|${Math.round(end.x)}:${Math.round(end.y)},${obj.repeatCount || 1},${obj.pixelLength || 100}\n`;
    } else if (obj.objectType === 'spinner') {
      out += `${obj.x},${obj.y},${obj.time},12,0,${obj.endTime}\n`;
    }
  }

  return out;
}

/**
 * Combines difficulty skill components into an overall Star Rating.
 * Implements osu!lazer ruleset's performance combination formula:
 * StarRating = ((BaseAim^1.1 + BaseSpeed^1.1 + BaseCognition^1.1)^(1 / 1.1) * 1.12)^(1 / 3).
 */
export function combineStarRating(
  aim: number,
  speed: number,
  reading: number = 0,
  flashlight: number = 0
): number {
  const baseAimPerf = 4.0 * Math.pow(Math.max(0, aim), 3);
  const baseSpeedPerf = 4.0 * Math.pow(Math.max(0, speed), 3);
  const baseReadingPerf = 4.0 * Math.pow(Math.max(0, reading), 3);
  const baseFlashlightPerf = 25.0 * Math.pow(Math.max(0, flashlight), 2);

  let baseCognitionPerf = 0;
  if (baseReadingPerf <= 0) {
    baseCognitionPerf = baseFlashlightPerf;
  } else if (baseFlashlightPerf <= 0) {
    baseCognitionPerf = baseReadingPerf;
  } else {
    const flRatio = Math.min(1.0, Math.max(0.25, baseFlashlightPerf / baseReadingPerf));
    baseCognitionPerf = Math.pow(
      Math.pow(baseReadingPerf, 1.1) + Math.pow(baseFlashlightPerf * flRatio, 1.1),
      1 / 1.1
    );
  }

  const basePerf = Math.pow(
    Math.pow(baseAimPerf, 1.1) + Math.pow(baseSpeedPerf, 1.1) + Math.pow(baseCognitionPerf, 1.1),
    1 / 1.1
  );

  return Math.cbrt(basePerf * 1.12);
}

/**
 * Computes a continuous rolling difficulty timeline across a beatmap.
 * Uses a fixed 400ms sampling grid and a localized sliding window
 * evaluated directly through the rosu-pp WebAssembly engine.
 */
export async function calculateRollingDifficulty(
  beatmapOrContent: Beatmap | string,
  options: RollingDifficultyOptions = {}
): Promise<RollingDifficultyResult> {
  await ensureRosuInitialized();

  const beatmap: Beatmap = typeof beatmapOrContent === 'string'
    ? parseOsuBeatmap(beatmapOrContent)
    : beatmapOrContent;

  const objects = beatmap.hitObjects;
  if (!objects || objects.length === 0) {
    return {
      stepMs: options.stepMs ?? 400,
      windowDurationMs: options.windowDurationMs ?? 4000,
      points: [],
      maxStarRating: 0,
      averageStarRating: 0
    };
  }

  const stepMs = Math.max(50, options.stepMs ?? 400);
  const windowDurationMs = Math.max(stepMs, options.windowDurationMs ?? 4000);
  const halfWindow = windowDurationMs / 2;
  const mods = options.mods ?? 0;
  const clockRate = options.clockRate ?? null;
  const effectiveRate = clockRate ?? getGameplayRate(mods);
  const lazer = options.lazer ?? true;
  const steadyStateCompensation = options.steadyStateCompensation ?? true;

  const firstTime = objects[0].time;
  const lastTime = objects[objects.length - 1].time;

  const startMs = Math.floor(Math.max(0, firstTime - halfWindow) / stepMs) * stepMs;
  const endMs = Math.ceil((lastTime + halfWindow) / stepMs) * stepMs;

  const diffCalc = new RosuDifficulty({
    mods,
    clockRate,
    lazer
  });

  let overallAttributes: LazerDifficultyAttributes | undefined;
  try {
    const fullContent = beatmap.rawContent || buildSliceOsuContent(beatmap, objects);
    const fullRosuMap = new RosuBeatmap(fullContent);
    try {
      const rawFullAttrs = diffCalc.calculate(fullRosuMap);
      overallAttributes = {
        starRating: Math.round(rawFullAttrs.stars * 100) / 100,
        maxCombo: rawFullAttrs.maxCombo,
        aimDifficulty: rawFullAttrs.aim ?? 0,
        speedDifficulty: rawFullAttrs.speed ?? 0,
        flashlightDifficulty: rawFullAttrs.flashlight ?? 0,
        sliderFactor: rawFullAttrs.sliderFactor ?? 1,
        speedNoteCount: rawFullAttrs.speedNoteCount,
        aimDifficultStrainCount: rawFullAttrs.aimDifficultStrainCount,
        speedDifficultStrainCount: rawFullAttrs.speedDifficultStrainCount,
        readingDifficulty: (rawFullAttrs as unknown as { readingDifficulty?: number }).readingDifficulty ?? 0,
        readingDifficultNoteCount: (rawFullAttrs as unknown as { readingDifficultNoteCount?: number }).readingDifficultNoteCount ?? 0,
        rawAttributes: rawFullAttrs
      };
    } finally {
      fullRosuMap.free();
    }
  } catch (err) {
    console.warn('Could not compute full map attributes for rolling difficulty:', err);
  }

  const points: RollingDifficultyPoint[] = [];

  for (let t = startMs; t <= endMs; t += stepMs) {
    const windowStart = t - halfWindow;
    const windowEnd = t + halfWindow;

    const startIdx = lowerBound(objects, windowStart);
    const endIdx = upperBound(objects, windowEnd);
    const countInWindow = Math.max(0, endIdx - startIdx);

    // Breaks or isolated single notes have 0 pattern strain
    if (countInWindow < 2) {
      points.push({
        timeMs: t,
        starRating: 0,
        aim: 0,
        speed: 0,
        reading: 0,
        flashlight: 0,
        objectCount: countInWindow
      });
      continue;
    }

    // Include 1 lead-in object before the window if present to preserve movement/strain continuity
    const sliceStartIdx = startIdx > 0 ? startIdx - 1 : startIdx;
    const sliceObjects = objects.slice(sliceStartIdx, endIdx);

    const sliceContent = buildSliceOsuContent(beatmap, sliceObjects);
    const rosuMap = new RosuBeatmap(sliceContent);

    try {
      const attrs = diffCalc.calculate(rosuMap);
      points.push({
        timeMs: t,
        starRating: Math.round(attrs.stars * 100) / 100,
        aim: Math.round((attrs.aim ?? 0) * 100) / 100,
        speed: Math.round((attrs.speed ?? 0) * 100) / 100,
        reading: Math.round(((attrs as unknown as { readingDifficulty?: number }).readingDifficulty ?? 0) * 100) / 100,
        flashlight: Math.round((attrs.flashlight ?? 0) * 100) / 100,
        objectCount: countInWindow
      });
    } finally {
      rosuMap.free();
    }
  }

  diffCalc.free();

  // Steady-state infinite series compensation with power-law skill scaling.
  // osu!'s strain accumulation uses a geometric series with decay r = 0.9 per 400ms section.
  // In steady state (infinite map), sum_{k=0}^inf 0.9^k = 1 / (1 - 0.9) = 10.0.
  // In a localized window of duration W ms, the effective time in gameplay space is
  // W_gameplay = W / effectiveRate, giving K = W_gameplay / 400 sections where
  // sum_{k=0}^{K-1} 0.9^k = 10.0 * (1 - 0.9^K).
  //
  // Crucially, this decay ratio mStrain = 1 / (1 - 0.9^K) scales physical STRAIN, NOT Star Rating.
  // In osu!, Star Rating is non-linear in strain:
  // - Speed rating = sqrt(strain) * 0.0675 (exponent 0.50)
  // - Aim rating = strain^0.63 * 0.02275 (exponent 0.63)
  // - Reading / Flashlight = sqrt(strain) (exponent 0.50)
  //
  // Additionally, rosu-pp applies a 4000ms top-strain logarithmic reduction (0.727 factor)
  // that affects 100% of a 4-second sub-slice. Correcting by 1.15 neutralizes this localized penalty.
  if (steadyStateCompensation) {
    const gameplayWindowMs = windowDurationMs / Math.max(0.1, effectiveRate);
    const kSections = Math.max(1, gameplayWindowMs / 400);
    const mStrain = 1 / (1 - Math.pow(0.9, kSections));

    const slicePenaltyCorrection = 1.15;
    const multAim = Math.pow(mStrain, 0.63) * slicePenaltyCorrection;
    const multSpeed = Math.pow(mStrain, 0.50) * slicePenaltyCorrection;
    const multReading = Math.pow(mStrain, 0.50) * slicePenaltyCorrection;
    const multFlashlight = Math.pow(mStrain, 0.50) * slicePenaltyCorrection;

    for (const pt of points) {
      if (pt.starRating > 0) {
        pt.aim = Math.round(pt.aim * multAim * 100) / 100;
        pt.speed = Math.round(pt.speed * multSpeed * 100) / 100;
        pt.reading = Math.round(pt.reading * multReading * 100) / 100;
        pt.flashlight = Math.round(pt.flashlight * multFlashlight * 100) / 100;
        pt.starRating = Math.round(combineStarRating(pt.aim, pt.speed, pt.reading, pt.flashlight) * 100) / 100;
      }
    }
  }

  let maxStarRating = 0;
  let activeStarSum = 0;
  let activeCount = 0;

  for (const pt of points) {
    if (pt.starRating > maxStarRating) {
      maxStarRating = pt.starRating;
    }
    if (pt.starRating > 0) {
      activeStarSum += pt.starRating;
      activeCount++;
    }
  }

  const averageStarRating = activeCount > 0
    ? Math.round((activeStarSum / activeCount) * 100) / 100
    : 0;

  return {
    stepMs,
    windowDurationMs,
    points,
    maxStarRating,
    averageStarRating,
    overallAttributes
  };
}

/**
 * Finds the nearest rolling difficulty point for a given audio playback timestamp.
 * Runs in O(1) time using stepMs indexing.
 */
export function getDifficultyAtTime(
  result: RollingDifficultyResult,
  timeMs: number
): RollingDifficultyPoint | undefined {
  if (!result.points || result.points.length === 0) return undefined;
  const first = result.points[0];
  const last = result.points[result.points.length - 1];

  if (timeMs < first.timeMs) return first;
  if (timeMs > last.timeMs) return last;

  const idx = Math.round((timeMs - first.timeMs) / result.stepMs);
  if (idx >= 0 && idx < result.points.length) {
    return result.points[idx];
  }
  return undefined;
}
