import { OsrReplay } from '../../core/types/replay.ts';
import { Beatmap } from '../../core/types/beatmap.ts';
import { EvaluationResult } from '../../core/evaluator/ReplayEvaluator.ts';
import { TimedHitEvent } from '../../core/types/telemetry.ts';
import { PerformanceBreakdown, DifficultyAttributes } from '../../core/math/PerformancePoints.ts';
import { LazerDifficultyAttributes, LazerPerformanceBreakdown } from '../../core/math/LazerDifficulty.ts';
import { calculateEffectiveDifficulty } from '../../core/math/HitWindows.ts';
import { calculateLazerAccuracy } from '../../core/math/RollingAccuracy.ts';
import { getDiffColor, getDiffTextColor } from '../../core/math/ColorHelper.ts';
import { buildPrefixCombo } from '../../core/math/ComboTracker.ts';
import { renderModBadges } from '../../ui/components/ModBadges.ts';
import { Odometer, ODO_ACC, ODO_COMBO, ODO_INT, ODO_PP, ODO_UR, type OdometerOptions } from '../../ui/components/Odometer.ts';

const BADGE_ICONS = import.meta.glob<string>('../../assets/icons/Badges/*.svg', { eager: true, import: 'default' });

export interface PrefixHitStat {
  time: number;
  c300: number;
  c100: number;
  c50: number;
  cMiss: number;
  combo: number;
  maxComboSoFar: number;
  acc: number;
  ticksHit: number;
  maxTicks: number;
  endsHit: number;
  maxEnds: number;
  ppStep: boolean;
  headIdx: number;
}

export class LiveStatsManager {
  private currentReplay: OsrReplay | null = null;
  private currentBeatmap: Beatmap | null = null;
  private currentEval: EvaluationResult | null = null;
  private maxPossiblePP: PerformanceBreakdown | null = null;
  private precomputedLivePP: LazerPerformanceBreakdown[] = [];
  private currentLazerDiff: LazerDifficultyAttributes | null = null;
  private currentDiffAttributes: DifficultyAttributes | null = null;
  private prefixStats: PrefixHitStat[] = [];

  private odometers = new Map<string, { odo: Odometer; el: HTMLElement }>();
  private odoMinInt = new Map<string, number>([['acc', 3], ['ur', 2]]);
  private lastLiveTime = 0;
  private lastLiveIdx = -1;

  private measureCtx: CanvasRenderingContext2D | null = null;
  private measureCtxReady = false;

  constructor() {
    if (typeof document !== 'undefined' && document.fonts) {
      void document.fonts.ready.then(() => {
        if (this.currentBeatmap) this.reserveHstatsWidths();
      });
    }
  }

  public setSession(
    beatmap: Beatmap | null,
    replay: OsrReplay | null,
    evalResult: EvaluationResult | null,
    maxPossiblePP: PerformanceBreakdown | null,
    precomputedLivePP: LazerPerformanceBreakdown[],
    lazerDiff: LazerDifficultyAttributes | null,
    diffAttributes: DifficultyAttributes | null,
    prefixStats?: PrefixHitStat[]
  ): void {
    this.currentBeatmap = beatmap;
    this.currentReplay = replay;
    this.currentEval = evalResult;
    this.maxPossiblePP = maxPossiblePP;
    this.precomputedLivePP = precomputedLivePP;
    this.currentLazerDiff = lazerDiff;
    this.currentDiffAttributes = diffAttributes;
    this.resetOdometers();
    this.lastLiveTime = 0;
    this.lastLiveIdx = -1;

    if (prefixStats) {
      this.prefixStats = prefixStats;
    } else if (evalResult && beatmap && replay) {
      this.buildPrefixStats(evalResult.hitEvents);
    } else {
      this.prefixStats = [];
    }
  }

  public getPrefixStats(): PrefixHitStat[] {
    return this.prefixStats;
  }

