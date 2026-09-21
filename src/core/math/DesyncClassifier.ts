import { DesyncType } from '../types/telemetry.ts';
import { ReplayFrame } from '../types/replay.ts';

export interface ClosestApproach {
  minDistance: number;
  timeAtMin: number;
  xAtMin: number;
  yAtMin: number;
}

/**
 * Finds the closest cursor approach to an object within a time window
 */
export function findClosestApproach(
  frames: ReplayFrame[],
  targetX: number,
  targetY: number,
  windowStart: number,
  windowEnd: number
): ClosestApproach {
  let minDistance = Infinity;
  let timeAtMin = windowStart;
  let xAtMin = targetX;
  let yAtMin = targetY;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.time < windowStart) continue;
    if (f.time > windowEnd) break;

    const dx = f.x - targetX;
    const dy = f.y - targetY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < minDistance) {
      minDistance = dist;
      timeAtMin = f.time;
      xAtMin = f.x;
      yAtMin = f.y;
    }
  }

  return { minDistance, timeAtMin, xAtMin, yAtMin };
}

/**
 * Classifies aim tracking vs. tap timing desync.
 *
 * @param hasTap           True when the game engine matched a tap inside the circle.
 * @param hasSpeedMiss     True when a tap fell inside the hit window but the cursor
 *                         had already moved past the circle (overshoot / cursor desync).
 * @param tapTime          Timestamp of the blamed tap.
 * @param tapDistance      Distance from the cursor to note centre at tap time.
 * @param circleRadius     Note radius in osu! pixels.
 * @param closest          Closest cursor approach within the hit window.
 */
export function classifyDesync(
  hasTap: boolean,
  hasSpeedMiss: boolean,
  tapTime: number,
  tapDistance: number,
  circleRadius: number,
  closest: ClosestApproach
): DesyncType {
  // If player tapped inside circle radius — clean hit
  if (hasTap && tapDistance <= circleRadius) {
    return DesyncType.None;
  }

  // Cursor-desync / speed-overshoot: tap was on time but cursor already moved past.
  // Distinct from LateTap (cursor reached circle, tap came late) and from
  // MisaimInWindow (both tap and cursor were within the window, just wrong position).
  if (hasSpeedMiss) {
    return DesyncType.SpeedMiss;
  }

  // If aim reached inside circle radius at some point within the window
  const aimReachedCircle = closest.minDistance <= circleRadius;

  if (hasTap) {
    if (aimReachedCircle) {
      return tapTime < closest.timeAtMin ? DesyncType.EarlyTap : DesyncType.LateTap;
    }
    return DesyncType.MisaimInWindow;
  }

  // No tap actuated within hit window
  if (aimReachedCircle) {
    return DesyncType.LateTap; // Reached circle but failed to actuate in time
  }

  return DesyncType.TrueAimMiss;
}
