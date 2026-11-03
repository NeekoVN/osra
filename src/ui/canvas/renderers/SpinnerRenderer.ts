import { OsrReplay } from '../../../core/types/replay.ts';

export interface SpinnerTelemetry {
  spm: number;
  totalRotations: number;
  rotationAngle: number;
  isTracking: boolean;
  clearTimeMs: number;
}

export function getSpinnerTelemetry(
  replay: OsrReplay | null,
  spinnerStart: number,
  currentTimeMs: number,
  spinsRequired: number = 0
): SpinnerTelemetry {
  if (!replay || !replay.frames || replay.frames.length === 0 || currentTimeMs < spinnerStart) {
    return { spm: 0, totalRotations: 0, rotationAngle: 0, isTracking: false, clearTimeMs: -1 };
  }

  const frames = replay.frames;
  const cx = 256;
  const cy = 192;

  let l = 0;
  let r = frames.length - 1;
  while (l < r) {
    const m = Math.floor((l + r) / 2);
    if (frames[m].time < spinnerStart) l = m + 1;
    else r = m;
  }
  const startIdx = l;

  l = 0;
  r = frames.length - 1;
  while (l < r) {
    const m = Math.ceil((l + r) / 2);
    if (frames[m].time <= currentTimeMs) l = m;
    else r = m - 1;
  }
  const curIdx = l;

  if (curIdx <= startIdx) {
    return { spm: 0, totalRotations: 0, rotationAngle: 0, isTracking: false, clearTimeMs: -1 };
  }

  const requiredAngle = spinsRequired * Math.PI * 2;
  let clearTimeMs = -1;

  let totalAngle = 0;
  let prevAngle = Math.atan2(frames[startIdx].y - cy, frames[startIdx].x - cx);

  for (let i = startIdx + 1; i <= curIdx; i++) {
    const curAngle = Math.atan2(frames[i].y - cy, frames[i].x - cx);
    let diff = curAngle - prevAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    totalAngle += diff;
    prevAngle = curAngle;
    if (clearTimeMs === -1 && requiredAngle > 0 && Math.abs(totalAngle) >= requiredAngle) {
      clearTimeMs = frames[i].time;
    }
  }

  const windowStart = Math.max(spinnerStart, currentTimeMs - 500);
  let winStartIdx = startIdx;
  while (winStartIdx < curIdx && frames[winStartIdx].time < windowStart) {
    winStartIdx++;
  }

  let windowAngle = 0;
  if (winStartIdx < curIdx) {
    let winPrev = Math.atan2(frames[winStartIdx].y - cy, frames[winStartIdx].x - cx);
    for (let i = winStartIdx + 1; i <= curIdx; i++) {
      const curA = Math.atan2(frames[i].y - cy, frames[i].x - cx);
      let diff = curA - winPrev;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      windowAngle += Math.abs(diff);
      winPrev = curA;
    }
  }

  const windowDuration = currentTimeMs - windowStart;
  let spm = 0;
  if (windowDuration >= 80) {
    const windowRotations = windowAngle / (Math.PI * 2);
    spm = Math.min(477, Math.max(0, Math.round((windowRotations / (windowDuration / 60000)))));
  }

  const totalRotations = Math.floor(Math.abs(totalAngle) / (Math.PI * 2));
  const isTracking = spm > 25;

  return {
    spm,
    totalRotations,
    rotationAngle: totalAngle,
    isTracking,
    clearTimeMs
  };
}

