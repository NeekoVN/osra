import { OsrReplay } from '../types/replay.ts';
import { Beatmap } from '../types/beatmap.ts';
import { TimedHitEvent, HitJudgement, DesyncType } from '../types/telemetry.ts';
import { HitWindowsResult, judgeHitOffset } from '../math/HitWindows.ts';
import { calculateHitProjection } from '../math/Projections.ts';
import { classifyDesync, findClosestApproach } from '../math/DesyncClassifier.ts';
import { TapEvent, MatchState } from './types.ts';

export interface HitSimulationResult {
  hitEvents: TimedHitEvent[];
  desyncEvents: TimedHitEvent[];
  totalMargin: number;
  totalLongitudinal: number;
  totalLateral: number;
  validHitsCount: number;
  screenDriftX: number;
  screenDriftY: number;
}

function checkTapHit(t: TapEvent, targetX: number, targetY: number) {
  const minDist = Math.hypot(t.x - targetX, t.y - targetY);
  const hitX = t.x;
  const hitY = t.y;
  const hitTime = t.time;
  return { minDist, hitX, hitY, hitTime };
}

export function simulateHitJudgements(
  replay: OsrReplay,
  beatmap: Beatmap,
  windows: HitWindowsResult,
  circleRadius: number,
  gameplayRate: number,
  preemptMs: number,
  taps: TapEvent[]
): HitSimulationResult {
  const hitEvents: TimedHitEvent[] = [];
  const desyncEvents: TimedHitEvent[] = [];
  const frames = replay.frames;
  const objects = beatmap.hitObjects;

  let prevObjX: number | null = null;
  let prevObjY: number | null = null;

  let totalMargin = 0;
  let totalLongitudinal = 0;
  let totalLateral = 0;
  let validHitsCount = 0;

  let screenDriftX = 0;
  let screenDriftY = 0;

  const matchStates: MatchState[] = objects.map(() => ({ judged: false, bestTap: null, bestTapInfo: null }));

  const orderedIndices = objects
    .map((_, i) => i)
    .sort((a, b) => objects[a].time - objects[b].time);
  const orderPos = new Array<number>(objects.length);
  orderedIndices.forEach((idx, k) => { orderPos[idx] = k; });

  let settledIdx = 0;

  for (let j = 0; j < taps.length; j++) {
    const t = taps[j];
    if (t.used) continue;

    // Auto-miss sweep: anything whose full hit window has elapsed is dead.
    while (settledIdx < orderedIndices.length) {
      const idx = orderedIndices[settledIdx];
      if (objects[idx].objectType === 'spinner' || matchStates[idx].judged) {
        settledIdx++;
        continue;
      }
      if (objects[idx].time + windows.meh < t.time) {
        matchStates[idx].judged = true;
        settledIdx++;
      } else {
        break;
      }
    }

    // Hit-test: the earliest unjudged in-window receptor under the cursor.
    let topmost = -1;
    for (let k = settledIdx; k < orderedIndices.length; k++) {
      const idx = orderedIndices[k];
      const obj = objects[idx];
      if (obj.time - windows.meh > t.time) break;
      if (matchStates[idx].judged || obj.objectType === 'spinner') continue;
      if (t.time > obj.time + windows.meh) continue;
      const info = checkTapHit(t, obj.stackedX, obj.stackedY);
      if (info.minDist > circleRadius) continue;
      topmost = idx;
      break;
    }

    if (topmost < 0) continue;

    const obj = objects[topmost];
    const objPos = orderPos[topmost];

    let blockingIdx = -1;
    for (let k = settledIdx; k < orderedIndices.length; k++) {
      const idx = orderedIndices[k];
      if (objects[idx].time >= obj.time) break;
      if (!matchStates[idx].judged && objects[idx].objectType !== 'spinner') blockingIdx = idx;
    }

    if (blockingIdx >= 0 && t.time < objects[blockingIdx].time) {
      t.used = true;
      t.blocked = true;
      continue;
    }

    matchStates[topmost].judged = true;
    matchStates[topmost].bestTap = t;
    matchStates[topmost].bestTapInfo = checkTapHit(t, obj.stackedX, obj.stackedY);
    t.used = true;

    let sealTo = settledIdx;
    for (; sealTo < objPos; sealTo++) {
      const idx = orderedIndices[sealTo];
      if (objects[idx].time >= obj.time) break;
      if (objects[idx].objectType !== 'spinner') matchStates[idx].judged = true;
    }
    settledIdx = sealTo;
  }

  let lastJudgedTapTime = -Infinity;

  const nextJudgedTapTime: number[] = new Array(objects.length).fill(Infinity);
  {
    let runningMin = Infinity;
    for (let k = objects.length - 1; k >= 0; k--) {
      nextJudgedTapTime[k] = runningMin;
      const bt = matchStates[k]?.bestTap;
      if (bt && matchStates[k].judged) runningMin = Math.min(runningMin, bt.time);
    }
  }

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

    const windowStart = targetTime - windows.meh;
    const windowEnd = targetTime + windows.meh;

    const closest = findClosestApproach(frames, targetX, targetY, windowStart, windowEnd);

    const mState = matchStates[i];
    const bestTap = mState?.bestTap || null;
    const bestTapInfo = mState?.bestTapInfo || null;

    let tapTime = targetTime;
    let tapX = targetX;
    let tapY = targetY;
    let hasTap = false;
    let hasLateTapOutsideWindow = false;
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
      let foundInWindowTap = false;
      let closestInWindowDist = Infinity;
      const step1Upper = Math.min(windowEnd, nextJudgedTapTime[i]);
      for (let ti = 0; ti < taps.length; ti++) {
        const t = taps[ti];
        if (t.time < windowStart) continue;
        if (t.time > step1Upper) break;
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
          hasSpeedMiss = true;
          t.displayUsed = true;
        }
      }

      if (!foundInWindowTap) {
        const MAX_BLAME_RADII = 4.0;
        const maxBlameDist = circleRadius * MAX_BLAME_RADII;
        const TIME_WEIGHT_PX_PER_MS = 0.5;
        const earliestLookback = Math.max(targetTime - preemptMs, lastJudgedTapTime);
        const latestLookahead = Math.min(windowEnd, nextJudgedTapTime[i]);

        let bestScore = Infinity;
        let foundAnyTap = false;

        for (let ti = 0; ti < taps.length; ti++) {
          const t = taps[ti];
          if (t.time < earliestLookback) continue;
          if (t.time > latestLookahead) break;
          if (t.used && !t.blocked) continue;
          if (t.displayUsed) continue;

          const dist = Math.hypot(t.x - targetX, t.y - targetY);
          if (dist > maxBlameDist) continue;

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
          for (let ti = 0; ti < taps.length; ti++) {
            if (taps[ti].time === tapTime && taps[ti].x === tapX) {
              taps[ti].displayUsed = true;
              break;
            }
          }
        } else {
          tapDistance = closest.minDistance;
          tapX = closest.xAtMin;
          tapY = closest.yAtMin;
        }
      }
    }

    const timeOffset = (hasTap || hasLateTapOutsideWindow || hasSpeedMiss) ? tapTime - targetTime : windows.miss;
    const rateAdjustedOffset = timeOffset / gameplayRate;

    const isLazerClassic =
      !!replay.soloScoreInfo && (replay.soloScoreInfo.mods?.some(m => m.acronym === 'CL') ?? false);

    let judgement = HitJudgement.Miss;
    if (hasTap && tapDistance <= circleRadius && Math.abs(timeOffset) <= windows.meh) {
      if (isSliderHead && isLazerClassic) {
        judgement = HitJudgement.Great;
      } else {
        judgement = judgeHitOffset(timeOffset, windows);
      }
    }

    const proj = calculateHitProjection(
      targetX,
      targetY,
      prevObjX,
      prevObjY,
      tapX,
      tapY,
      circleRadius
    );

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

    if (hasTap || hasSpeedMiss) {
      lastJudgedTapTime = Math.max(lastJudgedTapTime, tapTime);
    } else {
      lastJudgedTapTime = Math.max(lastJudgedTapTime, windowEnd);
    }
  }

  return {
    hitEvents,
    desyncEvents,
    totalMargin,
    totalLongitudinal,
    totalLateral,
    validHitsCount,
    screenDriftX,
    screenDriftY
  };
}
