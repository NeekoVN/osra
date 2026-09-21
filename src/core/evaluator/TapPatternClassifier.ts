import { Beatmap } from '../types/beatmap.ts';
import { TimedHitEvent } from '../types/telemetry.ts';
import { calculateCircleRadius } from '../math/Projections.ts';

export type PatternType = 'stream' | 'deathstream' | 'burst' | 'alt' | 'tech_alt';

export interface TapPattern {
  type: PatternType;
  noteCount: number;
  startTime: number;
  endTime: number;
  avgIntervalMs: number;
  estimatedBpm: number;
  label: string;
}

/**
 * Classifies rhythmic sequences into Streams and Bursts based on osu! standards:
 * - 1/4 note at 140 BPM and below (dt > 107ms) is considered an "alt" (alternate/finger control) and does NOT count.
 * - Average stream speed is 1/4 beat from 180 to 220 BPM (75ms to 68ms), reaching faster for high BPM.
 * - Every note is 1/3 of a beat apart or closer (or 1/2 if song BPM is super high, e.g. >= 280 BPM).
 * - Circles are close to each other, most often overlapping (dist <= 2.0 * radius).
 *   If not overlapping, it must be a fast spaced stream/burst (dt <= 85ms / >= 176 BPM and dist <= 3.5 * radius).
 * - Trajectory flow: stream angles between consecutive notes flow smoothly (closer to straight line / 180°),
 *   strictly rejecting acute back-and-forth 1-2 jump snaps.
 * - Length 3 to 11: Burst
 * - Length 8 to 39: Stream
 * - Length 40+: Deathstream
 */
export class TapPatternClassifier {
  // 1/4 beat at 140 BPM = 60000 / (140 * 4) = 107.14ms.
  // 140 BPM and below is considered an "alt" and does not count as a stream/burst.
  public static readonly MAX_STREAM_INTERVAL_MS = 107;
  public static readonly MAX_INTERVAL_VARIANCE_MS = 28;

  public static readonly MAX_SPACED_STREAM_DISTANCE_RATIO = 5.0;

  /**
   * Classifies tapping patterns from beatmap hit objects, incorporating cadence,
   * beat ratio, spatial overlap, trajectory angle, and clock-rate altering mods (DT/HT).
   */
  public static classifyBeatmap(
    beatmap: Beatmap,
    clockRate: number = 1.0,
    options?: { includeAlt?: boolean }
  ): TapPattern[] {
    const objects = beatmap.hitObjects || [];
    if (objects.length < 3) return [];

    const radius = calculateCircleRadius(beatmap.difficulty?.circleSize ?? 4);

    // Filter uninherited timing points with valid beatLength
    const uninheritedPoints = (beatmap.timingPoints || [])
      .filter(tp => tp.uninherited || tp.beatLength > 0)
      .sort((a, b) => a.time - b.time);

    const getBeatLengthAt = (time: number): number => {
      let bl = 0;
      for (const tp of uninheritedPoints) {
        if (tp.time <= time) bl = tp.beatLength;
        else break;
      }
      return bl;
    };

    const patterns: TapPattern[] = [];
    let currentGroup: Array<{ time: number; x: number; y: number }> = [];

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      const x = obj.stackedX ?? obj.x;
      const y = obj.stackedY ?? obj.y;
      const t = obj.time;

      if (currentGroup.length === 0) {
        currentGroup.push({ time: t, x, y });
        continue;
      }

      const prev = currentGroup[currentGroup.length - 1];
      const dtAudio = t - prev.time;
      const dtReal = dtAudio / clockRate;
      const dist = Math.hypot(x - prev.x, y - prev.y);
      const beatLengthAudio = getBeatLengthAt(t);
      const beatLengthReal = beatLengthAudio / clockRate;

      // Check rhythm and spacing candidate qualifications using real physical cadence
      let isCandidate = TapPatternClassifier.isStreamCandidate(dtReal, dist, radius, beatLengthReal);

      // Trajectory angle check: verify motion represents a smooth flow-aim pattern rather than jump snapping
      if (isCandidate && currentGroup.length >= 2) {
        const prevPrev = currentGroup[currentGroup.length - 2];
        if (!TapPatternClassifier.isSmoothFlowTrajectory(
          prevPrev.x, prevPrev.y,
          prev.x, prev.y,
          x, y,
          radius
        )) {
          isCandidate = false;
        }
      }

      if (isCandidate) {
        if (currentGroup.length === 1) {
          currentGroup.push({ time: t, x, y });
        } else {
          const avgDtAudio = (currentGroup[currentGroup.length - 1].time - currentGroup[0].time) / (currentGroup.length - 1);
          const avgDtReal = avgDtAudio / clockRate;
          if (Math.abs(dtReal - avgDtReal) <= TapPatternClassifier.MAX_INTERVAL_VARIANCE_MS) {
            currentGroup.push({ time: t, x, y });
          } else {
            TapPatternClassifier.recordPattern(currentGroup.map(c => c.time), patterns, clockRate);
            currentGroup = [{ time: prev.time, x: prev.x, y: prev.y }, { time: t, x, y }];
          }
        }
      } else {
        TapPatternClassifier.recordPattern(currentGroup.map(c => c.time), patterns, clockRate);
        currentGroup = [{ time: t, x, y }];
      }
    }

