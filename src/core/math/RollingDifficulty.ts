import {
  Beatmap as RosuBeatmap,
  Difficulty as RosuDifficulty
} from '../../vendor/rosu-pp/rosu_pp_js.js';
import { Beatmap, HitObject } from '../types/beatmap.ts';
import { parseOsuBeatmap } from '../binary/OsuParser.ts';
import { ensureRosuInitialized, LazerDifficultyAttributes } from './LazerDifficulty.ts';

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
  /** Whether to normalize rolling peak difficulty to the full map star rating (default: true) */
  normalizeToFullMap?: boolean;
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
function buildSliceOsuContent(beatmap: Beatmap, sliceObjects: HitObject[]): string {
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
  const lazer = options.lazer ?? true;
  const normalizeToFullMap = options.normalizeToFullMap ?? true;

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
  if (normalizeToFullMap) {
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
      console.warn('Could not compute full map attributes for rolling difficulty normalization:', err);
    }
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

  let rawMaxStarRating = 0;
  for (const pt of points) {
    if (pt.starRating > rawMaxStarRating) {
      rawMaxStarRating = pt.starRating;
    }
  }

  // Calibrate rolling difficulty against full-map star rating to counteract sub-map
  // geometric decay series truncation (1/(1-0.9)=10.0 vs slice ~6.5) and short-map length penalties.
  if (normalizeToFullMap && overallAttributes && rawMaxStarRating > 0 && overallAttributes.starRating > 0) {
    const scaleFactor = overallAttributes.starRating / rawMaxStarRating;
    for (const pt of points) {
      pt.starRating = Math.round(pt.starRating * scaleFactor * 100) / 100;
      pt.aim = Math.round(pt.aim * scaleFactor * 100) / 100;
      pt.speed = Math.round(pt.speed * scaleFactor * 100) / 100;
      pt.reading = Math.round(pt.reading * scaleFactor * 100) / 100;
      pt.flashlight = Math.round(pt.flashlight * scaleFactor * 100) / 100;
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
