import initRosu, {
  Beatmap as RosuBeatmap,
  Difficulty as RosuDifficulty,
  Performance as RosuPerformance,
  DifficultyAttributes as RosuDifficultyAttributes,
  PerformanceAttributes as RosuPerformanceAttributes,
  ScoreState as RosuScoreState
} from '../../vendor/rosu-pp/rosu_pp_js.js';
import { Beatmap } from '../types/beatmap.ts';

export interface LazerDifficultyAttributes {
  starRating: number;
  maxCombo: number;
  aimDifficulty: number;
  speedDifficulty: number;
  flashlightDifficulty: number;
  sliderFactor: number;
  speedNoteCount?: number;
  aimDifficultStrainCount?: number;
  speedDifficultStrainCount?: number;
  readingDifficulty: number;
  readingDifficultNoteCount: number;
  rawAttributes: RosuDifficultyAttributes;
}

export interface LazerPerformanceBreakdown {
  totalPP: number;
  aimPP: number;
  speedPP: number;
  accPP: number;
  readingPP: number;
  flashlightPP: number;
  effectiveMissCount: number;
  speedDeviation?: number;
}

export interface LazerScoreInput {
  maxCombo?: number;
  count300?: number;
  count100?: number;
  count50?: number;
  countMiss?: number;
  countGeki?: number;
  countKatu?: number;
  sliderEndHits?: number;
  largeTickHits?: number;
  smallTickHits?: number;
  /**
   * Whether the score follows osu!lazer or osu!stable scoring rules.
   * Defaults to `true`. Pass `false` for plays recorded on stable or with the
   * Classic mod to get the legacy score semantics, and pair it with
   * `legacyTotalScore`.
   */
  lazer?: boolean;
  /** Legacy total score. Only relevant when `lazer` is `false`. */
  legacyTotalScore?: number;
}

let initPromise: Promise<void> | null = null;

/**
 * Ensures the rosu-pp WebAssembly module is initialized.
 * Compatible with both Node.js (Vitest) and Browser (Vite).
 */
export async function ensureRosuInitialized(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (typeof window === 'undefined') {
      // Node.js / Vitest runtime
      const { fileURLToPath } = await import('node:url');
      const fs = await import('node:fs');
      const wasmPath = fileURLToPath(new URL('../../vendor/rosu-pp/rosu_pp_js_bg.wasm', import.meta.url));
      const wasmBuffer = fs.readFileSync(wasmPath);
      await initRosu({ module_or_path: wasmBuffer });
    } else {
      // Browser / Vite runtime
      // @ts-expect-error Vite URL query parameter import for wasm asset
      const wasmUrl = (await import('../../vendor/rosu-pp/rosu_pp_js_bg.wasm?url')).default;
      await initRosu({ module_or_path: wasmUrl });
    }
  })();

  return initPromise;
}

/**
 * Extracts raw .osu content from Beatmap or reconstructs a minimal valid .osu string
 */
