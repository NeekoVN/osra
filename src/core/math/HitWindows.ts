import { HitJudgement } from '../types/telemetry.ts';
import { OsuMods } from '../types/replay.ts';

export interface HitWindowsResult {
  great: number; // 300 window (ms)
  ok: number;    // 100 window (ms)
  meh: number;   // 50 window (ms)
  miss: number;  // 400ms
  od: number;    // Effective OD after mods
}

/** A lazer-style mod descriptor from soloScoreInfo, e.g. { acronym: 'DT', settings: { speed_change: 1.2 } } */
export interface SoloModLike {
  acronym?: string;
  settings?: Record<string, unknown>;
}

/**
 * Computes exact osu!lazer hit windows given base OD and active mods
 * Verified against osu.Game.Rulesets.Osu.Objects.OsuHitWindows
 */
export function difficultyRange(difficulty: number, min: number, mid: number, max: number): number {
  if (difficulty > 5) return mid + (max - mid) * (difficulty - 5) / 5;
  if (difficulty < 5) return mid - (mid - min) * (5 - difficulty) / 5;
  return mid;
}

export function calculateHitWindows(baseOD: number, mods: number = OsuMods.None, clockRate?: number): HitWindowsResult {
  let od = baseOD;

  if (mods & OsuMods.HardRock) {
    od = Math.min(10.0, od * 1.4);
  } else if (mods & OsuMods.Easy) {
    od = od * 0.5;
  }

  // Base hit windows in ms. These are the windows osu!lazer judges against:
  // replay frame timestamps are recorded in the beatmap clock, which already
  // runs at the mod rate, so scaling the windows by rate would double-penalise
  // clock mods (DT/NC/HT).
  const great = Math.floor(80 - 6 * od) - 0.5;
  const ok = Math.floor(140 - 8 * od) - 0.5;
  const meh = Math.floor(200 - 10 * od) - 0.5;
  const miss = 400.0;

  const rate = clockRate ?? getGameplayRate(mods);
  if (rate !== 1.0) {
    // Effective OD after clock speed (display/PP only, not used for judgement)
    od = Math.max(0, Math.min(11.1, (80 - great / rate) / 6));
  }

  return { great, ok, meh, miss, od };
}

/**
 * Computes effective HP Drain Rate accounting for Hard Rock and Easy mods
 */
export function calculateEffectiveHp(baseHp: number, mods: number = OsuMods.None): number {
  let hp = baseHp;
  if (mods & OsuMods.HardRock) {
    hp = Math.min(10.0, hp * 1.4);
  } else if (mods & OsuMods.Easy) {
    hp = hp * 0.5;
  }
  return hp;
}

/**
 * Computes effective Approach Rate accounting for Hard Rock, Easy, and clock mods (DT/NC/HT)
 */
export function calculateEffectiveAr(baseAr: number, mods: number = OsuMods.None, clockRate?: number): number {
  let ar = baseAr;
  if (mods & OsuMods.HardRock) {
    ar = Math.min(10.0, ar * 1.4);
  } else if (mods & OsuMods.Easy) {
    ar = ar * 0.5;
  }

  const rate = clockRate ?? getGameplayRate(mods);
  if (rate === 1.0) return ar;

  // Convert AR to preempt (ms)
  let preempt = ar < 5 ? 1200 + 600 * (5 - ar) / 5 : 1200 - 750 * (ar - 5) / 5;
  preempt /= rate;

  // Convert modded preempt back to AR
  if (preempt > 1200) {
    return Math.max(0, 5 - (preempt - 1200) / 120);
  } else {
    return Math.min(11.1, 5 + (1200 - preempt) / 150);
  }
}

/**
 * Computes effective CS, HP, OD, AR difficulty stats after all difficulty and speed mods
 */
export function calculateEffectiveDifficulty(
  base: { circleSize: number; hpDrainRate: number; overallDifficulty: number; approachRate: number },
  mods: number = OsuMods.None,
  clockRate?: number
): { cs: number; hp: number; od: number; ar: number } {
  let cs = base.circleSize;
  let hp = base.hpDrainRate;

  if (mods & OsuMods.HardRock) {
    cs = Math.min(10.0, cs * 1.3);
    hp = Math.min(10.0, hp * 1.4);
  } else if (mods & OsuMods.Easy) {
    cs = cs * 0.5;
    hp = hp * 0.5;
  }

  const ar = calculateEffectiveAr(base.approachRate, mods, clockRate);
  const windows = calculateHitWindows(base.overallDifficulty, mods, clockRate);
  const od = windows.od;

  return { cs, hp, od, ar };
}

/**
 * Returns the gameplay rate multiplier for clock-altering mods
 */
export function getGameplayRate(mods: number = OsuMods.None): number {
  if (mods & (OsuMods.DoubleTime | OsuMods.Nightcore)) {
    return 1.5;
  }
  if (mods & OsuMods.HalfTime) {
    return 0.75;
  }
  return 1.0;
}

/**
 * Returns the actual gameplay rate for a replay, preferring the explicit
 * `speed_change`/`speed_rate` setting stored on lazer solo mods (e.g.
 * DT@1.2x) and falling back to the bitmask-derived rate (stable format).
 */
export function getGameplayRateFromMods(
  soloMods: ReadonlyArray<SoloModLike> | undefined,
  mods: number = OsuMods.None
): number {
  if (soloMods && soloMods.length > 0) {
    for (const m of soloMods) {
      const acronym = (m.acronym || '').toUpperCase();
      if (acronym === 'DT' || acronym === 'NC' || acronym === 'HT') {
        const speed = m.settings?.speed_change ?? m.settings?.speed_rate;
        if (typeof speed === 'number') return speed;
      }
    }
    for (const m of soloMods) {
      const acronym = (m.acronym || '').toUpperCase();
      if (acronym === 'DT' || acronym === 'NC') return 1.5;
      if (acronym === 'HT') return 0.75;
    }
  }
  return getGameplayRate(mods);
}

/**
 * Evaluates hit judgement based on raw hit offset and hit windows
 */
export function judgeHitOffset(offsetMs: number, windows: HitWindowsResult): HitJudgement {
  const absOffset = Math.abs(offsetMs);
  if (absOffset <= windows.great) return HitJudgement.Great;
  if (absOffset <= windows.ok) return HitJudgement.Ok;
  if (absOffset <= windows.meh) return HitJudgement.Meh;
  return HitJudgement.Miss;
}
