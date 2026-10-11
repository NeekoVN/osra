import { Beatmap } from '../types/beatmap.ts';
import { HitJudgement, TimedHitEvent } from '../types/telemetry.ts';

export interface ComboPrefixStat {
  time: number;
  c300: number;
  c100: number;
  c50: number;
  cMiss: number;
  combo: number;
  maxComboSoFar: number;
  ticksHit: number;
  maxTicks: number;
  endsHit: number;
  maxEnds: number;
  /**
   * True for head steps (one per hitobject). Slider sub-steps (ticks,
   * reverses, tails) carry it false: the rosu gradual stepper advances
   * exactly once per hitobject, so only head steps may consume a step —
   * otherwise the stepper exhausts early and live PP freezes mid-map.
   */
  ppStep: boolean;
  /**
   * Head-event index this entry belongs to (its own pos for head steps, the
   * most recent head for sub-steps). Per-head evaluator arrays
   * (cumulativeUR, …) must be indexed with this, never with the sub-step
   * position — otherwise they drift and freeze on the fallback value.
   */
  headIdx: number;
}

export interface ComboTickTotals {
  /** Large-tick hits / maximums (lazer `large_tick_hit`). Omit both when unknown (stable replays). */
  ticksHit?: number;
  ticksMax?: number;
  /** Slider-tail hits / maximums (`slider_tail_hit`). Omit both when unknown (stable replays). */
  endsHit?: number;
  endsMax?: number;
}

/**
 * Distributes an integer `total` across `weights` using largest-remainder so the
 * parts always sum to exactly `total`. Each part is optionally capped.
 */
