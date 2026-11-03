import { PlayfieldRenderer } from '../../ui/canvas/PlayfieldRenderer.ts';
import { HitScatterRenderer } from '../../ui/canvas/HitScatterRenderer.ts';
import { TelemetryCharts } from '../../ui/charts/TelemetryCharts.ts';
import { TimeBus } from '../../ui/TimeBus.ts';

export interface LayoutControllerOptions {
  timeBus: TimeBus;
  getPlayfieldRenderer: () => PlayfieldRenderer | null;
  getScatterRenderer: () => HitScatterRenderer | null;
  getTelemetryCharts: () => TelemetryCharts | null;
  onResetToIngestion: () => void;
}

export class LayoutController {
  private timeBus: TimeBus;
  private getPlayfieldRenderer: () => PlayfieldRenderer | null;
  private getScatterRenderer: () => HitScatterRenderer | null;
  private getTelemetryCharts: () => TelemetryCharts | null;
  private onResetToIngestion: () => void;

  constructor(options: LayoutControllerOptions) {
    this.timeBus = options.timeBus;
    this.getPlayfieldRenderer = options.getPlayfieldRenderer;
    this.getScatterRenderer = options.getScatterRenderer;
    this.getTelemetryCharts = options.getTelemetryCharts;
    this.onResetToIngestion = options.onResetToIngestion;
  }

  public setup(): void {
    window.addEventListener('resize', () => {
      this.updatePlayfieldDimensions();
      this.getScatterRenderer()?.handleResize();
      const t = this.timeBus.getCurrentTime();
      this.getPlayfieldRenderer()?.render(t);
      this.getScatterRenderer()?.render(t);
    });

    this.setupBrandAndImport();
    this.setupEventsPanel();
    this.setupPlayfieldControls();
    this.setupScatterControls();
    this.setupChartsExpandAll();
  }

  public updatePlayfieldDimensions(): void {
    const col = document.querySelector('.workspace-col-left') as HTMLElement | null;
    const playfieldPanel = document.getElementById('playfield-panel') as HTMLElement | null;
    const incidentsPanel = document.getElementById('incidents-panel') as HTMLElement | null;
    if (!col || !playfieldPanel) return;

    const isEventsMinimized = incidentsPanel?.classList.contains('minimized');
    const isPlayfieldExpanded = playfieldPanel.classList.contains('expanded');

    if (isEventsMinimized || isPlayfieldExpanded) {
      const colWidth = col.clientWidth - 32;
      const aspectHeight = Math.round(colWidth * 0.75) + 40;
      playfieldPanel.style.height = `${aspectHeight}px`;
    } else {
      playfieldPanel.style.height = '460px';
    }

    const renderer = this.getPlayfieldRenderer();
    renderer?.handleResize();
    renderer?.render(this.timeBus.getCurrentTime());
  }

  private setupBrandAndImport(): void {
    const brandHeader = document.getElementById('brand-header') || document.querySelector('.brand-cell');
    if (brandHeader) {
      brandHeader.addEventListener('click', () => {
        this.onResetToIngestion();
      });
    }
    const importBtn = document.getElementById('btn-import') as HTMLButtonElement | null;
    if (importBtn) {
      importBtn.addEventListener('click', () => {
        this.onResetToIngestion();
      });
    }
  }

