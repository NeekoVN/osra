import {
  getDifficultyAtTime,
  RollingDifficultyResult
} from '../../../core/math/RollingDifficulty.ts';
import { getDiffColor, getDiffTextColor } from '../../../core/math/ColorHelper.ts';

export class DifficultyHud {
  private diffChipEl: HTMLElement | null = null;
  private diffChipStarEl: HTMLElement | null = null;
  private diffChipValEl: HTMLElement | null = null;
  private diffAimValEl: HTMLElement | null = null;
  private diffSpeedValEl: HTMLElement | null = null;
  private diffReadingValEl: HTMLElement | null = null;

  public attach(parent: HTMLElement, peakSR: number, meanSR: number): void {
    const diffHud = document.createElement('div');
    diffHud.style.display = 'inline-flex';
    diffHud.style.alignItems = 'center';
    diffHud.style.gap = '6px';
    diffHud.innerHTML = `
      <span class="sr-pill diff-sr-chip" id="diff-live-sr-chip">
        <i id="diff-live-sr-star" class="sr-star fa-solid fa-star"></i>
        <span id="diff-live-sr-val">0.00</span>
      </span>
      <span class="telemetry-subtitle" id="diff-live-stats" style="margin-left: 2px;">
        Aim <span id="diff-live-aim" style="color:#FF8068;font-weight:600;">0.00</span>
        &nbsp;•&nbsp; Spd <span id="diff-live-speed" style="color:#4FFFD5;font-weight:600;">0.00</span>
        &nbsp;•&nbsp; Read <span id="diff-live-reading" style="color:#C645B8;font-weight:600;">0.00</span>
        &nbsp;•&nbsp; Peak <span style="color:#FFFFFF;font-weight:600;">${peakSR.toFixed(2)}★</span>
        &nbsp;•&nbsp; Mean <span style="color:#A68E99;">${meanSR.toFixed(2)}★</span>
      </span>
    `;

    const oldSubtitle = parent.querySelector('.telemetry-subtitle');
    if (oldSubtitle) oldSubtitle.remove();
    parent.appendChild(diffHud);

    this.diffChipEl = diffHud.querySelector('#diff-live-sr-chip');
    this.diffChipStarEl = diffHud.querySelector('#diff-live-sr-star');
    this.diffChipValEl = diffHud.querySelector('#diff-live-sr-val');
    this.diffAimValEl = diffHud.querySelector('#diff-live-aim');
    this.diffSpeedValEl = diffHud.querySelector('#diff-live-speed');
    this.diffReadingValEl = diffHud.querySelector('#diff-live-reading');
  }

  public update(currentTimeMs: number, rollingResult: RollingDifficultyResult | null): void {
    if (!rollingResult || !this.diffChipValEl) return;
    const cur = getDifficultyAtTime(rollingResult, currentTimeMs);
    if (!cur) return;

    const starBg = getDiffColor(cur.starRating);
    const starText = getDiffTextColor(cur.starRating);

    if (this.diffChipEl) {
      this.diffChipEl.style.backgroundColor = starBg;
      this.diffChipEl.style.color = starText;
    }
    if (this.diffChipStarEl) {
      this.diffChipStarEl.style.color = starText;
    }
    this.diffChipValEl.textContent = cur.starRating.toFixed(2);

    if (this.diffAimValEl) this.diffAimValEl.textContent = cur.aim.toFixed(2);
    if (this.diffSpeedValEl) this.diffSpeedValEl.textContent = cur.speed.toFixed(2);
    if (this.diffReadingValEl) this.diffReadingValEl.textContent = cur.reading.toFixed(2);
  }

  public destroy(): void {
    this.diffChipEl = null;
    this.diffChipStarEl = null;
    this.diffChipValEl = null;
    this.diffAimValEl = null;
    this.diffSpeedValEl = null;
    this.diffReadingValEl = null;
  }
}
