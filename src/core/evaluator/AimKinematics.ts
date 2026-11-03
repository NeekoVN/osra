import { ReplayFrame } from '../types/replay.ts';
import { HitObject } from '../types/beatmap.ts';
import { TimedHitEvent, HitJudgement } from '../types/telemetry.ts';
import { KinematicsResult } from '../math/Kinematics.ts';
import { ObjectAimGeometry, PatternGroup } from './types.ts';

export function getAimGeometry(obj: any): ObjectAimGeometry {
  const startX = obj.stackedX ?? obj.x;
  const startY = obj.stackedY ?? obj.y;
  const startTime = obj.time;
  const isSlider = obj.objectType === 'slider';

  if (!isSlider) {
    return {
      startX,
      startY,
      startTime,
      endX: startX,
      endY: startY,
      endTime: startTime,
      approachingX: startX,
      approachingY: startY,
      isSlider: false,
      pixelLength: 0,
      repeatCount: 1,
      duration: 0
    };
  }

  const offsetX = startX - obj.x;
  const offsetY = startY - obj.y;
  const rawEndX = obj.sliderEnd?.x ?? obj.x;
  const rawEndY = obj.sliderEnd?.y ?? obj.y;
  const endX = rawEndX + offsetX;
  const endY = rawEndY + offsetY;
  const duration = Math.max(0, obj.duration || (obj.endTime ? obj.endTime - obj.time : 0));
  const endTime = obj.endTime || (obj.time + duration);

  let approachingX = startX;
  let approachingY = startY;

  if (obj.curvePoints && obj.curvePoints.length >= 2) {
    const lastIdx = obj.curvePoints.length - 1;
    const secondLast = obj.curvePoints[Math.max(0, lastIdx - 1)];
    approachingX = secondLast.x + offsetX;
    approachingY = secondLast.y + offsetY;
  }

  return {
    startX,
    startY,
    startTime,
    endX,
    endY,
    endTime,
    approachingX,
    approachingY,
    isSlider: true,
    pixelLength: obj.pixelLength || 0,
    repeatCount: obj.repeatCount || 1,
    duration
  };
}

export function calculateVectorAngle(
  currX: number, currY: number,
  lastX: number, lastY: number,
  lastLastX: number, lastLastY: number
): number {
  const v1x = lastLastX - lastX;
  const v1y = lastLastY - lastY;
  const v2x = currX - lastX;
  const v2y = currY - lastY;

  const dot = v1x * v2x + v1y * v2y;
  const det = v1x * v2y - v1y * v2x;

  return Math.abs(Math.atan2(det, dot));
}

export function calculateNisicoTurnAngle(
  currGeom: ObjectAimGeometry,
  lastGeom: ObjectAimGeometry,
  lastLastGeom: ObjectAimGeometry
): number {
  let angleRad: number;

  if (lastGeom.isSlider && lastGeom.pixelLength > 0) {
    const headAngle = calculateVectorAngle(
      currGeom.startX, currGeom.startY,
      lastGeom.startX, lastGeom.startY,
      lastLastGeom.endX, lastLastGeom.endY
    );

    const sliderExitAngle = calculateVectorAngle(
      currGeom.startX, currGeom.startY,
      lastGeom.endX, lastGeom.endY,
      lastGeom.approachingX, lastGeom.approachingY
    );

    angleRad = Math.min(headAngle, sliderExitAngle);
  } else {
    angleRad = calculateVectorAngle(
      currGeom.startX, currGeom.startY,
      lastGeom.startX, lastGeom.startY,
      lastLastGeom.endX, lastLastGeom.endY
    );
  }

  const turnSharpnessDeg = 180 - (angleRad * 180) / Math.PI;
  return Math.max(0, Math.min(180, turnSharpnessDeg));
}

export interface AimKinematicsResult {
  turnAngles: Float64Array;
  velocities: Float64Array;
  easedVelocities: Float64Array;
  strains: Float64Array;
  patternGroups: PatternGroup[];
}

