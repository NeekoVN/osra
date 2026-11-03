import { OsrReplay, OsuMods } from '../types/replay.ts';
import { Beatmap } from '../types/beatmap.ts';
import { calculateHitWindows, getGameplayRateFromMods } from '../math/HitWindows.ts';
import { calculateCircleRadius } from '../math/Projections.ts';
import { calculateUnstableRate } from '../math/UnstableRate.ts';
import { calculateKinematics } from '../math/Kinematics.ts';
import { TapPatternClassifier } from './TapPatternClassifier.ts';

import { KeyInterval, FingerLockEvent, PatternGroup, EvaluationResult } from './types.ts';
import { getModdedBeatmap } from './ModdedBeatmap.ts';
import { extractTapsFromFrames, extractKeyTimelineAndIntervals, detectFingerLockEvents } from './KeyTracking.ts';
import { simulateHitJudgements } from './HitSimulation.ts';
import { computeKinematicStrains } from './AimKinematics.ts';
import { computeTappingDynamics } from './TappingDynamics.ts';
import { buildHitTimeSeriesBuffers, buildFrameLevelKinematics } from './TimeSeriesPacker.ts';

// Re-export types and utilities for backwards-compatibility and public facade
export type { KeyInterval, FingerLockEvent, PatternGroup, EvaluationResult };
export { getModdedBeatmap };

/**
 * Replays and evaluates all hit events against the beatmap with exact osu!lazer rules
 */
export function evaluateReplaySession(replay: OsrReplay, rawBeatmap: Beatmap): EvaluationResult {
  const mods = replay.mods;
  const beatmap = getModdedBeatmap(rawBeatmap, mods);
  const windows = calculateHitWindows(beatmap.difficulty.overallDifficulty, mods);
  const circleRadius = calculateCircleRadius(beatmap.difficulty.circleSize, mods);
  const gameplayRate = getGameplayRateFromMods(replay.soloScoreInfo?.mods, mods);

  // Compute approach rate preempt (mirrors PlayfieldRenderer / osu! OsuHitObject.TimePreempt)
  let ar = beatmap.difficulty.approachRate;
  if (mods & OsuMods.HardRock) ar = Math.min(10.0, ar * 1.4);
  else if (mods & OsuMods.Easy) ar = ar * 0.5;
  const preemptMs = ar < 5
    ? 1200 + 600 * (5 - ar) / 5
    : 1200 - 750 * (ar - 5) / 5;

  const frames = replay.frames;
  const objects = beatmap.hitObjects;

  // Extract key taps from frame diffs
  const taps = extractTapsFromFrames(frames);

  // Run core note-lock and hit judgement simulation
  const sim = simulateHitJudgements(replay, beatmap, windows, circleRadius, gameplayRate, preemptMs, taps);
  const { hitEvents, desyncEvents, validHitsCount, totalMargin, totalLongitudinal, totalLateral, screenDriftX, screenDriftY } = sim;

  // Calculate aggregates
  const urEligibleHits = hitEvents.filter(e => e.judgement !== 0); // 0 = Miss
  const validOffsets = urEligibleHits.map(e => e.timeOffset);
  const overallUR = calculateUnstableRate(validOffsets, gameplayRate);

  const avgMarginUsage = validHitsCount > 0 ? totalMargin / validHitsCount : 0;
  const longitudinalBias = validHitsCount > 0 ? totalLongitudinal / validHitsCount : 0;
  const lateralWobble = validHitsCount > 0 ? totalLateral / validHitsCount : 0;

  const avgDriftX = validHitsCount > 0 ? screenDriftX / validHitsCount : 0;
  const avgDriftY = validHitsCount > 0 ? screenDriftY / validHitsCount : 0;
  const screenDriftQuadrant = `${avgDriftY >= 0 ? 'Bottom' : 'Top'}-${avgDriftX >= 0 ? 'Right' : 'Left'}`;

  // Build continuous time arrays for uPlot
  const hitBuffers = buildHitTimeSeriesBuffers(hitEvents, gameplayRate);

  // Kinematics and Aim Strains
  const kinematics = calculateKinematics(frames);
  const aimKinematics = computeKinematicStrains(
    hitEvents,
    objects,
    frames,
    kinematics,
    hitBuffers.rollingAccArr,
    gameplayRate,
    circleRadius
  );

  // Tapping Dynamics & Stamina
  const tappingDynamics = computeTappingDynamics(
    hitEvents,
    objects,
    gameplayRate,
    aimKinematics.turnAngles,
    circleRadius
  );

  // Extract full continuous keypress timeline across all frames for Channel 2
  const keyTimeline = extractKeyTimelineAndIntervals(frames);

  // Frame level kinematic interpolations
  const frameKinematics = buildFrameLevelKinematics(
    frames,
    kinematics,
    keyTimeline.keyTimes,
    hitBuffers.timePoints,
    aimKinematics.strains
  );

  // Detect and classify rhythmic streams and bursts
  const tapPatterns = TapPatternClassifier.classifyBeatmap(beatmap, gameplayRate, { includeAlt: true });

  // Detect true finger lock
  const fingerLockEvents = detectFingerLockEvents(
    keyTimeline.k1Intervals,
    keyTimeline.k2Intervals,
    objects,
    tapPatterns
  );

  return {
    hitEvents,
    desyncEvents,
    fingerLockEvents,
    tapPatterns,
    patternGroups: aimKinematics.patternGroups,
    overallUR,
    avgMarginUsage,
    longitudinalBias,
    lateralWobble,
    screenDriftQuadrant,
    mods,
    gameplayRate,
    timePoints: hitBuffers.timePoints,
    hitOffsets: hitBuffers.hitOffsets,
    rollingUR: hitBuffers.rollingUR,
    cumulativeUR: hitBuffers.cumulativeUR,
    rollingMean: hitBuffers.rollingMean,
    rollingAcc: hitBuffers.rollingAcc,
    cumulativeAcc: hitBuffers.cumulativeAcc,
    k1Held: hitBuffers.k1Held,
    k2Held: hitBuffers.k2Held,
    velocities: aimKinematics.velocities,
    easedVelocities: aimKinematics.easedVelocities,
    turnAngles: aimKinematics.turnAngles,
    strains: aimKinematics.strains,
    tapBpm: tappingDynamics.tapBpm,
    targetBpm: tappingDynamics.targetBpm,
    staminaStrains: tappingDynamics.staminaStrains,
    fingerControlScores: tappingDynamics.fingerControlScores,
    keyTimes: keyTimeline.keyTimes,
    k1Frames: keyTimeline.k1Frames,
    k2Frames: keyTimeline.k2Frames,
    k1Intervals: keyTimeline.k1Intervals,
    k2Intervals: keyTimeline.k2Intervals,
    frameVelocities: frameKinematics.frameVelocities,
    frameTurnAngles: frameKinematics.frameTurnAngles,
    frameStrains: frameKinematics.frameStrains
  };
}