  public reset(): void {
    this.currentReplay = null;
    this.currentBeatmap = null;
    this.currentEval = null;
    this.maxPossiblePP = null;
    this.precomputedLivePP = [];
    this.currentLazerDiff = null;
    this.currentDiffAttributes = null;
    this.prefixStats = [];
    this.resetOdometers();
    this.lastLiveTime = 0;
    this.lastLiveIdx = -1;

    const rankTileReset = document.getElementById('meta-rank');
    if (rankTileReset) {
      rankTileReset.hidden = true;
      delete rankTileReset.dataset.currentRank;
      rankTileReset.innerHTML = '';
    }
    const srPillReset = document.getElementById('meta-sr-pill');
    if (srPillReset) srPillReset.hidden = true;
    const modsReset = document.getElementById('meta-mods-container');
    if (modsReset) {
      modsReset.innerHTML = '';
      modsReset.style.display = 'none';
    }
    const topTitle = document.getElementById('top-title');
    if (topTitle) topTitle.textContent = 'REPLAY ANALYZER';
    const topSubtitle = document.getElementById('top-subtitle');
    if (topSubtitle) topSubtitle.textContent = 'osu!standard • lazer ruleset';
  }

  private resetOdometers(): void {
    this.odometers.clear();
  }

  private odoSet(key: string, el: HTMLElement | null, value: number, opts: OdometerOptions, snap: boolean): void {
    if (!el) return;
    let entry = this.odometers.get(key);
    if (!entry || entry.el !== el) {
      entry = { odo: new Odometer(el, opts), el };
      this.odometers.set(key, entry);
    }
    const minInt = this.odoMinInt.get(key);
    if (minInt !== undefined) entry.odo.setMinIntDigits(minInt);
    entry.odo.set(value, snap);
  }

  public buildPrefixStats(events: TimedHitEvent[]): void {
    const comboStats = buildPrefixCombo(events, this.currentBeatmap, {
      ticksHit: this.currentReplay?.sliderTicks?.hit,
      ticksMax: this.currentReplay?.sliderTicks?.max,
      endsHit: this.currentReplay?.sliderEnds?.hit,
      endsMax: this.currentReplay?.sliderEnds?.max
    });
    this.prefixStats = comboStats.map((s) => ({
      time: s.time,
      c300: s.c300,
      c100: s.c100,
      c50: s.c50,
      cMiss: s.cMiss,
      combo: s.combo,
      maxComboSoFar: s.maxComboSoFar,
      acc: calculateLazerAccuracy(s.c300, s.c100, s.c50, s.cMiss, s.ticksHit, s.maxTicks, s.endsHit, s.maxEnds),
      ticksHit: s.ticksHit,
      maxTicks: s.maxTicks,
      endsHit: s.endsHit,
      maxEnds: s.maxEnds,
      ppStep: s.ppStep,
      headIdx: s.headIdx
    }));
  }

