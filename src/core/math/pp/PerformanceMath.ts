/**
 * Core mathematical utilities and statistical functions for osu! Performance Points calculation.
 */

export function difficultyToPerformance(difficulty: number): number {
  return 4.0 * Math.pow(Math.max(0, difficulty), 3);
}

/**
 * Miss penalty function from osu! CSR rework:
 * 0.93 / (missCount / (4 * ln(max(1, difficultStrainCount))) + 1)
 */
export function calculateMissPenalty(missCount: number, difficultStrainCount: number): number {
  if (missCount <= 0) return 1.0;
  const strains = Math.max(1, difficultStrainCount);
  const denom = (missCount / (4.0 * Math.log(strains))) + 1.0;
  return Math.max(0, 0.93 / denom);
}

/**
 * Error function approximation (Abramowitz and Stegun 7.1.26)
 */
export function erf(x: number): number {
  if (x === 0) return 0;
  const t = 1.0 / (1.0 + 0.3275911 * Math.abs(x));
  const tau =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfVal = 1.0 - tau * Math.exp(-x * x);
  return x >= 0 ? erfVal : -erfVal;
}

/**
 * Inverse error function approximation
 */
export function erfInv(x: number): number {
  if (x <= -1) return -Infinity;
  if (x >= 1) return Infinity;
  if (x === 0) return 0;
  const a = 0.147;
  const sgn = Math.sign(x);
  const absX = Math.abs(x);
  const ln = Math.log(1 - absX * absX);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  const t2 = ln / a;
  const baseApprox = Math.sqrt(t1 * t1 - t2) - t1;
  const c = absX >= 0.85 ? Math.pow((absX - 0.85) / 0.293, 8) : 0;
  return sgn * (Math.sqrt(baseApprox) + c);
}

/**
 * Estimates player tap deviation from hit judgements and OD windows
 * (OsuPerformanceCalculator.calculateDeviation)
 */
export function calculateDeviation(
  relevantCountGreat: number,
  relevantCountOk: number,
  relevantCountMeh: number,
  greatHitWindow: number,
  okHitWindow: number,
  mehHitWindow: number
): number | null {
  if (relevantCountGreat + relevantCountOk + relevantCountMeh <= 0) return null;

  const n = Math.max(1, relevantCountGreat + relevantCountOk);
  const p = relevantCountGreat / n;
  const z = 2.32634787404; // 99% critical value

  const pLowerBound = Math.min(
    p,
    (n * p + (z * z) / 2) / (n + z * z) - (z / (n + z * z)) * Math.sqrt(n * p * (1 - p) + (z * z) / 4)
  );

  let deviation: number;
  if (pLowerBound > 0.01) {
    deviation = greatHitWindow / (Math.SQRT2 * erfInv(pLowerBound));

    const okTailAmount =
      (Math.sqrt(2 / Math.PI) *
        okHitWindow *
        Math.exp(-0.5 * Math.pow(okHitWindow / deviation, 2))) /
      (deviation * erf(okHitWindow / (Math.SQRT2 * deviation)));

    if (okTailAmount < 1) {
      deviation *= Math.sqrt(1 - okTailAmount);
    }
  } else {
    deviation = okHitWindow / Math.sqrt(3);
  }

  const mehVariance = (mehHitWindow * mehHitWindow + okHitWindow * mehHitWindow + okHitWindow * okHitWindow) / 3;
  const totalSuccessful = relevantCountGreat + relevantCountOk + relevantCountMeh;
  deviation = Math.sqrt(
    ((relevantCountGreat + relevantCountOk) * Math.pow(deviation, 2) + relevantCountMeh * mehVariance) /
      totalSuccessful
  );

  return deviation;
}
