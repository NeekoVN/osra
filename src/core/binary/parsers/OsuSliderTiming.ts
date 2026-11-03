import { HitObject, TimingPoint } from '../../types/beatmap.ts';

/**
 * Computes authentic slider velocities and durations using uninherited and inherited timing points
 */
export function computeSliderVelocitiesAndDurations(
  hitObjects: HitObject[],
  timingPoints: TimingPoint[],
  sliderMultiplier: number
): void {
  for (const obj of hitObjects) {
    if (obj.objectType !== 'slider') continue;

    let uninheritedTp: TimingPoint | null = null;
    let inheritedTp: TimingPoint | null = null;

    for (const tp of timingPoints) {
      if (tp.time > obj.time) break;
      if (tp.uninherited) {
        uninheritedTp = tp;
        inheritedTp = null;
      } else {
        inheritedTp = tp;
      }
    }

    if (!uninheritedTp) {
      uninheritedTp = timingPoints.find(t => t.uninherited) || timingPoints[0] || {
        time: 0,
        beatLength: 500,
        meter: 4,
        sampleSet: 0,
        sampleIndex: 0,
        volume: 100,
        uninherited: true,
        effects: 0
      };
    }

    let bpmMultiplier = 1;
    if (inheritedTp && inheritedTp.beatLength < 0) {
      bpmMultiplier = Math.max(0.1, Math.min(10, -inheritedTp.beatLength / 100));
    }

    const scoringDistance = 100 * sliderMultiplier;
    const velocity = scoringDistance / (uninheritedTp.beatLength * bpmMultiplier);
    const spanCount = Math.max(1, obj.repeatCount);
    const duration = velocity > 0 ? (spanCount * obj.pixelLength) / velocity : 0;

    obj.duration = duration;
    obj.endTime = obj.time + duration;
  }
}
