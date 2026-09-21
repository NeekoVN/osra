import { OsrReplay, KeyFlags, OsuMods } from '../types/replay.ts';
import { Beatmap } from '../types/beatmap.ts';
import { TimedHitEvent, HitJudgement, DesyncType } from '../types/telemetry.ts';
import { calculateHitWindows, getGameplayRateFromMods, judgeHitOffset } from '../math/HitWindows.ts';
import { calculateCircleRadius, calculateHitProjection } from '../math/Projections.ts';
import { classifyDesync, findClosestApproach } from '../math/DesyncClassifier.ts';
import { calculateUnstableRate, calculateRollingMeanOffset } from '../math/UnstableRate.ts';
import { calculateRollingAccuracy } from '../math/RollingAccuracy.ts';
import { calculateKinematics } from '../math/Kinematics.ts';



import { TapPatternClassifier, TapPattern, PatternType } from './TapPatternClassifier.ts';

export interface KeyInterval {
  key: string;
  pressTime: number;
  releaseTime: number;
  duration: number;
}

export interface FingerLockEvent {
  time: number;
  duration: number;
  overlapMs: number;
  overlapStart: number;
  overlapEnd: number;
  key1: string;
  key2: string;
  patternType?: PatternType;
  patternNoteCount?: number;
  patternBpm?: number;
  patternLabel?: string;
}

export interface PatternGroup {
  startIndex: number;
  endIndex: number;
  startTime: number;
  endTime: number;
  minRollingAcc: number;
  isClean: boolean; // rolling acc never dropped under 75 in this pattern group and 0 misses
  missCount: number;
}

export interface EvaluationResult {
  hitEvents: TimedHitEvent[];
  desyncEvents: TimedHitEvent[];
  fingerLockEvents: FingerLockEvent[];
  tapPatterns: TapPattern[];
  patternGroups: PatternGroup[];
  overallUR: number;
  avgMarginUsage: number;
  longitudinalBias: number;
  lateralWobble: number;
  screenDriftQuadrant: string;
  mods: number;
  gameplayRate: number;

  // Time-series buffers for uPlot
  timePoints: Float64Array;
  hitOffsets: Float64Array;
  rollingUR: Float64Array;
  cumulativeUR: Float64Array;
  rollingMean: Float64Array;
  rollingAcc: Float64Array;
  cumulativeAcc: Float64Array;
  k1Held: Float64Array;
  k2Held: Float64Array;
  velocities: Float64Array;
  easedVelocities: Float64Array;
  turnAngles: Float64Array;
  strains: Float64Array;

  // Tapping Dynamics & Stamina for Channel 5
  tapBpm: Float64Array;
  targetBpm: Float64Array;
  staminaStrains: Float64Array;
  fingerControlScores: Float64Array;

  // Frame-level keypress timeline for Channel 2
  keyTimes: Float64Array;
  k1Frames: Float64Array;
  k2Frames: Float64Array;

  // Discrete 2K Mania Key Press Intervals
  k1Intervals: KeyInterval[];
  k2Intervals: KeyInterval[];

  // Continuous frame-level kinematics for Channel 4
  frameVelocities: Float64Array;
  frameTurnAngles: Float64Array;
  frameStrains: Float64Array;
}

/**
 * Returns a cloned beatmap with hit objects and slider curves transformed
 * to match the visual and playable space for active mods (e.g. Hard Rock vertical flip).
 */
export function getModdedBeatmap(beatmap: Beatmap, mods: number = OsuMods.None): Beatmap {
  if (!(mods & OsuMods.HardRock)) {
    return beatmap;
  }
  if ((beatmap as any).__isFlippedHR) {
    return beatmap;
  }
  const moddedObjects = beatmap.hitObjects.map(obj => {
    const flippedY = 384 - obj.y;
    const flippedStackedY = 384 - obj.stackedY;
    if (obj.objectType === 'slider') {
      return {
        ...obj,
        y: flippedY,
        stackedY: flippedStackedY,
        curvePoints: obj.curvePoints ? obj.curvePoints.map(p => ({ x: p.x, y: 384 - p.y })) : [],
        sliderEnd: obj.sliderEnd ? { x: obj.sliderEnd.x, y: 384 - obj.sliderEnd.y } : { x: obj.x, y: flippedY },
        ticks: obj.ticks ? [...obj.ticks] : []
      };
    }
    return {
      ...obj,
      y: flippedY,
      stackedY: flippedStackedY
    };
  });
  return {
    ...beatmap,
    hitObjects: moddedObjects,
    __isFlippedHR: true
  } as Beatmap;
}

/**
 * Replays and evaluates all hit events against the beatmap with exact osu!lazer rules
 */
