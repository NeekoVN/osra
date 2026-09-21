/**
 * Bitmask flags for osu! gameplay mods
 */
export enum OsuMods {
  None = 0,
  NoFail = 1 << 0,
  Easy = 1 << 1,
  TouchDevice = 1 << 2,
  Hidden = 1 << 3,
  HardRock = 1 << 4,
  SuddenDeath = 1 << 5,
  DoubleTime = 1 << 6,
  Relax = 1 << 7,
  HalfTime = 1 << 8,
  Nightcore = 1 << 9,
  Flashlight = 1 << 10,
  Autoplay = 1 << 11,
  SpunOut = 1 << 12,
  Autopilot = 1 << 13,
  Perfect = 1 << 14,
  Key4 = 1 << 15,
  Key5 = 1 << 16,
  Key6 = 1 << 17,
  Key7 = 1 << 18,
  Key8 = 1 << 19,
  FadeIn = 1 << 20,
  Random = 1 << 21,
  Cinema = 1 << 22,
  TargetPractice = 1 << 23,
  Key9 = 1 << 24,
  KeyCoop = 1 << 25,
  Key1 = 1 << 26,
  Key3 = 1 << 27,
  Key2 = 1 << 28,
  ScoreV2 = 1 << 29,
  Mirror = 1 << 30
}

/**
 * Key actuation flags from replay frame keys bitmask
 */
export enum KeyFlags {
  None = 0,
  M1 = 1 << 0,
  M2 = 1 << 1,
  K1 = 1 << 2,
  K2 = 1 << 3,
  Smoke = 1 << 4
}

/**
 * Single raw replay frame
 */
export interface ReplayFrame {
  /** Delta time in ms from previous frame */
  timeDelta: number;
  /** Monotonic cumulative time in ms from start */
  time: number;
  /** Cursor X in standard 512 coordinate space */
  x: number;
  /** Cursor Y in standard 384 coordinate space */
  y: number;
  /** Bitmask of active key flags */
  keys: number;
}

export interface SoloScoreInfo {
  clientVersion?: string;
  rank?: string;
  userId?: number;
  onlineId?: number;
  mods?: Array<{ acronym: string; settings?: Record<string, unknown> }>;
  statistics: Record<string, number>;
  maximumStatistics?: Record<string, number>;
  totalScoreWithoutMods?: number;
}

/**
 * Parsed .osr replay structure
 */
export interface OsrReplay {
  gameMode: number; // 0 = osu!standard
  gameVersion: number;
  beatmapHash: string;
  playerName: string;
  replayHash: string;
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  totalScore: number;
  maxCombo: number;
  isPerfect: boolean;
  mods: number;
  lifeBarGraph: string;
  timestamp: Date;
  rawCompressedDataLength: number;
  onlineScoreId: bigint;
  frames: ReplayFrame[];
  rngSeed?: number;
  skipGaps?: Array<{ from: number; to: number }>;
  soloScoreInfo?: SoloScoreInfo;
  sliderTicks?: { hit: number; max: number };
  sliderEnds?: { hit: number; max: number };
  rank?: string;
}