export function getBeatmapContent(beatmapOrContent: Beatmap | string): string {
  if (typeof beatmapOrContent === 'string') {
    return beatmapOrContent;
  }
  if (beatmapOrContent.rawContent) {
    return beatmapOrContent.rawContent;
  }

  // Fallback: reconstruct minimal .osu file format
  const b = beatmapOrContent;
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
  for (const tp of b.timingPoints) {
    out += `${tp.time},${tp.beatLength},${tp.meter},${tp.sampleSet},${tp.sampleIndex},${tp.volume},${tp.uninherited ? 1 : 0},${tp.effects}\n`;
  }
  out += '\n[HitObjects]\n';
  for (const obj of b.hitObjects) {
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
 * Calculates exact osu!lazer difficulty attributes (Star Rating, Aim, Speed, etc.)
 */
export async function calculateLazerDifficulty(
  beatmapOrContent: Beatmap | string,
  mods: number = 0,
  clockRate?: number
): Promise<LazerDifficultyAttributes> {
  await ensureRosuInitialized();

  const content = getBeatmapContent(beatmapOrContent);
  const rosuMap = new RosuBeatmap(content);

  try {
    const diff = new RosuDifficulty({
      mods,
      lazer: true,
      clockRate: clockRate ?? null
    });

    const attrs = diff.calculate(rosuMap);

    return {
      starRating: Math.round(attrs.stars * 100) / 100,
      maxCombo: attrs.maxCombo,
      aimDifficulty: attrs.aim ?? 0,
      speedDifficulty: attrs.speed ?? 0,
      flashlightDifficulty: attrs.flashlight ?? 0,
      sliderFactor: attrs.sliderFactor ?? 1,
      speedNoteCount: attrs.speedNoteCount,
      aimDifficultStrainCount: attrs.aimDifficultStrainCount,
      speedDifficultStrainCount: attrs.speedDifficultStrainCount,
      readingDifficulty: attrs.readingDifficulty ?? 0,
      readingDifficultNoteCount: attrs.readingDifficultNoteCount ?? 0,
      rawAttributes: attrs
    };
  } finally {
    rosuMap.free();
  }
}

function toRosuScoreState(score: LazerScoreInput): RosuScoreState {
  const state: RosuScoreState = {};
  if (score.maxCombo != null) state.maxCombo = score.maxCombo;
  if (score.count300 != null) state.n300 = score.count300;
  if (score.count100 != null) state.n100 = score.count100;
  if (score.count50 != null) state.n50 = score.count50;
  if (score.countMiss != null) state.misses = score.countMiss;
  if (score.countGeki != null) state.nGeki = score.countGeki;
  if (score.countKatu != null) state.nKatu = score.countKatu;
  if (score.sliderEndHits != null) state.sliderEndHits = score.sliderEndHits;
  if (score.largeTickHits != null) state.osuLargeTickHits = score.largeTickHits;
  if (score.smallTickHits != null) state.osuSmallTickHits = score.smallTickHits;
  if (score.legacyTotalScore != null) state.legacyTotalScore = score.legacyTotalScore;
  return state;
}

/**
 * Calculates exact osu!lazer performance points (PP) for a completed score
 */
export async function calculateLazerPerformance(
  beatmapOrContent: Beatmap | string,
  score: LazerScoreInput,
  mods: number = 0,
  cachedAttrs?: RosuDifficultyAttributes,
  clockRate?: number
): Promise<LazerPerformanceBreakdown> {
  await ensureRosuInitialized();

  const perfArgs: Record<string, unknown> = {
    mods,
    lazer: score.lazer ?? true,
    clockRate: clockRate ?? null
  };
  if (score.maxCombo != null) perfArgs.combo = score.maxCombo;
  if (score.count300 != null) perfArgs.n300 = score.count300;
  if (score.count100 != null) perfArgs.n100 = score.count100;
  if (score.count50 != null) perfArgs.n50 = score.count50;
  if (score.countMiss != null) perfArgs.misses = score.countMiss;
  if (score.countGeki != null) perfArgs.nGeki = score.countGeki;
  if (score.countKatu != null) perfArgs.nKatu = score.countKatu;
  if (score.sliderEndHits != null) perfArgs.sliderEndHits = score.sliderEndHits;
  if (score.largeTickHits != null) perfArgs.largeTickHits = score.largeTickHits;
  if (score.smallTickHits != null) perfArgs.smallTickHits = score.smallTickHits;
  if (score.legacyTotalScore != null) perfArgs.legacyTotalScore = score.legacyTotalScore;

  const perfCalc = new RosuPerformance(perfArgs);

  let perfAttrs: RosuPerformanceAttributes;

  if (cachedAttrs) {
    perfAttrs = perfCalc.calculate(cachedAttrs);
  } else {
    const content = getBeatmapContent(beatmapOrContent);
    const rosuMap = new RosuBeatmap(content);
    try {
      perfAttrs = perfCalc.calculate(rosuMap);
    } finally {
      rosuMap.free();
    }
  }

  const result: LazerPerformanceBreakdown = {
    totalPP: Math.round((perfAttrs.pp || 0) * 100) / 100,
    aimPP: Math.round(((perfAttrs.ppAim as unknown as number) || 0) * 100) / 100,
    speedPP: Math.round(((perfAttrs.ppSpeed as unknown as number) || 0) * 100) / 100,
    accPP: Math.round(((perfAttrs.ppAccuracy as unknown as number) || 0) * 100) / 100,
    flashlightPP: Math.round(((perfAttrs.ppFlashlight as unknown as number) || 0) * 100) / 100,
    readingPP: Math.round(((perfAttrs.ppReading as unknown as number) || 0) * 100) / 100,
    effectiveMissCount: (perfAttrs.effectiveMissCount as unknown as number) || (score.countMiss ?? 0),
    speedDeviation: perfAttrs.speedDeviation as unknown as number | undefined
  };

  return result;
}

export interface GradualPerformanceStepper {
  next(score: LazerScoreInput): LazerPerformanceBreakdown | undefined;
  nRemaining: number;
  free(): void;
}

/**
 * Creates a gradual performance stepper to compute authentic osu!lazer live PP on every hitobject
 */
export async function createLazerGradualPerformance(
  beatmapOrContent: Beatmap | string,
  mods: number = 0,
  clockRate?: number,
  lazer: boolean = true
): Promise<GradualPerformanceStepper> {
  await ensureRosuInitialized();

  const content = getBeatmapContent(beatmapOrContent);
  const rosuMap = new RosuBeatmap(content);

  const diff = new RosuDifficulty({
    mods,
    lazer,
    clockRate: clockRate ?? null
  });

  const gradual = diff.gradualPerformance(rosuMap);

  return {
    get nRemaining(): number {
      return gradual.nRemaining;
    },
    next(score: LazerScoreInput): LazerPerformanceBreakdown | undefined {
      const state = toRosuScoreState(score);
      const perfAttrs = gradual.next(state);
      if (!perfAttrs) return undefined;

      return {
        totalPP: Math.round((perfAttrs.pp || 0) * 100) / 100,
        aimPP: Math.round(((perfAttrs.ppAim as unknown as number) || 0) * 100) / 100,
        speedPP: Math.round(((perfAttrs.ppSpeed as unknown as number) || 0) * 100) / 100,
        accPP: Math.round(((perfAttrs.ppAccuracy as unknown as number) || 0) * 100) / 100,
        flashlightPP: Math.round(((perfAttrs.ppFlashlight as unknown as number) || 0) * 100) / 100,
        readingPP: Math.round(((perfAttrs.ppReading as unknown as number) || 0) * 100) / 100,
        effectiveMissCount: (perfAttrs.effectiveMissCount as unknown as number) || (score.countMiss ?? 0),
        speedDeviation: perfAttrs.speedDeviation as unknown as number | undefined
      };
    },
    free(): void {
      gradual.free();
      rosuMap.free();
    }
  };
}
