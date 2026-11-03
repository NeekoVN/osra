import uPlot from 'uplot';

export class PlayheadOverlay {
  private container: HTMLElement;
  private playheadEl: HTMLElement | null = null;
  private playheadBadge: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public create(firstRowEl: HTMLElement | null): void {
    this.playheadEl = document.createElement('div');
    this.playheadEl.className = 'telemetry-playhead';
    this.playheadEl.innerHTML = `
      <div class="playhead-badge" id="playhead-badge">00:00.00</div>
      <div class="playhead-line"></div>
    `;
    this.container.appendChild(this.playheadEl);
    this.playheadBadge = this.playheadEl.querySelector('#playhead-badge') as HTMLElement;
    if (firstRowEl) {
      this.playheadEl.style.top = `${firstRowEl.offsetTop}px`;
    }
  }

  public updateTop(firstRowEl: HTMLElement | null): void {
    if (this.playheadEl && firstRowEl) {
      this.playheadEl.style.top = `${firstRowEl.offsetTop}px`;
    }
  }

  public update(
    currentTimeMs: number,
    chart: uPlot | undefined,
    firstRowEl: HTMLElement | null,
    followScrubber: boolean,
    currentMin: number,
    currentMax: number,
    scrollWindowMs: number,
    applyXScaleToAllCharts: (min: number, max: number) => void
  ): void {
    if (!this.playheadEl || !this.playheadBadge || !chart) return;

    if (firstRowEl && (!this.playheadEl.style.top || this.playheadEl.style.top === '')) {
      this.playheadEl.style.top = `${firstRowEl.offsetTop}px`;
    }

    // Handle Scrubber Centered Lock mode
    if (followScrubber) {
      const half = scrollWindowMs / 2;
      applyXScaleToAllCharts(currentTimeMs - half, currentTimeMs + half);

      const overRect = chart.over.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      const playheadLeft = overRect.left - containerRect.left + overRect.width / 2;

      this.playheadEl.style.display = 'block';
      this.playheadEl.style.left = `${playheadLeft}px`;

      const mins = Math.floor(Math.abs(currentTimeMs) / 60000);
      const secs = ((Math.abs(currentTimeMs) % 60000) / 1000).toFixed(2);
      const sign = currentTimeMs < 0 ? '-' : '';
      this.playheadBadge.textContent = `${sign}${mins}:${secs.padStart(5, '0')}`;
      return;
    }

    // Standard Free Playhead mode
    if (currentTimeMs < currentMin || currentTimeMs > currentMax) {
      this.playheadEl.style.display = 'none';
      return;
    }

    const px = chart.valToPos(currentTimeMs, 'x');
    const plotWidth = chart.bbox.width / (window.devicePixelRatio || 1);

    if (isNaN(px) || px < 0 || px > plotWidth) {
      this.playheadEl.style.display = 'none';
      return;
    }

    const overRect = chart.over.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const playheadLeft = overRect.left - containerRect.left + px;

    this.playheadEl.style.display = 'block';
    this.playheadEl.style.left = `${playheadLeft}px`;

    const mins = Math.floor(Math.abs(currentTimeMs) / 60000);
    const secs = ((Math.abs(currentTimeMs) % 60000) / 1000).toFixed(2);
    const sign = currentTimeMs < 0 ? '-' : '';
    this.playheadBadge.textContent = `${sign}${mins}:${secs.padStart(5, '0')}`;
  }

  public destroy(): void {
    if (this.playheadEl) {
      this.playheadEl.remove();
      this.playheadEl = null;
    }
    this.playheadBadge = null;
  }
}
