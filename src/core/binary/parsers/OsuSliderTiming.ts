import { HitObject, TimingPoint } from '../../types/beatmap.ts';

/**
 * Computes authentic slider velocities and durations using uninherited and inherited timing points
 */
export function computeSliderVelocitiesAndDurations(
  hitObjects: HitObject[],
  timingPoints: TimingPoint[],
  sliderMultiplier: number,
  sliderTickRate: number = 1
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
    const spanDuration = duration / spanCount;

    obj.duration = duration;
    obj.endTime = obj.time + duration;

    // osu!lazer SliderEventGenerator tick calculation
    const tickRate = Math.max(0.01, sliderTickRate || 1);
    const tickDistance = (scoringDistance / bpmMultiplier) / tickRate;
    const minDistanceFromEnd = velocity * 10;
    const length = obj.pixelLength;

    obj.ticks = [];

    if (tickDistance > 0 && length > 0) {
      for (let span = 0; span < spanCount; span++) {
        const spanStartTime = obj.time + span * spanDuration;
        const reversed = span % 2 === 1;

        for (let d = tickDistance; d <= length; d += tickDistance) {
          if (d >= length - minDistanceFromEnd) break;

          const pathProgress = d / length;
          const timeProgress = reversed ? 1 - pathProgress : pathProgress;

          obj.ticks.push({
            time: spanStartTime + timeProgress * spanDuration,
            spanIndex: span,
            pathProgress
          });
        }
      }
      obj.ticks.sort((a, b) => a.time - b.time);
    }
  }
}