export function getSpinnerProgressColor(progress: number): string {
  const COLOR_MISS: [number, number, number] = [255, 102, 102];
  const COLOR_50:   [number, number, number] = [235, 194, 71];
  const COLOR_100:  [number, number, number] = [153, 235, 71];
  const COLOR_300:  [number, number, number] = [102, 204, 255];

  if (progress < 0.72) return '#ff6666';
  if (progress < 0.78) {
    const t = (progress - 0.72) / 0.06;
    const r = Math.round(COLOR_MISS[0] + (COLOR_50[0] - COLOR_MISS[0]) * t);
    const g = Math.round(COLOR_MISS[1] + (COLOR_50[1] - COLOR_MISS[1]) * t);
    const b = Math.round(COLOR_MISS[2] + (COLOR_50[2] - COLOR_MISS[2]) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (progress < 0.87) return '#ebc247';
  if (progress < 0.93) {
    const t = (progress - 0.87) / 0.06;
    const r = Math.round(COLOR_50[0] + (COLOR_100[0] - COLOR_50[0]) * t);
    const g = Math.round(COLOR_50[1] + (COLOR_100[1] - COLOR_50[1]) * t);
    const b = Math.round(COLOR_50[2] + (COLOR_100[2] - COLOR_50[2]) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (progress < 0.97) return '#99eb47';
  if (progress < 1.03) {
    const t = (progress - 0.97) / 0.06;
    const r = Math.round(COLOR_100[0] + (COLOR_300[0] - COLOR_100[0]) * t);
    const g = Math.round(COLOR_100[1] + (COLOR_300[1] - COLOR_100[1]) * t);
    const b = Math.round(COLOR_100[2] + (COLOR_300[2] - COLOR_100[2]) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
  return '#66ccff';
}

export function renderArgonSpinner(
  ctx: CanvasRenderingContext2D,
  replay: OsrReplay | null,
  obj: any,
  currentTimeMs: number,
  comboColor: string,
  preemptMs: number,
  effectiveOD: number
): void {
  const spinnerStart = obj.time;
  const spinnerEnd = obj.endTime;
  const duration = Math.max(1, spinnerEnd - spinnerStart);

  if (currentTimeMs < spinnerStart - preemptMs || currentTimeMs > spinnerEnd + 260) {
    return;
  }

  const od = effectiveOD;
  const minRpm = od < 5 ? 90 + (150 - 90) * (od / 5) : 150 + (225 - 150) * ((od - 5) / 5);
  const maxRpm = od < 5 ? 250 + (380 - 250) * (od / 5) : 380 + (430 - 380) * ((od - 5) / 5);
  const secondsDuration = duration / 1000;
  const spinsRequired = Math.max(1, Math.floor((minRpm / 60) * secondsDuration + 0.0001));
  const bonusSpinsGap = 2;
  const spinsRequiredForBonus = spinsRequired + bonusSpinsGap;
  const maximumBonusSpins = Math.max(0, Math.floor((maxRpm / 60) * secondsDuration + 0.0001) - spinsRequired - bonusSpinsGap);
  const bonusStep = 50;

  const telemetry = getSpinnerTelemetry(replay, spinnerStart, currentTimeMs, spinsRequired);

  const totalRotations = replay?.frames?.length
    ? Math.abs(telemetry.rotationAngle) / (Math.PI * 2)
    : (currentTimeMs >= spinnerStart ? spinsRequired * Math.min(1.0, (currentTimeMs - spinnerStart) / duration) : 0);

  const progress = spinsRequired > 0 ? totalRotations / spinsRequired : 1.0;
  const clampedProgress = Math.min(1.0, Math.max(0.0, progress));
  const isComplete = progress >= 1.0;

  let clearTransition = 0.0;
  if (isComplete) {
    if (telemetry.clearTimeMs > 0) {
      clearTransition = Math.min(1.0, Math.max(0.0, (currentTimeMs - telemetry.clearTimeMs) / 220));
    } else {
      clearTransition = Math.min(1.0, Math.max(0.0, (progress - 1.0) * 3));
    }
  }

  const completedFullSpins = Math.floor(totalRotations);
  const bonusSpins = Math.max(0, Math.min(maximumBonusSpins, completedFullSpins - spinsRequiredForBonus));
  const bonusScore = bonusSpins * bonusStep;
  const isMaxBonus = maximumBonusSpins > 0 && bonusSpins >= maximumBonusSpins;

  let alpha = 1.0;
  let discScale = 1.0;

  if (currentTimeMs < spinnerStart) {
    const fadeElapsed = currentTimeMs - (spinnerStart - preemptMs);
    const fadeInDuration = preemptMs * 0.4;
    alpha = Math.max(0.01, Math.min(1.0, fadeElapsed / fadeInDuration));

    const preemptProgress = Math.max(0, Math.min(1.0, fadeElapsed / preemptMs));
    discScale = Math.min(1.0, Math.max(0.05, 1 - Math.pow(1 - preemptProgress, 3)));
  } else if (currentTimeMs > spinnerEnd) {
    const elapsed = currentTimeMs - spinnerEnd;
    alpha = Math.max(0.01, 1.0 - elapsed / 260);
    discScale = 1.0 + 0.15 * Math.min(1.0, elapsed / 260);
  }

  const cx = 256;
  const cy = 192;
  const discR = 152 * discScale;

  ctx.save();
  ctx.globalAlpha = Math.min(1.0, alpha);

  // 1. Dark outer backdrop disc
  ctx.fillStyle = 'rgba(9, 11, 16, 0.90)';
  ctx.beginPath();
  ctx.arc(cx, cy, discR, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = comboColor;
  ctx.lineWidth = 1.0;
  ctx.globalAlpha = Math.min(0.35, alpha * 0.35);
  ctx.stroke();
  ctx.globalAlpha = Math.min(1.0, alpha);

  // 2. Expanding radial fill disc
  const durationProgress = Math.min(1.0, Math.max(0.0, (currentTimeMs - spinnerStart) / duration));
  const fillR = discR * (0.08 + 0.90 * durationProgress);
  const grad = ctx.createRadialGradient(cx, cy, fillR * 0.10, cx, cy, fillR);
  if (isComplete) {
    grad.addColorStop(0, 'rgba(100, 25, 50, 0.60)');
    grad.addColorStop(0.7, 'rgba(180, 45, 90, 0.70)');
    grad.addColorStop(1.0, 'rgba(252, 97, 143, 0.92)');
  } else {
    const fillIntensity = telemetry.isTracking ? 0.65 : 0.40;
    grad.addColorStop(0, `rgba(80, 20, 40, ${fillIntensity * 0.4})`);
    grad.addColorStop(0.7, `rgba(160, 40, 80, ${fillIntensity * 0.6})`);
    grad.addColorStop(1.0, `rgba(252, 97, 143, ${fillIntensity})`);
  }

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, fillR, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.strokeStyle = '#FC618F';
  ctx.lineWidth = isComplete ? 2.5 * discScale : 1.8 * discScale;
  ctx.shadowColor = '#FC618F';
  ctx.shadowBlur = (isComplete ? 20 : 12) * discScale;
  ctx.stroke();
  ctx.restore();

  // 3. 25 Turbine Tick Marks Ring
  const ticksR = discR * 0.76;
  const ambientAngle = (currentTimeMs - spinnerStart) * 0.001;
  const totalRotation = ambientAngle + telemetry.rotationAngle;
  const tickW = 14 * discScale;
  const tickH = 3.5 * discScale;
  const tickHalfW = tickW / 2;
  const tickHalfH = tickH / 2;

  for (let i = 0; i < 25; i++) {
    const tickAngle = totalRotation + (i / 25) * Math.PI * 2;
    const tx = cx + Math.cos(tickAngle) * ticksR;
    const ty = cy + Math.sin(tickAngle) * ticksR;

    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(tickAngle + Math.PI * 0.22);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 1.4 * discScale;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';

    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(-tickHalfW, -tickHalfH, tickW, tickH, tickHalfH);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(-tickHalfW, -tickHalfH, tickW, tickH);
      ctx.strokeRect(-tickHalfW, -tickHalfH, tickW, tickH);
    }
    ctx.restore();
  }

  // 4. Outer Ring Expansion
  const arcFill = 0.31 + 0.19 * clearTransition;
  const arcSpan = arcFill * Math.PI;
  const ringLineWidth = (4.0 + 2.5 * clearTransition) * discScale;

  ctx.save();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = ringLineWidth;
  ctx.lineCap = 'round';
  if (clearTransition > 0) {
    ctx.shadowColor = '#FC618F';
    ctx.shadowBlur = 22 * clearTransition * discScale;
  }

  ctx.beginPath();
  ctx.arc(cx, cy, discR, -Math.PI / 2 - arcSpan, -Math.PI / 2 + arcSpan);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, discR, Math.PI / 2 - arcSpan, Math.PI / 2 + arcSpan);
  ctx.stroke();
  ctx.restore();

  // 5. Thicker Side Progress Arcs
  const sideHalfSpan = 0.15 * Math.PI;
  const indicatorAlpha = Math.max(0.0, 1.0 - clearTransition);

  if (indicatorAlpha > 0.005) {
    ctx.save();
    ctx.globalAlpha = Math.min(1.0, alpha * indicatorAlpha);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 14 * discScale;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.arc(cx, cy, discR, -sideHalfSpan, sideHalfSpan);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, discR, Math.PI - sideHalfSpan, Math.PI + sideHalfSpan);
    ctx.stroke();

    const progressColor = getSpinnerProgressColor(progress);
    const currentHalfSpan = isComplete
      ? sideHalfSpan * (1.0 - clearTransition)
      : sideHalfSpan * clampedProgress;

    if (currentHalfSpan > 0.005) {
      ctx.strokeStyle = progressColor;
      ctx.lineWidth = 9.5 * discScale;
      ctx.lineCap = 'round';

      ctx.beginPath();
      ctx.arc(cx, cy, discR, -currentHalfSpan, currentHalfSpan);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, discR, Math.PI - currentHalfSpan, Math.PI + currentHalfSpan);
      ctx.stroke();
    }

    ctx.restore();
  }

  // 6. Concentric dual-ring center hub
  const hubR = (telemetry.isTracking ? 15 : 24) * discScale;

  ctx.fillStyle = '#090B10';
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 3.0 * discScale;
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#FC618F';
  ctx.lineWidth = 3.5 * discScale;
  ctx.beginPath();
  ctx.arc(cx, cy, hubR * 0.72, 0, Math.PI * 2);
  ctx.stroke();

  // 7. HUD Indicators (SPM & Top Status)
  const hudFade = Math.min(1.0, Math.max(0.0, (currentTimeMs - (spinnerStart - 80)) / 160));
  if (hudFade > 0.01) {
    ctx.save();
    ctx.globalAlpha = Math.min(1.0, alpha * hudFade);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${Math.round(28 * discScale)}px "Torus", "Inter", -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(telemetry.spm), cx, cy + 62 * discScale);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.font = `bold ${Math.round(9.5 * discScale)}px "Inter", -apple-system, sans-serif`;
    ctx.fillText('SPINS PER MINUTE', cx, cy + 80 * discScale);

    const topY = cy - 74 * discScale;
    if (currentTimeMs >= spinnerEnd) {
      if (progress < 0.75) {
        ctx.fillStyle = '#ff6666';
        ctx.font = `bold ${Math.round(22 * discScale)}px "Torus", "Inter", -apple-system, sans-serif`;
        ctx.fillText('MISS', cx, topY);
      } else if (progress < 0.90) {
        ctx.fillStyle = '#ebc247';
        ctx.font = `bold ${Math.round(22 * discScale)}px "Torus", "Inter", -apple-system, sans-serif`;
        ctx.fillText('50', cx, topY);
      } else if (progress < 1.00) {
        ctx.fillStyle = '#99eb47';
        ctx.font = `bold ${Math.round(22 * discScale)}px "Torus", "Inter", -apple-system, sans-serif`;
        ctx.fillText('100', cx, topY);
      } else {
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${Math.round(30 * discScale)}px "Torus", "Inter", -apple-system, sans-serif`;
        if (isMaxBonus) {
          ctx.fillText('MAX', cx, topY);
        } else if (bonusScore > 0) {
          ctx.fillText(String(bonusScore), cx, topY);
        }
      }
    } else if (isComplete && bonusScore > 0) {
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold ${Math.round(30 * discScale)}px "Torus", "Inter", -apple-system, sans-serif`;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
      ctx.shadowBlur = 10 * discScale;
      if (isMaxBonus) {
        ctx.fillText('MAX', cx, topY);
      } else {
        ctx.fillText(String(bonusScore), cx, topY);
      }
    }

    ctx.restore();
  }

  ctx.restore();
}
