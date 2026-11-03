import { Beatmap } from '../../core/types/beatmap.ts';
import { OsrReplay, OsuMods } from '../../core/types/replay.ts';
import { TimedHitEvent, HitJudgement } from '../../core/types/telemetry.ts';
import { calculateCircleRadius } from '../../core/math/Projections.ts';
import { getGameplayRateFromMods } from '../../core/math/HitWindows.ts';
import { getModdedBeatmap } from '../../core/evaluator/ReplayEvaluator.ts';
import { CursorRenderer } from './renderers/CursorRenderer.ts';
import { renderArgonSpinner } from './renderers/SpinnerRenderer.ts';
import { getPathPoints, getPointAtProgress, slicePath, renderReverseArrowArc } from './renderers/SliderGeometry.ts';
import {
  renderGrid,
  renderCirclePiece,
  renderFlashlight,
  renderBreakTimer
} from './renderers/EffectsRenderer.ts';

export class PlayfieldRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private beatmap: Beatmap | null = null;
  private replay: OsrReplay | null = null;
  private hitEvents: TimedHitEvent[] = [];
  private circleRadius: number = 36;
  private preemptMs: number = 600;
  private rawPreemptMs: number = 600;
  private backgroundImage: HTMLImageElement | null = null;
  private backgroundLoaded: boolean = false;
  private lastRenderTime: number = 0;
  private effectiveOD: number = 8.0;

  // Mod flags
  private isHR: boolean = false;
  private isHD: boolean = false;
  private isFL: boolean = false;
  private isTC: boolean = false;
  private gameplayRate: number = 1.0;
  private playbackRate: number = 1.0;
  private resizeObserver: ResizeObserver | null = null;

  // Sub-renderers
  private cursorRenderer: CursorRenderer;

  // Break sections
  private breakSections: Array<{ start: number; end: number }> = [];

  // Visual toggles
  private showTrail: boolean = true;
  private showErrorVectors: boolean = true;
  private showPathTrail: boolean = false;
  private readonly pathTrailDurationMs = 1200;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Failed to acquire Canvas 2D context');
    this.ctx = context;

    this.cursorRenderer = new CursorRenderer(() => {
      this.render(this.lastRenderTime);
    });

    this.handleResize();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.handleResize();
        this.render(this.lastRenderTime);
      });
      this.resizeObserver.observe(this.canvas);
    }
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  public toggleTrail(): boolean {
    this.showTrail = !this.showTrail;
    this.render(this.lastRenderTime);
    return this.showTrail;
  }

  public setShowTrail(show: boolean): void {
    this.showTrail = show;
    this.render(this.lastRenderTime);
  }

  public isTrailEnabled(): boolean {
    return this.showTrail;
  }

  public togglePathTrail(): boolean {
    this.showPathTrail = !this.showPathTrail;
    this.render(this.lastRenderTime);
    return this.showPathTrail;
  }

  public setShowPathTrail(show: boolean): void {
    this.showPathTrail = show;
    this.render(this.lastRenderTime);
  }

  public isPathTrailEnabled(): boolean {
    return this.showPathTrail;
  }

  public toggleErrorVectors(): boolean {
    this.showErrorVectors = !this.showErrorVectors;
    this.render(this.lastRenderTime);
    return this.showErrorVectors;
  }

  public setShowErrorVectors(show: boolean): void {
    this.showErrorVectors = show;
    this.render(this.lastRenderTime);
  }

  public isErrorVectorsEnabled(): boolean {
    return this.showErrorVectors;
  }

  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.1, rate);
  }

  public setBackground(url?: string | null): void {
    if (!url) {
      this.backgroundImage = null;
      this.backgroundLoaded = false;
      this.render(this.lastRenderTime);
      return;
    }

    const img = new Image();
    img.onload = () => {
      this.backgroundImage = img;
      this.backgroundLoaded = true;
      this.render(this.lastRenderTime);
    };
    img.onerror = () => {
      this.backgroundImage = null;
      this.backgroundLoaded = false;
    };
    img.src = url;
  }

  public clear(): void {
    this.beatmap = null;
    this.replay = null;
    this.hitEvents = [];
    this.backgroundImage = null;
    this.backgroundLoaded = false;
    this.breakSections = [];
    this.render(0);
  }

  public setData(beatmap: Beatmap, replay: OsrReplay, hitEvents: TimedHitEvent[], backgroundUrl?: string | null): void {
    const mods = replay.mods;
    this.beatmap = getModdedBeatmap(beatmap, mods);
    this.replay = replay;
    this.hitEvents = hitEvents;
    if (backgroundUrl !== undefined) {
      this.setBackground(backgroundUrl);
    }

    this.isHR = !!(mods & OsuMods.HardRock);
    this.isHD = !!(mods & OsuMods.Hidden);
    this.isFL = !!(mods & OsuMods.Flashlight);
    this.isTC = !!(replay.soloScoreInfo?.mods?.some(m => m.acronym === 'TC'));
    this.gameplayRate = getGameplayRateFromMods(replay.soloScoreInfo?.mods, mods);
    this.playbackRate = this.gameplayRate;

    this.circleRadius = calculateCircleRadius(beatmap.difficulty.circleSize, mods);

    let ar = beatmap.difficulty.approachRate;
    if (this.isHR) ar = Math.min(10.0, ar * 1.4);
    else if (mods & OsuMods.Easy) ar = ar * 0.5;

    let od = beatmap.difficulty.overallDifficulty;
    if (this.isHR) od = Math.min(10.0, od * 1.4);
    else if (mods & OsuMods.Easy) od = od * 0.5;
    this.effectiveOD = od;

    if (ar < 5) {
      this.rawPreemptMs = 1200 + 600 * (5 - ar) / 5;
    } else {
      this.rawPreemptMs = 1200 - 750 * (ar - 5) / 5;
    }

    this.preemptMs = this.rawPreemptMs;

    this.breakSections = [];
    const objects = beatmap.hitObjects;
    for (let i = 1; i < objects.length; i++) {
      const prevEnd = objects[i - 1].objectType === 'slider'
        ? (objects[i - 1] as any).endTime
        : (objects[i - 1].objectType === 'spinner' ? (objects[i - 1] as any).endTime : objects[i - 1].time);
      const nextStart = objects[i].time;
      if (nextStart - prevEnd > 1500) {
        this.breakSections.push({ start: prevEnd + 200, end: nextStart - 200 });
      }
    }

    this.handleResize();
  }

  public handleResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
  }

  public render(currentTimeMs: number): void {
    this.lastRenderTime = currentTimeMs;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    if (w <= 60 || h <= 60) return;

    ctx.fillStyle = '#0E0F13';
    ctx.fillRect(0, 0, w, h);

    if (this.backgroundLoaded && this.backgroundImage) {
      const img = this.backgroundImage;
      const imgW = img.naturalWidth || img.width;
      const imgH = img.naturalHeight || img.height;

      if (imgW > 0 && imgH > 0) {
        const imgRatio = imgW / imgH;
        const canvasRatio = w / h;
        let drawW = w;
        let drawH = h;
        let drawX = 0;
        let drawY = 0;

        if (canvasRatio > imgRatio) {
          drawW = w;
          drawH = w / imgRatio;
          drawY = (h - drawH) / 2;
        } else {
          drawH = h;
          drawW = h * imgRatio;
          drawX = (w - drawW) / 2;
        }

        ctx.save();
        ctx.globalAlpha = 0.2;
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        ctx.restore();
      }
    }

    const scaleX = w / 512;
    const scaleY = h / 384;
    const scale = Math.max(0.01, Math.min(scaleX, scaleY) * 0.9);
    const offsetX = (w - 512 * scale) / 2;
    const offsetY = (h - 384 * scale) / 2;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    renderGrid(ctx);

    if (!this.beatmap || !this.replay) {
      ctx.restore();
      return;
    }

    this.renderFollowPoints(ctx, currentTimeMs);
    this.renderHitObjects(ctx, currentTimeMs);

    if (this.showTrail) {
      this.cursorRenderer.renderCursorTrail(ctx, this.replay, currentTimeMs);
    }

    if (this.showPathTrail) {
      this.cursorRenderer.renderPathTrail(ctx, this.replay, currentTimeMs, this.pathTrailDurationMs);
    }

    this.cursorRenderer.renderActiveCursor(
      ctx,
      this.replay,
      this.hitEvents,
      currentTimeMs,
      this.showErrorVectors,
      this.playbackRate
    );

    ctx.restore();

    if (this.isFL) {
      renderFlashlight(ctx, this.replay, w, h, currentTimeMs, offsetX, offsetY, scale);
    }

    renderBreakTimer(ctx, this.breakSections, w, h, currentTimeMs);
  }

  private renderHitObjects(ctx: CanvasRenderingContext2D, currentTimeMs: number): void {
    if (!this.beatmap) return;
    const objects = this.beatmap.hitObjects;
    const R = this.circleRadius;

    const firstNoteIdx = this.isHD ? objects.findIndex(o => o.objectType !== 'spinner') : -1;

    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      const comboColor = obj.comboColor || '#00D8FF';
      const hit = this.hitEvents[i];
      const isMiss = hit ? hit.judgement === HitJudgement.Miss : false;

      // 1. SPINNERS
      if (obj.objectType === 'spinner') {
        renderArgonSpinner(ctx, this.replay, obj, currentTimeMs, comboColor, this.preemptMs, this.effectiveOD);
        continue;
      }

      // 2. SLIDERS
      if (obj.objectType === 'slider') {
        const sliderStart = obj.time;
        const sliderDuration = Math.max(1, obj.duration || 100);
        const sliderEnd = obj.endTime || (sliderStart + sliderDuration);
        const totalSpans = Math.max(1, obj.repeatCount || 1);

        const fadeOutDuration = isMiss ? (240 * this.playbackRate) : (40 * this.playbackRate);

        if (currentTimeMs < sliderStart - this.preemptMs || currentTimeMs > sliderEnd + Math.max(260, fadeOutDuration + 20)) {
          continue;
        }

        const stackOffsetX = obj.stackedX - obj.x;
        const stackOffsetY = obj.stackedY - obj.y;
        const rawPoints = getPathPoints(obj);

        const timeFadeIn = 400 * Math.min(1.0, this.preemptMs / 450);
        const fadeOutStartTime = sliderStart - this.preemptMs + timeFadeIn;

        let bodyAlpha = 1.0;
        if (this.isHD) {
          if (currentTimeMs < fadeOutStartTime) {
            bodyAlpha = Math.min(1.0, Math.max(0.0, (currentTimeMs - (sliderStart - this.preemptMs)) / timeFadeIn));
          } else if (currentTimeMs <= sliderEnd) {
            const longFadeDuration = Math.max(1, sliderEnd - fadeOutStartTime);
            const fadeProgress = Math.min(1.0, Math.max(0.0, (currentTimeMs - fadeOutStartTime) / longFadeDuration));
            bodyAlpha = Math.pow(1.0 - fadeProgress, 2);
          } else {
            bodyAlpha = 0.0;
          }
        } else {
          if (currentTimeMs < sliderStart) {
            bodyAlpha = Math.min(1.0, Math.max(0.0, (currentTimeMs - (sliderStart - this.preemptMs)) / timeFadeIn));
          } else if (currentTimeMs <= sliderEnd) {
            bodyAlpha = 1.0;
          } else {
            // In lazer, if missed, the whole slider fades out over 240ms; if hit, short 40ms cleanup fade
            bodyAlpha = Math.max(0.0, 1.0 - (currentTimeMs - sliderEnd) / Math.max(1, fadeOutDuration));
          }
        }

        let startFrac = 0.0;
        let endFrac = 1.0;
        let isBodyVisible = false;

        if (currentTimeMs < sliderStart) {
          isBodyVisible = true;
          endFrac = Math.max(0.02, Math.min(1.0, (currentTimeMs - (sliderStart - this.preemptMs)) / (this.preemptMs / 3)));
        } else if (currentTimeMs < sliderEnd) {
          isBodyVisible = true;
          if (!isMiss) {
            // As per lazer spec: snaking out ONLY plays if head circle was hit
            const progress = Math.max(0, Math.min(1, (currentTimeMs - sliderStart) / sliderDuration));
            const currentSpan = Math.min(totalSpans - 1, Math.floor(progress * totalSpans));
            const spanProgress = (progress * totalSpans) - currentSpan;

            if (currentSpan >= totalSpans - 1) {
              // osu!lazer SnakingSliderBody: on the final span, snake out behind the ball
              if ((totalSpans - 1) % 2 === 1) {
                // Odd last span (reverse: tail -> head)
                startFrac = 0.0;
                endFrac = Math.max(0, 1.0 - spanProgress);
              } else {
                // Even last span (forward: head -> tail)
                startFrac = Math.min(1.0, spanProgress);
                endFrac = 1.0;
              }
            } else {
              // Intermediate spans keep the full body visible
              startFrac = 0.0;
              endFrac = 1.0;
            }
          } else {
            // Missed slider head: snaking out does NOT play, entire slider body remains visible
            startFrac = 0.0;
            endFrac = 1.0;
          }
        } else if (isMiss && currentTimeMs <= sliderEnd + fadeOutDuration) {
          // Missed slider head: snaking out never occurred, so full body fades out post-sliderEnd
          isBodyVisible = true;
          startFrac = 0.0;
          endFrac = 1.0;
        }

        if (isBodyVisible && bodyAlpha > 0.005) {
          const snakedPoints = slicePath(rawPoints, startFrac, endFrac);
          if (snakedPoints.length >= 2) {
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            ctx.strokeStyle = comboColor;
            ctx.lineWidth = R * 1.85;
            ctx.globalAlpha = bodyAlpha * 0.45;
            ctx.beginPath();
            ctx.moveTo(snakedPoints[0].x + stackOffsetX, snakedPoints[0].y + stackOffsetY);
            for (let p = 1; p < snakedPoints.length; p++) {
              ctx.lineTo(snakedPoints[p].x + stackOffsetX, snakedPoints[p].y + stackOffsetY);
            }
            ctx.stroke();

            ctx.strokeStyle = '#0E0F14';
            ctx.lineWidth = R * 1.5;
            ctx.globalAlpha = bodyAlpha * 0.85;
            ctx.stroke();
            ctx.restore();
          }
        }

        // 2b. SLIDER TICKS
        if (isBodyVisible && obj.ticks && obj.ticks.length > 0 && bodyAlpha > 0.005) {
          const tickRadius = Math.max(3.5, R * 0.14);

          for (const tick of obj.ticks) {
            // During approach snake-in, only show if path has snaked to this point
            if (currentTimeMs < sliderStart && tick.pathProgress > endFrac) {
              continue;
            }

            // During gameplay snake-out, hide if the body has snaked past this point
            if (currentTimeMs >= sliderStart && (tick.pathProgress < startFrac || tick.pathProgress > endFrac)) {
              continue;
            }

            const timeDiff = tick.time - currentTimeMs;
            const tickElapsed = -timeDiff / this.playbackRate;

            // Skip if hit animation already finished (> 150ms)
            if (tickElapsed > 150) continue;

            const pt = getPointAtProgress(rawPoints, tick.pathProgress);
            const tx = pt.x + stackOffsetX;
            const ty = pt.y + stackOffsetY;

            let tickAlpha = bodyAlpha * 0.45;
            let curRadius = tickRadius;

            if (timeDiff <= 0) {
              // 150ms fade-out and slight pop
              const p = Math.min(1.0, tickElapsed / 150);
              tickAlpha = (bodyAlpha * 0.45) * (1.0 - p);
              curRadius = tickRadius * (1.0 + 0.3 * (1.0 - Math.pow(1.0 - p, 3)));
            }

            if (tickAlpha > 0.005) {
              ctx.save();
              ctx.globalAlpha = tickAlpha;
              ctx.fillStyle = comboColor; // Same color and opacity as slider border
              ctx.beginPath();
              ctx.arc(tx, ty, curRadius, 0, Math.PI * 2);
              ctx.fill();
              ctx.restore();
            }
          }
        }

        if (totalSpans > 1 && currentTimeMs < sliderEnd + 260 && rawPoints.length >= 2) {
          const progress = currentTimeMs >= sliderStart ? (currentTimeMs - sliderStart) / sliderDuration : 0;
          const currentSpan = Math.floor(progress * totalSpans);

          if (currentSpan < totalSpans - 1 && currentTimeMs < sliderEnd) {
            const isAtTail = currentSpan % 2 === 0;
            let arrowX: number;
            let arrowY: number;
            let tangentAngle: number;

            if (isAtTail) {
              const tailPt = rawPoints[rawPoints.length - 1];
              let prevPt = rawPoints[Math.max(0, rawPoints.length - 2)];
              for (let p = rawPoints.length - 2; p >= 0; p--) {
                if (Math.hypot(tailPt.x - rawPoints[p].x, tailPt.y - rawPoints[p].y) > 0.1) {
                  prevPt = rawPoints[p];
                  break;
                }
              }
              arrowX = tailPt.x + stackOffsetX;
              arrowY = tailPt.y + stackOffsetY;
              tangentAngle = Math.atan2(tailPt.y - prevPt.y, tailPt.x - prevPt.x);
            } else {
              const headPt = rawPoints[0];
              let nextPt = rawPoints[Math.min(rawPoints.length - 1, 1)];
              for (let p = 1; p < rawPoints.length; p++) {
                if (Math.hypot(headPt.x - rawPoints[p].x, headPt.y - rawPoints[p].y) > 0.1) {
                  nextPt = rawPoints[p];
                  break;
                }
              }
              arrowX = headPt.x + stackOffsetX;
              arrowY = headPt.y + stackOffsetY;
              tangentAngle = Math.atan2(headPt.y - nextPt.y, headPt.x - nextPt.x);
            }

            let arrowAlpha = 1.0;
            if (currentTimeMs < sliderStart) {
              arrowAlpha = Math.min(1.0, Math.max(0.0, (currentTimeMs - (sliderStart - this.preemptMs)) / timeFadeIn));
            }

            renderReverseArrowArc(ctx, arrowX, arrowY, R, tangentAngle, comboColor, 1.0, arrowAlpha);
          }

          for (let span = 1; span < totalSpans; span++) {
            const repeatTime = sliderStart + (span / totalSpans) * sliderDuration;
            const elapsed = (currentTimeMs - repeatTime) / this.playbackRate;
            if (elapsed >= 0 && elapsed <= 240) {
              const isTailRepeat = (span % 2 === 1);
              let anchorX: number;
              let anchorY: number;
              let tangentAngle: number;

              if (isTailRepeat) {
                const tailPt = rawPoints[rawPoints.length - 1];
                let prevPt = rawPoints[Math.max(0, rawPoints.length - 2)];
                for (let p = rawPoints.length - 2; p >= 0; p--) {
                  if (Math.hypot(tailPt.x - rawPoints[p].x, tailPt.y - rawPoints[p].y) > 0.1) {
                    prevPt = rawPoints[p];
                    break;
                  }
                }
                anchorX = tailPt.x + stackOffsetX;
                anchorY = tailPt.y + stackOffsetY;
                tangentAngle = Math.atan2(tailPt.y - prevPt.y, tailPt.x - prevPt.x);
              } else {
                const headPt = rawPoints[0];
                let nextPt = rawPoints[Math.min(rawPoints.length - 1, 1)];
                for (let p = 1; p < rawPoints.length; p++) {
                  if (Math.hypot(headPt.x - rawPoints[p].x, headPt.y - rawPoints[p].y) > 0.1) {
                    nextPt = rawPoints[p];
                    break;
                  }
                }
                anchorX = headPt.x + stackOffsetX;
                anchorY = headPt.y + stackOffsetY;
                tangentAngle = Math.atan2(headPt.y - nextPt.y, headPt.x - nextPt.x);
              }

              const hitProgress = elapsed / 240;
              const easeOut = 1.0 - Math.pow(1.0 - hitProgress, 3);
              const hitScale = 1.0 + 0.45 * easeOut;
              const hitAlpha = Math.max(0, 1.0 - hitProgress);

              renderReverseArrowArc(ctx, anchorX, anchorY, R, tangentAngle, comboColor, hitScale, hitAlpha);
            }
          }
        }

        const headX = obj.stackedX;
        const headY = obj.stackedY;
        const headDiff = sliderStart - currentTimeMs;

        let headAlpha = 1.0;
        if (this.isHD) {
          if (currentTimeMs < fadeOutStartTime) {
            headAlpha = Math.min(1.0, Math.max(0.0, (currentTimeMs - (sliderStart - this.preemptMs)) / timeFadeIn));
          } else {
            const headFadeDuration = this.preemptMs * 0.3;
            headAlpha = Math.max(0.0, 1.0 - (currentTimeMs - fadeOutStartTime) / headFadeDuration);
          }
        } else {
          if (currentTimeMs < sliderStart) {
            headAlpha = Math.min(1.0, Math.max(0.0, (currentTimeMs - (sliderStart - this.preemptMs)) / timeFadeIn));
          } else {
            headAlpha = 1.0;
          }
        }

        if (headDiff > -240 * this.playbackRate) {
          const showHeadApproach = !this.isHD || (i === firstNoteIdx);
          renderCirclePiece(
            ctx,
            headX,
            headY,
            R,
            comboColor,
            obj.comboIndex || 1,
            headDiff,
            headAlpha,
            isMiss,
            showHeadApproach,
            this.isHD,
            this.isTC,
            this.preemptMs,
            this.playbackRate
          );
        }

        if (currentTimeMs >= sliderStart && currentTimeMs <= sliderEnd) {
          const progress = (currentTimeMs - sliderStart) / sliderDuration;
          const currentSpan = Math.floor(progress * totalSpans);
          const spanProgress = (progress * totalSpans) % 1;
          const ballProgress = (currentSpan % 2 === 1) ? (1.0 - spanProgress) : spanProgress;

          const ballPos = getPointAtProgress(rawPoints, ballProgress);
          const bx = ballPos.x + stackOffsetX;
          const by = ballPos.y + stackOffsetY;

          ctx.save();
          ctx.globalAlpha = 1.0;

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(bx, by, R * 2.4, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = '#12151D';
          ctx.beginPath();
          ctx.arc(bx, by, R * 0.85, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = comboColor;
          ctx.lineWidth = 3.0;
          ctx.stroke();

          ctx.fillStyle = '#FFFFFF';
          ctx.beginPath();
          ctx.arc(bx, by, 4.0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        continue;
      }

      // 3. HIT CIRCLES
      const timeDiff = obj.time - currentTimeMs;
      if (timeDiff > -240 * this.playbackRate && timeDiff <= this.preemptMs) {
        const x = obj.stackedX;
        const y = obj.stackedY;

        let alpha = 0.0;
        if (timeDiff > 0) {
          const age = this.preemptMs - timeDiff;
          if (this.isHD) {
            const fadeIn = this.preemptMs * 0.4;
            const fadeOut = this.preemptMs * 0.3;
            if (age < fadeIn) {
              alpha = Math.min(1.0, age / fadeIn);
            } else if (age < fadeIn + fadeOut) {
              alpha = Math.max(0.0, 1.0 - (age - fadeIn) / fadeOut);
            } else {
              alpha = 0.0;
            }
          } else {
            const fadeIn = 400 * Math.min(1.0, this.preemptMs / 450);
            alpha = Math.min(1.0, Math.max(0.0, age / fadeIn));
          }
        }

        ctx.save();
        const showApproachCircle = !this.isHD || (i === firstNoteIdx);
        renderCirclePiece(
          ctx,
          x,
          y,
          R,
          comboColor,
          obj.comboIndex || 1,
          timeDiff,
          alpha,
          isMiss,
          showApproachCircle,
          this.isHD,
          this.isTC,
          this.preemptMs,
          this.playbackRate
        );
        ctx.restore();
      }
    }
  }

  private renderFollowPoints(ctx: CanvasRenderingContext2D, currentTimeMs: number): void {
    if (!this.beatmap) return;
    const objects = this.beatmap.hitObjects;
    const SPACING = 32;

    for (let i = 0; i < objects.length - 1; i++) {
      const objA = objects[i];
      const objB = objects[i + 1];

      // In osu!lazer, follow points only connect objects within the same combo chain,
      // and neither object may be a spinner.
      if (objB.isNewCombo) continue;
      if (objA.objectType === 'spinner' || objB.objectType === 'spinner') continue;

      const startTime = objA.objectType === 'slider'
        ? (objA.endTime || (objA.time + (objA.duration || 0)))
        : objA.time;
      const endTime = objB.time;
      const duration = endTime - startTime;
      if (duration <= 0) continue;

      const preempt = 800 * Math.min(1.0, this.preemptMs / 450);

      // Window check: earliest point fades in at (startTime - preempt),
      // latest point completes fade-out at (endTime + 400)
      if (currentTimeMs < startTime - preempt || currentTimeMs > endTime + 400) {
        continue;
      }

      let startX: number;
      let startY: number;

      if (objA.objectType === 'slider') {
        const repeats = Math.max(1, objA.repeatCount || 1);
        const stackOffsetX = objA.stackedX - objA.x;
        const stackOffsetY = objA.stackedY - objA.y;
        if (repeats % 2 === 1) {
          startX = (objA.sliderEnd ? objA.sliderEnd.x : objA.x) + stackOffsetX;
          startY = (objA.sliderEnd ? objA.sliderEnd.y : objA.y) + stackOffsetY;
        } else {
          startX = objA.stackedX;
          startY = objA.stackedY;
        }
      } else {
        startX = objA.stackedX;
        startY = objA.stackedY;
      }

      const endX = objB.stackedX;
      const endY = objB.stackedY;

      const dx = endX - startX;
      const dy = endY - startY;
      const distance = Math.hypot(dx, dy);

      if (distance < SPACING * 2.5) continue;

      const dirX = dx / distance;
      const dirY = dy / distance;

      for (let d = SPACING * 1.5; d < distance - SPACING; d += SPACING) {
        const fraction = d / distance;
        const fadeOutTime = startTime + fraction * duration;
        const fadeInTime = fadeOutTime - preempt;

        if (currentTimeMs < fadeInTime || currentTimeMs > fadeOutTime + 400) {
          continue;
        }

        const fadeInElapsed = (currentTimeMs - fadeInTime) / this.playbackRate;
        const fadeInProgress = Math.min(1.0, Math.max(0.0, fadeInElapsed / 400));
        // Lazer Easing.Out for smooth movement
        const easeOut = 1.0 - Math.pow(1.0 - fadeInProgress, 2);

        // Lazer: pointStartPosition = startPosition + (fraction - 0.1) * distanceVector
        // moving to: pointEndPosition = startPosition + fraction * distanceVector
        const currentFraction = fraction - 0.1 * (1.0 - easeOut);
        const px = startX + currentFraction * dx;
        const py = startY + currentFraction * dy;

        let alpha = 0.0;
        if (currentTimeMs < fadeOutTime) {
          alpha = fadeInProgress;
        } else {
          const fadeOutElapsed = (currentTimeMs - fadeOutTime) / this.playbackRate;
          alpha = Math.max(0.0, 1.0 - fadeOutElapsed / 400);
        }

        // Keep it subtle as requested:
        // "the shape should resemble a thin line and be subtle, I don't want a solid very visible line even if it's thin, not '>>>' like in default skins."
        const finalAlpha = alpha * 0.35;
        if (finalAlpha <= 0.01) continue;

        const dashLen = 7;
        const halfLen = dashLen / 2;
        const x1 = px - dirX * halfLen;
        const y1 = py - dirY * halfLen;
        const x2 = px + dirX * halfLen;
        const y2 = py + dirY * halfLen;

        ctx.save();
        ctx.globalAlpha = finalAlpha;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}
