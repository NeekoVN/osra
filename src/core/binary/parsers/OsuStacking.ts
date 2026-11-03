import { HitObject } from '../../types/beatmap.ts';

/**
 * Computes osu! standard stack heights matching osu!lazer
 */
export function computeStacking(
  hitObjects: HitObject[],
  circleSize: number,
  approachRate: number,
  stackLeniency: number
): void {
  const n = hitObjects.length;
  if (n === 0) return;

  // Compute AR preempt time
  let preempt = 1200;
  if (approachRate < 5) {
    preempt = 1200 + 600 * (5 - approachRate) / 5;
  } else if (approachRate > 5) {
    preempt = 1200 - 750 * (approachRate - 5) / 5;
  }

  const stackThreshold = preempt * stackLeniency;
  const scale = (0.85 - 0.07 * circleSize) * 1.00041;
  const stackOffsetPerHeight = scale * -6.4;

  // Stacking reverse scan
  for (let i = n - 1; i > 0; i--) {
    let current = hitObjects[i];
    if (current.stackHeight !== 0 || current.objectType === 'spinner') continue;

    const startX = current.x;
    const startY = current.y;

    for (let j = i - 1; j >= 0; j--) {
      const prev = hitObjects[j];
      if (prev.objectType === 'spinner') continue;

      if (current.time - prev.time > stackThreshold) break;

      const dx = Math.abs(prev.x - startX);
      const dy = Math.abs(prev.y - startY);

      if (dx < 3 && dy < 3) {
        prev.stackHeight = current.stackHeight + 1;
        current = prev;
      }
    }
  }

  // Apply stacked positions
  for (let i = 0; i < n; i++) {
    const obj = hitObjects[i];
    if (obj.stackHeight > 0) {
      obj.stackedX = obj.x + obj.stackHeight * stackOffsetPerHeight;
      obj.stackedY = obj.y + obj.stackHeight * stackOffsetPerHeight;
    }
  }
}
