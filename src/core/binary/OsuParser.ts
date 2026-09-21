import {
  Beatmap,
  BeatmapDifficulty,
  BeatmapMetadata,
  HitCircleObject,
  HitObject,
  HitObjectType,
  SliderObject,
  SliderPathPoint,
  SpinnerObject,
  TimingPoint
} from '../types/beatmap.ts';

/**
 * Parses raw .osu text file into structured Beatmap object with stack height calculations
 */
export function parseOsuBeatmap(content: string): Beatmap {
  const lines = content.split(/\r?\n/);
  let currentSection = '';

  let formatVersion = 14;
  let stackLeniency = 0.7;

  const metadata: BeatmapMetadata = {
    title: '',
    titleUnicode: '',
    artist: '',
    artistUnicode: '',
    creator: '',
    version: '',
    source: '',
    tags: [],
    beatmapId: 0,
    beatmapSetId: 0
  };

  const difficulty: BeatmapDifficulty = {
    hpDrainRate: 5,
    circleSize: 5,
    overallDifficulty: 5,
    approachRate: 5,
    sliderMultiplier: 1.4,
    sliderTickRate: 1
  };

  const timingPoints: TimingPoint[] = [];
  const rawHitObjects: HitObject[] = [];
  const comboColours: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith('//')) continue;

    if (rawLine.startsWith('osu file format v')) {
      const v = parseInt(rawLine.replace('osu file format v', ''), 10);
      if (!isNaN(v)) formatVersion = v;
      continue;
    }

    if (rawLine.startsWith('[') && rawLine.endsWith(']')) {
      currentSection = rawLine.substring(1, rawLine.length - 1);
      continue;
    }

    switch (currentSection) {
      case 'General': {
        const [key, ...vals] = rawLine.split(':');
        if (key.trim() === 'StackLeniency') {
          const val = parseFloat(vals.join(':').trim());
          if (!isNaN(val)) stackLeniency = val;
        }
        break;
      }
      case 'Metadata': {
        const [key, ...vals] = rawLine.split(':');
        const val = vals.join(':').trim();
        const k = key.trim();
        if (k === 'Title') metadata.title = val;
        else if (k === 'TitleUnicode') metadata.titleUnicode = val;
        else if (k === 'Artist') metadata.artist = val;
        else if (k === 'ArtistUnicode') metadata.artistUnicode = val;
        else if (k === 'Creator') metadata.creator = val;
        else if (k === 'Version') metadata.version = val;
        else if (k === 'Source') metadata.source = val;
        else if (k === 'Tags') metadata.tags = val.split(' ').filter(Boolean);
        else if (k === 'BeatmapID') metadata.beatmapId = parseInt(val, 10) || 0;
        else if (k === 'BeatmapSetID') metadata.beatmapSetId = parseInt(val, 10) || 0;
        break;
      }
      case 'Difficulty': {
        const [key, ...vals] = rawLine.split(':');
        const val = parseFloat(vals.join(':').trim()) || 0;
        const k = key.trim();
        if (k === 'HPDrainRate') difficulty.hpDrainRate = val;
        else if (k === 'CircleSize') difficulty.circleSize = val;
        else if (k === 'OverallDifficulty') {
          difficulty.overallDifficulty = val;
          // osu! default: if AR is not explicitly set, AR = OD
          if (difficulty.approachRate === 5) difficulty.approachRate = val;
        } else if (k === 'ApproachRate') difficulty.approachRate = val;
        else if (k === 'SliderMultiplier') difficulty.sliderMultiplier = val;
        else if (k === 'SliderTickRate') difficulty.sliderTickRate = val;
        break;
      }
      case 'Colours': {
        const [key, ...vals] = rawLine.split(':');
        const k = key.trim();
        if (k.startsWith('Combo')) {
          const rgbParts = vals.join(':').split(',').map(s => parseInt(s.trim(), 10));
          if (rgbParts.length >= 3 && !rgbParts.some(isNaN)) {
            const hex = '#' + rgbParts.slice(0, 3).map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
            comboColours.push(hex.toUpperCase());
          }
        }
        break;
      }
      case 'TimingPoints': {
        const parts = rawLine.split(',');
        if (parts.length >= 2) {
          const time = parseFloat(parts[0]);
          const beatLength = parseFloat(parts[1]);
          const meter = parts.length > 2 ? parseInt(parts[2], 10) || 4 : 4;
          const sampleSet = parts.length > 3 ? parseInt(parts[3], 10) || 0 : 0;
          const sampleIndex = parts.length > 4 ? parseInt(parts[4], 10) || 0 : 0;
          const volume = parts.length > 5 ? parseInt(parts[5], 10) || 100 : 100;
          const uninherited = parts.length > 6 ? parts[6].trim() === '1' : true;
          const effects = parts.length > 7 ? parseInt(parts[7], 10) || 0 : 0;

          timingPoints.push({
            time,
            beatLength,
            meter,
            sampleSet,
            sampleIndex,
            volume,
            uninherited,
            effects
          });
        }
        break;
      }
      case 'HitObjects': {
        const obj = parseHitObjectLine(rawLine);
        if (obj) rawHitObjects.push(obj);
        break;
      }
    }
  }

  // Sort timing points and hit objects by time
  timingPoints.sort((a, b) => a.time - b.time);
  rawHitObjects.sort((a, b) => a.time - b.time);

  // Compute authentic combo numbers and combo colors
  const defaultColors = ['#00D8FF', '#88FF66', '#FF66AB', '#FFD966', '#B87BFF'];
  const palette = comboColours.length > 0 ? comboColours : defaultColors;
  let colorIndex = 0;
  let comboNum = 1;

  for (let i = 0; i < rawHitObjects.length; i++) {
    const obj = rawHitObjects[i];
    if (i === 0) {
      comboNum = 1;
      colorIndex = 0;
    } else if (obj.isNewCombo) {
      const skip = ((obj.type >> 4) & 7) + 1;
      colorIndex = (colorIndex + skip) % palette.length;
      comboNum = 1;
    }
    obj.comboIndex = comboNum++;
    obj.comboColor = palette[colorIndex];
  }

  // Apply Stacking logic and compute stack offsets
  computeStacking(rawHitObjects, difficulty.circleSize, difficulty.approachRate, stackLeniency);

  // Compute slider velocities and durations
  computeSliderVelocitiesAndDurations(rawHitObjects, timingPoints, difficulty.sliderMultiplier);

  return {
    formatVersion,
    metadata,
    difficulty,
    timingPoints,
    hitObjects: rawHitObjects,
    stackLeniency,
    colours: {
      combos: palette
    },
    rawContent: content
  };
}