  public updateLiveStats(currentTimeMs: number): void {
    if (!this.currentReplay || !this.currentEval || this.prefixStats.length === 0) return;

    const metaAcc = document.getElementById('meta-acc');
    const metaCombo = document.getElementById('meta-combo');
    const count300 = document.getElementById('meta-count-300');
    const count100 = document.getElementById('meta-count-100');
    const count50 = document.getElementById('meta-count-50');
    const countMiss = document.getElementById('meta-count-miss');
    const metaUR = document.getElementById('meta-ur');
    const metaPP = document.getElementById('meta-pp');
    const skillAim = document.getElementById('skill-aim');
    const skillSpeed = document.getElementById('skill-speed');
    const skillAcc = document.getElementById('skill-acc');
    const skillReading = document.getElementById('skill-reading');

    if (!metaAcc || !metaCombo || !count300 || !count100 || !count50 || !countMiss || !metaUR) return;

    // Fast binary search for latest hit event with time <= currentTimeMs
    let low = 0;
    let high = this.prefixStats.length - 1;
    let matchIdx = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.prefixStats[mid].time <= currentTimeMs) {
        matchIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const timeJump = Math.abs(currentTimeMs - this.lastLiveTime);
    const idxJump = Math.abs(matchIdx - this.lastLiveIdx);
    const snap = timeJump > 750 || idxJump > 12;
    this.lastLiveTime = currentTimeMs;
    this.lastLiveIdx = matchIdx;

    if (matchIdx < 0) {
      this.odoSet('acc', metaAcc, 100, ODO_ACC, snap);
      this.odoSet('combo', metaCombo, 0, ODO_COMBO, snap);
      this.odoSet('c300', count300, 0, ODO_INT, snap);
      this.odoSet('c100', count100, 0, ODO_INT, snap);
      this.odoSet('c50', count50, 0, ODO_INT, snap);
      this.odoSet('cmiss', countMiss, 0, ODO_INT, snap);
      this.odoSet('ur', metaUR, this.currentEval.overallUR, ODO_UR, snap);
      metaUR.title = `Overall UR: ${this.currentEval.overallUR.toFixed(2)}`;

      this.handleAccuracyConditions({
        time: 0,
        c300: 0,
        c100: 0,
        c50: 0,
        cMiss: 0,
        combo: 0,
        maxComboSoFar: 0,
        acc: 100.0,
        ticksHit: 0,
        maxTicks: 0,
        endsHit: 0,
        maxEnds: 0,
        ppStep: false,
        headIdx: -1
      });

      if (metaPP && this.maxPossiblePP) {
        const maxVal = this.maxPossiblePP.totalPP;
        const liveEl = this.ensurePPDom(metaPP, maxVal);
        this.odoSet('pp', liveEl, 0, ODO_PP, snap);
        metaPP.title = `osu!lazer Performance: 0pp / ${Math.round(maxVal)}pp`;
        if (skillAim) skillAim.textContent = 'Aim 0%';
        if (skillSpeed) skillSpeed.textContent = 'Spd 0%';
        if (skillAcc) skillAcc.textContent = 'Acc 0%';
        if (skillReading) skillReading.textContent = 'Read 0%';
      }
    } else {
      const stat = this.prefixStats[matchIdx];

      this.odoSet('acc', metaAcc, stat.acc, ODO_ACC, snap);
      this.odoSet('combo', metaCombo, stat.combo, ODO_COMBO, snap);
      this.odoSet('c300', count300, stat.c300, ODO_INT, snap);
      this.odoSet('c100', count100, stat.c100, ODO_INT, snap);
      this.odoSet('c50', count50, stat.c50, ODO_INT, snap);
      this.odoSet('cmiss', countMiss, stat.cMiss, ODO_INT, snap);

      this.handleAccuracyConditions(stat);

      if (metaPP && this.maxPossiblePP) {
        const maxVal = this.maxPossiblePP.totalPP;
        let displayTotal = 0;
        let displayAim = 0;
        let displaySpeed = 0;
        let displayAcc = 0;
        let displayReading = 0;

        if (matchIdx >= 0 && this.precomputedLivePP.length > matchIdx) {
          const live = this.precomputedLivePP[matchIdx];
          displayTotal = live.totalPP;
          displayAim = live.aimPP;
          displaySpeed = live.speedPP;
          displayAcc = live.accPP;
          displayReading = live.readingPP ?? 0;
        }

        const aimPct = this.maxPossiblePP.aimPP > 0 ? Math.round((displayAim / this.maxPossiblePP.aimPP) * 100) : 0;
        const spdPct = this.maxPossiblePP.speedPP > 0 ? Math.round((displaySpeed / this.maxPossiblePP.speedPP) * 100) : 0;
        const accPct = this.maxPossiblePP.accPP > 0 ? Math.round((displayAcc / this.maxPossiblePP.accPP) * 100) : 0;
        const readPct = this.maxPossiblePP.readingPP > 0 ? Math.round((displayReading / this.maxPossiblePP.readingPP) * 100) : 0;

        const liveEl = this.ensurePPDom(metaPP, maxVal);
        this.odoSet('pp', liveEl, displayTotal, ODO_PP, snap);
        metaPP.title = `osu!lazer Performance: ${Math.round(displayTotal)}pp / ${Math.round(maxVal)}pp | Aim: ${aimPct}% (${Math.round(displayAim)}pp) | Speed: ${spdPct}% (${Math.round(displaySpeed)}pp) | Acc: ${accPct}% (${Math.round(displayAcc)}pp) | Reading: ${readPct}% (${Math.round(displayReading)}pp)`;

        if (skillAim) {
          skillAim.textContent = `Aim ${aimPct}%`;
          skillAim.title = `Aim PP: ${aimPct}% (${Math.round(displayAim)}pp / ${Math.round(this.maxPossiblePP.aimPP)}pp)`;
        }
        if (skillSpeed) {
          skillSpeed.textContent = `Spd ${spdPct}%`;
          skillSpeed.title = `Speed PP: ${spdPct}% (${Math.round(displaySpeed)}pp / ${Math.round(this.maxPossiblePP.speedPP)}pp)`;
        }
        if (skillAcc) {
          skillAcc.textContent = `Acc ${accPct}%`;
          skillAcc.title = `Accuracy PP: ${accPct}% (${Math.round(displayAcc)}pp / ${Math.round(this.maxPossiblePP.accPP)}pp)`;
        }
        if (skillReading) {
          skillReading.textContent = `Read ${readPct}%`;
          skillReading.title = `Reading PP: ${readPct}% (${Math.round(displayReading)}pp / ${Math.round(this.maxPossiblePP.readingPP)}pp)`;
        }
      }

      const headIdx = stat.headIdx;
      let urTarget = this.currentEval.overallUR;
      if (this.currentEval.cumulativeUR && this.currentEval.cumulativeUR.length > 0) {
        if (headIdx >= 0 && headIdx < this.currentEval.cumulativeUR.length && this.currentEval.cumulativeUR[headIdx] > 0) {
          urTarget = this.currentEval.cumulativeUR[headIdx];
        }
      }
      this.odoSet('ur', metaUR, urTarget, ODO_UR, snap);
      metaUR.title = `Overall UR: ${this.currentEval.overallUR.toFixed(2)}`;
    }
  }