  private setupEventsPanel(): void {
    document.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest?.('#btn-toggle-events') as HTMLElement | null;
      if (!btn) return;
      e.stopPropagation();
      const incidentsPanel = document.getElementById('incidents-panel');
      if (!incidentsPanel) return;
      const isMin = incidentsPanel.classList.toggle('minimized');
      btn.innerHTML = isMin
        ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`
        : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
      btn.title = isMin ? 'Expand Events Panel' : 'Minimize Events Panel';
      this.updatePlayfieldDimensions();
    });
  }

  private setupPlayfieldControls(): void {
    const btnExpandPlayfield = document.getElementById('btn-expand-playfield') as HTMLButtonElement | null;
    const playfieldPanel = document.getElementById('playfield-panel') as HTMLElement | null;
    if (btnExpandPlayfield && playfieldPanel) {
      btnExpandPlayfield.addEventListener('click', (e) => {
        e.stopPropagation();
        const isExp = playfieldPanel.classList.toggle('expanded');
        btnExpandPlayfield.title = isExp ? 'Reset Playfield Size' : 'Expand Playfield (4:3 Max)';
        this.updatePlayfieldDimensions();
      });
    }

    const btnToggleTrail = document.getElementById('btn-toggle-trail') as HTMLButtonElement | null;
    const btnTogglePathTrail = document.getElementById('btn-toggle-path-trail') as HTMLButtonElement | null;
    const btnToggleVectors = document.getElementById('btn-toggle-vectors') as HTMLButtonElement | null;

    const updateChipState = (
      btn: HTMLButtonElement | null,
      isEnabled: boolean,
      activeTitle: string,
      inactiveTitle: string
    ) => {
      if (!btn) return;
      btn.classList.toggle('is-active', isEnabled);
      btn.classList.toggle('off', !isEnabled);
      btn.setAttribute('aria-pressed', String(isEnabled));
      btn.title = isEnabled ? activeTitle : inactiveTitle;
    };

    const renderer = this.getPlayfieldRenderer();
    if (renderer) {
      updateChipState(btnToggleTrail, renderer.isTrailEnabled(), 'Click to disable Cursor Trail', 'Click to enable Cursor Trail');
      updateChipState(btnTogglePathTrail, renderer.isPathTrailEnabled(), 'Click to disable Long Path Trail', 'Click to enable Long Path Trail');
      updateChipState(btnToggleVectors, renderer.isErrorVectorsEnabled(), 'Click to disable Error Vectors', 'Click to enable Error Vectors');
    }

    if (btnToggleTrail) {
      btnToggleTrail.addEventListener('click', (e) => {
        e.stopPropagation();
        const pRenderer = this.getPlayfieldRenderer();
        if (!pRenderer) return;
        const isEnabled = pRenderer.toggleTrail();
        updateChipState(btnToggleTrail, isEnabled, 'Click to disable Cursor Trail', 'Click to enable Cursor Trail');
      });
    }

    if (btnTogglePathTrail) {
      btnTogglePathTrail.addEventListener('click', (e) => {
        e.stopPropagation();
        const pRenderer = this.getPlayfieldRenderer();
        if (!pRenderer) return;
        const isEnabled = pRenderer.togglePathTrail();
        updateChipState(btnTogglePathTrail, isEnabled, 'Click to disable Long Path Trail', 'Click to enable Long Path Trail');
      });
    }

    if (btnToggleVectors) {
      btnToggleVectors.addEventListener('click', (e) => {
        e.stopPropagation();
        const pRenderer = this.getPlayfieldRenderer();
        if (!pRenderer) return;
        const isEnabled = pRenderer.toggleErrorVectors();
        updateChipState(btnToggleVectors, isEnabled, 'Click to disable Error Vectors', 'Click to enable Error Vectors');
      });
    }
  }

  private setupScatterControls(): void {
    const btnExpandScatter = document.getElementById('btn-expand-scatter') as HTMLButtonElement | null;
    const scatterPanel = document.getElementById('scatter-panel') as HTMLElement | null;
    if (btnExpandScatter && scatterPanel) {
      btnExpandScatter.addEventListener('click', (e) => {
        e.stopPropagation();
        const isExp = scatterPanel.classList.toggle('expanded');
        btnExpandScatter.title = isExp ? 'Collapse Hit Scatter' : 'Expand Hit Scatter';
        btnExpandScatter.innerHTML = isExp
          ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="10" y1="14" x2="3" y2="21"></line></svg>`
          : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>`;
        const sRenderer = this.getScatterRenderer();
        sRenderer?.handleResize();
        sRenderer?.render(this.timeBus.getCurrentTime());
      });
    }
  }

  private setupChartsExpandAll(): void {
    const btnExpandAllCharts = document.getElementById('btn-toggle-expand-all-charts') as HTMLButtonElement | null;
    const updateExpandAllButton = (allExpanded: boolean) => {
      if (!btnExpandAllCharts) return;
      btnExpandAllCharts.title = allExpanded ? 'Collapse All Telemetry Charts' : 'Expand All Telemetry Charts';
      btnExpandAllCharts.innerHTML = allExpanded
        ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="10" y1="14" x2="3" y2="21"></line></svg>`
        : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>`;
    };

    if (btnExpandAllCharts) {
      btnExpandAllCharts.addEventListener('click', (e) => {
        e.stopPropagation();
        const charts = this.getTelemetryCharts();
        if (!charts) return;
        const allExpanded = charts.toggleExpandAll();
        updateExpandAllButton(allExpanded);
      });
    }

    const charts = this.getTelemetryCharts();
    if (charts) {
      charts.onExpandStateChange = (allExpanded) => {
        updateExpandAllButton(allExpanded);
      };
    }
  }
}
