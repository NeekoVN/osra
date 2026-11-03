import { SliderPathPoint } from '../types/beatmap.ts';

const BEZIER_TOLERANCE = 0.25;
const CIRCULAR_ARC_TOLERANCE = 0.1;
const CATMULL_DETAIL = 50;

export type Vec2 = { x: number; y: number };

// --- Circular Arc (Perfect Curve / 'P') ---

export interface CircularArcProps {
  isValid: boolean;
  thetaStart: number;
  thetaRange: number;
  direction: number; // +1 or -1
  radius: number;
  cx: number;
  cy: number;
}

/**
 * Port of CircularArcProperties.cs constructor.
 * Computes circumscribed circle passing through 3 control points.
 */
export function getCircularArcProps(pts: Vec2[]): CircularArcProps {
  const a = pts[0], b = pts[1], c = pts[2];

  // Degenerate check (collinear)
  const det = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y);
  if (Math.abs(det) < 1e-7) {
    return { isValid: false, thetaStart: 0, thetaRange: 0, direction: 0, radius: 0, cx: 0, cy: 0 };
  }

  // Circumscribed circle centre via Cartesian formula
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const aSq = a.x * a.x + a.y * a.y;
  const bSq = b.x * b.x + b.y * b.y;
  const cSq = c.x * c.x + c.y * c.y;

  const cx = (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d;
  const cy = (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d;

  const dAx = a.x - cx;
  const dAy = a.y - cy;
  const dCx = c.x - cx;
  const dCy = c.y - cy;

  const radius = Math.hypot(dAx, dAy);
  const thetaStart = Math.atan2(dAy, dAx);
  let thetaEnd = Math.atan2(dCy, dCx);

  while (thetaEnd < thetaStart) thetaEnd += 2 * Math.PI;

  let direction = 1;
  let thetaRange = thetaEnd - thetaStart;

  // Determine arc direction based on which side of AC that B lies
  const orthoX = c.y - a.y;
  const orthoY = -(c.x - a.x);
  const dot = orthoX * (b.x - a.x) + orthoY * (b.y - a.y);
  if (dot < 0) {
    direction = -1;
    thetaRange = 2 * Math.PI - thetaRange;
  }

  return { isValid: true, thetaStart, thetaRange, direction, radius, cx, cy };
}

/**
 * Port of PathApproximator.CircularArcToPiecewiseLinear.
 */
export function circularArcToPiecewiseLinear(pts: Vec2[]): Vec2[] {
  const arc = getCircularArcProps(pts);
  if (!arc.isValid) return bezierToPiecewiseLinear(pts);

  const { thetaStart, thetaRange, direction, radius, cx, cy } = arc;

  const amountPoints =
    2 * radius <= CIRCULAR_ARC_TOLERANCE
      ? 2
      : Math.max(2, Math.ceil(thetaRange / (2 * Math.acos(1 - CIRCULAR_ARC_TOLERANCE / radius))));

  // Safety for pathological cases (radius >> tolerance)
  if (amountPoints >= 1000) return bezierToPiecewiseLinear(pts);

  const output: Vec2[] = [];
  for (let i = 0; i < amountPoints; i++) {
    const frac = i / (amountPoints - 1);
    const theta = thetaStart + direction * frac * thetaRange;
    output.push({
      x: cx + Math.cos(theta) * radius,
      y: cy + Math.sin(theta) * radius
    });
  }
  return output;
}

// --- Catmull-Rom ('C') ---

export function catmullFindPoint(v1: Vec2, v2: Vec2, v3: Vec2, v4: Vec2, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t * t2;
  return {
    x: 0.5 * (2 * v2.x + (-v1.x + v3.x) * t + (2 * v1.x - 5 * v2.x + 4 * v3.x - v4.x) * t2 + (-v1.x + 3 * v2.x - 3 * v3.x + v4.x) * t3),
    y: 0.5 * (2 * v2.y + (-v1.y + v3.y) * t + (2 * v1.y - 5 * v2.y + 4 * v3.y - v4.y) * t2 + (-v1.y + 3 * v2.y - 3 * v3.y + v4.y) * t3)
  };
}

/**
 * Port of PathApproximator.CatmullToPiecewiseLinear.
 */
export function catmullToPiecewiseLinear(pts: Vec2[]): Vec2[] {
  const result: Vec2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const v1 = i > 0 ? pts[i - 1] : pts[i];
    const v2 = pts[i];
    const v3 = pts[i + 1];
    const v4 = i < pts.length - 2 ? pts[i + 2] : { x: v3.x + v3.x - v2.x, y: v3.y + v3.y - v2.y };
    for (let c = 0; c < CATMULL_DETAIL; c++) {
      result.push(catmullFindPoint(v1, v2, v3, v4, c / CATMULL_DETAIL));
      result.push(catmullFindPoint(v1, v2, v3, v4, (c + 1) / CATMULL_DETAIL));
    }
  }
  return result;
}