  public updateTopBar(currentReplayRate: number, currentTimeMs: number): void {
    if (!this.currentReplay || !this.currentBeatmap || !this.currentEval) return;

    const topTitle = document.getElementById('top-title')!;
    const topSubtitle = document.getElementById('top-subtitle')!;
    const metaModsContainer = document.getElementById('meta-mods-container')!;
    const srPill = document.getElementById('meta-sr-pill') as HTMLElement | null;
    const beatmapDiffGrid = document.getElementById('beatmap-diff-grid') as HTMLElement | null;

    const b = this.currentBeatmap;
    const r = this.currentReplay;
    const eff = calculateEffectiveDifficulty(b.difficulty, r.mods, currentReplayRate);
    const starRating = this.currentLazerDiff?.starRating ?? this.currentDiffAttributes?.starRating;

    const uninherited = (b.timingPoints || []).filter(tp => tp.uninherited || tp.beatLength > 0);
    const baseBpm = uninherited.length > 0 ? Math.round(60000 / uninherited[0].beatLength) : 0;
    const effectiveBpm = Math.round(baseBpm * currentReplayRate);
    let bpmText = '';
    if (baseBpm > 0) {
      bpmText = currentReplayRate !== 1.0 ? `${effectiveBpm} BPM (${baseBpm})` : `${baseBpm} BPM`;
    }

    topTitle.textContent = `${b.metadata.artist} - ${b.metadata.title} [${b.metadata.version}]`;
    const subParts = [r.playerName, b.metadata.creator, 'osu!standard', 'lazer ruleset'].filter((p) => p && p.length > 0);
    topSubtitle.textContent = subParts.join(' • ');
    const diffParts = [
      bpmText,
      `HP ${eff.hp.toFixed(1)}`,
      `CS ${eff.cs.toFixed(1)}`,
      `OD ${eff.od.toFixed(1)}`,
      `AR ${eff.ar.toFixed(1)}`,
    ].filter((p) => p && p.length > 0);
    topSubtitle.title = diffParts.join(' • ');

    if (beatmapDiffGrid) {
      beatmapDiffGrid.style.display = 'grid';

      const updateDiffCell = (valId: string, cellId: string, statName: string, baseVal: number, effVal: number) => {
        const valEl = document.getElementById(valId);
        const cellEl = document.getElementById(cellId);
        if (!valEl) return;

        valEl.textContent = effVal.toFixed(1);
        valEl.classList.remove('stat-buff', 'stat-nerf');

        const delta = effVal - baseVal;
        if (delta > 0.05) {
          valEl.classList.add('stat-buff');
          if (cellEl) cellEl.title = `${statName}: ${baseVal.toFixed(1)} → ${effVal.toFixed(1)} (Buffed by mods)`;
        } else if (delta < -0.05) {
          valEl.classList.add('stat-nerf');
          if (cellEl) cellEl.title = `${statName}: ${baseVal.toFixed(1)} → ${effVal.toFixed(1)} (Nerfed by mods)`;
        } else {
          if (cellEl) cellEl.title = `${statName}: ${baseVal.toFixed(1)}`;
        }
      };

      updateDiffCell('meta-diff-cs', 'cell-cs', 'Circle Size (CS)', b.difficulty.circleSize, eff.cs);
      updateDiffCell('meta-diff-hp', 'cell-hp', 'HP Drain (HP)', b.difficulty.hpDrainRate, eff.hp);
      updateDiffCell('meta-diff-od', 'cell-od', 'Overall Difficulty (OD)', b.difficulty.overallDifficulty, eff.od);
      updateDiffCell('meta-diff-ar', 'cell-ar', 'Approach Rate (AR)', b.difficulty.approachRate, eff.ar);
    }

    if (srPill) {
      if (starRating) {
        srPill.innerHTML = `<i id="meta-sr-star" class="sr-star fa-solid fa-star"></i> ${starRating.toFixed(2)}`;
        const srStar = document.getElementById('meta-sr-star') as HTMLElement | null;
        if (srStar) {
          srStar.style.color = getDiffTextColor(starRating);
          srStar.style.fontSize = '9.6px';
        }
        srPill.style.backgroundColor = getDiffColor(starRating);
        srPill.style.color = getDiffTextColor(starRating);
        srPill.hidden = false;
      } else {
        srPill.hidden = true;
      }
    }

    renderModBadges(metaModsContainer, r);
    this.reserveHstatsWidths();
    this.updateLiveStats(currentTimeMs);
  }

