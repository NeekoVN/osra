import { Beatmap } from '../../core/types/beatmap.ts';
import { OsrReplay, OsuMods } from '../../core/types/replay.ts';
import { TimedHitEvent, HitJudgement, DesyncType } from '../../core/types/telemetry.ts';
import { calculateCircleRadius } from '../../core/math/Projections.ts';
import { getGameplayRateFromMods } from '../../core/math/HitWindows.ts';
import { getModdedBeatmap } from '../../core/evaluator/ReplayEvaluator.ts';
import cursorImgUrl from '../../assets/skin/cursor@2x.png';
import cursorTrailImgUrl from '../../assets/skin/cursortrail@2x.png';

export class PlayfieldRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private beatmap: Beatmap | null = null;
  private replay: OsrReplay | null = null;
  private hitEvents: TimedHitEvent[] = [];
  private circleRadius: number = 36;
  private preemptMs: number = 600;
  /** Raw preemptMs computed from AR, before gameplay-rate division */
  private rawPreemptMs: number = 600;
  private backgroundImage: HTMLImageElement | null = null;
  private backgroundLoaded: boolean = false;
  private lastRenderTime: number = 0;
  private effectiveOD: number = 8.0;

  // Mod flags (cached for render loop)
  private isHR: boolean = false;
  private isHD: boolean = false;
  private isFL: boolean = false;
  private isTC: boolean = false;  // Traceable (lazer)
  private gameplayRate: number = 1.0;
  private playbackRate: number = 1.0;
  private resizeObserver: ResizeObserver | null = null;

  // Cached skin images and fallback sprites
  private cursorImg: HTMLImageElement | null = null;
  private cursorTrailImg: HTMLImageElement | null = null;
  private trailSprite: HTMLCanvasElement | null = null;
  private cursorSprite: HTMLCanvasElement | null = null;

  // Break sections derived from beatmap hit objects
  private breakSections: Array<{ start: number; end: number }> = [];

  // Visual overlay toggles
  private showTrail: boolean = true;
  private showErrorVectors: boolean = true;
  private showPathTrail: boolean = false;

  // Trajectory inspection trail: long observation window in song-time ms so
  // the full cursor path stays visible (vs the ~120ms default trail)
  private readonly pathTrailDurationMs = 1200;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Failed to acquire Canvas 2D context');
    this.ctx = context;
    this.initCursorTextures();
    this.initCursorSprites();
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
    // Traceable is a lazer-only mod stored in soloScoreInfo
    this.isTC = !!(replay.soloScoreInfo?.mods?.some(m => m.acronym === 'TC'));
    this.gameplayRate = getGameplayRateFromMods(replay.soloScoreInfo?.mods, mods);
    this.playbackRate = this.gameplayRate;

    this.circleRadius = calculateCircleRadius(beatmap.difficulty.circleSize, mods);

    // Compute AR effective value (already includes mod adjustments in the difficulty object
    // if parsed through a mod-aware parser; otherwise we need to apply manually)
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

    // Preempt in song-time milliseconds matches osu! ruleset directly.
    // The playback clock (TimeBus) advances at playbackRate, so rawPreemptMs song-ms
    // naturally elapses in (rawPreemptMs / playbackRate) real seconds.
    this.preemptMs = this.rawPreemptMs;

    // Compute break sections: gaps > 1500ms between consecutive hit objects
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

    // Clear background
    ctx.fillStyle = '#0E0F13';
    ctx.fillRect(0, 0, w, h);

    // Draw beatmap background image at 80% dim if loaded
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

    // Compute letterboxed scale for standard osu! 512x384 playfield
    const scaleX = w / 512;
    const scaleY = h / 384;
    const scale = Math.max(0.01, Math.min(scaleX, scaleY) * 0.9);
    const offsetX = (w - 512 * scale) / 2;
    const offsetY = (h - 384 * scale) / 2;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // 1. Draw 4x3 regional grid
    this.renderGrid(ctx);

    if (!this.beatmap || !this.replay) {
      ctx.restore();
      return;
    }

    // 2. Draw Hit Objects visible around currentTimeMs
    this.renderHitObjects(ctx, currentTimeMs);

    // 3. Draw Cursor Motion Trail (500ms past)
    if (this.showTrail) {
      this.renderCursorTrail(ctx, currentTimeMs);
    }

    // 3.5 Draw Cursor Path Trail (long, thin trajectory for inspection)
    if (this.showPathTrail) {
      this.renderPathTrail(ctx, currentTimeMs);
    }

    // 4. Draw Active Cursor and Error Vector
    this.renderActiveCursor(ctx, currentTimeMs);

    ctx.restore();

    // 5. Flashlight overlay (in screen space, after restoring transform)
    if (this.isFL) {
      this.renderFlashlight(ctx, w, h, currentTimeMs, offsetX, offsetY, scale);
    }

    // 6. Break section timer overlay
    this.renderBreakTimer(ctx, w, h, currentTimeMs);
  }

  private renderGrid(ctx: CanvasRenderingContext2D): void {
    ctx.strokeStyle = '#1D1F27';
    ctx.lineWidth = 1;

    // Playfield outer border
    ctx.strokeRect(0, 0, 512, 384);

    // 4 columns (every 128px)
    for (let x = 128; x < 512; x += 128) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 384);
      ctx.stroke();
    }

    // 3 rows (every 128px)
    for (let y = 128; y < 384; y += 128) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(512, y);
      ctx.stroke();
    }
  }

  private renderHitObjects(ctx: CanvasRenderingContext2D, currentTimeMs: number): void {
    if (!this.beatmap) return;
    const objects = this.beatmap.hitObjects;
    const R = this.circleRadius;

    // In osu! Hidden rules (OsuModHidden.cs -> IsFirstAdjustableObject):
    // Only the very first note of the entire beatmap receives an approach circle.
    const firstNoteIdx = this.isHD ? objects.findIndex(o => o.objectType !== 'spinner') : -1;

    // Iterate in REVERSE order so earlier hit objects (due first) are rendered ON TOP of later ones
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      const comboColor = obj.comboColor || '#00D8FF';
      const hit = this.hitEvents[i];
      const isMiss = hit ? hit.judgement === HitJudgement.Miss : false;

      // -------------------------------------------------------------
      // 1. SPINNERS
      // -------------------------------------------------------------
      // 1. SPINNERS (osu!lazer Argon skin line)
      if (obj.objectType === 'spinner') {
        this.renderArgonSpinner(ctx, obj, currentTimeMs, comboColor);
        continue;
      }

      // -------------------------------------------------------------
      // -------------------------------------------------------------
      // 2. SLIDERS
      // -------------------------------------------------------------
      if (obj.objectType === 'slider') {
        const sliderStart = obj.time;
        const sliderDuration = Math.max(1, obj.duration || 100);
        const sliderEnd = obj.endTime || (sliderStart + sliderDuration);
        const totalSpans = Math.max(1, obj.repeatCount || 1);

        if (currentTimeMs < sliderStart - this.preemptMs || currentTimeMs > sliderEnd + 260) {
          continue;
        }

        const stackOffsetX = obj.stackedX - obj.x;
        const stackOffsetY = obj.stackedY - obj.y;
        const rawPoints = this.getPathPoints(obj);

        // Standard slider fade-in duration matches Stable: 400 * Math.min(1, preempt / 450)
        const timeFadeIn = 400 * Math.min(1.0, this.preemptMs / 450);
        const fadeOutStartTime = sliderStart - this.preemptMs + timeFadeIn;

        // 1. Calculate Slider Body Alpha according to osu! OsuModHidden rules:
        // Body fades in over timeFadeIn. With Hidden, it fades out with Easing.Out
        // across the entire duration until sliderEnd.
        let bodyAlpha = 1.0;
        if (this.isHD) {
          if (currentTimeMs < fadeOutStartTime) {
            bodyAlpha = Math.min(1.0, Math.max(0.0, (currentTimeMs - (sliderStart - this.preemptMs)) / timeFadeIn));
          } else if (currentTimeMs <= sliderEnd) {
            const longFadeDuration = Math.max(1, sliderEnd - fadeOutStartTime);
            const fadeProgress = Math.min(1.0, Math.max(0.0, (currentTimeMs - fadeOutStartTime) / longFadeDuration));
            // Easing.Out: alpha(t) = (1 - t)^2
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
            bodyAlpha = Math.max(0.0, 1.0 - (currentTimeMs - sliderEnd) / 100);
          }
        }

        // 2. Snaking in and snaking out fraction calculations
        let startFrac = 0.0;
        let endFrac = 1.0;
        let isBodyVisible = currentTimeMs <= sliderEnd;

        if (currentTimeMs < sliderStart) {
          // Snaking in during approach (preempt / 3)
          endFrac = Math.max(0.02, Math.min(1.0, (currentTimeMs - (sliderStart - this.preemptMs)) / (this.preemptMs / 3)));
        } else if (currentTimeMs >= sliderStart && currentTimeMs < sliderEnd) {
          // Active slider
          if (totalSpans === 1) {
            // Snaking out only for non-repeat sliders (official osu!lazer behavior)
            const progress = (currentTimeMs - sliderStart) / sliderDuration;
            startFrac = progress;
            endFrac = 1.0;
          } else {
            startFrac = 0.0;
            endFrac = 1.0;
          }
        }

        // 3. Draw Snaked Slider Body Track
        // TC (Traceable): slider body IS drawn (only hitcircle body hidden)
        if (isBodyVisible && bodyAlpha > 0.005) {
          const snakedPoints = this.slicePath(rawPoints, startFrac, endFrac);
          if (snakedPoints.length >= 2) {
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // Outer colored border of slider track
            ctx.strokeStyle = comboColor;
            ctx.lineWidth = R * 1.85;
            ctx.globalAlpha = bodyAlpha * 0.45;
            ctx.beginPath();
            ctx.moveTo(snakedPoints[0].x + stackOffsetX, snakedPoints[0].y + stackOffsetY);
            for (let p = 1; p < snakedPoints.length; p++) {
              ctx.lineTo(snakedPoints[p].x + stackOffsetX, snakedPoints[p].y + stackOffsetY);
            }
            ctx.stroke();

            // Dark inner slider track
            ctx.strokeStyle = '#0E0F14';
            ctx.lineWidth = R * 1.5;
            ctx.globalAlpha = bodyAlpha * 0.85;
            ctx.stroke();
            ctx.restore();
          }
        }

        // 4. Reverse Arrows (osu! source: reverse arrows are NOT affected by hidden!)
        if (totalSpans > 1 && currentTimeMs < sliderEnd + 260 && rawPoints.length >= 2) {
          const progress = currentTimeMs >= sliderStart ? (currentTimeMs - sliderStart) / sliderDuration : 0;
          const currentSpan = Math.floor(progress * totalSpans);

          // Render active unhit reverse arrow
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

            this.renderReverseArrowArc(ctx, arrowX, arrowY, R, tangentAngle, comboColor, 1.0, arrowAlpha);
          }

          // Reverse Arrow Hit Animations: the reverse arrow itself plays the hit animation, scaling from slider end center
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

              this.renderReverseArrowArc(ctx, anchorX, anchorY, R, tangentAngle, comboColor, hitScale, hitAlpha);
            }
          }
        }

        // 5. Slider Head Circle (osu! source: slider head circle hides FIRST under hidden!)
        const headX = obj.stackedX;
        const headY = obj.stackedY;
        const headDiff = sliderStart - currentTimeMs;

        let headAlpha = 1.0;
        if (this.isHD) {
          if (currentTimeMs < fadeOutStartTime) {
            headAlpha = Math.min(1.0, Math.max(0.0, (currentTimeMs - (sliderStart - this.preemptMs)) / timeFadeIn));
          } else {
            // Head circle fades out quickly over 0.3 * preempt and is gone long before sliderStart
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
          this.renderCirclePiece(ctx, headX, headY, R, comboColor, obj.comboIndex || 1, headDiff, headAlpha, isMiss, showHeadApproach);
        }

        // 6. Active Slider Ball & Follow Circle (Renders NORMALLY with full opacity!)
        if (currentTimeMs >= sliderStart && currentTimeMs <= sliderEnd) {
          const progress = (currentTimeMs - sliderStart) / sliderDuration;
          const currentSpan = Math.floor(progress * totalSpans);
          const spanProgress = (progress * totalSpans) % 1;
          const ballProgress = (currentSpan % 2 === 1) ? (1.0 - spanProgress) : spanProgress;

          const ballPos = this.getPointAtProgress(rawPoints, ballProgress);
          const bx = ballPos.x + stackOffsetX;
          const by = ballPos.y + stackOffsetY;

          ctx.save();
          ctx.globalAlpha = 1.0;

          // Follow circle ring
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(bx, by, R * 2.4, 0, Math.PI * 2);
          ctx.stroke();

          // Ball inner dark disc
          ctx.fillStyle = '#12151D';
          ctx.beginPath();
          ctx.arc(bx, by, R * 0.85, 0, Math.PI * 2);
          ctx.fill();

          // Ball outer colored ring
          ctx.strokeStyle = comboColor;
          ctx.lineWidth = 3.0;
          ctx.stroke();

          // Ball white center pip
          ctx.fillStyle = '#FFFFFF';
          ctx.beginPath();
          ctx.arc(bx, by, 4.0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        continue;
      }

      // -------------------------------------------------------------
      // 3. HIT CIRCLES
      // -------------------------------------------------------------
      const timeDiff = obj.time - currentTimeMs;
      if (timeDiff > -240 * this.playbackRate && timeDiff <= this.preemptMs) {
        const x = obj.stackedX;
        const y = obj.stackedY;

        let alpha = 0.0;
        if (timeDiff > 0) {
          const age = this.preemptMs - timeDiff; // ms since appearance
          if (this.isHD) {
            // osu! OsuModHidden rules:
            // TimeFadeIn = TimePreempt * 0.4
            // FadeOutDuration = TimePreempt * 0.3
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
            // Standard osu! rules:
            // TimeFadeIn = 400 * Math.min(1.0, TimePreempt / 450)
            const fadeIn = 400 * Math.min(1.0, this.preemptMs / 450);
            alpha = Math.min(1.0, Math.max(0.0, age / fadeIn));
          }
        }

        ctx.save();
        const showApproachCircle = !this.isHD || (i === firstNoteIdx);
        this.renderCirclePiece(ctx, x, y, R, comboColor, obj.comboIndex || 1, timeDiff, alpha, isMiss, showApproachCircle);
        ctx.restore();
      }
    }
  }

  /**
   * Renders a hit circle piece.
   * @param showApproachCircle — false for HD (hidden) objects; also respects TC
   */
  private renderCirclePiece(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    R: number,
    comboColor: string,
    comboIndex: number,
    timeDiff: number,
    baseAlpha: number,
    isMiss: boolean = false,
    showApproachCircle: boolean = true
  ): void {
    if (timeDiff <= 0) {
      // In osu!, hit animations (hit explosion / miss fade) are not played when Hidden mod is active
      if (this.isHD) {
        return;
      }

      // Scale elapsed time by playbackRate so hit animations play at original real-time visual speed
      const visualElapsed = (-timeDiff) / this.playbackRate;

      if (isMiss) {
        // On miss: circle fades out over 100ms
        if (visualElapsed <= 100) {
          const missAlpha = Math.max(0, 1.0 - visualElapsed / 100);
          ctx.save();
          ctx.globalAlpha = missAlpha * 0.35;
          ctx.fillStyle = '#101217';
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1, R), 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = '#ED1121';
          ctx.lineWidth = 2.0;
          ctx.stroke();
          ctx.restore();
        }
        return;
      }

      // Hit: render hit explosion
      this.renderHitExplosion(ctx, x, y, R, comboColor, visualElapsed, 1.0);

      // In osu!, combo number / flash fades out within 40ms of the hit
      if (visualElapsed < 40) {
        ctx.save();
        const numAlpha = Math.max(0, 1.0 - (visualElapsed / 40));
        ctx.globalAlpha = numAlpha;
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 15px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(comboIndex), x, y);
        ctx.restore();
      }
      return;
    }

    // Normal Approaching Circle
    if (baseAlpha <= 0.001 && !showApproachCircle) {
      return;
    }

    // TC (Traceable): hitcircle body is hidden; only approach circle is drawn
    if (!this.isTC && baseAlpha > 0.001) {
      ctx.save();
      // Base dark disc
      ctx.fillStyle = '#101217';
      ctx.globalAlpha = Math.max(0.01, baseAlpha);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, R), 0, Math.PI * 2);
      ctx.fill();

      // Combo color tint overlay
      ctx.fillStyle = comboColor;
      ctx.globalAlpha = baseAlpha * 0.25;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, R), 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = baseAlpha;

      // Colored perimeter ring
      ctx.strokeStyle = comboColor;
      ctx.lineWidth = 2.8;
      ctx.stroke();

      // Subtle white inner ring for depth
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, R - 1.5), 0, Math.PI * 2);
      ctx.stroke();

      // Combo number in center
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 15px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(comboIndex), x, y);
      ctx.restore();
    }

    // Approach circle (contracts from 3.0 R down to 1.0 R)
    if (showApproachCircle) {
      const approachProgress = Math.max(0, timeDiff / this.preemptMs);
      const approachRadius = Math.max(1, R + (R * 2.0 * approachProgress));
      const approachAlpha = Math.min(0.9, (this.preemptMs - timeDiff) / Math.min(this.preemptMs, 300));

      ctx.save();
      ctx.globalAlpha = approachAlpha;
      ctx.strokeStyle = comboColor;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(x, y, approachRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private renderHitExplosion(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    R: number,
    comboColor: string,
    elapsed: number,
    baseAlpha: number = 1.0
  ): void {
    if (this.isHD || elapsed < 0 || elapsed > 240) return;
    const progress = elapsed / 240;
    const easeOut = 1.0 - Math.pow(1.0 - progress, 2);
    const scale = 1.0 + 0.45 * easeOut;
    const alpha = Math.max(0, (1.0 - progress) * baseAlpha);

    ctx.save();
    ctx.globalAlpha = Math.max(0.01, alpha);

    // Expanding white ring
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, R * (1.0 + 0.5 * easeOut)), 0, Math.PI * 2);
    ctx.stroke();

    // Combo color explosion
    ctx.fillStyle = comboColor;
    ctx.globalAlpha = alpha * 0.35;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, R * scale), 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = comboColor;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = alpha;
    ctx.stroke();

    ctx.restore();
  }

  private getPathPoints(obj: any): Array<{ x: number; y: number }> {
    if (obj.curvePoints && obj.curvePoints.length > 0) return obj.curvePoints;
    return [{ x: obj.x, y: obj.y }, obj.sliderEnd || { x: obj.x, y: obj.y }];
  }

  private getPointAtProgress(points: Array<{ x: number; y: number }>, progress: number): { x: number; y: number } {
    if (points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1 || progress <= 0) return points[0];
    if (progress >= 1) return points[points.length - 1];

    let totalDist = 0;
    const dists: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      totalDist += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      dists.push(totalDist);
    }
    if (totalDist === 0) return points[0];

    const targetDist = progress * totalDist;
    for (let i = 0; i < dists.length - 1; i++) {
      if (targetDist <= dists[i + 1]) {
        const segLen = dists[i + 1] - dists[i];
        const segFrac = segLen > 0 ? (targetDist - dists[i]) / segLen : 0;
        return {
          x: points[i].x + (points[i + 1].x - points[i].x) * segFrac,
          y: points[i].y + (points[i + 1].y - points[i].y) * segFrac
        };
      }
    }
    return points[points.length - 1];
  }

  private slicePath(
    points: Array<{ x: number; y: number }>,
    startFrac: number,
    endFrac: number
  ): Array<{ x: number; y: number }> {
    if (points.length <= 1) return points;
    const start = Math.max(0, Math.min(1, startFrac));
    const end = Math.max(start, Math.min(1, endFrac));
    if (start === 0 && end === 1) return points;

    let totalDist = 0;
    const dists: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      totalDist += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      dists.push(totalDist);
    }
    if (totalDist === 0) return points;

    const startDist = start * totalDist;
    const endDist = end * totalDist;

    const sliced: Array<{ x: number; y: number }> = [this.getPointAtProgress(points, start)];

    for (let i = 1; i < points.length - 1; i++) {
      if (dists[i] > startDist && dists[i] < endDist) {
        sliced.push(points[i]);
      }
    }

    sliced.push(this.getPointAtProgress(points, end));
    return sliced;
  }

  private renderReverseArrowArc(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    tangentAngle: number,
    comboColor: string,
    scale: number = 1.0,
    alpha: number = 1.0
  ): void {
    if (alpha <= 0.001) return;

    ctx.save();

    // Scale centered at slider end anchor (cx, cy)
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

    const arcRadius = R * 1.25;
    const spread = 0.95;

    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, tangentAngle - spread, tangentAngle + spread);
    ctx.strokeStyle = comboColor;
    ctx.lineWidth = 4.5;
    ctx.globalAlpha = 0.4 * alpha;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.95 * alpha;
    ctx.stroke();

    const apexDist = arcRadius + 1.0;
    const apexX = cx + Math.cos(tangentAngle) * apexDist;
    const apexY = cy + Math.sin(tangentAngle) * apexDist;
    const reverseAngle = tangentAngle + Math.PI;

    const arrowLen = 9;
    const arrowWidth = 7;
    const tipX = apexX + Math.cos(reverseAngle) * arrowLen;
    const tipY = apexY + Math.sin(reverseAngle) * arrowLen;
    const leftX = apexX + Math.cos(tangentAngle + Math.PI / 2) * arrowWidth;
    const leftY = apexY + Math.sin(tangentAngle + Math.PI / 2) * arrowWidth;
    const rightX = apexX + Math.cos(tangentAngle - Math.PI / 2) * arrowWidth;
    const rightY = apexY + Math.sin(tangentAngle - Math.PI / 2) * arrowWidth;

    ctx.fillStyle = '#FFFFFF';
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(leftX, leftY);
    ctx.lineTo(apexX + Math.cos(reverseAngle) * 3, apexY + Math.sin(reverseAngle) * 3);
    ctx.lineTo(rightX, rightY);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  private initCursorTextures(): void {
    const cImg = new Image();
    cImg.src = cursorImgUrl;
    cImg.onload = () => {
      this.cursorImg = cImg;
      this.render(this.lastRenderTime);
    };

    const tImg = new Image();
    tImg.src = cursorTrailImgUrl;
    tImg.onload = () => {
      this.cursorTrailImg = tImg;
      this.render(this.lastRenderTime);
    };
  }

  private initCursorSprites(): void {
    // 1. Pre-render soft white trail sprite fallback (cursortrail.png)
    const tCanvas = document.createElement('canvas');
    tCanvas.width = 32;
    tCanvas.height = 32;
    const tCtx = tCanvas.getContext('2d');
    if (tCtx) {
      const grad = tCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
      grad.addColorStop(0.28, 'rgba(255, 255, 255, 0.75)');
      grad.addColorStop(0.65, 'rgba(255, 255, 255, 0.25)');
      grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
      tCtx.fillStyle = grad;
      tCtx.beginPath();
      tCtx.arc(16, 16, 16, 0, Math.PI * 2);
      tCtx.fill();
    }
    this.trailSprite = tCanvas;

    // 2. Pre-render soft glowing emerald cursor fallback (cursor.png)
    const cCanvas = document.createElement('canvas');
    cCanvas.width = 64;
    cCanvas.height = 64;
    const cCtx = cCanvas.getContext('2d');
    if (cCtx) {
      // Outer subtle ambient glow halo
      const glowGrad = cCtx.createRadialGradient(32, 32, 8, 32, 32, 26);
      glowGrad.addColorStop(0, 'rgba(0, 240, 150, 0.35)');
      glowGrad.addColorStop(0.55, 'rgba(0, 229, 153, 0.15)');
      glowGrad.addColorStop(1.0, 'rgba(0, 229, 153, 0.0)');
      cCtx.fillStyle = glowGrad;
      cCtx.beginPath();
      cCtx.arc(32, 32, 26, 0, Math.PI * 2);
      cCtx.fill();

      // Main soft emerald body
      const bodyGrad = cCtx.createRadialGradient(30, 30, 0, 32, 32, 14);
      bodyGrad.addColorStop(0, '#38FFB8');
      bodyGrad.addColorStop(0.35, '#00E599');
      bodyGrad.addColorStop(0.75, '#00B86C');
      bodyGrad.addColorStop(0.90, 'rgba(0, 184, 108, 0.85)');
      bodyGrad.addColorStop(1.0, 'rgba(0, 200, 120, 0.0)');
      cCtx.fillStyle = bodyGrad;
      cCtx.beginPath();
      cCtx.arc(32, 32, 14, 0, Math.PI * 2);
      cCtx.fill();
    }
    this.cursorSprite = cCanvas;
  }

  private renderCursorTrail(ctx: CanvasRenderingContext2D, currentTimeMs: number): void {
    if (!this.replay) return;
    const trailImg = (this.cursorTrailImg && this.cursorTrailImg.complete) ? this.cursorTrailImg : this.trailSprite;
    if (!trailImg) return;

    const frames = this.replay.frames;
    if (frames.length === 0) return;

    // Normal responsive legacy trail duration in 90% osu skins: ~120ms
    const trailDuration = 120;
    const startTime = currentTimeMs - trailDuration;

    // Binary search for first frame >= startTime
    let left = 0;
    let right = frames.length - 1;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (frames[mid].time < startTime) left = mid + 1;
      else right = mid;
    }
    const startIndex = Math.max(0, left - 1);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const step = 4; // osu coordinates step for smooth interpolation

    for (let i = startIndex; i < frames.length; i++) {
      const f1 = frames[i];
      if (f1.time > currentTimeMs) break;

      const f0 = i > 0 ? frames[i - 1] : f1;
      // Skip gaps or large pauses
      if (f1.time - f0.time > 250) continue;

      const dx = f1.x - f0.x;
      const dy = f1.y - f0.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.floor(dist / step));

      for (let s = 1; s <= steps; s++) {
        const ratio = s / steps;
        const ptTime = f0.time + (f1.time - f0.time) * ratio;
        if (ptTime < startTime || ptTime > currentTimeMs) continue;

        const age = currentTimeMs - ptTime;
        const progress = age / trailDuration; // 0 (current) to 1 (tail)
        const alpha = Math.pow(1.0 - progress, 1.3) * 0.75;
        // Standard legacy scale: 80x80 @2x sprite -> 40px at 1x playfield scale, gently tapering
        const size = 38 * (1.0 - progress * 0.32);
        const half = size / 2;

        const px = f0.x + dx * ratio;
        const py = f0.y + dy * ratio;

        ctx.globalAlpha = alpha;
        ctx.drawImage(trailImg, px - half, py - half, size, size);
      }
    }

    ctx.restore();
  }

  /**
   * Renders a thin, long-lived cursor trajectory trail similar to default
   * osu! skin cursor trails. Instead of the short ~120ms additive blob of
   * renderCursorTrail, this keeps a crisp polyline of the cursor path over a
   * much longer window so movement through the whole approach (and any
   * evaluator telemetry mismatches) remains inspectable.
   */
  private renderPathTrail(ctx: CanvasRenderingContext2D, currentTimeMs: number): void {
    if (!this.replay) return;
    const frames = this.replay.frames;
    if (frames.length === 0) return;

    const trailDuration = this.pathTrailDurationMs;
    const startTime = currentTimeMs - trailDuration;

    // Binary search for first frame >= startTime
    let left = 0;
    let right = frames.length - 1;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (frames[mid].time < startTime) left = mid + 1;
      else right = mid;
    }
    const startIndex = Math.max(0, left - 1);

    // Collect interpolated path samples inside the observation window,
    // newest point last (oldest -> newest chronological order)
    const points: Array<{ x: number; y: number; age: number }> = [];
    const step = 4; // osu coordinates step for smooth interpolation

    for (let i = startIndex; i < frames.length; i++) {
      const f1 = frames[i];
      if (f1.time > currentTimeMs) break;

      const f0 = i > 0 ? frames[i - 1] : f1;
      // Skip gaps or large pauses
      if (f1.time - f0.time > 250) continue;

      const dx = f1.x - f0.x;
      const dy = f1.y - f0.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.floor(dist / step));

      for (let s = 1; s <= steps; s++) {
        const ratio = s / steps;
        const ptTime = f0.time + (f1.time - f0.time) * ratio;
        if (ptTime < startTime || ptTime > currentTimeMs) continue;
        points.push({
          x: f0.x + dx * ratio,
          y: f0.y + dy * ratio,
          age: currentTimeMs - ptTime
        });
      }
    }

    if (points.length < 2) return;

    // Layered passes from tail to head build up a smooth comet fade without
    // per-segment alpha state churn. The trail is thin (few px) yet spans the
    // whole window, so overlapping fast motions stay readable.
    const passes: Array<{ maxAgeFrac: number; color: string; width: number; alpha: number }> = [
{ maxAgeFrac: 1.0, color: 'rgba(0, 229, 153, 1)', width: 5.5, alpha: 0.10 },  // soft outer glow, full tail
      { maxAgeFrac: 0.7, color: 'rgba(56, 255, 184, 1)', width: 3.2, alpha: 0.26 }, // mid emerald ribbon
      { maxAgeFrac: 0.35, color: 'rgba(200, 255, 232, 1)', width: 2.3, alpha: 0.55 }, // core path
      { maxAgeFrac: 0.12, color: '#FFFFFF', width: 3.4, alpha: 0.9 }                  // bright head near cursor
    ];

    const lastIdx = points.length - 1;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const pass of passes) {
      const maxAge = pass.maxAgeFrac * trailDuration;
      // Points are chronological; age grows towards the tail. Contract the
      // budget backwards from the newest point while older neighbours qualify.
      let from = lastIdx;
      while (from > 0 && points[from - 1].age <= maxAge) from--;
      if (lastIdx - from < 1) continue;

      ctx.strokeStyle = pass.color;
      ctx.lineWidth = pass.width;
      ctx.globalAlpha = pass.alpha;
      ctx.beginPath();
      ctx.moveTo(points[from].x, points[from].y);
      for (let i = from + 1; i <= lastIdx; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  private renderActiveCursor(ctx: CanvasRenderingContext2D, currentTimeMs: number): void {
    if (!this.replay) return;
    const frames = this.replay.frames;
    if (frames.length === 0) return;

    const inSkipGap = this.replay.skipGaps?.some(g => currentTimeMs >= g.from && currentTimeMs < g.to);
    if (inSkipGap) return;

    let left = 0;
    let right = frames.length - 1;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (frames[mid].time < currentTimeMs) left = mid + 1;
      else right = mid;
    }

    const curFrame = frames[left] || frames[0];
    const cx = curFrame.x;
    const cy = curFrame.y;

    // Active hitmarkers & incident vectors
    if (this.showErrorVectors) {
      const activeHits = this.hitEvents.filter(e => {
        const visualAge = (currentTimeMs - e.targetTime) / this.playbackRate;
        return visualAge >= -30 && visualAge <= 700;
      });

    for (let i = 0; i < activeHits.length; i++) {
      const hit = activeHits[i];
      const age = (currentTimeMs - hit.targetTime) / this.playbackRate;

      let alpha = 1.0;
      if (age < 0) {
        alpha = Math.max(0.2, 1 + age / 30);
      } else if (age <= 500) {
        alpha = 1.0;
      } else {
        alpha = Math.max(0, 1.0 - (age - 500) / 200);
      }

      const isDesync = hit.desyncType === DesyncType.EarlyTap || hit.desyncType === DesyncType.LateTap || hit.desyncType === DesyncType.SpeedMiss;
      const isMiss = hit.judgement === HitJudgement.Miss;

      let col = '#4AA4FF';
      if (isDesync) col = '#B87BFF';
      else if (isMiss) col = '#ED1121';
      else if (hit.judgement === HitJudgement.Ok) col = '#74D128';
      else if (hit.judgement === HitJudgement.Meh) col = '#FFCC22';

      const hasTapAttribution = hit.key !== 'NONE';

      ctx.save();
      ctx.globalAlpha = alpha;

      if (hasTapAttribution) {
        // Draw dashed error vector from tap position to note centre
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.0;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(hit.tapX, hit.tapY);
        ctx.lineTo(hit.targetX, hit.targetY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Tap cursor dot
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(hit.tapX, hit.tapY, 4.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.arc(hit.tapX, hit.tapY, 5.5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // No tap attributed — draw a small X at note centre so it's clear this
        // is a pure aim/timing miss with no cursor evidence to display
        const xSize = 5;
        const nx = hit.targetX;
        const ny = hit.targetY;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(nx - xSize, ny - xSize);
        ctx.lineTo(nx + xSize, ny + xSize);
        ctx.moveTo(nx + xSize, ny - xSize);
        ctx.lineTo(nx - xSize, ny + xSize);
        ctx.stroke();
      }

      if (age >= -30 && age <= 150) {
        let tooltipAlpha = 1.0;
        if (age < 0) {
          tooltipAlpha = Math.max(0.2, 1 + age / 30);
        } else {
          tooltipAlpha = Math.max(0, 1.0 - (age / 150));
        }

        ctx.save();
        ctx.globalAlpha = alpha * tooltipAlpha;

        const isTap = hit.key !== 'NONE';
        let label: string;
        if (isDesync) {
          const desyncName = hit.desyncType === DesyncType.EarlyTap ? 'EARLY TAP'
            : hit.desyncType === DesyncType.LateTap ? 'LATE TAP'
            : 'CURSOR DESYNC';
          label = isTap
            ? `${desyncName}: ${hit.timeOffset > 0 ? '+' : ''}${hit.timeOffset.toFixed(0)}ms (Δ ${hit.distanceToCenter.toFixed(1)}px)`
            : `${desyncName}: No tap`;
        } else if (isMiss) {
          label = hit.desyncType === DesyncType.MisaimInWindow
            ? `MISAIM (Δ ${hit.distanceToCenter.toFixed(1)}px)`
            : `MISS (Δ ${hit.distanceToCenter.toFixed(1)}px)`;
        } else {
          label = `${hit.judgement} (${hit.timeOffset > 0 ? '+' : ''}${hit.timeOffset.toFixed(0)}ms, Δ ${hit.distanceToCenter.toFixed(1)}px)`;
        }

        ctx.font = 'bold 10px -apple-system, sans-serif';
        const textWidth = ctx.measureText(label).width;
        const boxW = textWidth + 14;
        const boxH = 20;
        // Tooltip anchored to tap position (or note centre for no-tap misses)
        const tooltipAnchorX = hasTapAttribution ? hit.tapX : hit.targetX;
        const tooltipAnchorY = hasTapAttribution ? hit.tapY : hit.targetY;
        const boxX = Math.max(4, Math.min(512 - boxW - 4, tooltipAnchorX - boxW / 2));
        const boxY = Math.max(4, tooltipAnchorY - 26);

        ctx.fillStyle = 'rgba(14, 16, 22, 0.92)';
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(boxX, boxY, boxW, boxH, 4);
        } else {
          ctx.rect(boxX, boxY, boxW, boxH);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, boxX + boxW / 2, boxY + boxH / 2);

        ctx.restore();
      }

      ctx.restore();
    }
  }

    // Draw active cursor: skin texture from @src/assets/skin/cursor@2x.png (no grow on click)
    const cursorImg = (this.cursorImg && this.cursorImg.complete) ? this.cursorImg : this.cursorSprite;
    if (cursorImg) {
      ctx.save();
      // 240x240 @2x sprite -> 120x120 at 1x playfield scale (exact 0.5x ratio)
      const size = 120;
      const half = size / 2;
      ctx.drawImage(cursorImg, cx - half, cy - half, size, size);
      ctx.restore();
    }
  }

  /**
   * Renders the Flashlight mod vignette in screen-space coordinates.
   * The "torch" follows the cursor position transformed into canvas space.
   */
  private renderFlashlight(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    currentTimeMs: number,
    offsetX: number,
    offsetY: number,
    scale: number
  ): void {
    if (!this.replay) return;
    const frames = this.replay.frames;
    if (frames.length === 0) return;

    // Find cursor position
    let left = 0;
    let right = frames.length - 1;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (frames[mid].time < currentTimeMs) left = mid + 1;
      else right = mid;
    }
    const curFrame = frames[left] || frames[0];

    // Transform cursor from osu! 512x384 space to canvas pixels
    const cursorScreenX = offsetX + curFrame.x * scale;
    const cursorScreenY = offsetY + curFrame.y * scale;

    // Flashlight radius: standard FL is ~220px in 512-space; scale to canvas
    const flRadiusPx = 220 * scale;

    // Radial gradient: bright in center, dark at edges
    const grad = ctx.createRadialGradient(cursorScreenX, cursorScreenY, 0, cursorScreenX, cursorScreenY, flRadiusPx);
    grad.addColorStop(0.0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0)');
    grad.addColorStop(0.75, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0.97)');

    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Hard black border outside torch
    ctx.fillStyle = 'rgba(0,0,0,0.97)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.arc(cursorScreenX, cursorScreenY, flRadiusPx * 1.05, 0, Math.PI * 2, true); // subtract circle
    ctx.fill('evenodd');

    ctx.restore();
  }

  /**
   * Renders the authentic osu!lazer centered break section overlay.
   * Features inward chevrons, numeric remaining seconds countdown,
   * and a symmetric shrinking white progress bar.
   */
  private renderBreakTimer(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    currentTimeMs: number
  ): void {
    const activeBreak = this.breakSections.find(b => currentTimeMs >= b.start && currentTimeMs <= b.end);
    if (!activeBreak) return;

    const duration = Math.max(1, activeBreak.end - activeBreak.start);
    const elapsed = currentTimeMs - activeBreak.start;
    const remaining = Math.max(0, activeBreak.end - currentTimeMs);

    // Smooth fade in / out (350ms window)
    const fadeIn = Math.min(1.0, elapsed / 350);
    const fadeOut = Math.min(1.0, remaining / 350);
    const alpha = Math.max(0, Math.min(1.0, Math.min(fadeIn, fadeOut)));
    if (alpha <= 0.01) return;

    const cx = w / 2;
    const cy = h / 2;

    const maxBarW = Math.min(260, w * 0.4);
    const progressRatio = Math.max(0, Math.min(1.0, remaining / duration));
    const curBarW = maxBarW * progressRatio;
    const barH = 6;

    ctx.save();
    ctx.globalAlpha = alpha;

    // 1. Large numeric countdown above center (e.g. 3, 2, 1)
    const secondsRemaining = Math.ceil(remaining / 1000);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 36px "Torus", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(secondsRemaining), cx, cy - 14);

    // 2. Center Progress Bar:
    // Translucent background track
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    const trackX = cx - maxBarW / 2;
    const barY = cy - barH / 2;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(trackX, barY, maxBarW, barH, barH / 2);
      ctx.fill();
    } else {
      ctx.fillRect(trackX, barY, maxBarW, barH);
    }

    // White active progress bar (shrinks symmetrically towards the center)
    if (curBarW > 1) {
      ctx.fillStyle = '#FFFFFF';
      const curBarX = cx - curBarW / 2;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(curBarX, barY, curBarW, barH, barH / 2);
        ctx.fill();
      } else {
        ctx.fillRect(curBarX, barY, curBarW, barH);
      }
    }

    // 3. Crisp inward chevrons on sides (NO glow, clean crisp lines)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Left chevron pointing right (>)
    const leftX = cx - maxBarW / 2 - 28;
    ctx.beginPath();
    ctx.moveTo(leftX - 6, cy - 9);
    ctx.lineTo(leftX + 4, cy);
    ctx.lineTo(leftX - 6, cy + 9);
    ctx.stroke();

    // Right chevron pointing left (<)
    const rightX = cx + maxBarW / 2 + 28;
    ctx.beginPath();
    ctx.moveTo(rightX + 6, cy - 9);
    ctx.lineTo(rightX - 4, cy);
    ctx.lineTo(rightX + 6, cy + 9);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Calculates real-time telemetry (SPM, total rotations, angle, tracking state)
   * from replay cursor frames during a spinner.
   */
  private getSpinnerTelemetry(
    spinnerStart: number,
    currentTimeMs: number,
    spinsRequired: number = 0
  ): { spm: number; totalRotations: number; rotationAngle: number; isTracking: boolean; clearTimeMs: number } {
    if (!this.replay || !this.replay.frames || this.replay.frames.length === 0 || currentTimeMs < spinnerStart) {
      return { spm: 0, totalRotations: 0, rotationAngle: 0, isTracking: false, clearTimeMs: -1 };
    }

    const frames = this.replay.frames;
    const cx = 256;
    const cy = 192;

    // Binary search for first frame >= spinnerStart
    let l = 0;
    let r = frames.length - 1;
    while (l < r) {
      const m = Math.floor((l + r) / 2);
      if (frames[m].time < spinnerStart) l = m + 1;
      else r = m;
    }
    const startIdx = l;

    // Binary search for last frame <= currentTimeMs
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

    // Cumulative rotation from start to current
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

    // Instantaneous SPM over recent 500ms sliding window
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

  /**
   * Evaluates the smoothly faded judgement color for spinner progress matching the top bar:
   * Miss (--red-1: #ff6666) -> 50 (--orange-1: #ebc247) -> 100 (--lime-2: #99eb47) -> 300 (--blue-1: #66ccff)
   */
  private getSpinnerProgressColor(progress: number): string {
    const COLOR_MISS: [number, number, number] = [255, 102, 102]; // #ff6666 (--red-1)
    const COLOR_50:   [number, number, number] = [235, 194, 71];  // #ebc247 (--orange-1)
    const COLOR_100:  [number, number, number] = [153, 235, 71];  // #99eb47 (--lime-2)
    const COLOR_300:  [number, number, number] = [102, 204, 255]; // #66ccff (--blue-1)

    if (progress < 0.72) {
      return '#ff6666';
    }
    if (progress < 0.78) {
      const t = (progress - 0.72) / 0.06;
      const r = Math.round(COLOR_MISS[0] + (COLOR_50[0] - COLOR_MISS[0]) * t);
      const g = Math.round(COLOR_MISS[1] + (COLOR_50[1] - COLOR_MISS[1]) * t);
      const b = Math.round(COLOR_MISS[2] + (COLOR_50[2] - COLOR_MISS[2]) * t);
      return `rgb(${r}, ${g}, ${b})`;
    }
    if (progress < 0.87) {
      return '#ebc247';
    }
    if (progress < 0.93) {
      const t = (progress - 0.87) / 0.06;
      const r = Math.round(COLOR_50[0] + (COLOR_100[0] - COLOR_50[0]) * t);
      const g = Math.round(COLOR_50[1] + (COLOR_100[1] - COLOR_50[1]) * t);
      const b = Math.round(COLOR_50[2] + (COLOR_100[2] - COLOR_50[2]) * t);
      return `rgb(${r}, ${g}, ${b})`;
    }
    if (progress < 0.97) {
      return '#99eb47';
    }
    if (progress < 1.03) {
      const t = (progress - 0.97) / 0.06;
      const r = Math.round(COLOR_100[0] + (COLOR_300[0] - COLOR_100[0]) * t);
      const g = Math.round(COLOR_100[1] + (COLOR_300[1] - COLOR_100[1]) * t);
      const b = Math.round(COLOR_100[2] + (COLOR_300[2] - COLOR_100[2]) * t);
      return `rgb(${r}, ${g}, ${b})`;
    }
    return '#66ccff';
  }

  /**
   * Renders a HitObject Spinner matching the modern osu!lazer Argon skin design:
   * - Pink expanding ring indicates the duration of the spinner as a whole (time elapsed vs total duration)
   * - Side progress indicators are anchored at the center of their line arcs:
   *   while spinning, they expand outward from the center; once cleared, they shrink in length
   *   anchored at the center at the exact same speed as the white ring expands to the edges,
   *   fading out at the end.
   * - Outer white ring expands from 0.31 to 0.50 upon clearing to seal into a glowing complete circle.
   * - osu!lazer standardized bonus scoring: displays +50 per full bonus spin at top (Image 2), up to MAX.
   * - Concentric hub with white outer and pink inner rings; 25 turbine tick marks.
   */
  private renderArgonSpinner(
    ctx: CanvasRenderingContext2D,
    obj: any,
    currentTimeMs: number,
    comboColor: string
  ): void {
    const spinnerStart = obj.time;
    const spinnerEnd = obj.endTime;
    const duration = Math.max(1, spinnerEnd - spinnerStart);

    if (currentTimeMs < spinnerStart - this.preemptMs || currentTimeMs > spinnerEnd + 260) {
      return;
    }

    // Dynamic spins required calculation matching osu!lazer Spinner.cs
    const od = this.effectiveOD;
    const minRpm = od < 5 ? 90 + (150 - 90) * (od / 5) : 150 + (225 - 150) * ((od - 5) / 5);
    const maxRpm = od < 5 ? 250 + (380 - 250) * (od / 5) : 380 + (430 - 380) * ((od - 5) / 5);
    const secondsDuration = duration / 1000;
    const spinsRequired = Math.max(1, Math.floor((minRpm / 60) * secondsDuration + 0.0001));
    const bonusSpinsGap = 2;
    const spinsRequiredForBonus = spinsRequired + bonusSpinsGap;
    const maximumBonusSpins = Math.max(0, Math.floor((maxRpm / 60) * secondsDuration + 0.0001) - spinsRequired - bonusSpinsGap);
    const bonusStep = 50; // osu!lazer standardized bonus step (+50 score per full bonus spin)

    // Spinner telemetry from replay cursor
    const telemetry = this.getSpinnerTelemetry(spinnerStart, currentTimeMs, spinsRequired);

    // Calculate rotation count and progress towards 300 / 100 / 50
    const totalRotations = this.replay?.frames?.length
      ? Math.abs(telemetry.rotationAngle) / (Math.PI * 2)
      : (currentTimeMs >= spinnerStart ? spinsRequired * Math.min(1.0, (currentTimeMs - spinnerStart) / duration) : 0);

    // Progress towards clearing (1.0 = 300 / clear; 0.9 = 100; 0.75 = 50)
    const progress = spinsRequired > 0 ? totalRotations / spinsRequired : 1.0;
    const clampedProgress = Math.min(1.0, Math.max(0.0, progress));
    const isComplete = progress >= 1.0;

    // Smooth completion animation:
    // Rate of transition t from 0 to 1 over 220ms
    let clearTransition = 0.0;
    if (isComplete) {
      if (telemetry.clearTimeMs > 0) {
        clearTransition = Math.min(1.0, Math.max(0.0, (currentTimeMs - telemetry.clearTimeMs) / 220));
      } else {
        clearTransition = Math.min(1.0, Math.max(0.0, (progress - 1.0) * 3));
      }
    }

    // Dynamic bonus scoring (osu!lazer: +50 per full spin after spinsRequired + bonusSpinsGap)
    const completedFullSpins = Math.floor(totalRotations);
    const bonusSpins = Math.max(0, Math.min(maximumBonusSpins, completedFullSpins - spinsRequiredForBonus));
    const bonusScore = bonusSpins * bonusStep;
    const isMaxBonus = maximumBonusSpins > 0 && bonusSpins >= maximumBonusSpins;

    // Compute alpha and scale transforms matching ArgonSpinnerDisc.cs
    let alpha = 1.0;
    let discScale = 1.0;

    if (currentTimeMs < spinnerStart) {
      const fadeElapsed = currentTimeMs - (spinnerStart - this.preemptMs);
      const fadeInDuration = this.preemptMs * 0.4;
      alpha = Math.max(0.01, Math.min(1.0, fadeElapsed / fadeInDuration));

      // Ease-out scale from 0 to 1 over preempt duration
      const preemptProgress = Math.max(0, Math.min(1.0, fadeElapsed / this.preemptMs));
      discScale = Math.min(1.0, Math.max(0.05, 1 - Math.pow(1 - preemptProgress, 3)));
    } else if (currentTimeMs > spinnerEnd) {
      const elapsed = currentTimeMs - spinnerEnd;
      alpha = Math.max(0.01, 1.0 - elapsed / 260);
      discScale = 1.0 + 0.15 * Math.min(1.0, elapsed / 260); // Pulse outwards on clear
    }

    const cx = 256;
    const cy = 192;
    const discR = 152 * discScale;

    ctx.save();
    ctx.globalAlpha = Math.min(1.0, alpha);

    // 1. Dark outer backdrop disc with subtle combo accent aura
    ctx.fillStyle = 'rgba(9, 11, 16, 0.90)';
    ctx.beginPath();
    ctx.arc(cx, cy, discR, 0, Math.PI * 2);
    ctx.fill();

    // Subtle combo perimeter aura
    ctx.strokeStyle = comboColor;
    ctx.lineWidth = 1.0;
    ctx.globalAlpha = Math.min(0.35, alpha * 0.35);
    ctx.stroke();
    ctx.globalAlpha = Math.min(1.0, alpha);

    // 2. Expanding radial fill disc (Argon pink/magenta #FC618F)
    // Represents duration of the spinner as a whole (time elapsed vs duration)
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

    // Perimeter boundary of the fill disc
    ctx.save();
    ctx.strokeStyle = '#FC618F';
    ctx.lineWidth = isComplete ? 2.5 * discScale : 1.8 * discScale;
    ctx.shadowColor = '#FC618F';
    ctx.shadowBlur = (isComplete ? 20 : 12) * discScale;
    ctx.stroke();
    ctx.restore();

    // 3. 25 Turbine Tick Marks Ring (ArgonSpinnerTicks.cs)
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
      // Slanted turbine angle matching Argon spinner design (Images 1 & 2)
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

    // 4. Smooth Outer Ring Expansion (ArgonSpinnerRingArc.cs)
    // Top & Bottom arcs expand from 0.31 to 0.50 of circle upon completion, meeting at left and right edges
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

    // Top Arc (centered at -PI / 2, 12 o'clock)
    ctx.beginPath();
    ctx.arc(cx, cy, discR, -Math.PI / 2 - arcSpan, -Math.PI / 2 + arcSpan);
    ctx.stroke();

    // Bottom Arc (centered at +PI / 2, 6 o'clock)
    ctx.beginPath();
    ctx.arc(cx, cy, discR, Math.PI / 2 - arcSpan, Math.PI / 2 + arcSpan);
    ctx.stroke();
    ctx.restore();

    // 5. Thicker Side Progress Arcs (ArgonSpinnerProgressArc.cs)
    // Anchored at the center of each arc (0 for right, PI for left).
    // While spinning: fills outward from center.
    // Upon clearing: shrinks in length anchored at the center at the exact same speed as the white ring expands,
    // while fading out at the end.
    const sideHalfSpan = 0.15 * Math.PI;
    const indicatorAlpha = Math.max(0.0, 1.0 - clearTransition);

    if (indicatorAlpha > 0.005) {
      ctx.save();
      ctx.globalAlpha = Math.min(1.0, alpha * indicatorAlpha);

      // Clean background track (no cyan aura/glow)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.lineWidth = 14 * discScale;
      ctx.lineCap = 'round';

      // Right track (centered at 0, 3 o'clock)
      ctx.beginPath();
      ctx.arc(cx, cy, discR, -sideHalfSpan, sideHalfSpan);
      ctx.stroke();

      // Left track (centered at PI, 9 o'clock)
      ctx.beginPath();
      ctx.arc(cx, cy, discR, Math.PI - sideHalfSpan, Math.PI + sideHalfSpan);
      ctx.stroke();

      // Smooth color fading between judgement thresholds: Miss (#ED1121) -> 50 (#FFCC22) -> 100 (#74D128) -> 300 (#4AA4FF)
      const progressColor = this.getSpinnerProgressColor(progress);

      // Active Progress Fill (anchored at the center of each line arc)
      const currentHalfSpan = isComplete
        ? sideHalfSpan * (1.0 - clearTransition)
        : sideHalfSpan * clampedProgress;

      if (currentHalfSpan > 0.005) {
        ctx.strokeStyle = progressColor;
        ctx.lineWidth = 9.5 * discScale;
        ctx.lineCap = 'round';

        // Right side fill (anchored symmetrically at 0)
        ctx.beginPath();
        ctx.arc(cx, cy, discR, -currentHalfSpan, currentHalfSpan);
        ctx.stroke();

        // Left side fill (anchored symmetrically at PI)
        ctx.beginPath();
        ctx.arc(cx, cy, discR, Math.PI - currentHalfSpan, Math.PI + currentHalfSpan);
        ctx.stroke();
      }

      ctx.restore();
    }

    // 6. Concentric dual-ring center hub (ArgonSpinnerDisc.cs)
    const hubR = (telemetry.isTracking ? 15 : 24) * discScale;

    // Dark core
    ctx.fillStyle = '#090B10';
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
    ctx.fill();

    // Outer white ring
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3.0 * discScale;
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
    ctx.stroke();

    // Inner pink ring
    ctx.strokeStyle = '#FC618F';
    ctx.lineWidth = 3.5 * discScale;
    ctx.beginPath();
    ctx.arc(cx, cy, hubR * 0.72, 0, Math.PI * 2);
    ctx.stroke();

    // 7. HUD Indicators (SPM & Top Status) with Smooth Fade-in
    const hudFade = Math.min(1.0, Math.max(0.0, (currentTimeMs - (spinnerStart - 80)) / 160));
    if (hudFade > 0.01) {
      ctx.save();
      ctx.globalAlpha = Math.min(1.0, alpha * hudFade);

      // Bottom SPM Counter (matching Images 1 & 2)
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold ${Math.round(28 * discScale)}px "Torus", "Inter", -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(telemetry.spm), cx, cy + 62 * discScale);

      // Subtitle "SPINS PER MINUTE"
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.font = `bold ${Math.round(9.5 * discScale)}px "Inter", -apple-system, sans-serif`;
      ctx.fillText('SPINS PER MINUTE', cx, cy + 80 * discScale);

      // Top Bonus Display (ArgonSpinner.cs)
      // Displays accumulating bonus score (+50 each) or MAX once cleared
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
          // Completed
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
}
