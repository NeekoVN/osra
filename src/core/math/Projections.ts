import { OsuMods } from '../types/replay.ts';

export interface HitProjection {
  // Absolute screen space error
  rawErrorX: number;
  rawErrorY: number;
  normX: number; // rawErrorX / R
  normY: number; // rawErrorY / R
  distanceToCenter: number;
  circleRadius: number;
  marginUsagePercent: number;

  // Jump-aligned projection
  jumpAngleRad: number;
  longitudinalError: number; // + overaim, - underaim
  lateralError: number;      // perpendicular wobble
  normLongitudinal: number;  // longitudinalError / R
  normLateral: number;       // lateralError / R
}

/**
 * Calculates circle radius in osu! pixels matching osu!lazer
 * Scale = (0.85 - 0.07 * CS) * 1.00041
 * Radius = 64.0 * Scale
 */
export function calculateCircleRadius(baseCS: number, mods: number = OsuMods.None): number {
  let cs = baseCS;
  if (mods & OsuMods.HardRock) {
    cs = Math.min(10.0, cs * 1.3);
  } else if (mods & OsuMods.Easy) {
    cs = cs * 0.5;
  }

  const scale = (0.85 - 0.07 * cs) * 1.00041;
  return 64.0 * scale;
}

/**
 * Projects a hit event into both Absolute Screen Space and Relative Jump-Aligned space
 */
export function calculateHitProjection(
  targetX: number,
  targetY: number,
  prevTargetX: number | null,
  prevTargetY: number | null,
  tapX: number,
  tapY: number,
  circleRadius: number
): HitProjection {
  const rawErrorX = tapX - targetX;
  const rawErrorY = tapY - targetY;
  const distanceToCenter = Math.sqrt(rawErrorX * rawErrorX + rawErrorY * rawErrorY);
  const marginUsagePercent = (distanceToCenter / circleRadius) * 100;
  const normX = rawErrorX / circleRadius;
  const normY = rawErrorY / circleRadius;

  let jumpAngleRad = 0;
  let longitudinalError = rawErrorX;
  let lateralError = rawErrorY;

  if (prevTargetX !== null && prevTargetY !== null) {
    const jumpDx = targetX - prevTargetX;
    const jumpDy = targetY - prevTargetY;
    const jumpLen = Math.sqrt(jumpDx * jumpDx + jumpDy * jumpDy);

    if (jumpLen > 0.001) {
      jumpAngleRad = Math.atan2(jumpDy, jumpDx);
      const cos = Math.cos(jumpAngleRad);
      const sin = Math.sin(jumpAngleRad);

      // Rotate by -theta so jump enters horizontally along +X
      longitudinalError = rawErrorX * cos + rawErrorY * sin;
      lateralError = -rawErrorX * sin + rawErrorY * cos;
    }
  }

  const normLongitudinal = longitudinalError / circleRadius;
  const normLateral = lateralError / circleRadius;

  return {
    rawErrorX,
    rawErrorY,
    normX,
    normY,
    distanceToCenter,
    circleRadius,
    marginUsagePercent,
    jumpAngleRad,
    longitudinalError,
    lateralError,
    normLongitudinal,
    normLateral
  };
}