// --- Adaptive Bézier / B-Spline ('B') ---

export function bezierIsFlatEnough(pts: Vec2[]): boolean {
  for (let i = 1; i < pts.length - 1; i++) {
    const ux = pts[i - 1].x - 2 * pts[i].x + pts[i + 1].x;
    const uy = pts[i - 1].y - 2 * pts[i].y + pts[i + 1].y;
    if (ux * ux + uy * uy > BEZIER_TOLERANCE * BEZIER_TOLERANCE * 4) return false;
  }
  return true;
}

export function bezierSubdivide(pts: Vec2[], l: Vec2[], r: Vec2[], mid: Vec2[]): void {
  const n = pts.length;
  for (let i = 0; i < n; i++) mid[i] = { ...pts[i] };
  for (let i = 0; i < n; i++) {
    l[i] = { ...mid[0] };
    r[n - i - 1] = { ...mid[n - i - 1] };
    for (let j = 0; j < n - i - 1; j++) {
      mid[j] = { x: (mid[j].x + mid[j + 1].x) / 2, y: (mid[j].y + mid[j + 1].y) / 2 };
    }
  }
}

export function bezierApproximate(pts: Vec2[], output: Vec2[], l: Vec2[], r: Vec2[], mid: Vec2[]): void {
  const n = pts.length;
  bezierSubdivide(pts, l, r, mid);
  for (let i = 0; i < n - 1; i++) l[n + i] = r[i + 1];
  output.push({ ...pts[0] });
  for (let i = 1; i < n - 1; i++) {
    const idx = 2 * i;
    const p = {
      x: 0.25 * (l[idx - 1].x + 2 * l[idx].x + l[idx + 1].x),
      y: 0.25 * (l[idx - 1].y + 2 * l[idx].y + l[idx + 1].y)
    };
    output.push(p);
  }
}

/**
 * Port of PathApproximator.BezierToPiecewiseLinear (adaptive subdivision).
 * Matches BSplineToPiecewiseLinear with degree = n-1 (pure Bézier).
 */
export function bezierToPiecewiseLinear(pts: Vec2[]): Vec2[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [pts[0]];

  const output: Vec2[] = [];
  const n = pts.length;

  // Stack of curves to flatten
  const toFlatten: Vec2[][] = [pts.map(p => ({ ...p }))];
  const freeBuffers: Vec2[][] = [];

  const subBuf1 = new Array(n).fill(null).map(() => ({ x: 0, y: 0 })) as Vec2[];
  const subBuf2 = new Array(n * 2).fill(null).map(() => ({ x: 0, y: 0 })) as Vec2[];
  const l = subBuf2;
  const r = subBuf1;

  while (toFlatten.length > 0) {
    const parent = toFlatten.pop()!;
    if (bezierIsFlatEnough(parent)) {
      bezierApproximate(parent, output, l, r, subBuf1);
      freeBuffers.push(parent);
      continue;
    }
    const rightChild = freeBuffers.length > 0 ? freeBuffers.pop()! : new Array(n).fill(null).map(() => ({ x: 0, y: 0 })) as Vec2[];
    bezierSubdivide(parent, l, rightChild, subBuf1);
    for (let i = 0; i < n; i++) parent[i] = { ...l[i] };
    toFlatten.push(rightChild);
    toFlatten.push(parent);
  }

  output.push({ ...pts[n - 1] });
  return output;
}

// --- Linear ('L') ---

export function linearToPiecewiseLinear(pts: Vec2[]): Vec2[] {
  return pts.map(p => ({ ...p }));
}

// --- Path length clamping/extension (SliderPath.calculateLength) ---

/**
 * Clamps or extends a calculated path to exactly pixelLength.
 * Port of SliderPath.calculateLength.
 */
export function clampPathToLength(path: Vec2[], pixelLength: number): Vec2[] {
  if (path.length === 0 || pixelLength <= 0) return path;

  // Build cumulative distances
  const cumLen: number[] = [0];
  let totalLen = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    totalLen += d;
    cumLen.push(totalLen);
  }

  if (Math.abs(totalLen - pixelLength) < 0.01) return path;

  if (totalLen > pixelLength) {
    // Shorten: trim points beyond pixelLength, then interpolate final
    const result: Vec2[] = [];
    for (let i = 0; i < path.length; i++) {
      if (cumLen[i] > pixelLength) break;
      result.push({ ...path[i] });
    }
    // Interpolate final point along last segment
    const last = result.length - 1;
    if (last < path.length - 1) {
      const i = last;
      const segLen = cumLen[i + 1] - cumLen[i];
      if (segLen > 0) {
        const frac = (pixelLength - cumLen[i]) / segLen;
        result.push({
          x: path[i].x + (path[i + 1].x - path[i].x) * frac,
          y: path[i].y + (path[i + 1].y - path[i].y) * frac
        });
      }
    }
    return result;
  } else {
    // Extend: extrapolate along final tangent
    const end = path[path.length - 1];
    const prev = path[path.length - 2] ?? end;
    const dx = end.x - prev.x;
    const dy = end.y - prev.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-7) return path;
    const extend = pixelLength - totalLen;
    const result = path.map(p => ({ ...p }));
    result.push({
      x: end.x + (dx / segLen) * extend,
      y: end.y + (dy / segLen) * extend
    });
    return result;
  }
}

