export function traceMonotoneSpline(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[]
): void {
  const n = pts.length;
  if (n < 2) return;
  if (n === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }

  const dx = new Float64Array(n - 1);
  const dy = new Float64Array(n - 1);
  const slope = new Float64Array(n - 1);

  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    dy[i] = pts[i + 1].y - pts[i].y;
    slope[i] = dx[i] !== 0 ? dy[i] / dx[i] : 0;
  }

  const m = new Float64Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];

  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (2 * slope[i - 1] * slope[i]) / (slope[i - 1] + slope[i]);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const segDx = dx[i];

    const cp1x = p0.x + segDx / 3;
    const cp1y = p0.y + (m[i] * segDx) / 3;
    const cp2x = p1.x - segDx / 3;
    const cp2y = p1.y - (m[i + 1] * segDx) / 3;

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p1.x, p1.y);
  }
}
