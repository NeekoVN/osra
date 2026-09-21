import { ReplayFrame } from '../types/replay.ts';

export interface KinematicsResult {
  velocities: Float32Array;      // px/ms
  easedVelocities: Float32Array; // px/ms smoothed
  accelerations: Float32Array;   // px/ms^2
  snapAngles: Float32Array;      // degrees (0 - 180)
}

/**
 * Computes instantaneous velocity, acceleration, and turn sharpness from replay frames
 */
export function calculateKinematics(frames: ReplayFrame[]): KinematicsResult {
  const n = frames.length;
  const velocities = new Float32Array(n);
  const easedVelocities = new Float32Array(n);
  const accelerations = new Float32Array(n);
  const snapAngles = new Float32Array(n);

  if (n < 2) {
    return { velocities, easedVelocities, accelerations, snapAngles };
  }

  // Raw instantaneous velocities (player movement naturally provides continuous inertia)
  for (let i = 1; i < n; i++) {
    const dt = frames[i].time - frames[i - 1].time;
    if (dt > 0) {
      const dx = frames[i].x - frames[i - 1].x;
      const dy = frames[i].y - frames[i - 1].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      velocities[i] = dist / dt;
    } else {
      velocities[i] = velocities[i - 1];
    }
    easedVelocities[i] = velocities[i];
  }

  // Calculate accelerations and snap angles from raw velocities
  for (let i = 2; i < n; i++) {
    const dt = frames[i].time - frames[i - 1].time;
    if (dt > 0) {
      accelerations[i] = (velocities[i] - velocities[i - 1]) / dt;
    }

    // Vector 1: from frame i-2 to i-1
    const v1x = frames[i - 1].x - frames[i - 2].x;
    const v1y = frames[i - 1].y - frames[i - 2].y;
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);

    // Vector 2: from frame i-1 to i
    const v2x = frames[i].x - frames[i - 1].x;
    const v2y = frames[i].y - frames[i - 1].y;
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);

    if (len1 > 0.5 && len2 > 0.5) {
      const dot = v1x * v2x + v1y * v2y;
      const cosTheta = Math.max(-1, Math.min(1, dot / (len1 * len2)));
      // Turn sharpness: deviation from straight path (0° = straight, 180° = complete reversal)
      const angleRad = Math.acos(cosTheta);
      snapAngles[i] = (angleRad * 180) / Math.PI;
    }
  }

  return { velocities, easedVelocities, accelerations, snapAngles };
}