function parseHitObjectLine(line: string): HitObject | null {
  const parts = line.split(',');
  if (parts.length < 5) return null;

  const x = parseFloat(parts[0]);
  const y = parseFloat(parts[1]);
  const time = parseFloat(parts[2]);
  const type = parseInt(parts[3], 10);
  const hitSound = parseInt(parts[4], 10);
  const isNewCombo = (type & HitObjectType.NewCombo) !== 0;

  const base = {
    x,
    y,
    time,
    type,
    hitSound,
    isNewCombo,
    comboIndex: 1,
    stackHeight: 0,
    stackedX: x,
    stackedY: y
  };

  if (type & HitObjectType.Circle) {
    const circle: HitCircleObject = {
      ...base,
      objectType: 'circle'
    };
    return circle;
  }

  if (type & HitObjectType.Slider) {
    const curveRaw = parts[5] || '';
    const repeatCount = parts.length > 6 ? parseInt(parts[6], 10) || 1 : 1;
    const pixelLength = parts.length > 7 ? parseFloat(parts[7]) || 0 : 0;

    // Parse multi-segment slider path matching ConvertHitObjectParser.convertPathString
    const approximatedPath = parseSliderPath(curveRaw, x, y, pixelLength);
    const curveType = (curveRaw.split('|')[0] || 'B').toUpperCase();
    const sliderEnd = approximatedPath.length > 0 ? approximatedPath[approximatedPath.length - 1] : { x, y };

    const slider: SliderObject = {
      ...base,
      objectType: 'slider',
      curveType,
      curvePoints: approximatedPath,
      repeatCount,
      pixelLength,
      duration: 0,
      endTime: time,
      ticks: [],
      sliderEnd
    };
    return slider;
  }

  if (type & HitObjectType.Spinner) {
    const endTime = parts.length > 5 ? parseFloat(parts[5]) || time : time;
    const spinner: SpinnerObject = {
      ...base,
      objectType: 'spinner',
      endTime
    };
    return spinner;
  }

  return null;
}

/**
 * Computes osu! standard stack heights matching osu!lazer
 */
