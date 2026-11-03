export interface PerformanceInput {
  aimDifficulty: number;
  speedDifficulty: number;
  readingDifficulty: number;
  overallDifficulty: number;
  approachRate: number;
  circleSize: number;
  hitCircleCount: number;
  sliderCount: number;
  spinnerCount: number;
  totalHits: number;
  maxCombo: number;
  currentCombo: number;
  count300: number;
  count100: number;
  count50: number;
  countMiss: number;
  mods?: number;
}

export interface PerformanceBreakdown {
  totalPP: number;
  aimPP: number;
  speedPP: number;
  accPP: number;
  readingPP: number;
  effectiveMissCount: number;
  speedDeviation?: number;
}

export interface DifficultyAttributes {
  starRating: number;
  aimDifficulty: number;
  speedDifficulty: number;
  readingDifficulty: number;
  aimDifficultStrainCount: number;
  speedDifficultStrainCount: number;
  readingDifficultNoteCount: number;
  sliderFactor: number;
  maxCombo: number;
}