  private handleAccuracyConditions(stat: PrefixHitStat): void {
    const metaRank = document.getElementById('meta-rank');
    if (!metaRank) return;

    const mods = typeof this.currentReplay?.soloScoreInfo?.mods === 'number'
      ? this.currentReplay.soloScoreInfo.mods
      : (typeof this.currentReplay?.mods === 'number' ? this.currentReplay.mods : 0);

    const isSilver = this.isHiddenFlashlightTraceableOrBlindsEnabled(mods);

    let badgeName = 'GradeSmall-D.svg';

    if (stat.acc < 70.0) {
      badgeName = 'GradeSmall-D.svg';
    } else if (stat.acc < 80.0) {
      badgeName = 'GradeSmall-C.svg';
    } else if (stat.acc < 90.0) {
      badgeName = 'GradeSmall-B.svg';
    } else if (stat.acc < 95.0 || (stat.acc >= 95.0 && stat.cMiss >= 1)) {
      badgeName = 'GradeSmall-A.svg';
    } else if (stat.acc >= 100.0) {
      badgeName = isSilver ? 'GradeSmall-SS-Silver.svg' : 'GradeSmall-SS.svg';
    } else if (stat.acc >= 95.0) {
      badgeName = isSilver ? 'GradeSmall-S-Silver.svg' : 'GradeSmall-S.svg';
    }

    const assetPath = BADGE_ICONS[`../../assets/icons/Badges/${badgeName}`] || '';

    if (metaRank.dataset.currentRank !== badgeName) {
      metaRank.dataset.currentRank = badgeName;
      metaRank.innerHTML = `<img src="${assetPath}" alt="Rank" class="rank-badge-svg" />`;
    }

    metaRank.hidden = false;
  }

  private isHiddenFlashlightTraceableOrBlindsEnabled(mods: number): boolean {
    const HIDDEN = 1 << 3;
    const FLASHLIGHT = 1 << 10;
    return (mods & (HIDDEN | FLASHLIGHT)) !== 0;
  }

