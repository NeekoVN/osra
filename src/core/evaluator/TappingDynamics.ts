import { HitObject } from '../types/beatmap.ts';
import { TimedHitEvent } from '../types/telemetry.ts';

export interface TappingDynamicsResult {
  tapBpm: Float64Array;
  targetBpm: Float64Array;
  staminaStrains: Float64Array;
  fingerControlScores: Float64Array;
}

export function computeTappingDynamics(
  hitEvents: TimedHitEvent[],
  objects: HitObject[],
  gameplayRate: number,
  turnAngles: Float64Array,
  circleRadius: number
): TappingDynamicsResult {
  const nHits = hitEvents.length;
  const tapBpm = new Float64Array(nHits);
  const targetBpm = new Float64Array(nHits);
  const staminaStrains = new Float64Array(nHits);
  const fingerControlScores = new Float64Array(nHits);

  let staminaK1 = 0;
  let staminaK2 = 0;
  let lastTapTimeK1 = -99999;
  let lastTapTimeK2 = -99999;
  let prevTapTime = hitEvents[0]?.tapTime ?? (objects[0]?.time ?? 0);
  let prevHeadToHeadDt = 100;

  const rawTapBpm = new Float64Array(nHits);

  for (let i = 0; i < nHits; i++) {
    const ev = hitEvents[i];
    const prevEv = i > 0 ? hitEvents[i - 1] : null;
    const nextEv = i < nHits - 1 ? hitEvents[i + 1] : null;
    const currObj = objects[ev.objectIndex - 1];
    const prevObj = prevEv ? objects[prevEv.objectIndex - 1] : null;
    const nextObj = nextEv ? objects[nextEv.objectIndex - 1] : null;
    const isSlider = currObj?.objectType === 'slider';

    const prevDtAudio = prevObj ? Math.max(20, currObj.time - prevObj.time) : (nextObj ? Math.max(20, nextObj.time - currObj.time) : 100);
    const nextDtAudio = nextObj ? Math.max(20, nextObj.time - currObj.time) : prevDtAudio;
    const headToHeadDtAudio = prevDtAudio;
    const headToHeadDtReal = headToHeadDtAudio / gameplayRate;

    const localMinDtReal = Math.min(prevDtAudio, nextDtAudio) / gameplayRate;

    let tapDtReal = headToHeadDtReal;
    if (prevEv) {
      const tapDtAudio = ev.tapTime - prevTapTime;
      if (tapDtAudio >= 15 && tapDtAudio <= 2000) {
        tapDtReal = tapDtAudio / gameplayRate;
      } else {
        tapDtReal = headToHeadDtReal;
      }
    }
    prevTapTime = ev.tapTime;

    rawTapBpm[i] = Math.max(0, Math.min(450, 15000 / Math.max(30, tapDtReal)));
    targetBpm[i] = Math.max(0, Math.min(450, 15000 / Math.max(30, headToHeadDtReal)));

    const isK1 = ev.key === 'K1' || ev.key === 'M1';
    const isK2 = ev.key === 'K2' || ev.key === 'M2';

    const dtSincePrevHit = prevEv ? Math.max(10, (ev.tapTime - prevEv.tapTime) / gameplayRate) : 500;

    const restDecay = Math.pow(0.5, dtSincePrevHit / 280);
    staminaK1 *= restDecay;
    staminaK2 *= restDecay;

    const dtSameFinger = isK1
      ? (lastTapTimeK1 > -90000 ? (ev.tapTime - lastTapTimeK1) / gameplayRate : 1000)
      : isK2
        ? (lastTapTimeK2 > -90000 ? (ev.tapTime - lastTapTimeK2) / gameplayRate : 1000)
        : 1000;

    if (dtSameFinger <= 260) {
      let tapAddition = Math.pow((260 - dtSameFinger) / 60, 1.3) * 6.0;
      if (isSlider) {
        tapAddition = dtSameFinger <= 180 ? tapAddition * 0.25 : 0;
      }

      if (isK1) {
        staminaK1 += tapAddition;
      } else if (isK2) {
        staminaK2 += tapAddition;
      } else {
        staminaK1 += tapAddition * 0.5;
        staminaK2 += tapAddition * 0.5;
      }
    }

    if (isK1) lastTapTimeK1 = ev.tapTime;
    if (isK2) lastTapTimeK2 = ev.tapTime;

    staminaStrains[i] = Math.max(staminaK1, staminaK2);

    let fcScore = 0;

    if (isSlider && currObj) {
      if (localMinDtReal <= 115) {
        const currEndTime = ('endTime' in currObj && currObj.endTime) ? currObj.endTime : currObj.time;
        const liftOffWindow = nextObj ? Math.max(0, (nextObj.time - currEndTime) / gameplayRate) : 999;
        if (liftOffWindow <= 120) {
          let liftOffPressure = Math.min(2.5, 120 / Math.max(20, liftOffWindow));
          if (nextEv && ev.key !== 'NONE' && nextEv.key === ev.key) {
            liftOffPressure *= 1.6;
          }
          fcScore = Math.min(100, 25.0 * liftOffPressure);
        }
      }
    } else if (!isSlider && prevObj && currObj) {
      const isStreamCadence = localMinDtReal <= 135;
      const isAltCadence = localMinDtReal > 135 && localMinDtReal <= 190;

      const ratio = headToHeadDtReal / Math.max(25, prevHeadToHeadDt);
      const logRatio = Math.abs(Math.log2(Math.max(0.05, ratio)));
      const rhythmShift = Math.min(1.8, logRatio * 1.0);

      if (isStreamCadence || (isAltCadence && (turnAngles[i] >= 50 || rhythmShift > 0.20 || dtSameFinger < 220))) {
        const speedIntensity = isStreamCadence
          ? Math.min(2.5, Math.pow((135 - localMinDtReal) / 35, 1.25))
          : Math.max(0.40, ((190 - localMinDtReal) / 55) * 0.90);

        const absOffset = Math.abs(ev.timeOffset);
        const accuracyDemand = 1.0 + Math.min(0.6, absOffset / 35);

        const rhythmFactor = 1.0 + Math.min(1.2, rhythmShift * 0.8);

        let burstFactor = 1.0;
        if (headToHeadDtReal <= 120) {
          burstFactor = 1.25;
        }

        let oddSpacedBurstFactor = 1.0;
        if (headToHeadDtReal <= 190) {
          const currDist = prevEv
            ? Math.hypot(ev.tapX - prevEv.tapX, ev.tapY - prevEv.tapY)
            : Math.hypot(currObj.x - prevObj.x, currObj.y - prevObj.y);

          const prev2Ev = i > 1 ? hitEvents[i - 2] : null;
          const prev2Obj = prev2Ev ? objects[prev2Ev.objectIndex - 1] : null;
          const prevDist = prevEv && prev2Ev
            ? Math.hypot(prevEv.tapX - prev2Ev.tapX, prevEv.tapY - prev2Ev.tapY)
            : (prevObj && prev2Obj ? Math.hypot(prevObj.x - prev2Obj.x, prevObj.y - prev2Obj.y) : null);

          const nextObjCoords = nextObj ? { x: nextObj.x, y: nextObj.y } : null;
          const nextDist = nextObjCoords
            ? Math.hypot(nextObjCoords.x - currObj.x, nextObjCoords.y - currObj.y)
            : null;

          let maxDisparity = 1.0;
          if (prevDist !== null && prevDist > 5 && currDist > 5) {
            const ratio1 = Math.max(currDist, prevDist) / Math.min(currDist, prevDist);
            if (ratio1 > maxDisparity) maxDisparity = ratio1;
          }
          if (nextDist !== null && nextDist > 5 && currDist > 5) {
            const ratio2 = Math.max(currDist, nextDist) / Math.min(currDist, nextDist);
            if (ratio2 > maxDisparity) maxDisparity = ratio2;
          }

          if (maxDisparity > 1.8) {
            const spacingDeception = Math.min(0.75, (maxDisparity - 1.8) * 0.28);
            oddSpacedBurstFactor += spacingDeception;
          }

          if (turnAngles[i] > 40 && currDist > 15) {
            const angleDeception = Math.min(0.35, ((turnAngles[i] - 40) / 90) * 0.30);
            oddSpacedBurstFactor += angleDeception;
          }

          const circleDiam = circleRadius * 2;
          const spacingRatio = circleDiam > 0 ? currDist / circleDiam : 0;
          if (spacingRatio > 0.4 && headToHeadDtReal <= 125) {
            oddSpacedBurstFactor += Math.min(0.35, (spacingRatio - 0.4) * 0.35);
          }

          if (headToHeadDtReal > 125 && turnAngles[i] >= 60 && currDist > 25) {
            const techAltDeception = Math.min(0.40, ((turnAngles[i] - 60) / 90) * 0.35);
            oddSpacedBurstFactor += techAltDeception;
          }
        }

        const isSameFinger = prevEv && ev.key !== 'NONE' && ev.key === prevEv.key;
        const isMonoBurstReset = dtSincePrevHit >= 120 && dtSameFinger < 220;
        let playstyleFactor = 1.0;

        if (isSameFinger || isMonoBurstReset) {
          const collisionSeverity = Math.min(2.0, Math.max(0.5, (220 - dtSameFinger) / 55));
          playstyleFactor = 1.0 + collisionSeverity;
        } else {
          if (rhythmShift > 0.35) {
            playstyleFactor = 0.80 * (1.0 + rhythmShift * 0.25);
          } else {
            playstyleFactor = 0.60;
          }
        }

        const rawScore = 15.0 * speedIntensity * playstyleFactor * burstFactor * rhythmFactor * accuracyDemand * oddSpacedBurstFactor;
        fcScore = Math.min(100, Math.max(0, rawScore));
      }
    }

    fingerControlScores[i] = fcScore;
    prevHeadToHeadDt = headToHeadDtReal;
  }

  for (let i = 0; i < nHits; i++) {
    const prev = i > 0 ? rawTapBpm[i - 1] : rawTapBpm[i];
    const curr = rawTapBpm[i];
    const next = i < nHits - 1 ? rawTapBpm[i + 1] : rawTapBpm[i];
    tapBpm[i] = 0.5 * curr + 0.25 * (prev + next);
  }

  return {
    tapBpm,
    targetBpm,
    staminaStrains,
    fingerControlScores
  };
}