// --- Segment sub-path dispatcher ---

export function calculateSubPath(type: string, pts: Vec2[]): Vec2[] {
  switch (type) {
    case 'L':
      return linearToPiecewiseLinear(pts);
    case 'P':
      // Perfect curve: only valid for exactly 3 points
      if (pts.length === 3) {
        const arcPts = circularArcToPiecewiseLinear(pts);
        if (arcPts.length > 0) return arcPts;
      }
      // Fallthrough to bezier
      return bezierToPiecewiseLinear(pts);
    case 'C':
      return catmullToPiecewiseLinear(pts);
    case 'B':
    default:
      return bezierToPiecewiseLinear(pts);
  }
}

/**
 * Parses the full slider curve string from a .osu HitObject line and returns
 * the piecewise-linear approximated path clamped to pixelLength.
 *
 * Matches ConvertHitObjectParser.convertPathString + SliderPath.calculatePath +
 * SliderPath.calculateLength from ppy/osu.
 *
 * Format: "B|100:200|200:300|200:300|300:200|L|400:100" etc.
 * Head point (x, y) is prepended as the first control point with type from first token.
 */
export function parseSliderPath(
  curveRaw: string,
  headX: number,
  headY: number,
  pixelLength: number
): SliderPathPoint[] {
  if (!curveRaw) return [{ x: headX, y: headY }];

  const tokens = curveRaw.split('|');
  if (tokens.length === 0) return [{ x: headX, y: headY }];

  const segments: Array<{ type: string; pts: Vec2[] }> = [];
  let currentType = 'B';
  let currentPts: Vec2[] = [];
  let isFirst = true;

  for (const token of tokens) {
    if (token.length > 0 && /^[BLPCblpc]$/.test(token)) {
      if (!isFirst && currentPts.length > 0) {
        segments.push({ type: currentType, pts: currentPts });
        currentPts = [currentPts[currentPts.length - 1]];
      } else if (isFirst) {
        currentPts = [{ x: headX, y: headY }];
        isFirst = false;
      }
      currentType = token.toUpperCase();
    } else {
      if (isFirst) {
        currentPts = [{ x: headX, y: headY }];
        isFirst = false;
      }
      const colonIdx = token.indexOf(':');
      if (colonIdx !== -1) {
        const px = parseFloat(token.slice(0, colonIdx));
        const py = parseFloat(token.slice(colonIdx + 1));
        if (!isNaN(px) && !isNaN(py)) {
          currentPts.push({ x: px, y: py });
        }
      }
    }
  }
  if (currentPts.length > 0) {
    segments.push({ type: currentType, pts: currentPts });
  }

  if (segments.length === 0) return [{ x: headX, y: headY }];

  const calculatedPath: Vec2[] = [];

  for (const seg of segments) {
    const { type, pts } = seg;

    const subSegments: Vec2[][] = [];
    let subStart = 0;
    for (let i = 1; i < pts.length; i++) {
      const eq =
        Math.abs(pts[i].x - pts[i - 1].x) < 0.001 &&
        Math.abs(pts[i].y - pts[i - 1].y) < 0.001;
      if (eq && type !== 'C' && i < pts.length - 1) {
        subSegments.push(pts.slice(subStart, i));
        subStart = i;
      }
    }
    subSegments.push(pts.slice(subStart));

    for (const subPts of subSegments) {
      if (subPts.length === 0) continue;
      if (subPts.length === 1) {
        const last = calculatedPath[calculatedPath.length - 1];
        if (!last || Math.hypot(subPts[0].x - last.x, subPts[0].y - last.y) > 0.01) {
          calculatedPath.push({ ...subPts[0] });
        }
        continue;
      }

      const subPath = calculateSubPath(type, subPts);

      let skipFirst = false;
      if (calculatedPath.length > 0 && subPath.length > 0) {
        const last = calculatedPath[calculatedPath.length - 1];
        skipFirst =
          Math.abs(subPath[0].x - last.x) < 0.001 &&
          Math.abs(subPath[0].y - last.y) < 0.001;
      }

      for (let i = skipFirst ? 1 : 0; i < subPath.length; i++) {
        calculatedPath.push(subPath[i]);
      }
    }
  }

  if (calculatedPath.length === 0) return [{ x: headX, y: headY }];

  const finalPath = pixelLength > 0 ? clampPathToLength(calculatedPath, pixelLength) : calculatedPath;

  return finalPath;
}
