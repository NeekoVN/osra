export enum HitJudgement {
  Miss = 0,
  Meh = 50,
  Ok = 100,
  Great = 300
}

export enum DesyncType {
  None = 'NONE',
  EarlyTap = 'EARLY_TAP',
  LateTap = 'LATE_TAP',
  /** Tap was on-time but cursor had already moved past the circle (speed/overshoot). */
  SpeedMiss = 'SPEED_MISS',
  TrueAimMiss = 'TRUE_AIM_MISS',
  MisaimInWindow = 'MISAIM_IN_WINDOW'
}

/**
 * Individual evaluated hit event for a note / slider head
 */
export interface TimedHitEvent {
  objectIndex: number;
  targetTime: number;
  tapTime: number;
  timeOffset: number; // tapTime - targetTime (ms)
  rateAdjustedOffset: number; // timeOffset / GameplayRate
  judgement: HitJudgement;
  isSliderHead: boolean;
  
  // Spatial coordinates
  targetX: number;
  targetY: number;
  tapX: number;
  tapY: number;
  
  // Vector error
  rawErrorX: number; // tapX - targetX
  rawErrorY: number; // tapY - targetY
  distanceToCenter: number;
  circleRadius: number;
  marginUsagePercent: number; // (distanceToCenter / circleRadius) * 100
  
  // Jump-aligned projection
  jumpAngleRad: number;
  longitudinalError: number; // + overaim, - underaim
  lateralError: number;      // perpendicular wobble
  
  // Desync classification
  desyncType: DesyncType;
  closestApproachDistance: number;
  closestApproachTime: number;
  
  // Key pressed
  key: 'K1' | 'K2' | 'M1' | 'M2' | 'NONE';
}

/**
 * Aggregated telemetry metrics for a complete replay session
 */
export interface SessionTelemetry {
  overallUnstableRate: number;
  rollingUnstableRate: Float32Array; // per object
  rollingMeanOffset: Float32Array;   // per object
  rollingAccuracy: Float32Array;     // per beat window
  
  // Tapping metrics
  k1HoldTimes: Float32Array;
  k2HoldTimes: Float32Array;
  instantaneousBPM: Float32Array;
  fingerLockEvents: Array<{ time: number; overlapMs: number; key1: string; key2: string }>;
  
  // Aim metrics
  avgMarginUsage: number;
  longitudinalBias: number; // mean under/overaim
  lateralWobble: number;
  regionalDriftTensors: Float32Array; // 4x3 grid (12 sectors)
  
  // Kinematics
  velocities: Float32Array;
  accelerations: Float32Array;
  snapAngles: Float32Array;
  
  // Events
  hitEvents: TimedHitEvent[];
  desyncIncidents: TimedHitEvent[];
}
