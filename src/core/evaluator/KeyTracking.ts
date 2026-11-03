import { ReplayFrame, KeyFlags } from '../types/replay.ts';
import { HitObject } from '../types/beatmap.ts';
import { KeyInterval, FingerLockEvent, TapEvent } from './types.ts';
import { TapPatternClassifier, TapPattern } from './TapPatternClassifier.ts';

export function extractTapsFromFrames(frames: ReplayFrame[]): TapEvent[] {
  interface KeyState {
    isDown: boolean;
    pressTime: number;
  }
  const k1: KeyState = { isDown: false, pressTime: 0 };
  const k2: KeyState = { isDown: false, pressTime: 0 };
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

  return taps;
}

export interface KeyFrameTimeline {
  keyTimes: Float64Array;
  k1Frames: Float64Array;
  k2Frames: Float64Array;
  k1Intervals: KeyInterval[];
  k2Intervals: KeyInterval[];
}

export function extractKeyTimelineAndIntervals(frames: ReplayFrame[]): KeyFrameTimeline {
  const nFrames = frames.length;
  const keyTimes = new Float64Array(nFrames);
  const k1Frames = new Float64Array(nFrames);
  const k2Frames = new Float64Array(nFrames);

  const k1Intervals: KeyInterval[] = [];
  const k2Intervals: KeyInterval[] = [];

  let k1Start: number | null = null;
  let k2Start: number | null = null;

  for (let i = 0; i < nFrames; i++) {
    const f = frames[i];
    keyTimes[i] = f.time;
    const isK1 = (f.keys & (KeyFlags.K1 | KeyFlags.M1)) !== 0;
    const isK2 = (f.keys & (KeyFlags.K2 | KeyFlags.M2)) !== 0;

    k1Frames[i] = isK1 ? 1 : 0;
    k2Frames[i] = isK2 ? 1 : 0;

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

  return {
    keyTimes,
    k1Frames,
    k2Frames,
    k1Intervals,
    k2Intervals
  };
}

export function detectFingerLockEvents(
  k1Intervals: KeyInterval[],
  k2Intervals: KeyInterval[],
  objects: HitObject[],
  tapPatterns: TapPattern[]
): FingerLockEvent[] {
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
  return fingerLockEvents;
}