    TapPatternClassifier.recordPattern(currentGroup.map(c => c.time), patterns, clockRate);

    if (options?.includeAlt) {
      const altPatterns = TapPatternClassifier.classifyAltPatterns(beatmap, clockRate);
      patterns.push(...altPatterns);
      patterns.sort((a, b) => a.startTime - b.startTime);
    }

    return patterns;
  }

  /**
   * Classifies alternating patterns (alt and tech alt) from beatmap hit objects:
   * - Cadence: 1/2-beat or fast rhythms with dtReal between 108ms and 195ms (approx 154 - 277 BPM 1/2-beat).
   * - Spacing: Micro to medium spacing (1.0 * radius to 5.2 * radius), not overlapping like streams,
   *   and not wide cross-screen jump spam.
   * - Minimum length: at least 4 notes.
   * - Distinction:
   *   * 'tech_alt': awkward non-linear patterns (square corners >= 75°, linear reversals >= 135°,
   *     or zig-zag / oscillating paths with mean turn angle >= 55°).
   *   * 'alt': smooth-flowing or linear alternating patterns (mean turn angle < 55° without sharp reversals).
   */
  public static classifyAltPatterns(beatmap: Beatmap, clockRate: number = 1.0): TapPattern[] {
    const objects = beatmap.hitObjects || [];
    if (objects.length < 4) return [];

    const radius = calculateCircleRadius(beatmap.difficulty?.circleSize ?? 4);
    const patterns: TapPattern[] = [];
    let currentGroup: Array<{ time: number; x: number; y: number }> = [];

    const flushGroup = () => {
      if (currentGroup.length >= 4) {
        const count = currentGroup.length;
        const startTime = currentGroup[0].time;
        const endTime = currentGroup[count - 1].time;
        const avgIntervalRealMs = ((endTime - startTime) / (count - 1)) / clockRate;
        // Alt BPM convention: 1/2 beat interval => BPM = 30000 / avgIntervalRealMs
        const estimatedBpm = Math.round(30000 / avgIntervalRealMs);

        // Analyze angles and non-linearity
        let totalAngle = 0;
        let angleCount = 0;
        let hasReversal = false;
        let hasSquareCorner = false;
        let zigzagCount = 0;

        for (let j = 1; j < currentGroup.length - 1; j++) {
          const p0 = currentGroup[j - 1];
          const p1 = currentGroup[j];
          const p2 = currentGroup[j + 1];

          const ux = p1.x - p0.x;
          const uy = p1.y - p0.y;
          const vx = p2.x - p1.x;
          const vy = p2.y - p1.y;
          const lenU = Math.hypot(ux, uy);
          const lenV = Math.hypot(vx, vy);

          if (lenU > 1 && lenV > 1) {
            const cosAngle = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lenU * lenV)));
            // turnAngle: 0 = straight line, 180 = complete reversal
            const turnAngleDeg = Math.acos(cosAngle) * (180 / Math.PI);
            totalAngle += turnAngleDeg;
            angleCount++;

            if (turnAngleDeg >= 135) hasReversal = true;
            if (turnAngleDeg >= 75 && turnAngleDeg <= 115) hasSquareCorner = true;

            // Check zigzag oscillation (cross product sign flip)
            if (j >= 2) {
              const pPrev = currentGroup[j - 2];
              const prevUx = p0.x - pPrev.x;
              const prevUy = p0.y - pPrev.y;
              const cross1 = prevUx * uy - prevUy * ux;
              const cross2 = ux * vy - uy * vx;
              if ((cross1 > 150 && cross2 < -150) || (cross1 < -150 && cross2 > 150)) {
                zigzagCount++;
              }
            }
          }
        }

        const meanAngle = angleCount > 0 ? totalAngle / angleCount : 0;
        const isTechAlt = hasReversal || hasSquareCorner || zigzagCount >= 1 || meanAngle >= 55;
        const type: PatternType = isTechAlt ? 'tech_alt' : 'alt';
        const typeLabel = isTechAlt ? 'tech alt' : 'alt';
        const label = `${count}-note ${typeLabel} @ ${estimatedBpm} BPM`;

        patterns.push({
          type,
          noteCount: count,
          startTime,
          endTime,
          avgIntervalMs: Math.round(avgIntervalRealMs * 10) / 10,
          estimatedBpm,
          label
        });
      }
      currentGroup = [];
    };

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      const x = obj.stackedX ?? obj.x;
      const y = obj.stackedY ?? obj.y;
      const t = obj.time;

      if (currentGroup.length === 0) {
        currentGroup.push({ time: t, x, y });
        continue;
      }

      const prev = currentGroup[currentGroup.length - 1];
      const dtAudio = t - prev.time;
      const dtReal = dtAudio / clockRate;
      const dist = Math.hypot(x - prev.x, y - prev.y);

      // Alternating cadence check: 108ms <= dtReal <= 195ms
      // Spacing check: 1.0 * radius <= dist <= 5.2 * radius
      const isAltCandidate = dtReal >= 108 && dtReal <= 195 && dist >= 1.0 * radius && dist <= 5.2 * radius;

      if (isAltCandidate) {
        if (currentGroup.length === 1) {
          currentGroup.push({ time: t, x, y });
        } else {
          const avgDtAudio = (currentGroup[currentGroup.length - 1].time - currentGroup[0].time) / (currentGroup.length - 1);
          const avgDtReal = avgDtAudio / clockRate;
          if (Math.abs(dtReal - avgDtReal) <= 32) {
            currentGroup.push({ time: t, x, y });
          } else {
            flushGroup();
            currentGroup = [{ time: prev.time, x: prev.x, y: prev.y }, { time: t, x, y }];
          }
        }
      } else {
        flushGroup();
        currentGroup = [{ time: t, x, y }];
      }
    }

    flushGroup();
    return patterns;
  }

  /**
   * Evaluates whether a sequence of 3 points maintains a smooth flow-aim trajectory.
   * If notes are spaced (dist > 2.0 * radius) and the direction makes a sharp turn (cosAngle < 0, > 90° turn),
   * or if notes have moderate separation (> 1.5 * radius) with an acute reversal (cosAngle < -0.3),
   * it is classified as a jump pattern rather than a flow-aim stream.
   */
  public static isSmoothFlowTrajectory(
    p0x: number, p0y: number,
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    radius: number
  ): boolean {
    const ux = p1x - p0x;
    const uy = p1y - p0y;
    const lenU = Math.hypot(ux, uy);

    const vx = p2x - p1x;
    const vy = p2y - p1y;
    const lenV = Math.hypot(vx, vy);

    if (lenU < 1 || lenV < 1) return true;

    const cosAngle = (ux * vx + uy * vy) / (lenU * lenV);

    // If circles are spaced (non-overlapping: dist > 2.0 * radius):
    // Flow aim requires smooth continuation (turns <= 90°, cosAngle >= 0.0).
    // Sharp turns, triangles, or back-and-forth snaps are jump aim patterns.
    const isSpaced = lenU > 2.0 * radius || lenV > 2.0 * radius;
    if (isSpaced && cosAngle < 0.0) {
      return false;
    }

    // For moderately separated notes (> 1.5 * radius), reject acute back-and-forth snaps (turn > 107°)
    if (lenU > 1.5 * radius && lenV > 1.5 * radius && cosAngle < -0.3) {
      return false;
    }

    return true;
  }

  /**
   * Helper to verify if a note-to-note transition qualifies as part of a stream/burst.
   * Spaced streams/bursts follow the same cadence/rhythm logic as overlapping streams,
   * unless circles are too far apart (> 5.0 * radius) into the jump category.
   */
  private static isStreamCandidate(dt: number, dist: number, radius: number, beatLength: number): boolean {
    if (dt < 25) return false;

    // Hard cutoff: 140 BPM 1/4 note is 107.14ms.
    // 140 BPM and below is considered an "alt" (finger control / alternate), doesn't count.
    if (dt > TapPatternClassifier.MAX_STREAM_INTERVAL_MS) return false;

    // Timing point check:
    // Notes must be 1/3 of a beat apart or closer (beatRatio <= 0.36),
    // UNLESS song BPM is super high (beatLength <= 214ms / >= 280 BPM where 1/2 beat <= 107ms).
    if (beatLength > 0) {
      const beatRatio = dt / beatLength;
      const isSuperHighBpm = beatLength <= 214; // >= 280 BPM
      if (isSuperHighBpm) {
        if (beatRatio > 0.55) return false;
      } else {
        if (beatRatio > 0.36) return false; // 1/2 jumps on normal BPMs rejected
      }
    }

    // Spacing check:
    // Circles too far apart (> 5.0 * radius) fall into the jump category (even if fast)
    if (dist > TapPatternClassifier.MAX_SPACED_STREAM_DISTANCE_RATIO * radius) return false;

    return true;
  }

  /**
   * Classifies tapping patterns from evaluated hit events
   */
  public static classifyHitEvents(events: TimedHitEvent[], clockRate: number = 1.0): TapPattern[] {
    if (events.length < 3) return [];
    const radius = events[0]?.circleRadius || 36;
    const patterns: TapPattern[] = [];
    let currentGroup: TimedHitEvent[] = [events[0]];

    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      const dtAudio = curr.targetTime - prev.targetTime;
      const dtReal = dtAudio / clockRate;
      const dist = Math.hypot(curr.targetX - prev.targetX, curr.targetY - prev.targetY);

      let isCandidate = dtReal >= 20 &&
        dtReal <= TapPatternClassifier.MAX_STREAM_INTERVAL_MS &&
        dist <= TapPatternClassifier.MAX_SPACED_STREAM_DISTANCE_RATIO * radius;

      // Flow aim angle check for consecutive hit events
      if (isCandidate && currentGroup.length >= 2) {
        const prevPrev = currentGroup[currentGroup.length - 2];
        if (!TapPatternClassifier.isSmoothFlowTrajectory(
          prevPrev.targetX, prevPrev.targetY,
          prev.targetX, prev.targetY,
          curr.targetX, curr.targetY,
          radius
        )) {
          isCandidate = false;
        }
      }

      if (isCandidate) {
        if (currentGroup.length === 1) {
          currentGroup.push(curr);
        } else {
          const avgDtAudio = (currentGroup[currentGroup.length - 1].targetTime - currentGroup[0].targetTime) / (currentGroup.length - 1);
          const avgDtReal = avgDtAudio / clockRate;
          if (Math.abs(dtReal - avgDtReal) <= TapPatternClassifier.MAX_INTERVAL_VARIANCE_MS) {
            currentGroup.push(curr);
          } else {
            TapPatternClassifier.recordPattern(currentGroup.map(e => e.targetTime), patterns, clockRate);
            currentGroup = [prev, curr];
          }
        }
      } else {
        TapPatternClassifier.recordPattern(currentGroup.map(e => e.targetTime), patterns, clockRate);
        currentGroup = [curr];
      }
    }

    TapPatternClassifier.recordPattern(currentGroup.map(e => e.targetTime), patterns, clockRate);
    return patterns;
  }

  /**
   * Core pattern extraction algorithm over sorted timestamps (fallback when spatial data is unavailable)
   */
  public static classifyTimes(times: number[], clockRate: number = 1.0): TapPattern[] {
    if (times.length < 3) return [];

    const patterns: TapPattern[] = [];
    let currentGroup: number[] = [times[0]];

    for (let i = 1; i < times.length; i++) {
      const prevTime = times[i - 1];
      const currTime = times[i];
      const dtAudio = currTime - prevTime;
      const dtReal = dtAudio / clockRate;

      if (dtReal <= TapPatternClassifier.MAX_STREAM_INTERVAL_MS && dtReal >= 20) {
        if (currentGroup.length === 1) {
          currentGroup.push(currTime);
        } else {
          const currentAvgDtAudio = (currentGroup[currentGroup.length - 1] - currentGroup[0]) / (currentGroup.length - 1);
          const currentAvgDtReal = currentAvgDtAudio / clockRate;
          if (Math.abs(dtReal - currentAvgDtReal) <= TapPatternClassifier.MAX_INTERVAL_VARIANCE_MS) {
            currentGroup.push(currTime);
          } else {
            TapPatternClassifier.recordPattern(currentGroup, patterns, clockRate);
            currentGroup = [prevTime, currTime];
          }
        }
      } else {
        TapPatternClassifier.recordPattern(currentGroup, patterns, clockRate);
        currentGroup = [currTime];
      }
    }

    TapPatternClassifier.recordPattern(currentGroup, patterns, clockRate);
    return patterns;
  }

  private static recordPattern(group: number[], out: TapPattern[], clockRate: number = 1.0): void {
    const count = group.length;
    if (count < 3) return; // 1-2 notes is single tap or doublet

    const startTime = group[0];
    const endTime = group[group.length - 1];
    const avgIntervalAudioMs = (endTime - startTime) / (count - 1);
    const avgIntervalRealMs = avgIntervalAudioMs / clockRate;
    // In osu!, 1/4 note interval = 60000 / (4 * BPM) => BPM = 15000 / avgIntervalRealMs
    const estimatedBpm = Math.round(15000 / avgIntervalRealMs);

    // 140 BPM and below in real tapping rate is considered an "alt", doesn't count as stream/burst
    if (estimatedBpm <= 140) return;

    const type: PatternType = count >= 40 ? 'deathstream' : count >= 8 ? 'stream' : 'burst';
    const label = type === 'deathstream'
      ? `${count}-note deathstream @ ${estimatedBpm} BPM`
      : type === 'stream'
        ? `${count}-note stream @ ${estimatedBpm} BPM`
        : `${count}-note burst @ ${estimatedBpm} BPM`;

    out.push({
      type,
      noteCount: count,
      startTime,
      endTime,
      avgIntervalMs: Math.round(avgIntervalRealMs * 10) / 10,
      estimatedBpm,
      label
    });
  }

  /**
   * Finds any active pattern at or around a specific timestamp (within 100ms tolerance)
   */
  public static findPatternAt(patterns: TapPattern[], timeMs: number): TapPattern | null {
    for (const p of patterns) {
      if (timeMs >= p.startTime - 100 && timeMs <= p.endTime + 100) {
        return p;
      }
    }
    return null;
  }
}
