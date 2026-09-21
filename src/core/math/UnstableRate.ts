/**
 * Unstable Rate (UR) calculations verified against osu!lazer HitEventExtensions.cs
 */

export interface WelfordState {
  count: number;
  mean: number;
  m2: number;
}

/**
 * Creates an empty Welford accumulator
 */
export function createWelfordState(): WelfordState {
  return { count: 0, mean: 0, m2: 0 };
}

/**
 * Updates Welford state with a single sample x
 */
export function updateWelford(state: WelfordState, x: number): void {
  state.count += 1;
  const delta = x - state.mean;
  state.mean += delta / state.count;
  const delta2 = x - state.mean;
  state.m2 += delta * delta2;
}

/**
 * Computes Unstable Rate from an array of raw offsets (ms) and a gameplay rate multiplier
 * UR = 10.0 * population_std_dev(offsets / gameplayRate)
 */
export function calculateUnstableRate(offsets: number[] | Float32Array, gameplayRate: number = 1.0): number {
  const n = offsets.length;
  if (n === 0) return 0;

  const state = createWelfordState();
  for (let i = 0; i < n; i++) {
    const x = offsets[i] / gameplayRate;
    updateWelford(state, x);
  }

  // Population variance = M2 / N
  const variance = state.m2 / state.count;
  return 10.0 * Math.sqrt(variance);
}

/**
 * Computes a rolling Unstable Rate curve over a sliding window
 */
export function calculateRollingUnstableRate(
  offsets: number[] | Float32Array,
  windowSize: number = 30,
  gameplayRate: number = 1.0
): Float32Array {
  const n = offsets.length;
  const result = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const sliceLen = i - start + 1;
    const state = createWelfordState();

    for (let j = start; j <= i; j++) {
      updateWelford(state, offsets[j] / gameplayRate);
    }

    const variance = state.m2 / sliceLen;
    result[i] = 10.0 * Math.sqrt(variance);
  }

  return result;
}

/**
 * Computes a rolling mean offset curve tracking early/late drift
 */
export function calculateRollingMeanOffset(
  offsets: number[] | Float32Array,
  windowSize: number = 30
): Float32Array {
  const n = offsets.length;
  const result = new Float32Array(n);

  let currentSum = 0;
  for (let i = 0; i < n; i++) {
    currentSum += offsets[i];
    if (i >= windowSize) {
      currentSum -= offsets[i - windowSize];
      result[i] = currentSum / windowSize;
    } else {
      result[i] = currentSum / (i + 1);
    }
  }

  return result;
}

/**
 * Estimates the official game client Unstable Rate from replay score judgements (300, 100, 50)
 * and hit windows, taking into account the measured player timing bias (mean offset).
 * In osu!, UR = 10 * sigma (standard deviation of hit errors in milliseconds).
 */
export function estimateReplayUnstableRate(
  count300: number,
  count100: number,
  count50: number,
  greatWindow: number,
  okWindow: number,
  mehWindow: number,
  measuredMeanOffset: number = 0
): number | null {
  const total = count300 + count100 + count50;
  if (total <= 0) return null;

  const mu = Math.abs(measuredMeanOffset);
  const w300 = greatWindow;
  const w100 = okWindow;
  const w50 = mehWindow;

  function erf(x: number): number {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1.0 / (1.0 + p * Math.abs(x));
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  function cdf(x: number, s: number): number {
    return 0.5 * (1 + erf((x - mu) / (s * Math.SQRT2)));
  }

  let bestSigma = 25;
  let bestLL = -Infinity;
  for (let s = 5.0; s <= 70.0; s += 0.05) {
    const p300 = Math.max(1e-9, cdf(w300, s) - cdf(-w300, s));
    const p100 = Math.max(1e-9, (cdf(w100, s) - cdf(-w100, s)) - p300);
    const p50 = Math.max(1e-9, (cdf(w50, s) - cdf(-w50, s)) - (p300 + p100));
    const ll = count300 * Math.log(p300) + count100 * Math.log(p100) + count50 * Math.log(p50);
    if (ll > bestLL) {
      bestLL = ll;
      bestSigma = s;
    }
  }

  const roughSigma = bestSigma;
  for (let s = Math.max(1, roughSigma - 0.15); s <= roughSigma + 0.15; s += 0.001) {
    const p300 = Math.max(1e-9, cdf(w300, s) - cdf(-w300, s));
    const p100 = Math.max(1e-9, (cdf(w100, s) - cdf(-w100, s)) - p300);
    const p50 = Math.max(1e-9, (cdf(w50, s) - cdf(-w50, s)) - (p300 + p100));
    const ll = count300 * Math.log(p300) + count100 * Math.log(p100) + count50 * Math.log(p50);
    if (ll > bestLL) {
      bestLL = ll;
      bestSigma = s;
    }
  }

  return bestSigma * 10;
}