export function computeKinematicStrains(
  hitEvents: TimedHitEvent[],
  objects: HitObject[],
  frames: ReplayFrame[],
  kinematics: KinematicsResult,
  rollingAccArr: Float32Array,
  gameplayRate: number,
  circleRadius: number
): AimKinematicsResult {
  const nHits = hitEvents.length;
  const easedVelocities = new Float64Array(nHits);
  const turnAngles = new Float64Array(nHits);
  const strains = new Float64Array(nHits);
  const velocities = new Float64Array(nHits);

  let curStrain = 0;

  const patternGroups: PatternGroup[] = [];
  let pGroupStart = 0;

  for (let i = 0; i < nHits; i++) {
    const currObj = objects[hitEvents[i].objectIndex - 1];
    const currObjEndTime = ('endTime' in currObj && (currObj as any).endTime) ? (currObj as any).endTime : currObj.time;
    const nextObj = i < nHits - 1 ? objects[hitEvents[i + 1].objectIndex - 1] : null;

    const gapToNext = nextObj ? (nextObj.time - currObjEndTime) / gameplayRate : 9999;
    const isPatternBoundary = i === nHits - 1 || gapToNext > 240;

    if (isPatternBoundary) {
      let minAcc = 100;
      let misses = 0;
      for (let k = pGroupStart; k <= i; k++) {
        if (rollingAccArr[k] < minAcc) minAcc = rollingAccArr[k];
        if (hitEvents[k].judgement === HitJudgement.Miss) misses++;
      }
      const startObj = objects[hitEvents[pGroupStart].objectIndex - 1];
      patternGroups.push({
        startIndex: pGroupStart,
        endIndex: i,
        startTime: startObj.time,
        endTime: currObjEndTime,
        minRollingAcc: minAcc,
        isClean: minAcc >= 75 && misses === 0,
        missCount: misses
      });
      pGroupStart = i + 1;
    }
  }

  for (let i = 0; i < nHits; i++) {
    const ev = hitEvents[i];
    const currObj = objects[ev.objectIndex - 1];
    const currGeom = getAimGeometry(currObj);
    const prevEv = i > 0 ? hitEvents[i - 1] : null;
    const prevObj = prevEv ? objects[prevEv.objectIndex - 1] : null;
    const prevGeom = prevObj ? getAimGeometry(prevObj) : null;
    const prev2Ev = i > 1 ? hitEvents[i - 2] : null;
    const prev2Obj = prev2Ev ? objects[prev2Ev.objectIndex - 1] : null;
    const prev2Geom = prev2Obj ? getAimGeometry(prev2Obj) : null;
    const nextEv = i < nHits - 1 ? hitEvents[i + 1] : null;
    const nextObj = nextEv ? objects[nextEv.objectIndex - 1] : null;

    let low = 0;
    let high = frames.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (frames[mid].time < ev.targetTime) low = mid + 1;
      else high = mid - 1;
    }
    const frameIdx = Math.min(frames.length - 1, Math.max(0, low));

    let depCursorX = currGeom.startX;
    let depCursorY = currGeom.startY;
    let depCursorTime = ev.targetTime - 100;
    let approachX = depCursorX;
    let approachY = depCursorY;
    let depFrameIdx = frameIdx;

    if (prevEv && prevGeom) {
      if (prevGeom.isSlider) {
        let sLow = 0;
        let sHigh = frames.length - 1;
        while (sLow <= sHigh) {
          const sMid = (sLow + sHigh) >> 1;
          if (frames[sMid].time < prevGeom.endTime) sLow = sMid + 1;
          else sHigh = sMid - 1;
        }
        depFrameIdx = Math.min(frames.length - 1, Math.max(0, sLow));
        depCursorX = frames[depFrameIdx].x;
        depCursorY = frames[depFrameIdx].y;
        depCursorTime = frames[depFrameIdx].time;

        let preIdx = depFrameIdx;
        while (preIdx > 0 && frames[preIdx].time > depCursorTime - 45) {
          preIdx--;
        }
        approachX = frames[preIdx].x;
        approachY = frames[preIdx].y;
      } else {
        depCursorX = prevEv.tapX;
        depCursorY = prevEv.tapY;
        depCursorTime = prevEv.tapTime;

        let cLow = 0;
        let cHigh = frames.length - 1;
        while (cLow <= cHigh) {
          const cMid = (cLow + cHigh) >> 1;
          if (frames[cMid].time < prevEv.tapTime) cLow = cMid + 1;
          else cHigh = cMid - 1;
        }
        depFrameIdx = Math.min(frames.length - 1, Math.max(0, cLow));

        let preIdx = depFrameIdx;
        while (preIdx > 0 && frames[preIdx].time > depCursorTime - 45) {
          preIdx--;
        }
        approachX = frames[preIdx].x;
        approachY = frames[preIdx].y;
      }
    }

    const arrCursorX = ev.tapX;
    const arrCursorY = ev.tapY;
    const arrCursorTime = ev.tapTime;

    let turnAngle = 0;
    if (prevGeom) {
      const vinX = depCursorX - approachX;
      const vinY = depCursorY - approachY;
      const lenIn = Math.hypot(vinX, vinY);

      const voutX = arrCursorX - depCursorX;
      const voutY = arrCursorY - depCursorY;
      const lenOut = Math.hypot(voutX, voutY);

      let vectorSharpness = 0;
      if (lenIn > 0.5 && lenOut > 0.5) {
        const dot = vinX * voutX + vinY * voutY;
        const det = vinX * voutY - vinY * voutX;
        const angleRad = Math.abs(Math.atan2(det, dot));
        vectorSharpness = (angleRad * 180) / Math.PI;
      }

      let peakSnap = 0;
      const tTransStart = depCursorTime - 30;
      const tTransEnd = depCursorTime + 50;
      let sF = depFrameIdx;
      while (sF > 0 && frames[sF].time > tTransStart) sF--;
      for (let f = sF; f < frames.length; f++) {
        if (frames[f].time > tTransEnd) break;
        if (kinematics.snapAngles[f] > peakSnap) {
          peakSnap = kinematics.snapAngles[f];
        }
      }

      if (lenIn > 0.5 && lenOut > 0.5) {
        turnAngle = Math.max(vectorSharpness, peakSnap);
      } else if (peakSnap > 0) {
        turnAngle = peakSnap;
      } else {
        turnAngle = (prevGeom && prev2Geom) ? calculateNisicoTurnAngle(currGeom, prevGeom, prev2Geom) : 0;
      }
    }
    turnAngles[i] = turnAngle;

    const tJumpStart = prevGeom ? depCursorTime : ev.targetTime - 100;
    const tJumpEnd = ev.targetTime;

    let maxEasedVel = kinematics.easedVelocities[frameIdx] || 0;
    let maxRawVel = kinematics.velocities[frameIdx] || 0;

    let startF = frameIdx;
    while (startF > 0 && frames[startF].time > tJumpStart - 10) {
      startF--;
    }
    for (let f = startF; f < frames.length; f++) {
      const ft = frames[f].time;
      if (ft >= tJumpStart - 10 && ft <= tJumpEnd + 20) {
        if (kinematics.easedVelocities[f] > maxEasedVel) {
          maxEasedVel = kinematics.easedVelocities[f];
        }
        if (kinematics.velocities[f] > maxRawVel) {
          maxRawVel = kinematics.velocities[f];
        }
      }
      if (ft > tJumpEnd + 20) break;
    }

    velocities[i] = maxRawVel;
    easedVelocities[i] = maxEasedVel;

    if (prevGeom) {
      const jumpDist = Math.hypot(arrCursorX - depCursorX, arrCursorY - depCursorY);
      const dtJump = Math.max(15, (arrCursorTime - depCursorTime) / gameplayRate);
      const rawJumpSpeed = jumpDist / dtJump;
      const jumpSpeed = Math.max(rawJumpSpeed, maxEasedVel * 0.8);

      const decay = Math.pow(0.15, dtJump / 1000);
      curStrain *= decay;

      let angleBonus = 1.0;
      if (turnAngle > 60) {
        angleBonus = 1.0 + Math.min(1.2, Math.pow((turnAngle - 60) / 60, 1.25) * 0.65);
      }

      const jumpStrain = Math.pow(jumpSpeed, 1.25) * 40.0 * angleBonus;
      curStrain += jumpStrain;

      const circleDiam = circleRadius * 2;
      const spacingRatio = circleDiam > 0 ? jumpDist / circleDiam : 1.5;

      if (dtJump >= 100 && dtJump <= 205 && spacingRatio >= 1.0 && spacingRatio <= 4.2) {
        const cadenceWeight = Math.max(0, 1.0 - Math.abs(dtJump - 150) / 65);

        let inertiaArrest = 0;
        if (turnAngle >= 60) {
          if (turnAngle >= 135) {
            inertiaArrest = 1.2 + ((turnAngle - 135) / 45) * 0.8;
          } else if (turnAngle >= 75) {
            inertiaArrest = 0.8 + ((turnAngle - 75) / 60) * 0.5;
          } else {
            inertiaArrest = ((turnAngle - 60) / 15) * 0.5;
          }
        }

        let oscillationBonus = 0;
        if (i >= 2) {
          const prev2Ev = hitEvents[i - 2];
          const prev2Obj = prev2Ev ? objects[prev2Ev.objectIndex - 1] : null;
          if (prev2Obj && prevObj) {
            const uX = prevObj.x - prev2Obj.x;
            const uY = prevObj.y - prev2Obj.y;
            const vX = currObj.x - prevObj.x;
            const vY = currObj.y - prevObj.y;
            const crossPrev = uX * vY - uY * vX;

            if (nextObj) {
              const wX = nextObj.x - currObj.x;
              const wY = nextObj.y - currObj.y;
              const crossNext = vX * wY - vY * wX;
              if ((crossPrev > 250 && crossNext < -250) || (crossPrev < -250 && crossNext > 250)) {
                oscillationBonus = 0.65;
              }
            }
          }
        }

        if (inertiaArrest > 0 || oscillationBonus > 0) {
          const techAltStrain = Math.pow(jumpSpeed, 0.9) * 26.0 * cadenceWeight * (inertiaArrest + oscillationBonus);
          curStrain += techAltStrain;
        }
      }

      if (currGeom.isSlider && currGeom.pixelLength > 0) {
        const sliderDt = Math.max(20, currGeom.duration / gameplayRate);
        let actualTravel = 0;
        let sF = frameIdx;
        while (sF > 0 && frames[sF].time > currGeom.startTime) sF--;
        let eF = frameIdx;
        while (eF < frames.length - 1 && frames[eF].time < currGeom.endTime) eF++;
        for (let f = sF + 1; f <= eF; f++) {
          actualTravel += Math.hypot(frames[f].x - frames[f - 1].x, frames[f].y - frames[f - 1].y);
        }
        const actualSpeed = actualTravel / sliderDt;
        const sliderTrackingStrain = Math.pow(actualSpeed, 1.15) * 22.0;

        curStrain = curStrain * Math.pow(0.4, sliderDt / 1000) + sliderTrackingStrain;
      }
    }

    strains[i] = curStrain;
  }

  return {
    turnAngles,
    velocities,
    easedVelocities,
    strains,
    patternGroups
  };
}