function computeStacking(
  hitObjects: HitObject[],
  circleSize: number,
  approachRate: number,
  stackLeniency: number
): void {
  const n = hitObjects.length;
  if (n === 0) return;

  // Compute AR preempt time
  let preempt = 1200;
  if (approachRate < 5) {
    preempt = 1200 + 600 * (5 - approachRate) / 5;
  } else if (approachRate > 5) {
    preempt = 1200 - 750 * (approachRate - 5) / 5;
  }

  const stackThreshold = preempt * stackLeniency;
  const scale = (0.85 - 0.07 * circleSize) * 1.00041;
  const stackOffsetPerHeight = scale * -6.4;

  // Stacking reverse scan
  for (let i = n - 1; i > 0; i--) {
    let current = hitObjects[i];
    if (current.stackHeight !== 0 || current.objectType === 'spinner') continue;

    const startX = current.x;
    const startY = current.y;

    for (let j = i - 1; j >= 0; j--) {
      const prev = hitObjects[j];
      if (prev.objectType === 'spinner') continue;

      if (current.time - prev.time > stackThreshold) break;

      const dx = Math.abs(prev.x - startX);
      const dy = Math.abs(prev.y - startY);

      if (dx < 3 && dy < 3) {
        prev.stackHeight = current.stackHeight + 1;
        current = prev;
      }
    }
  }

  // Apply stacked positions
  for (let i = 0; i < n; i++) {
    const obj = hitObjects[i];
    if (obj.stackHeight > 0) {
      obj.stackedX = obj.x + obj.stackHeight * stackOffsetPerHeight;
      obj.stackedY = obj.y + obj.stackHeight * stackOffsetPerHeight;
    }
  }
}

/**
 * Computes authentic slider velocities and durations using uninherited and inherited timing points
 */
function computeSliderVelocitiesAndDurations(
  hitObjects: HitObject[],
  timingPoints: TimingPoint[],
  sliderMultiplier: number
): void {
  for (const obj of hitObjects) {
    if (obj.objectType !== 'slider') continue;

    let uninheritedTp: TimingPoint | null = null;
    let inheritedTp: TimingPoint | null = null;

    for (const tp of timingPoints) {
      if (tp.time > obj.time) break;
      if (tp.uninherited) {
        uninheritedTp = tp;
        inheritedTp = null;
      } else {
        inheritedTp = tp;
      }
    }

    if (!uninheritedTp) {
      uninheritedTp = timingPoints.find(t => t.uninherited) || timingPoints[0] || {
        time: 0,
        beatLength: 500,
        meter: 4,
        sampleSet: 0,
        sampleIndex: 0,
        volume: 100,
        uninherited: true,
        effects: 0
      };
    }

    let bpmMultiplier = 1;
    if (inheritedTp && inheritedTp.beatLength < 0) {
      bpmMultiplier = Math.max(0.1, Math.min(10, -inheritedTp.beatLength / 100));
    }

    const scoringDistance = 100 * sliderMultiplier;
    const velocity = scoringDistance / (uninheritedTp.beatLength * bpmMultiplier);
    const spanCount = Math.max(1, obj.repeatCount);
    const duration = velocity > 0 ? (spanCount * obj.pixelLength) / velocity : 0;

    obj.duration = duration;
    obj.endTime = obj.time + duration;
  }
}

// =============================================================================
// osu! PathApproximator port - matching osu-framework and osu SliderPath.cs
// =============================================================================

const BEZIER_TOLERANCE = 0.25;
const CIRCULAR_ARC_TOLERANCE = 0.1;
const CATMULL_DETAIL = 50;

type Vec2 = { x: number; y: number };

// --- Circular Arc (Perfect Curve / 'P') ---

