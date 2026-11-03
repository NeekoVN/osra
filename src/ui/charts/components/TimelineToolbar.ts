import { CHART_ICONS } from '../types.ts';

export interface TimelineToolbarCallbacks {
  onZoom: (factor: number) => void;
  onReset: () => void;
  onToggleLock: (locked: boolean) => void;
}

export class TimelineToolbar {
  private container: HTMLElement;
  private btnLock: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public render(callbacks: TimelineToolbarCallbacks): void {
    const toolbar = document.createElement('div');
    toolbar.className = 'telemetry-toolbar';
    toolbar.innerHTML = `
      <div class="telemetry-toolbar-left">
        <span class="telemetry-toolbar-label">TELEMETRY TIMELINE</span>
        <span class="telemetry-toolbar-hint">Ctrl + Scroll to Zoom • Shift + Scroll to Pan • Double-Click to Reset</span>
      </div>
      <div class="telemetry-toolbar-right">
        <div class="btn-group-segmented" role="group" aria-label="Timeline zoom controls">
          <button class="btn-tool-segment" id="btn-zoom-out" title="Zoom Out (Ctrl + Scroll Down)">${CHART_ICONS.zoomOut}<span>Out</span></button>
          <button class="btn-tool-segment" id="btn-zoom-in" title="Zoom In (Ctrl + Scroll Up)">${CHART_ICONS.zoomIn}<span>In</span></button>
        </div>
        <button class="btn-tool" id="btn-zoom-reset" title="Reset Zoom to Full Extent">${CHART_ICONS.reset}<span>Reset</span></button>
        <div class="toolbar-separator"></div>
        <button class="osu-switch cyan btn-lock" id="btn-lock-scrubber" aria-pressed="false" title="Lock playhead centered while timeline scrolls smoothly">
          <span class="lock-icon">${CHART_ICONS.lock}</span>
          <span class="switch-label">Lock Scrubber</span>
          <span class="switch-nub"><span class="nub-fill"></span></span>
        </button>
      </div>
    `;
    this.container.appendChild(toolbar);
    this.toolbarEl = toolbar;

    const btnZoomIn = toolbar.querySelector('#btn-zoom-in') as HTMLButtonElement;
    const btnZoomOut = toolbar.querySelector('#btn-zoom-out') as HTMLButtonElement;
    const btnReset = toolbar.querySelector('#btn-zoom-reset') as HTMLButtonElement;
    const btnLock = toolbar.querySelector('#btn-lock-scrubber') as HTMLButtonElement;

    this.btnLock = btnLock;
    this.setLockState(false);

    btnZoomIn.onclick = () => callbacks.onZoom(0.7);
    btnZoomOut.onclick = () => callbacks.onZoom(1.4);
    btnReset.onclick = () => callbacks.onReset();
    btnLock.onclick = () => {
      const isCurrentlyLocked = btnLock.getAttribute('aria-pressed') === 'true';
      callbacks.onToggleLock(!isCurrentlyLocked);
    };
  }

  public setLockState(follow: boolean): void {
    if (!this.btnLock) return;
    this.btnLock.setAttribute('aria-pressed', String(follow));
    this.btnLock.classList.toggle('is-active', follow);
    const iconSpan = this.btnLock.querySelector('.lock-icon') as HTMLElement | null;
    if (iconSpan) {
      iconSpan.innerHTML = follow ? CHART_ICONS.pin : CHART_ICONS.lock;
    }
    this.btnLock.title = follow
      ? 'Scrubber Locked (Click to Unlock)'
      : 'Lock playhead centered while timeline scrolls smoothly';
  }

  public destroy(): void {
    if (this.toolbarEl) {
      this.toolbarEl.remove();
      this.toolbarEl = null;
    }
    this.btnLock = null;
  }
}