  private ensurePPDom(metaPP: HTMLElement, maxVal: number): HTMLElement | null {
    let liveEl = document.getElementById('meta-pp-live');
    let maxEl = document.getElementById('meta-max-pp');
    if (!liveEl || !maxEl || liveEl.parentElement !== metaPP) {
      metaPP.innerHTML = `<span class="meta-live" id="meta-pp-live">0pp</span> <span class="sv-sub" id="meta-max-pp">/ ${Math.round(maxVal)}pp</span>`;
      liveEl = document.getElementById('meta-pp-live');
      maxEl = document.getElementById('meta-max-pp');
    }
    if (maxEl) maxEl.textContent = `/ ${Math.round(maxVal)}pp`;
    return liveEl as HTMLElement | null;
  }

  public reserveHstatsWidths(): void {
    if (!this.currentBeatmap) return;
    const digits = (n: number) => String(Math.max(0, Math.round(n))).length;

    const mapMaxCombo = this.currentLazerDiff?.maxCombo
      ?? this.currentDiffAttributes?.maxCombo
      ?? this.currentReplay?.maxCombo
      ?? this.currentBeatmap.hitObjects.length;

    const comboMaxEl = document.getElementById('meta-combo-max');
    if (comboMaxEl) comboMaxEl.textContent = `/ ${mapMaxCombo}x`;

    this.odoMinInt.set('combo', digits(mapMaxCombo));

    const comboEl = document.getElementById('meta-combo');
    const comboBox = comboEl?.parentElement;
    if (comboEl && comboBox) {
      const comboDigits = digits(mapMaxCombo);
      const w = this.worstCaseWidth(comboEl, comboDigits, '', 'x ')
        + (comboMaxEl ? this.worstCaseWidth(comboMaxEl, comboDigits, '/ ', 'x') : 0);
      if (w > 0) comboBox.style.minWidth = `${w}px`;
    }

    this.reserveWidth('meta-acc', 3, '', '.00%');
    this.reserveWidth('meta-ur', 3, '', '.88');

    const maxPP = this.maxPossiblePP ? Math.round(this.maxPossiblePP.totalPP) : 0;
    if (maxPP > 0) {
      this.odoMinInt.set('pp', digits(maxPP));
      const ppBox = document.getElementById('meta-pp');
      const liveEl = document.getElementById('meta-pp-live') ?? ppBox;
      const subEl = document.getElementById('meta-max-pp');
      if (ppBox && liveEl) {
        const ppDigits = digits(maxPP);
        const w = this.worstCaseWidth(liveEl, ppDigits, '', 'pp ')
          + (subEl ? this.worstCaseWidth(subEl, ppDigits, '/ ', 'pp') : 0);
        if (w > 0) ppBox.style.minWidth = `${w}px`;
      }
    }

    const countDigits = digits(this.currentBeatmap.hitObjects.length);
    for (const key of ['c300', 'c100', 'c50', 'cmiss']) this.odoMinInt.set(key, countDigits);
    for (const id of ['meta-count-300', 'meta-count-100', 'meta-count-50', 'meta-count-miss']) {
      this.reserveWidth(id, countDigits);
    }
  }

  private ensureMeasureCtx(): CanvasRenderingContext2D | null {
    if (!this.measureCtxReady) {
      this.measureCtxReady = true;
      this.measureCtx = document.createElement('canvas').getContext('2d');
    }
    return this.measureCtx;
  }

  private widestDigitPx(el: Element): number {
    const ctx = this.ensureMeasureCtx();
    if (!ctx) return 0;
    const cs = getComputedStyle(el);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let w = 0;
    for (let d = 0; d <= 9; d++) {
      w = Math.max(w, ctx.measureText(String(d)).width);
    }
    return w;
  }

  private worstCaseWidth(el: Element, digitCount: number, prefix = '', suffix = '', slackPx = 4): number {
    const ctx = this.ensureMeasureCtx();
    if (!ctx) return 0;
    const digitW = this.widestDigitPx(el);
    if (digitW <= 0) return 0;
    const fixedW = ctx.measureText(prefix).width + ctx.measureText(suffix).width;
    return Math.ceil(digitW * Math.max(0, digitCount) + fixedW) + slackPx;
  }

  private reserveWidth(elId: string, digitCount: number, prefix = '', suffix = ''): void {
    const el = document.getElementById(elId);
    if (!el) return;
    const w = this.worstCaseWidth(el, digitCount, prefix, suffix);
    if (w > 0) el.style.minWidth = `${w}px`;
  }
}