interface CircularArcProps {
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
function getCircularArcProps(pts: Vec2[]): CircularArcProps {
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
function circularArcToPiecewiseLinear(pts: Vec2[]): Vec2[] {
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

function catmullFindPoint(v1: Vec2, v2: Vec2, v3: Vec2, v4: Vec2, t: number): Vec2 {
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
function catmullToPiecewiseLinear(pts: Vec2[]): Vec2[] {
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

function bezierIsFlatEnough(pts: Vec2[]): boolean {
  for (let i = 1; i < pts.length - 1; i++) {
    const ux = pts[i - 1].x - 2 * pts[i].x + pts[i + 1].x;
    const uy = pts[i - 1].y - 2 * pts[i].y + pts[i + 1].y;
    if (ux * ux + uy * uy > BEZIER_TOLERANCE * BEZIER_TOLERANCE * 4) return false;
  }
  return true;
}

function bezierSubdivide(pts: Vec2[], l: Vec2[], r: Vec2[], mid: Vec2[]): void {
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

function bezierApproximate(pts: Vec2[], output: Vec2[], l: Vec2[], r: Vec2[], mid: Vec2[]): void {
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
function bezierToPiecewiseLinear(pts: Vec2[]): Vec2[] {
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

function linearToPiecewiseLinear(pts: Vec2[]): Vec2[] {
  return pts.map(p => ({ ...p }));
}

// --- Path length clamping/extension (SliderPath.calculateLength) ---

/**
 * Clamps or extends a calculated path to exactly pixelLength.
 * Port of SliderPath.calculateLength.
 */
function clampPathToLength(path: Vec2[], pixelLength: number): Vec2[] {
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

function calculateSubPath(type: string, pts: Vec2[]): Vec2[] {
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

// --- Main entry point: parse .osu slider curve string ---

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
function parseSliderPath(
  curveRaw: string,
  headX: number,
  headY: number,
  pixelLength: number
): SliderPathPoint[] {
  if (!curveRaw) return [{ x: headX, y: headY }];

  const tokens = curveRaw.split('|');
  if (tokens.length === 0) return [{ x: headX, y: headY }];

  // Each token is either a type letter (B, L, P, C) or a "x:y" point.
  // Build a list of segments: { type, points: Vec2[] }
  const segments: Array<{ type: string; pts: Vec2[] }> = [];
  let currentType = 'B';
  let currentPts: Vec2[] = [];
  let isFirst = true;

  for (const token of tokens) {
    if (token.length > 0 && /^[BLPCblpc]$/.test(token)) {
      // New segment type
      if (!isFirst && currentPts.length > 0) {
        segments.push({ type: currentType, pts: currentPts });
        // The last point of the previous segment becomes the first of the next
        currentPts = [currentPts[currentPts.length - 1]];
      } else if (isFirst) {
        // Head point is first point of first segment
        currentPts = [{ x: headX, y: headY }];
        isFirst = false;
      }
      currentType = token.toUpperCase();
    } else {
      if (isFirst) {
        // Very first token should be a type but if it's a point, default to 'B'
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
  // Push last segment
  if (currentPts.length > 0) {
    segments.push({ type: currentType, pts: currentPts });
  }

  if (segments.length === 0) return [{ x: headX, y: headY }];

  // For each segment, split on knot-doubled points (matching osu! implicit segments),
  // then approximate each sub-segment and join. Follows SliderPath.calculatePath logic:
  // consecutive identical points mark the boundary between implicit Bezier sub-segments.
  const calculatedPath: Vec2[] = [];

  for (const seg of segments) {
    const { type, pts } = seg;

    // Split on knot-doubled (repeated adjacent) control points -> implicit sub-segments
    // Exception: Catmull sliders never split (old stable behavior preserved)
    const subSegments: Vec2[][] = [];
    let subStart = 0;
    for (let i = 1; i < pts.length; i++) {
      const eq =
        Math.abs(pts[i].x - pts[i - 1].x) < 0.001 &&
        Math.abs(pts[i].y - pts[i - 1].y) < 0.001;
      if (eq && type !== 'C' && i < pts.length - 1) {
        subSegments.push(pts.slice(subStart, i));
        subStart = i; // start of next sub-segment (reuses the knot point)
      }
    }
    subSegments.push(pts.slice(subStart));

    for (const subPts of subSegments) {
      if (subPts.length === 0) continue;
      if (subPts.length === 1) {
        // Single point: add if not duplicate of last
        const last = calculatedPath[calculatedPath.length - 1];
        if (!last || Math.hypot(subPts[0].x - last.x, subPts[0].y - last.y) > 0.01) {
          calculatedPath.push({ ...subPts[0] });
        }
        continue;
      }

      const subPath = calculateSubPath(type, subPts);

      // Skip first point if it duplicates the last added point (matching SliderPath.calculatePath)
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

  // Clamp / extend path to pixelLength
  const finalPath = pixelLength > 0 ? clampPathToLength(calculatedPath, pixelLength) : calculatedPath;

  return finalPath;
}