function distributeTotal(total: number, weights: number[], caps?: number[]): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0 || total <= 0) return out;
  const weightSum = weights.reduce((a, b) => a + b, 0);
  // No weighting info: spread as evenly as possible (still sums to total).
  const effWeights = weightSum > 0 ? weights : weights.map(() => 1);
  const effSum = effWeights.reduce((a, b) => a + b, 0);
  const quotas = effWeights.map((w) => (w / effSum) * total);
  const floors = quotas.map((q, i) => Math.min(Math.floor(q), caps?.[i] ?? Infinity));
  let assigned = floors.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) out[i] = floors[i];
  // Largest remainder for the leftover, respecting caps. Zero-weight entries
  // never receive leftovers (e.g. hit ticks must not land on missed sliders).
  const order = quotas
    .map((q, i) => ({ i, frac: q - Math.floor(q) }))
    .filter(({ i }) => effWeights[i] > 0)
    .sort((a, b) => b.frac - a.frac);
  let guard = 0;
  while (assigned < total && guard++ < n * 4) {
    let progressed = false;
    for (const { i } of order) {
      if (assigned >= total) break;
      const cap = caps?.[i] ?? Infinity;
      if (out[i] < cap) {
        out[i]++;
        assigned++;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * Builds per-hitobject prefix combo stats with faithful osu! combo semantics.
 *
 * Combo accrues as the ball travels, not in a lump on head touch (matches
 * rosu-pp `maxCombo = heads + spans + largeTicks` in total):
 * - circle / spinner: +1 at the head time
 * - slider head hit: +1 at the head time
 * - slider large tick: +1 at its position along the slider (evenly spaced;
 *   per-tick hit/miss is unknowable from aggregate totals, so the first N
 *   ticks take the hits)
 * - slider reverse (repeat): +1 at each span boundary while the head was hit
 *   (no per-repeat signal exists in the aggregate statistics)
 * - slider tail: +tail (0/1) at the slider end time
 * - any `Miss` head judgement resets the running combo to 0; a missed head
 *   kills its slider (no tick/repeat/tail combo), while max-side totals still
 *   accrue for accuracy. Missed ticks/tails never reset combo (lazer rules).
 *
 * One stat is emitted per combo step (heads + slider sub-steps), sorted by
 * time, so the live combo ticks up mid-slider. `maxComboSoFar` is the running
 * maximum — an FC play always has `combo === maxComboSoFar` at every step.
 *
 * Tick/tail totals come from the replay's lazer statistics when present. For
 * stable replays (unknown) tails are assumed hit whenever the head is hit and
 * ticks contribute 0.
 */
export function buildPrefixCombo(
  events: TimedHitEvent[],
  beatmap: Beatmap | null | undefined,
  totals: ComboTickTotals = {}
): ComboPrefixStat[] {
  const objects = beatmap?.hitObjects ?? [];

  const objAt = (e: TimedHitEvent, pos: number) => {
    const idx = (e.objectIndex ?? pos + 1) - 1;
    return idx >= 0 && idx < objects.length ? objects[idx] : undefined;
  };

  // Slider order (by event position) and their per-slider data.
  const sliderPos: number[] = [];
  const sliderRepeats: number[] = [];
  const sliderWeights: number[] = [];
  events.forEach((e, pos) => {
    const obj = objAt(e, pos);
    if (obj?.objectType === 'slider') {
      sliderPos.push(pos);
      const repeats = Math.max(1, (obj as unknown as { repeatCount?: number }).repeatCount ?? 1);
      sliderRepeats.push(repeats);
      const px = (obj as unknown as { pixelLength?: number }).pixelLength ?? 0;
      sliderWeights.push(Math.max(0, px * repeats));
    }
  });
  const nSliders = sliderPos.length;
  const sliderAtEvent = new Map<number, number>();
  sliderPos.forEach((pos, si) => sliderAtEvent.set(pos, si));

  const ticksKnown = totals.ticksMax != null || totals.ticksHit != null;
  const endsKnown = totals.endsMax != null || totals.endsHit != null;
  const ticksMaxTotal = Math.max(0, Math.round(totals.ticksMax ?? 0));
  const ticksHitTotal = Math.max(0, Math.round(totals.ticksHit ?? 0));
  const endsMaxTotal = Math.max(0, Math.round(totals.endsMax ?? 0));
  const endsHitTotal = Math.max(0, Math.round(totals.endsHit ?? 0));

  // Max-side allocation: large ticks spread across sliders by length weight.
  const tickMaxAlloc = distributeTotal(ticksMaxTotal, sliderWeights);
  // Tail max per slider: 1 each when totals match the slider count, otherwise
  // distribute the declared total as evenly as possible (0/1 units).
  const tailMaxAlloc = endsKnown
    ? distributeTotal(endsMaxTotal, sliderWeights.map(() => 1), sliderWeights.map(() => 1))
    : new Array<number>(nSliders).fill(1);

  const isHit = (e: TimedHitEvent) => e.judgement !== HitJudgement.Miss;
  const hitSliderFlags = sliderPos.map((pos) => isHit(events[pos]));
  // Hit-side allocation: ticks/tails only land on hit sliders, capped by max.
  const tickHitAlloc = ticksKnown
    ? distributeTotal(
        Math.min(ticksHitTotal, tickMaxAlloc.reduce((a, b) => a + b, 0)),
        sliderWeights.map((w, si) => (hitSliderFlags[si] ? w : 0)),
        tickMaxAlloc
      )
    : new Array<number>(nSliders).fill(0);
  const tailHitAlloc = endsKnown
    ? distributeTotal(
        Math.min(
          endsHitTotal,
          hitSliderFlags.reduce((sum, hit, si) => sum + (hit ? tailMaxAlloc[si] : 0), 0)
        ),
        sliderWeights.map((_, si) => (hitSliderFlags[si] ? tailMaxAlloc[si] : 0)),
        tailMaxAlloc
      )
    : hitSliderFlags.map((hit) => (hit ? 1 : 0));

  interface ComboStep {
    time: number;
    seq: number;
    /** Event index for head steps, -1 for slider sub-steps. */
    pos: number;
    kind: 'head' | 'tick' | 'repeat' | 'tail';
    /** Combo/hit-side increment applied when this step passes. */
    amt: number;
    /** Max-side (accuracy denominator) increment. */
    max: number;
  }

  const steps: ComboStep[] = [];
  let seq = 0;
  events.forEach((e, pos) => {
    const si = sliderAtEvent.get(pos);
    if (si == null) {
      steps.push({ time: e.targetTime, seq: seq++, pos, kind: 'head', amt: 0, max: 0 });
      return;
    }
    const obj = objAt(e, pos) as unknown as { endTime?: number; duration?: number } | undefined;
    const start = e.targetTime;
    const rawEnd = obj?.endTime ?? (obj?.duration != null ? start + obj.duration : start);
    const end = Math.max(start, rawEnd);
    steps.push({ time: start, seq: seq++, pos, kind: 'head', amt: 0, max: 0 });

    // Large ticks, evenly spaced along the slider body. Only the totals are
    // known, so the first N ticks absorb the hits.
    const nMax = tickMaxAlloc[si];
    const nHit = tickHitAlloc[si];
    for (let k = 0; k < nMax; k++) {
      steps.push({
        time: start + ((end - start) * (k + 1)) / (nMax + 1),
        seq: seq++,
        pos: -1,
        kind: 'tick',
        amt: k < nHit ? 1 : 0,
        max: 1
      });
    }
    // Reverses at span boundaries — only when the head was hit.
    if (hitSliderFlags[si]) {
      const reps = sliderRepeats[si];
      for (let k = 1; k < reps; k++) {
        steps.push({
          time: start + ((end - start) * k) / reps,
          seq: seq++,
          pos: -1,
          kind: 'repeat',
          amt: 1,
          max: 0
        });
      }
    }
    // Tail at the slider end (max accrues even on a dead slider).
    if (tailMaxAlloc[si] > 0) {
      steps.push({
        time: end,
        seq: seq++,
        pos: -1,
        kind: 'tail',
        amt: tailHitAlloc[si],
        max: tailMaxAlloc[si]
      });
    }
  });
  steps.sort((a, b) => a.time - b.time || a.seq - b.seq);

  const out: ComboPrefixStat[] = [];
  let c300 = 0;
  let c100 = 0;
  let c50 = 0;
  let cMiss = 0;
  let combo = 0;
  let maxCombo = 0;
  let lastHeadIdx = -1;
  let runTicksHit = 0;
  let runMaxTicks = 0;
  let runEndsHit = 0;
  let runMaxEnds = 0;

  for (const s of steps) {
    if (s.kind === 'head') {
      lastHeadIdx = s.pos;
      const e = events[s.pos];
      if (!isHit(e)) {
        cMiss++;
        combo = 0;
      } else {
        if (e.judgement === HitJudgement.Great) c300++;
        else if (e.judgement === HitJudgement.Ok) c100++;
        else c50++;
        combo += 1;
      }
    } else if (s.kind === 'tick') {
      runMaxTicks += s.max;
      if (s.amt > 0) {
        runTicksHit += s.amt;
        combo += s.amt;
      }
    } else if (s.kind === 'repeat') {
      combo += s.amt;
    } else {
      runMaxEnds += s.max;
      if (s.amt > 0) {
        runEndsHit += s.amt;
        combo += s.amt;
      }
    }
    if (combo > maxCombo) maxCombo = combo;
    out.push({
      time: s.time,
      c300,
      c100,
      c50,
      cMiss,
      combo,
      maxComboSoFar: maxCombo,
      ticksHit: runTicksHit,
      maxTicks: runMaxTicks,
      endsHit: runEndsHit,
      maxEnds: runMaxEnds,
      ppStep: s.kind === 'head',
      headIdx: lastHeadIdx
    });
  }
  return out;
}