export function evaluateReplaySession(replay: OsrReplay, rawBeatmap: Beatmap): EvaluationResult {
  const mods = replay.mods;
  const beatmap = getModdedBeatmap(rawBeatmap, mods);
  const windows = calculateHitWindows(beatmap.difficulty.overallDifficulty, mods);
  const circleRadius = calculateCircleRadius(beatmap.difficulty.circleSize, mods);
  const gameplayRate = getGameplayRateFromMods(replay.soloScoreInfo?.mods, mods);

  // Compute approach rate preempt (mirrors PlayfieldRenderer / osu! OsuHitObject.TimePreempt)
  let ar = beatmap.difficulty.approachRate;
  if (mods & OsuMods.HardRock) ar = Math.min(10.0, ar * 1.4);
  else if (mods & OsuMods.Easy) ar = ar * 0.5;
  const preemptMs = ar < 5
    ? 1200 + 600 * (5 - ar) / 5
    : 1200 - 750 * (ar - 5) / 5;

  const hitEvents: TimedHitEvent[] = [];
  const desyncEvents: TimedHitEvent[] = [];

  const frames = replay.frames;
  const objects = beatmap.hitObjects;

  // Key tracking state
  interface KeyState {
    isDown: boolean;
    pressTime: number;
  }
  const k1: KeyState = { isDown: false, pressTime: 0 };
  const k2: KeyState = { isDown: false, pressTime: 0 };

  // Track key transitions across frames
  interface TapEvent {
    time: number;
    frameIndex: number;
    x: number;
    y: number;
    key: 'K1' | 'K2' | 'M1' | 'M2';
    used: boolean;
    /** True if this tap was blocked by StartTimeOrderedHitPolicy (earlier unjudged note). */
    blocked: boolean;
    /** True once this tap has been chosen as the display tap for a missed note's vector. */
    displayUsed: boolean;
  }
  const taps: TapEvent[] = [];

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const prevF = i > 0 ? frames[i - 1] : null;
    const prevKeys = prevF ? prevF.keys : 0;

    const k1Pressed = (f.keys & KeyFlags.K1) !== 0 && (prevKeys & KeyFlags.K1) === 0;
    const k2Pressed = (f.keys & KeyFlags.K2) !== 0 && (prevKeys & KeyFlags.K2) === 0;
    const m1Pressed = (f.keys & KeyFlags.M1) !== 0 && (prevKeys & KeyFlags.M1) === 0 && (f.keys & KeyFlags.K1) === 0;
    const m2Pressed = (f.keys & KeyFlags.M2) !== 0 && (prevKeys & KeyFlags.M2) === 0 && (f.keys & KeyFlags.K2) === 0;

    if (k1Pressed) {
      taps.push({ time: f.time, frameIndex: i, x: f.x, y: f.y, key: 'K1', used: false, blocked: false, displayUsed: false });
      k1.isDown = true;
      k1.pressTime = f.time;
    } else if ((f.keys & KeyFlags.K1) === 0 && k1.isDown) {
      k1.isDown = false;
    }

    if (k2Pressed) {
      taps.push({ time: f.time, frameIndex: i, x: f.x, y: f.y, key: 'K2', used: false, blocked: false, displayUsed: false });
      k2.isDown = true;
      k2.pressTime = f.time;
    } else if ((f.keys & KeyFlags.K2) === 0 && k2.isDown) {
      k2.isDown = false;
    }

    if (m1Pressed) taps.push({ time: f.time, frameIndex: i, x: f.x, y: f.y, key: 'M1', used: false, blocked: false, displayUsed: false });
    if (m2Pressed) taps.push({ time: f.time, frameIndex: i, x: f.x, y: f.y, key: 'M2', used: false, blocked: false, displayUsed: false });
  }

  function checkTapHit(t: TapEvent, targetX: number, targetY: number) {
    const minDist = Math.hypot(t.x - targetX, t.y - targetY);
    const hitX = t.x;
    const hitY = t.y;
    const hitTime = t.time;
    return { minDist, hitX, hitY, hitTime };
  }

  // Match beatmap hit objects to taps
  let prevObjX: number | null = null;
  let prevObjY: number | null = null;

  let totalMargin = 0;
  let totalLongitudinal = 0;
  let totalLateral = 0;
  let validHitsCount = 0;

  let screenDriftX = 0;
  let screenDriftY = 0;


  interface MatchState {
    judged: boolean;
    bestTap: TapEvent | null;
    bestTapInfo: { minDist: number; hitX: number; hitY: number; hitTime: number } | null;
  }
  const matchStates: MatchState[] = objects.map(() => ({ judged: false, bestTap: null, bestTapInfo: null }));

  // ---------------------------------------------------------------------------
  // Faithful osu!lazer replay-input loop.
  //
  // Port of the lazer press pipeline for osu! standard:
  //   OsuReplayInputHandler frame diffing (button press edges)
  //   -> DrawableHitCircle.HitReceptor hit-testing (cursor inside click box)
  //   -> StartTimeOrderedHitPolicy gating (ordered note-lock)
  //   -> base hit window judgement.
  //
  //  * Every press is routed to the hit-receptors (hit circles & slider heads,
  //    `DrawableHitCircle`) whose click box contains the replay cursor position
  //    at the frame time. A press that produces no judgement (outside the hit
  //    window, or blocked by the policy) is consumed by the receptor and never
  //    falls through to an earlier object.
  //  * When several receptors contain the cursor, the earliest (current) one
  //    receives the press (lazer pools render earlier-start hit objects in front
  //    of later ones). Routing to a later receptor was empirically falsified:
  //    it force-misses every dense stream passage.
  //  * StartTimeOrderedHitPolicy (note-lock): a hit is disallowed while the
  //    last earlier unjudged blocking object has a start time strictly in the
  //    future of the press.
  //  * On a successful hit, all earlier unjudged blocking objects are
  //    force-missed (`MissForcefully`).
  //  * Unjudged objects whose hit window fully passes are auto-missed.
  // ---------------------------------------------------------------------------
  const orderedIndices = objects
    .map((_, i) => i)
    .sort((a, b) => objects[a].time - objects[b].time);

  for (let j = 0; j < taps.length; j++) {
    const t = taps[j];
    if (t.used) continue;

    // Auto-miss sweep: anything whose full hit window has elapsed is dead.
    for (const idx of orderedIndices) {
      if (matchStates[idx].judged || objects[idx].objectType === 'spinner') continue;
      if (objects[idx].time + windows.meh < t.time) {
        matchStates[idx].judged = true;
      }
    }

    // Hit-test: the earliest unjudged in-window receptor under the cursor.
    // The press is delivered to the receptor that is drawn on top; osu!lazer
    // pools draw earlier-start (current) hit objects in front of later ones,
    // so the topmost = the earliest candidate containing the cursor.
    let topmost = -1;
    for (const idx of orderedIndices) {
      const obj = objects[idx];
      if (matchStates[idx].judged || obj.objectType === 'spinner') continue;
      const windowStart = obj.time - windows.meh;
      const windowEnd = obj.time + windows.meh;
      if (t.time < windowStart) continue;
      if (t.time > windowEnd) continue;
      const info = checkTapHit(t, obj.stackedX, obj.stackedY);
      if (info.minDist > circleRadius) continue;
      topmost = idx;
      break; // earliest in-window receptor under the cursor wins
    }

    if (topmost < 0) continue; // press consumed by nothing hittable

    const obj = objects[topmost];

    // StartTimeOrderedHitPolicy: the last earlier unjudged blocking object.
    let blockingIdx = -1;
    for (const idx of orderedIndices) {
      if (objects[idx].time >= obj.time) break;
      if (matchStates[idx].judged || objects[idx].objectType === 'spinner') continue;
      blockingIdx = idx;
    }

    // If the press is before that blocking object's start time, it is blocked
    // (ClickAction.Shake): consumed, no judgement.
    if (blockingIdx >= 0 && t.time < objects[blockingIdx].time) {
      t.used = true;
      t.blocked = true;
      continue;
    }

    // Judgement against the unscaled base hit windows.
    matchStates[topmost].judged = true;
    matchStates[topmost].bestTap = t;
    matchStates[topmost].bestTapInfo = checkTapHit(t, obj.stackedX, obj.stackedY);
    t.used = true;

    // HandleHit: force-miss all earlier unjudged blocking objects.
    for (const idx of orderedIndices) {
      if (objects[idx].time >= obj.time) break;
      if (matchStates[idx].judged || objects[idx].objectType === 'spinner') continue;
      matchStates[idx].judged = true;
    }
  }

  // Watermark: the tap time of the most recently judged note. Any tap before this
  // time is causally in the past and cannot be blamed on a later miss.
  let lastJudgedTapTime = -Infinity;

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    if (obj.objectType === 'spinner') {
      hitEvents.push({
        objectIndex: i + 1,
        targetTime: obj.endTime || obj.time,
        tapTime: obj.endTime || obj.time,
        timeOffset: 0,
        rateAdjustedOffset: 0,
        judgement: HitJudgement.Great,
        isSliderHead: false,
        targetX: 256,
        targetY: 192,
        tapX: 256,
        tapY: 192,
        rawErrorX: 0,
        rawErrorY: 0,
        distanceToCenter: 0,
        circleRadius,
        marginUsagePercent: 0,
        jumpAngleRad: 0,
        longitudinalError: 0,
        lateralError: 0,
        desyncType: DesyncType.None,
        closestApproachDistance: 0,
        closestApproachTime: obj.endTime || obj.time,
        key: 'NONE'
      });
      continue;
    }

    const isSliderHead = obj.objectType === 'slider';
    const targetTime = obj.time;
    const targetX = obj.stackedX;
    const targetY = obj.stackedY;

    // Search window for valid taps around target time: [time - W_meh, time + W_meh]
    const windowStart = targetTime - windows.meh;
    const windowEnd = targetTime + windows.meh;

    // Find closest cursor approach within the hit window
    const closest = findClosestApproach(frames, targetX, targetY, windowStart, windowEnd);

    const mState = matchStates[i];
    const bestTap = mState?.bestTap || null;
    const bestTapInfo = mState?.bestTapInfo || null;

    let tapTime = targetTime;
    let tapX = targetX;
    let tapY = targetY;
    let hasTap = false;
    let hasLateTapOutsideWindow = false;
    // True when a tap was on-time (inside hit window) but cursor had already moved past
    // the hitcircle — a "cursor desync" / speed-overshoot miss.
    let hasSpeedMiss = false;
    let tapDistance = closest.minDistance;
    let keyPressed: 'K1' | 'K2' | 'M1' | 'M2' | 'NONE' = 'NONE';

    if (bestTap && bestTapInfo) {
      hasTap = true;
      tapTime = bestTap.time;
      tapX = bestTapInfo.hitX;
      tapY = bestTapInfo.hitY;
      tapDistance = bestTapInfo.minDist;
      keyPressed = bestTap.key;
    } else {
      // No tap was matched to this note in its window.
      //
      // Step 1: Check for in-window taps OUTSIDE the circle.
      // These are on-time presses where the cursor had already moved past —
      // a "speed miss" / overshoot. Prioritise these over the preempt-window
      // closest-distance search to avoid double-blaming the same tap across
      // consecutive misses (e.g. streams where every tap barely misses).
      let foundInWindowTap = false;
      let closestInWindowDist = Infinity;
      for (let ti = 0; ti < taps.length; ti++) {
        const t = taps[ti];
        if (t.time < windowStart) continue;
        if (t.time > windowEnd) break;
        // Skip taps already matched to another note or display-claimed
        if (t.used && !t.blocked) continue;
        if (t.displayUsed) continue;
        const dist = Math.hypot(t.x - targetX, t.y - targetY);
        if (dist < closestInWindowDist) {
          closestInWindowDist = dist;
          tapTime = t.time;
          tapX = t.x;
          tapY = t.y;
          tapDistance = dist;
          keyPressed = t.key;
          foundInWindowTap = true;
          hasSpeedMiss = true; // tap on time, cursor outside circle — cursor desync
          // Mark so consecutive missed notes don't claim the same tap
          t.displayUsed = true;
        }
      }

      if (!foundInWindowTap) {
        // Step 2: Attribute an out-of-window tap for display purposes only.
        //
        // Hard lower bound: never look before the previous judged note's tap time.
        // Basic timeline causality — once the game moved past a judgment, those taps
        // are consumed history and cannot be responsible for a later miss.
        //
        // Additional constraints:
        //   A) Distance cap: tap cursor must be within MAX_BLAME_RADII of the note.
        //   B) Time-proximity weight: prefer taps closer in time over spatially lucky old ones.
        const MAX_BLAME_RADII = 4.0;
        const maxBlameDist = circleRadius * MAX_BLAME_RADII;
        const TIME_WEIGHT_PX_PER_MS = 0.5;
        // Never reach back before the previous judgment
        const earliestLookback = Math.max(targetTime - preemptMs, lastJudgedTapTime);

        let bestScore = Infinity;
        let foundAnyTap = false;

        for (let ti = 0; ti < taps.length; ti++) {
          const t = taps[ti];
          if (t.time < earliestLookback) continue;
          if (t.time > windowEnd) break;
          if (t.used && !t.blocked) continue;
          if (t.displayUsed) continue;

          const dist = Math.hypot(t.x - targetX, t.y - targetY);
          // Hard distance cap: ignore taps whose cursor was nowhere near the note
          if (dist > maxBlameDist) continue;

          // Time penalty: how far outside the meh window is this tap?
          const timePenalty = t.time < windowStart
            ? (windowStart - t.time) * TIME_WEIGHT_PX_PER_MS
            : t.time > windowEnd
              ? (t.time - windowEnd) * TIME_WEIGHT_PX_PER_MS
              : 0;

          const score = dist + timePenalty;
          if (score < bestScore) {
            bestScore = score;
            tapTime = t.time;
            tapX = t.x;
            tapY = t.y;
            tapDistance = dist;
            keyPressed = t.key;
            foundAnyTap = true;
            hasLateTapOutsideWindow = t.time > windowEnd || t.time < windowStart;
          }
        }

        if (foundAnyTap) {
          // Mark the chosen tap so it won't be double-blamed on the next missed note
          for (let ti = 0; ti < taps.length; ti++) {
            if (taps[ti].time === tapTime && taps[ti].x === tapX) {
              taps[ti].displayUsed = true;
              break;
            }
          }
        } else {
          // No plausible tap found nearby — show closest cursor position within hit window.
          // This is the honest representation: we know where the cursor was, we just don't
          // know (or can't attribute) why they didn't tap.
          tapDistance = closest.minDistance;
          tapX = closest.xAtMin;
          tapY = closest.yAtMin;
        }
      }

    } // end else (no matched tap)

    // Speed miss: tap was on time → use the actual tap offset, not windows.miss
    const timeOffset = (hasTap || hasLateTapOutsideWindow || hasSpeedMiss) ? tapTime - targetTime : windows.miss;
    const rateAdjustedOffset = timeOffset / gameplayRate;

    // Classic mod & legacy stable scores do not have sliderhead accuracy (OsuModClassic.NoSliderHeadAccuracy = true)
    const isClassic = !replay.soloScoreInfo || replay.soloScoreInfo.mods?.some(m => m.acronym === 'CL');

    // Evaluate judgement
    let judgement = HitJudgement.Miss;
    if (hasTap && tapDistance <= circleRadius && Math.abs(timeOffset) <= windows.meh) {
      if (isSliderHead && isClassic) {
        judgement = HitJudgement.Great;
      } else {
        judgement = judgeHitOffset(timeOffset, windows);
      }
    }

    // Spatial projection & jump alignment
    const proj = calculateHitProjection(
      targetX,
      targetY,
      prevObjX,
      prevObjY,
      tapX,
      tapY,
      circleRadius
    );

    // Classify tap vs aim desync
    const desyncType = classifyDesync(hasTap, hasSpeedMiss, tapTime, tapDistance, circleRadius, closest);

    const hitEvent: TimedHitEvent = {
      objectIndex: i + 1,
      targetTime,
      tapTime,
      timeOffset,
      rateAdjustedOffset,
      judgement,
      isSliderHead,
      targetX,
      targetY,
      tapX,
      tapY,
      rawErrorX: proj.rawErrorX,
      rawErrorY: proj.rawErrorY,
      distanceToCenter: proj.distanceToCenter,
      circleRadius,
      marginUsagePercent: proj.marginUsagePercent,
      jumpAngleRad: proj.jumpAngleRad,
      longitudinalError: proj.longitudinalError,
      lateralError: proj.lateralError,
      desyncType,
      closestApproachDistance: closest.minDistance,
      closestApproachTime: closest.timeAtMin,
      key: keyPressed
    };

    hitEvents.push(hitEvent);

    if (desyncType === DesyncType.EarlyTap || desyncType === DesyncType.LateTap || desyncType === DesyncType.SpeedMiss) {
      desyncEvents.push(hitEvent);
    }

    if (judgement !== HitJudgement.Miss) {
      totalMargin += proj.marginUsagePercent;
      totalLongitudinal += proj.longitudinalError;
      totalLateral += Math.abs(proj.lateralError);
      screenDriftX += proj.rawErrorX;
      screenDriftY += proj.rawErrorY;
      validHitsCount++;
    }

    prevObjX = targetX;
    prevObjY = targetY;

    // Advance the causality watermark: taps at or before this time can no longer be
    // blamed on any subsequent miss. For hits, use the tap time; for misses, use the
    // end of the hit window (the point where the note definitively expired).
    if (hasTap || hasSpeedMiss) {
      lastJudgedTapTime = Math.max(lastJudgedTapTime, tapTime);
    } else {
      lastJudgedTapTime = Math.max(lastJudgedTapTime, windowEnd);
    }
  }

  // Calculate aggregates
  // Calculate UR strictly according to osu!lazer HitEventExtensions.cs:
  // AffectsUnstableRate => hitObject.HitWindows != HitWindows.Empty && result.IsHit()
  // In osu!lazer, both HitCircles and SliderHeads have hit windows and affect UR on hit.
  const urEligibleHits = hitEvents.filter(e => e.judgement !== HitJudgement.Miss);
  const validOffsets = urEligibleHits.map(e => e.timeOffset);

  const overallUR = calculateUnstableRate(validOffsets, gameplayRate);
  const urScale = 1.0;
  const avgMarginUsage = validHitsCount > 0 ? totalMargin / validHitsCount : 0;
  const longitudinalBias = validHitsCount > 0 ? totalLongitudinal / validHitsCount : 0;
  const lateralWobble = validHitsCount > 0 ? totalLateral / validHitsCount : 0;

  const avgDriftX = validHitsCount > 0 ? screenDriftX / validHitsCount : 0;
  const avgDriftY = validHitsCount > 0 ? screenDriftY / validHitsCount : 0;
  const screenDriftQuadrant = `${avgDriftY >= 0 ? 'Bottom' : 'Top'}-${avgDriftX >= 0 ? 'Right' : 'Left'}`;

  // Build continuous time arrays for uPlot
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
  const velocities = new Float64Array(nHits);

  // Compute rolling UR on all valid non-miss hits (HitCircles & SliderHeads per osu!lazer)
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
    2000 // 2-second rolling window
  );

  let c300 = 0;
  let c100 = 0;
  let c50 = 0;
  let cMiss = 0;

  // Track cumulative Unstable Rate via Welford algorithm
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

    // Cumulative accuracy calculation matching osu! score processor
    if (ev.judgement === HitJudgement.Great) c300++;
    else if (ev.judgement === HitJudgement.Ok) c100++;
    else if (ev.judgement === HitJudgement.Meh) c50++;
    else if (ev.judgement === HitJudgement.Miss) cMiss++;

    const totalCount = c300 + c100 + c50 + cMiss;
    cumulativeAcc[i] = totalCount > 0
      ? ((300 * c300 + 100 * c100 + 50 * c50) / (300 * totalCount)) * 100
      : 100.0;

    // Cumulative UR update per osu!lazer HitEventExtensions.cs (HitCircles & SliderHeads where result.IsHit())
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

  if (urScale !== 1.0) {
    for (let i = 0; i < nHits; i++) {
      rollingUR[i] *= urScale;
      cumulativeUR[i] *= urScale;
    }
  }

  const kinematics = calculateKinematics(frames);
  const easedVelocities = new Float64Array(nHits);
  const turnAngles = new Float64Array(nHits);
  const strains = new Float64Array(nHits);

  // -------------------------------------------------------------
  // Geometry & Nisico Slider Angle Modeling (osu! PR #35555)
  // Accounts for the fact that players must follow the slider ball to the end
  // -------------------------------------------------------------
  interface ObjectAimGeometry {
    startX: number;
    startY: number;
    startTime: number;
    endX: number;
    endY: number;
    endTime: number;
    approachingX: number;
    approachingY: number;
    isSlider: boolean;
    pixelLength: number;
    repeatCount: number;
    duration: number;
  }

  function getAimGeometry(obj: any): ObjectAimGeometry {
    const startX = obj.stackedX ?? obj.x;
    const startY = obj.stackedY ?? obj.y;
    const startTime = obj.time;
    const isSlider = obj.objectType === 'slider';

    if (!isSlider) {
      return {
        startX,
        startY,
        startTime,
        endX: startX,
        endY: startY,
        endTime: startTime,
        approachingX: startX,
        approachingY: startY,
        isSlider: false,
        pixelLength: 0,
        repeatCount: 1,
        duration: 0
      };
    }

    const offsetX = startX - obj.x;
    const offsetY = startY - obj.y;
    const rawEndX = obj.sliderEnd?.x ?? obj.x;
    const rawEndY = obj.sliderEnd?.y ?? obj.y;
    const endX = rawEndX + offsetX;
    const endY = rawEndY + offsetY;
    const duration = Math.max(0, obj.duration || (obj.endTime ? obj.endTime - obj.time : 0));
    const endTime = obj.endTime || (obj.time + duration);

    // Position approaching the slider end (Nisico's secondLastNestedObject):
    let approachingX = startX;
    let approachingY = startY;

    if (obj.curvePoints && obj.curvePoints.length >= 2) {
      const lastIdx = obj.curvePoints.length - 1;
      const secondLast = obj.curvePoints[Math.max(0, lastIdx - 1)];
      approachingX = secondLast.x + offsetX;
      approachingY = secondLast.y + offsetY;
    }

    return {
      startX,
      startY,
      startTime,
      endX,
      endY,
      endTime,
      approachingX,
      approachingY,
      isSlider: true,
      pixelLength: obj.pixelLength || 0,
      repeatCount: obj.repeatCount || 1,
      duration
    };
  }

  function calculateVectorAngle(
    currX: number, currY: number,
    lastX: number, lastY: number,
    lastLastX: number, lastLastY: number
  ): number {
    const v1x = lastLastX - lastX;
    const v1y = lastLastY - lastY;
    const v2x = currX - lastX;
    const v2y = currY - lastY;

    const dot = v1x * v2x + v1y * v2y;
    const det = v1x * v2y - v1y * v2x;

    return Math.abs(Math.atan2(det, dot)); // In radians [0, PI]
  }

  function calculateNisicoTurnAngle(
    currGeom: ObjectAimGeometry,
    lastGeom: ObjectAimGeometry,
    lastLastGeom: ObjectAimGeometry
  ): number {
    let angleRad: number;

    if (lastGeom.isSlider && lastGeom.pixelLength > 0) {
      // 1. Angle at the slider head
      const headAngle = calculateVectorAngle(
        currGeom.startX, currGeom.startY,
        lastGeom.startX, lastGeom.startY,
        lastLastGeom.endX, lastLastGeom.endY
      );

      // 2. Angle exiting the slider end (following the ball to the end)
      const sliderExitAngle = calculateVectorAngle(
        currGeom.startX, currGeom.startY,
        lastGeom.endX, lastGeom.endY,
        lastGeom.approachingX, lastGeom.approachingY
      );

      // In osu! difficulty calculation: Angle = Math.Min(headAngle, sliderExitAngle)
      // where smaller angle in radians = acute / sharp turn
      angleRad = Math.min(headAngle, sliderExitAngle);
    } else {
      // Normal circle angle
      angleRad = calculateVectorAngle(
        currGeom.startX, currGeom.startY,
        lastGeom.startX, lastGeom.startY,
        lastLastGeom.endX, lastLastGeom.endY
      );
    }

    // Convert to turn sharpness degrees: 0° = straight, 180° = acute reversal
    const turnSharpnessDeg = 180 - (angleRad * 180) / Math.PI;
    return Math.max(0, Math.min(180, turnSharpnessDeg));
  }

  let curStrain = 0;

  // -------------------------------------------------------------
  // Pattern Groups ("Sections") Analysis:
  // In osu!, "sections" are the pattern groups (streams, bursts, jump clusters,
  // and slider phrases) separated by rhythm pauses / pattern transitions (> 240ms).
  // -------------------------------------------------------------
  const patternGroups: PatternGroup[] = [];
  let pGroupStart = 0;

  for (let i = 0; i < nHits; i++) {
    const currObj = objects[hitEvents[i].objectIndex - 1];
    const currObjEndTime = ('endTime' in currObj && (currObj as any).endTime) ? (currObj as any).endTime : currObj.time;
    const nextObj = i < nHits - 1 ? objects[hitEvents[i + 1].objectIndex - 1] : null;

    // A gap > 240ms separates pattern groups (e.g. 1/2 beat at 125 BPM or 1/1 beat at 250 BPM)
    const gapToNext = nextObj ? (nextObj.time - currObjEndTime) / gameplayRate : 9999;
    const isPatternBoundary = i === nHits - 1 || gapToNext > 240;

    if (isPatternBoundary) {
      let minAcc = 100;
      let misses = 0;
      for (let k = pGroupStart; k <= i; k++) {
        if (rollingAccArr[k] < minAcc) minAcc = rollingAccArr[k];
        if (hitEvents[k].judgement === HitJudgement.Miss) misses++;
      }
      const startObj = objects[hitEvents[pGroupStart].objectIndex - 1];
      patternGroups.push({
        startIndex: pGroupStart,
        endIndex: i,
        startTime: startObj.time,
        endTime: currObjEndTime,
        minRollingAcc: minAcc,
        isClean: minAcc >= 75 && misses === 0,
        missCount: misses
      });
      pGroupStart = i + 1;
    }
  }

  for (let i = 0; i < nHits; i++) {
    const ev = hitEvents[i];
    const currObj = objects[ev.objectIndex - 1];
    const currGeom = getAimGeometry(currObj);
    const prevEv = i > 0 ? hitEvents[i - 1] : null;
    const prevObj = prevEv ? objects[prevEv.objectIndex - 1] : null;
    const prevGeom = prevObj ? getAimGeometry(prevObj) : null;
    const prev2Ev = i > 1 ? hitEvents[i - 2] : null;
    const prev2Obj = prev2Ev ? objects[prev2Ev.objectIndex - 1] : null;
    const prev2Geom = prev2Obj ? getAimGeometry(prev2Obj) : null;
    const nextEv = i < nHits - 1 ? hitEvents[i + 1] : null;
    const nextObj = nextEv ? objects[nextEv.objectIndex - 1] : null;

    // Binary search frame index for hit event time
    let low = 0;
    let high = frames.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (frames[mid].time < ev.targetTime) low = mid + 1;
      else high = mid - 1;
    }
    const frameIdx = Math.min(frames.length - 1, Math.max(0, low));

    // Determine actual cursor departure (from prevObj) and arrival (at currObj)
    let depCursorX = currGeom.startX;
    let depCursorY = currGeom.startY;
    let depCursorTime = ev.targetTime - 100;
    let approachX = depCursorX;
    let approachY = depCursorY;
    let depFrameIdx = frameIdx;

    if (prevEv && prevGeom) {
      if (prevGeom.isSlider) {
        // Player tracked the slider until its end (or departure point)
        let sLow = 0;
        let sHigh = frames.length - 1;
        while (sLow <= sHigh) {
          const sMid = (sLow + sHigh) >> 1;
          if (frames[sMid].time < prevGeom.endTime) sLow = sMid + 1;
          else sHigh = sMid - 1;
        }
        depFrameIdx = Math.min(frames.length - 1, Math.max(0, sLow));
        depCursorX = frames[depFrameIdx].x;
        depCursorY = frames[depFrameIdx].y;
        depCursorTime = frames[depFrameIdx].time;

        // Approach vector leading into slider end (~30-50ms prior)
        let preIdx = depFrameIdx;
        while (preIdx > 0 && frames[preIdx].time > depCursorTime - 45) {
          preIdx--;
        }
        approachX = frames[preIdx].x;
        approachY = frames[preIdx].y;
      } else {
        // Hit Circle: player tapped or arrived at prevEv.tapTime
        depCursorX = prevEv.tapX;
        depCursorY = prevEv.tapY;
        depCursorTime = prevEv.tapTime;

        let cLow = 0;
        let cHigh = frames.length - 1;
        while (cLow <= cHigh) {
          const cMid = (cLow + cHigh) >> 1;
          if (frames[cMid].time < prevEv.tapTime) cLow = cMid + 1;
          else cHigh = cMid - 1;
        }
        depFrameIdx = Math.min(frames.length - 1, Math.max(0, cLow));

        let preIdx = depFrameIdx;
        while (preIdx > 0 && frames[preIdx].time > depCursorTime - 45) {
          preIdx--;
        }
        approachX = frames[preIdx].x;
        approachY = frames[preIdx].y;
      }
    }

    const arrCursorX = ev.tapX;
    const arrCursorY = ev.tapY;
    const arrCursorTime = ev.tapTime;

    // Turn Angle calculation: Player's actual cursor redirection is the ground truth
    let turnAngle = 0;
    if (prevGeom) {
      const vinX = depCursorX - approachX;
      const vinY = depCursorY - approachY;
      const lenIn = Math.hypot(vinX, vinY);

      const voutX = arrCursorX - depCursorX;
      const voutY = arrCursorY - depCursorY;
      const lenOut = Math.hypot(voutX, voutY);

      let vectorSharpness = 0;
      if (lenIn > 0.5 && lenOut > 0.5) {
        const dot = vinX * voutX + vinY * voutY;
        const det = vinX * voutY - vinY * voutX;
        const angleRad = Math.abs(Math.atan2(det, dot));
        vectorSharpness = (angleRad * 180) / Math.PI;
      }

      // Instantaneous peak snap angle during transition window
      let peakSnap = 0;
      const tTransStart = depCursorTime - 30;
      const tTransEnd = depCursorTime + 50;
      let sF = depFrameIdx;
      while (sF > 0 && frames[sF].time > tTransStart) sF--;
      for (let f = sF; f < frames.length; f++) {
        if (frames[f].time > tTransEnd) break;
        if (kinematics.snapAngles[f] > peakSnap) {
          peakSnap = kinematics.snapAngles[f];
        }
      }

      if (lenIn > 0.5 && lenOut > 0.5) {
        turnAngle = Math.max(vectorSharpness, peakSnap);
      } else if (peakSnap > 0) {
        turnAngle = peakSnap;
      } else {
        // Fallback to beatmap nominal turn angle only if cursor was completely motionless
        turnAngle = (prevGeom && prev2Geom) ? calculateNisicoTurnAngle(currGeom, prevGeom, prev2Geom) : 0;
      }
    }
    turnAngles[i] = turnAngle;

    // Cursor Velocity: Search transit jump window [depCursorTime, ev.targetTime]
    // for peak snap velocity so deceleration on the hit circle doesn't zero out the jump
    const tJumpStart = prevGeom ? depCursorTime : ev.targetTime - 100;
    const tJumpEnd = ev.targetTime;

    let maxEasedVel = kinematics.easedVelocities[frameIdx] || 0;
    let maxRawVel = kinematics.velocities[frameIdx] || 0;

    let startF = frameIdx;
    while (startF > 0 && frames[startF].time > tJumpStart - 10) {
      startF--;
    }
    for (let f = startF; f < frames.length; f++) {
      const ft = frames[f].time;
      if (ft >= tJumpStart - 10 && ft <= tJumpEnd + 20) {
        if (kinematics.easedVelocities[f] > maxEasedVel) {
          maxEasedVel = kinematics.easedVelocities[f];
        }
        if (kinematics.velocities[f] > maxRawVel) {
          maxRawVel = kinematics.velocities[f];
        }
      }
      if (ft > tJumpEnd + 20) break;
    }

    velocities[i] = maxRawVel;
    easedVelocities[i] = maxEasedVel;

    // Aim Strain calculation: Player's actual cursor displacement and transit timing is the ground truth
    if (prevGeom) {
      const jumpDist = Math.hypot(arrCursorX - depCursorX, arrCursorY - depCursorY);
      const dtJump = Math.max(15, (arrCursorTime - depCursorTime) / gameplayRate);
      const rawJumpSpeed = jumpDist / dtJump; // px/ms
      const jumpSpeed = Math.max(rawJumpSpeed, maxEasedVel * 0.8);

      // Decay strain during the jump transit
      const decay = Math.pow(0.15, dtJump / 1000);
      curStrain *= decay;

      // Acute turn sharpness increases jump difficulty (angle bonus)
      let angleBonus = 1.0;
      if (turnAngle > 60) {
        angleBonus = 1.0 + Math.min(1.2, Math.pow((turnAngle - 60) / 60, 1.25) * 0.65);
      }

      // Jump strain addition
      const jumpStrain = Math.pow(jumpSpeed, 1.25) * 40.0 * angleBonus;
      curStrain += jumpStrain;

      // Tech Alt & Micro-Aim Inertia Strain:
      // Fast cadence (105ms - 205ms) with non-overlapping micro-jump spacing (1.0x to 4.2x circle diameter)
      // where the player's hand must repeatedly arrest inertia and execute abrupt counter-movements (square corners, reversals, zig-zags).
      const circleDiam = circleRadius * 2;
      const spacingRatio = circleDiam > 0 ? jumpDist / circleDiam : 1.5;

      if (dtJump >= 100 && dtJump <= 205 && spacingRatio >= 1.0 && spacingRatio <= 4.2) {
        // Cadence weight: peaks around 130ms - 165ms (e.g. 180 - 240 BPM 1/2 beat or fast 1/3)
        const cadenceWeight = Math.max(0, 1.0 - Math.abs(dtJump - 150) / 65);

        // Inertia arrest on directional change:
        // Right angles (80°-110°) destroy 100% of orthogonal momentum; reversals (135°-180°) require total counter-acceleration
        let inertiaArrest = 0;
        if (turnAngle >= 60) {
          if (turnAngle >= 135) {
            // Linear reversal / back-and-forth counter-movement
            inertiaArrest = 1.2 + ((turnAngle - 135) / 45) * 0.8; // 1.2 to 2.0
          } else if (turnAngle >= 75) {
            // Square corner / acute deflection
            inertiaArrest = 0.8 + ((turnAngle - 75) / 60) * 0.5; // 0.8 to 1.3
          } else {
            inertiaArrest = ((turnAngle - 60) / 15) * 0.5; // 0 to 0.5
          }
        }

        // Check trajectory oscillation (zigzagging/wiggling path)
        let oscillationBonus = 0;
        if (i >= 2) {
          const prev2Ev = hitEvents[i - 2];
          const prev2Obj = prev2Ev ? objects[prev2Ev.objectIndex - 1] : null;
          if (prev2Obj && prevObj) {
            const uX = prevObj.x - prev2Obj.x;
            const uY = prevObj.y - prev2Obj.y;
            const vX = currObj.x - prevObj.x;
            const vY = currObj.y - prevObj.y;
            const crossPrev = uX * vY - uY * vX;

            if (nextObj) {
              const wX = nextObj.x - currObj.x;
              const wY = nextObj.y - currObj.y;
              const crossNext = vX * wY - vY * wX;
              // Alternating cross product sign indicates zigzag/swinging oscillation
              if ((crossPrev > 250 && crossNext < -250) || (crossPrev < -250 && crossNext > 250)) {
                oscillationBonus = 0.65;
              }
            }
          }
        }

        if (inertiaArrest > 0 || oscillationBonus > 0) {
          const techAltStrain = Math.pow(jumpSpeed, 0.9) * 26.0 * cadenceWeight * (inertiaArrest + oscillationBonus);
          curStrain += techAltStrain;
        }
      }

      // Slider ball tracking: measure actual distance traveled across replay frames
      if (currGeom.isSlider && currGeom.pixelLength > 0) {
        const sliderDt = Math.max(20, currGeom.duration / gameplayRate);
        let actualTravel = 0;
        let sF = frameIdx;
        while (sF > 0 && frames[sF].time > currGeom.startTime) sF--;
        let eF = frameIdx;
        while (eF < frames.length - 1 && frames[eF].time < currGeom.endTime) eF++;
        for (let f = sF + 1; f <= eF; f++) {
          actualTravel += Math.hypot(frames[f].x - frames[f - 1].x, frames[f].y - frames[f - 1].y);
        }
        const actualSpeed = actualTravel / sliderDt; // px/ms
        const sliderTrackingStrain = Math.pow(actualSpeed, 1.15) * 22.0;

        // Holding and tracking the slider sustains aim strain
        curStrain = curStrain * Math.pow(0.4, sliderDt / 1000) + sliderTrackingStrain;
      }
    }

    strains[i] = curStrain;
  }

  // -------------------------------------------------------------
  // Tapping Dynamics, Cadence & Stamina Fatigue for Channel 5
  // -------------------------------------------------------------
  const tapBpm = new Float64Array(nHits);
  const targetBpm = new Float64Array(nHits);
  const staminaStrains = new Float64Array(nHits);
  const fingerControlScores = new Float64Array(nHits);

  let staminaK1 = 0;
  let staminaK2 = 0;
  let lastTapTimeK1 = -99999;
  let lastTapTimeK2 = -99999;
  let prevTapTime = hitEvents[0]?.tapTime ?? (objects[0]?.time ?? 0);
  let prevHeadToHeadDt = 100; // default baseline (ms)

  const rawTapBpm = new Float64Array(nHits);

  for (let i = 0; i < nHits; i++) {
    const ev = hitEvents[i];
    const prevEv = i > 0 ? hitEvents[i - 1] : null;
    const nextEv = i < nHits - 1 ? hitEvents[i + 1] : null;
    const currObj = objects[ev.objectIndex - 1];
    const prevObj = prevEv ? objects[prevEv.objectIndex - 1] : null;
    const nextObj = nextEv ? objects[nextEv.objectIndex - 1] : null;
    const isSlider = currObj?.objectType === 'slider';

    // Primary rhythm cadence is the head-to-head interval between hit objects
    const prevDtAudio = prevObj ? Math.max(20, currObj.time - prevObj.time) : (nextObj ? Math.max(20, nextObj.time - currObj.time) : 100);
    const nextDtAudio = nextObj ? Math.max(20, nextObj.time - currObj.time) : prevDtAudio;
    const headToHeadDtAudio = prevDtAudio;
    const headToHeadDtReal = headToHeadDtAudio / gameplayRate;

    // Local minimum gap: captures whether this note participates in a fast burst/stream (either as start, middle, or end)
    const localMinDtReal = Math.min(prevDtAudio, nextDtAudio) / gameplayRate;

    // Actual player tap cadence (ms)
    let tapDtReal = headToHeadDtReal;
    if (prevEv) {
      const tapDtAudio = ev.tapTime - prevTapTime;
      if (tapDtAudio >= 15 && tapDtAudio <= 2000) {
        tapDtReal = tapDtAudio / gameplayRate;
      } else {
        tapDtReal = headToHeadDtReal;
      }
    }
    prevTapTime = ev.tapTime;

    // Equivalent 1/4 streaming BPM (osu! standard: 15000 / dt)
    rawTapBpm[i] = Math.max(0, Math.min(450, 15000 / Math.max(30, tapDtReal)));
    targetBpm[i] = Math.max(0, Math.min(450, 15000 / Math.max(30, headToHeadDtReal)));

    // -------------------------------------------------------------
    // Per-Finger Physical Stamina (Natural Tendon Rest Recovery)
    // -------------------------------------------------------------
    const isK1 = ev.key === 'K1' || ev.key === 'M1';
    const isK2 = ev.key === 'K2' || ev.key === 'M2';

    // Time elapsed since previous hit event in real milliseconds
    const dtSincePrevHit = prevEv ? Math.max(10, (ev.tapTime - prevEv.tapTime) / gameplayRate) : 500;

    // Continuous tendon rest decay during the interval between hits (half-life ~280ms)
    const restDecay = Math.pow(0.5, dtSincePrevHit / 280);
    staminaK1 *= restDecay;
    staminaK2 *= restDecay;

    // Time since this specific finger last tapped
    const dtSameFinger = isK1
      ? (lastTapTimeK1 > -90000 ? (ev.tapTime - lastTapTimeK1) / gameplayRate : 1000)
      : isK2
        ? (lastTapTimeK2 > -90000 ? (ev.tapTime - lastTapTimeK2) / gameplayRate : 1000)
        : 1000;

    // A finger only accumulates stamina strain when it is pressed with high repetition frequency (dtSameFinger <= 260ms).
    // When dtSameFinger > 260ms (e.g. alternating slow sliders or chill jumps), tendons have ample recovery time.
    if (dtSameFinger <= 260) {
      let tapAddition = Math.pow((260 - dtSameFinger) / 60, 1.3) * 6.0;
      if (isSlider) {
        // Holding a slider involves static grip rather than rapid kinetic strikes
        tapAddition = dtSameFinger <= 180 ? tapAddition * 0.25 : 0;
      }

      if (isK1) {
        staminaK1 += tapAddition;
      } else if (isK2) {
        staminaK2 += tapAddition;
      } else {
        staminaK1 += tapAddition * 0.5;
        staminaK2 += tapAddition * 0.5;
      }
    }

    if (isK1) lastTapTimeK1 = ev.tapTime;
    if (isK2) lastTapTimeK2 = ev.tapTime;

    staminaStrains[i] = Math.max(staminaK1, staminaK2);

    // -------------------------------------------------------------
    // Finger Control & Playstyle Psychology (Alternation vs Reset)
    // -------------------------------------------------------------
    let fcScore = 0;

    if (isSlider && currObj) {
      // In osu!, holding a slider requires 0 finger control.
      // The only exception is a fast burst-tail kick-slider inside a stream (localMinDt <= 115ms)
      // where the player must release cleanly to strike the next rapid note:
      if (localMinDtReal <= 115) {
        const currEndTime = ('endTime' in currObj && currObj.endTime) ? currObj.endTime : currObj.time;
        const liftOffWindow = nextObj ? Math.max(0, (nextObj.time - currEndTime) / gameplayRate) : 999;
        if (liftOffWindow <= 120) {
          let liftOffPressure = Math.min(2.5, 120 / Math.max(20, liftOffWindow));
          if (nextEv && ev.key !== 'NONE' && nextEv.key === ev.key) {
            liftOffPressure *= 1.6; // Same finger re-press immediately after slider release
          }
          fcScore = Math.min(100, 25.0 * liftOffPressure);
        }
      }
    } else if (!isSlider && prevObj && currObj) {
      // Hit Circles
      // Cadence speed: finger control is demanding on:
      // A) Rapid burst/stream rhythms (localMinDt <= 135ms)
      // B) Fast alternating tech patterns (135ms < localMinDt <= 190ms with micro-jumps / acute turns / rhythm shifts / mono-tap galloping)
      const isStreamCadence = localMinDtReal <= 135;
      const isAltCadence = localMinDtReal > 135 && localMinDtReal <= 190;

      // 2. Rhythm Irregularity & Tech Cadence Shift
      const ratio = headToHeadDtReal / Math.max(25, prevHeadToHeadDt);
      const logRatio = Math.abs(Math.log2(Math.max(0.05, ratio)));
      const rhythmShift = Math.min(1.8, logRatio * 1.0);

      if (isStreamCadence || (isAltCadence && (turnAngles[i] >= 50 || rhythmShift > 0.20 || dtSameFinger < 220))) {
        // 1. Speed intensity
        const speedIntensity = isStreamCadence
          ? Math.min(2.5, Math.pow((135 - localMinDtReal) / 35, 1.25))
          : Math.max(0.40, ((190 - localMinDtReal) / 55) * 0.90);

        // 3. Tapping Timing & Accuracy Consistency
        // Large hit offset errors reflect struggle in rhythmic finger control execution
        const absOffset = Math.abs(ev.timeOffset);
        const accuracyDemand = 1.0 + Math.min(0.6, absOffset / 35);

        // 4. Rhythm Irregularity & Tech Cadence Transition
        // Uniform streams have shift ≈ 0; polyrhythms, syncopations, and rhythm changes increase demand
        const rhythmFactor = 1.0 + Math.min(1.2, rhythmShift * 0.8);

        // 5. Short Burst Factor (bursts of 3-7 notes require rapid start/stop coordination)
        let burstFactor = 1.0;
        if (headToHeadDtReal <= 120) {
          burstFactor = 1.25;
        }

        // 6. Odd-Spaced Burst & Tech Alt Coordination Deception
        // When consecutive notes in a continuous burst/stream have wildly uneven spacing (e.g. jumps between clusters),
        // abrupt angle changes, or micro-jump alternating snaps, the visual system tricks the player into perceiving disjoint rhythm chunks.
        // Forcing the tapping fingers to maintain continuous cadence despite deceptive spatial counter-movements
        // demands intense mental decoupling and finger control skill.
        let oddSpacedBurstFactor = 1.0;
        if (headToHeadDtReal <= 190) {
          const currDist = prevEv
            ? Math.hypot(ev.tapX - prevEv.tapX, ev.tapY - prevEv.tapY)
            : Math.hypot(currObj.x - prevObj.x, currObj.y - prevObj.y);

          const prev2Ev = i > 1 ? hitEvents[i - 2] : null;
          const prev2Obj = prev2Ev ? objects[prev2Ev.objectIndex - 1] : null;
          const prevDist = prevEv && prev2Ev
            ? Math.hypot(prevEv.tapX - prev2Ev.tapX, prevEv.tapY - prev2Ev.tapY)
            : (prevObj && prev2Obj ? Math.hypot(prevObj.x - prev2Obj.x, prevObj.y - prev2Obj.y) : null);

          const nextObjCoords = nextObj ? { x: nextObj.x, y: nextObj.y } : null;
          const nextDist = nextObjCoords
            ? Math.hypot(nextObjCoords.x - currObj.x, nextObjCoords.y - currObj.y)
            : null;

          // Detect spacing disparity (e.g. 25px cluster next to 120px jump -> disparity 4.8x)
          let maxDisparity = 1.0;
          if (prevDist !== null && prevDist > 5 && currDist > 5) {
            const ratio1 = Math.max(currDist, prevDist) / Math.min(currDist, prevDist);
            if (ratio1 > maxDisparity) maxDisparity = ratio1;
          }
          if (nextDist !== null && nextDist > 5 && currDist > 5) {
            const ratio2 = Math.max(currDist, nextDist) / Math.min(currDist, nextDist);
            if (ratio2 > maxDisparity) maxDisparity = ratio2;
          }

          if (maxDisparity > 1.8) {
            const spacingDeception = Math.min(0.75, (maxDisparity - 1.8) * 0.28);
            oddSpacedBurstFactor += spacingDeception;
          }

          // Abrupt angle discontinuity / zigzag inside the burst reinforces the chunking illusion
          if (turnAngles[i] > 40 && currDist > 15) {
            const angleDeception = Math.min(0.35, ((turnAngles[i] - 40) / 90) * 0.30);
            oddSpacedBurstFactor += angleDeception;
          }

          // Subtle aim-finger sync bonus for spaced streams (capped at +35%)
          const circleDiam = circleRadius * 2;
          const spacingRatio = circleDiam > 0 ? currDist / circleDiam : 0;
          if (spacingRatio > 0.4 && headToHeadDtReal <= 125) {
            oddSpacedBurstFactor += Math.min(0.35, (spacingRatio - 0.4) * 0.35);
          }

          // In tech alt patterns, high turn angles require coordinating finger alternation with inertia braking
          if (headToHeadDtReal > 125 && turnAngles[i] >= 60 && currDist > 25) {
            const techAltDeception = Math.min(0.40, ((turnAngles[i] - 60) / 90) * 0.35);
            oddSpacedBurstFactor += techAltDeception;
          }
        }

        // 7. Psychology & Perception of Playstyle: Full Alternation vs Mono-Burst Reset
        // Alternating glides smoothly on uniform streams, while mono-tap collisions or galloping spike strain
        const isSameFinger = prevEv && ev.key !== 'NONE' && ev.key === prevEv.key;
        const isMonoBurstReset = dtSincePrevHit >= 120 && dtSameFinger < 220;
        let playstyleFactor = 1.0;

        if (isSameFinger || isMonoBurstReset) {
          // Player repeated the same finger consecutively or reset on same finger across a rhythm pause
          const collisionSeverity = Math.min(2.0, Math.max(0.5, (220 - dtSameFinger) / 55));
          playstyleFactor = 1.0 + collisionSeverity; // Heavy penalty for single-finger lock/gallop
        } else {
          // Player alternated keys
          if (rhythmShift > 0.35) {
            playstyleFactor = 0.80 * (1.0 + rhythmShift * 0.25);
          } else {
            playstyleFactor = 0.60;
          }
        }

        const rawScore = 15.0 * speedIntensity * playstyleFactor * burstFactor * rhythmFactor * accuracyDemand * oddSpacedBurstFactor;
        fcScore = Math.min(100, Math.max(0, rawScore));
      }
    }

    fingerControlScores[i] = fcScore;
    prevHeadToHeadDt = headToHeadDtReal;
  }

  // 3-point smoothing for actual tap BPM to reduce discrete frame discretization noise
  for (let i = 0; i < nHits; i++) {
    const prev = i > 0 ? rawTapBpm[i - 1] : rawTapBpm[i];
    const curr = rawTapBpm[i];
    const next = i < nHits - 1 ? rawTapBpm[i + 1] : rawTapBpm[i];
    tapBpm[i] = 0.5 * curr + 0.25 * (prev + next);
  }

  // Extract full continuous keypress timeline across all frames for Channel 2
  const nFrames = frames.length;
  const keyTimes = new Float64Array(nFrames);
  const k1Frames = new Float64Array(nFrames);
  const k2Frames = new Float64Array(nFrames);

  const frameVelocities = new Float64Array(nFrames);
  const frameTurnAngles = new Float64Array(nFrames);
  const frameStrains = new Float64Array(nFrames);

  for (let i = 0; i < nFrames; i++) {
    const f = frames[i];
    keyTimes[i] = f.time;
    k1Frames[i] = (f.keys & (KeyFlags.K1 | KeyFlags.M1)) !== 0 ? 1 : 0;
    k2Frames[i] = (f.keys & (KeyFlags.K2 | KeyFlags.M2)) !== 0 ? 1 : 0;
    frameVelocities[i] = kinematics.velocities[i] || 0;
    frameTurnAngles[i] = kinematics.snapAngles[i] || 0;
  }

  // Smoothly interpolate aim strain across continuous replay frames between hit objects
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

  // Extract discrete 2K Mania Key Press Intervals
  const k1Intervals: KeyInterval[] = [];
  const k2Intervals: KeyInterval[] = [];

  let k1Start: number | null = null;
  let k2Start: number | null = null;

  for (let i = 0; i < nFrames; i++) {
    const f = frames[i];
    const isK1 = (f.keys & (KeyFlags.K1 | KeyFlags.M1)) !== 0;
    const isK2 = (f.keys & (KeyFlags.K2 | KeyFlags.M2)) !== 0;

    if (isK1 && k1Start === null) {
      k1Start = f.time;
    } else if (!isK1 && k1Start !== null) {
      const release = Math.max(k1Start + 12, f.time);
      k1Intervals.push({
        key: 'K1',
        pressTime: k1Start,
        releaseTime: release,
        duration: release - k1Start
      });
      k1Start = null;
    }

    if (isK2 && k2Start === null) {
      k2Start = f.time;
    } else if (!isK2 && k2Start !== null) {
      const release = Math.max(k2Start + 12, f.time);
      k2Intervals.push({
        key: 'K2',
        pressTime: k2Start,
        releaseTime: release,
        duration: release - k2Start
      });
      k2Start = null;
    }
  }

  // Handle key still held at the last replay frame
  if (k1Start !== null && nFrames > 0) {
    const lastTime = frames[nFrames - 1].time;
    const release = Math.max(k1Start + 16, lastTime);
    k1Intervals.push({
      key: 'K1',
      pressTime: k1Start,
      releaseTime: release,
      duration: release - k1Start
    });
  }
  if (k2Start !== null && nFrames > 0) {
    const lastTime = frames[nFrames - 1].time;
    const release = Math.max(k2Start + 16, lastTime);
    k2Intervals.push({
      key: 'K2',
      pressTime: k2Start,
      releaseTime: release,
      duration: release - k2Start
    });
  }

  // Detect and classify rhythmic streams and bursts taking active speed mods (DT/NC 1.5x, HT 0.75x) into account
  const tapPatterns = TapPatternClassifier.classifyBeatmap(beatmap, gameplayRate, { includeAlt: true });

  // Detect true finger lock: concurrent key holds with overlap >= 38ms during active gameplay
  const fingerLockEvents: FingerLockEvent[] = [];
  const firstObjTime = objects[0]?.time ?? 0;
  const lastObjTime = objects[objects.length - 1]?.time ?? Infinity;

  for (let a = 0; a < k1Intervals.length; a++) {
    const int1 = k1Intervals[a];
    for (let b = 0; b < k2Intervals.length; b++) {
      const int2 = k2Intervals[b];
      if (int2.pressTime > int1.releaseTime) break;
      if (int2.releaseTime < int1.pressTime) continue;

      const overlapStart = Math.max(int1.pressTime, int2.pressTime);
      const overlapEnd = Math.min(int1.releaseTime, int2.releaseTime);
      const overlapDuration = overlapEnd - overlapStart;

      if (overlapDuration >= 38) {
        if (overlapStart >= firstObjTime - 500 && overlapEnd <= lastObjTime + 1000) {
          const matchedPattern = TapPatternClassifier.findPatternAt(tapPatterns, overlapStart);
          fingerLockEvents.push({
            time: overlapStart,
            duration: overlapDuration,
            overlapMs: overlapDuration,
            overlapStart,
            overlapEnd,
            key1: int1.pressTime <= int2.pressTime ? 'K1' : 'K2',
            key2: int1.pressTime <= int2.pressTime ? 'K2' : 'K1',
            patternType: matchedPattern?.type,
            patternNoteCount: matchedPattern?.noteCount,
            patternBpm: matchedPattern?.estimatedBpm,
            patternLabel: matchedPattern?.label
          });
        }
      }
    }
  }
  fingerLockEvents.sort((x, y) => x.time - y.time);

  return {
    hitEvents,
    desyncEvents,
    fingerLockEvents,
    tapPatterns,
    patternGroups,
    overallUR,
    avgMarginUsage,
    longitudinalBias,
    lateralWobble,
    screenDriftQuadrant,
    mods,
    gameplayRate,
    timePoints,
    hitOffsets,
    rollingUR,
    cumulativeUR,
    rollingMean,
    rollingAcc,
    cumulativeAcc,
    k1Held,
    k2Held,
    velocities,
    easedVelocities,
    turnAngles,
    strains,
    tapBpm,
    targetBpm,
    staminaStrains,
    fingerControlScores,
    keyTimes,
    k1Frames,
    k2Frames,
    k1Intervals,
    k2Intervals,
    frameVelocities,
    frameTurnAngles,
    frameStrains
  };
}
