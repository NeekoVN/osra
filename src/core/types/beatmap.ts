export enum HitObjectType {
  Circle = 1 << 0,
  Slider = 1 << 1,
  NewCombo = 1 << 2,
  Spinner = 1 << 3,
  ComboOffset = (1 << 4) | (1 << 5) | (1 << 6),
  Hold = 1 << 7
}

export interface BeatmapMetadata {
  title: string;
  titleUnicode: string;
  artist: string;
  artistUnicode: string;
  creator: string;
  version: string; // Difficulty name
  source: string;
  tags: string[];
  beatmapId: number;
  beatmapSetId: number;
}

export interface BeatmapDifficulty {
  hpDrainRate: number;
  circleSize: number;
  overallDifficulty: number;
  approachRate: number;
  sliderMultiplier: number;
  sliderTickRate: number;
}

export interface TimingPoint {
  time: number;
  beatLength: number; // ms per beat (negative for inherited slider velocity multiplier)
  meter: number;
  sampleSet: number;
  sampleIndex: number;
  volume: number;
  uninherited: boolean;
  effects: number;
}

export interface HitObjectBase {
  x: number;
  y: number;
  time: number;
  type: number;
  hitSound: number;
  isNewCombo: boolean;
  comboIndex: number;
  comboColor?: string;
  stackHeight: number;
  stackedX: number;
  stackedY: number;
}

export interface HitCircleObject extends HitObjectBase {
  objectType: 'circle';
}

export interface SliderPathPoint {
  x: number;
  y: number;
}

export interface SliderObject extends HitObjectBase {
  objectType: 'slider';
  curveType: string;
  curvePoints: SliderPathPoint[];
  repeatCount: number;
  pixelLength: number;
  duration: number;
  endTime: number;
  ticks: number[];
  sliderEnd: SliderPathPoint;
}

export interface SpinnerObject extends HitObjectBase {
  objectType: 'spinner';
  endTime: number;
}

export type HitObject = HitCircleObject | SliderObject | SpinnerObject;

export interface Beatmap {
  formatVersion: number;
  metadata: BeatmapMetadata;
  difficulty: BeatmapDifficulty;
  timingPoints: TimingPoint[];
  hitObjects: HitObject[];
  stackLeniency: number;
  colours?: {
    combos: string[];
  };
  rawContent?: string;
}
