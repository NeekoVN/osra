import { TimedHitEvent } from '../types/telemetry.ts';
import { TapPattern, PatternType } from './TapPatternClassifier.ts';

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

export interface TapEvent {
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

export interface MatchState {
  judged: boolean;
  bestTap: TapEvent | null;
  bestTapInfo: { minDist: number; hitX: number; hitY: number; hitTime: number } | null;
}

export interface ObjectAimGeometry {
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
