export function getPathPoints(obj: any): Array<{ x: number; y: number }> {
  if (obj.curvePoints && obj.curvePoints.length > 0) return obj.curvePoints;
  return [{ x: obj.x, y: obj.y }, obj.sliderEnd || { x: obj.x, y: obj.y }];
}

export function getPointAtProgress(
  points: Array<{ x: number; y: number }>,
  progress: number
): { x: number; y: number } {
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

export function slicePath(
  points: Array<{ x: number; y: number }>,
  startFrac: number,
  endFrac: number
): Array<{ x: number; y: number }> {
  if (points.length <= 1) return points;
  const start = Math.max(0, Math.min(1, startFrac));
  const end = Math.max(start, Math.min(1, endFrac));
  if (start === 0 && end === 1) return points;
  if (end - start < 0.0001) return [];

  let totalDist = 0;
  const dists: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    totalDist += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    dists.push(totalDist);
  }
  if (totalDist === 0) return [];

  const startDist = start * totalDist;
  const endDist = end * totalDist;

  const sliced: Array<{ x: number; y: number }> = [getPointAtProgress(points, start)];

  for (let i = 1; i < points.length - 1; i++) {
    if (dists[i] > startDist && dists[i] < endDist) {
      sliced.push(points[i]);
    }
  }

  sliced.push(getPointAtProgress(points, end));
  return sliced;
}

export function renderReverseArrowArc(
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
