import { parseOsrReplay } from './core/binary/OsrParser.ts';
import { parseOsuBeatmap } from './core/binary/OsuParser.ts';
import { parseOszPackage, OszPackage, OszDifficultyEntry } from './core/binary/OszParser.ts';
import { MirrorClient } from './core/api/MirrorClient.ts';
import { calculateEffectiveDifficulty, getGameplayRateFromMods } from './core/math/HitWindows.ts';
import { calculateLazerAccuracy } from './core/math/RollingAccuracy.ts';
import { OsrReplay } from './core/types/replay.ts';
import { Beatmap } from './core/types/beatmap.ts';
import { evaluateReplaySession, getModdedBeatmap, EvaluationResult } from './core/evaluator/ReplayEvaluator.ts';
import { TimedHitEvent } from './core/types/telemetry.ts';
import { PerformancePoints, PerformanceBreakdown, DifficultyAttributes } from './core/math/PerformancePoints.ts';
import {
  calculateLazerDifficulty,
  createLazerGradualPerformance,
  LazerDifficultyAttributes,
  LazerPerformanceBreakdown
} from './core/math/LazerDifficulty.ts';
import { getDiffColor, getDiffTextColor } from './core/math/ColorHelper.ts';
import { buildPrefixCombo } from './core/math/ComboTracker.ts';
import { renderModBadges } from './ui/components/ModBadges.ts';
import { Odometer, ODO_ACC, ODO_COMBO, ODO_INT, ODO_PP, ODO_UR, type OdometerOptions } from './ui/components/Odometer.ts';

// UI Components
import { TimeBus } from './ui/TimeBus.ts';
import { PlayfieldRenderer } from './ui/canvas/PlayfieldRenderer.ts';
import { HitScatterRenderer } from './ui/canvas/HitScatterRenderer.ts';
import { TelemetryCharts } from './ui/charts/TelemetryCharts.ts';
import { IncidentsDrawer } from './ui/components/IncidentsDrawer.ts';
import { PlaybackControls } from './ui/components/PlaybackControls.ts';
import sampleClickUrl from './assets/sounds/osu-logo-select.wav';

const BADGE_ICONS = import.meta.glob<string>('./assets/icons/Badges/*.svg', { eager: true, import: 'default' });

let currentReplay: OsrReplay | null = null;
let currentBeatmap: Beatmap | null = null;
let currentPackage: OszPackage | null = null;
let currentEval: EvaluationResult | null = null;
let currentBackgroundBlobUrl: string | null = null;
let currentDiffAttributes: DifficultyAttributes | null = null;
let maxPossiblePP: PerformanceBreakdown | null = null;
let currentBeatmapStarRating: number | undefined = undefined;

let currentLazerDiff: LazerDifficultyAttributes | null = null;
let precomputedLivePP: LazerPerformanceBreakdown[] = [];

// Time & Rendering Bus
const timeBus = new TimeBus();
let playfieldRenderer: PlayfieldRenderer | null = null;
let scatterRenderer: HitScatterRenderer | null = null;
let telemetryCharts: TelemetryCharts | null = null;
let incidentsDrawer: IncidentsDrawer | null = null;
let playbackControls: PlaybackControls | null = null;

// Ingestion & Transition DOM Elements
const ingestionStage = document.getElementById('ingestion-stage') as HTMLElement;
const logoHoverContainer = document.getElementById('logo-hover-container') as HTMLElement;
const logoBounceContainer = document.getElementById('logo-bounce-container') as HTMLElement;
const flashLayer = document.getElementById('flash-layer') as HTMLElement;
const ringProgress = document.getElementById('ring-progress') as SVGCircleElement | null;
const replayInput = document.getElementById('replay-input') as HTMLInputElement;

const dockReplayBar = document.getElementById('dock-replay-bar') as HTMLElement;
const dockPlayer = document.getElementById('dock-player') as HTMLElement;
const dockHash = document.getElementById('dock-hash') as HTMLElement;
const dockMods = document.getElementById('dock-mods') as HTMLElement;
const beatmapInput = document.getElementById('beatmap-input') as HTMLInputElement;
const diffLadder = document.getElementById('diff-ladder') as HTMLElement;
const diffButtons = document.getElementById('diff-buttons') as HTMLElement;
const dockSubmitBtn = document.getElementById('dock-submit-btn') as HTMLButtonElement;

const wavesViewport = document.getElementById('waves-viewport') as HTMLElement;

const audioPlayer = document.getElementById('audio-player') as HTMLAudioElement;

const analyzerWorkspace = document.getElementById('analyzer-workspace') as HTMLElement;
const headerMetadata = document.getElementById('header-metadata') as HTMLElement;
const beatmapDiffGrid = document.getElementById('beatmap-diff-grid') as HTMLElement;

// Canvases & Containers
const playfieldCanvas = document.getElementById('playfield-canvas') as HTMLCanvasElement;
const scatterCanvas = document.getElementById('scatter-canvas') as HTMLCanvasElement;
const incidentsContainer = document.getElementById('incidents-container') as HTMLElement;
const playbackContainer = document.getElementById('playback-container') as HTMLElement;
const chartsContainer = document.getElementById('charts-container') as HTMLElement;

// Precomputed prefix statistics for real-time top bar updates
interface PrefixHitStat {
  time: number;
  c300: number;
  c100: number;
  c50: number;
  cMiss: number;
  combo: number;
  maxComboSoFar: number;
  acc: number;
  ticksHit: number;
  maxTicks: number;
  endsHit: number;
  maxEnds: number;
  ppStep: boolean;
  headIdx: number;
}
let prefixStats: PrefixHitStat[] = [];

// Odometer-style rolling numbers for the top-bar stats (ACC / combo / UR /
// PP / judgements). Bound lazily to their elements; targets stream in at
// TimeBus rate and each digit strip interpolates via CSS transition with a
// motion-blur class while rolling.
const odometers = new Map<string, { odo: Odometer; el: HTMLElement }>();
// Minimum integer slots per odometer: invisible ghost digits keep every
// value right-aligned in a fixed-width box so digits never shift as numbers
// grow. ACC caps at 100 and UR stays below 100 in practice; the rest derive
// from the loaded map in reserveHstatsWidths().
const odoMinInt = new Map<string, number>([['acc', 3], ['ur', 2]]);
function odoSet(key: string, el: HTMLElement | null, value: number, opts: OdometerOptions, snap: boolean): void {
  if (!el) return;
  let entry = odometers.get(key);
  if (!entry || entry.el !== el) {
    entry = { odo: new Odometer(el, opts), el };
    odometers.set(key, entry);
  }
  const minInt = odoMinInt.get(key);
  if (minInt !== undefined) entry.odo.setMinIntDigits(minInt);
  entry.odo.set(value, snap);
}
function resetOdometers(): void {
  odometers.clear();
}
// Last live-stat frame, used to detect seek jumps (snap instead of rolling).
let lastLiveTime = 0;
let lastLiveIdx = -1;

/** Actual gameplay clock rate for the loaded replay (e.g. DT@1.2x), from soloScoreInfo mods or the bitmask */
let currentReplayRate = 1.0;

// Initialize components
function initializeComponents() {
  playfieldRenderer = new PlayfieldRenderer(playfieldCanvas);
  scatterRenderer = new HitScatterRenderer(scatterCanvas);
  telemetryCharts = new TelemetryCharts(chartsContainer, timeBus);
  incidentsDrawer = new IncidentsDrawer(incidentsContainer, timeBus);
  playbackControls = new PlaybackControls(playbackContainer, timeBus);

  timeBus.setAudioElement(audioPlayer);

  // Subscribe renderers and live top bar stats to time bus
  timeBus.subscribe((t) => {
    playfieldRenderer?.render(t);
    scatterRenderer?.render(t);
    updateLiveStats(t);
  });

  timeBus.subscribeRate((rate) => {
    playfieldRenderer?.setPlaybackRate(rate);
  });

  window.addEventListener('resize', () => {
    updatePlayfieldDimensions();
    scatterRenderer?.handleResize();
    const t = timeBus.getCurrentTime();
    playfieldRenderer?.render(t);
    scatterRenderer?.render(t);
  });

  // Torus loads async via @font-face, so widths measured before it arrives
  // use the fallback font — re-reserve once the real digits exist.
  if (typeof document !== 'undefined' && document.fonts) {
    void document.fonts.ready.then(() => {
      if (currentBeatmap) reserveHstatsWidths();
    });
  }

  setupLayoutControls();
  setupLogoRig();
}

function updatePlayfieldDimensions(): void {
  const col = document.querySelector('.workspace-col-left') as HTMLElement | null;
  const playfieldPanel = document.getElementById('playfield-panel') as HTMLElement | null;
  const incidentsPanel = document.getElementById('incidents-panel') as HTMLElement | null;
  if (!col || !playfieldPanel) return;

  const isEventsMinimized = incidentsPanel?.classList.contains('minimized');
  const isPlayfieldExpanded = playfieldPanel.classList.contains('expanded');

  if (isEventsMinimized || isPlayfieldExpanded) {
    const colWidth = col.clientWidth - 32; // 16px padding on each side
    // 512x384 aspect ratio: canvas height = colWidth * (384 / 512) = colWidth * 0.75
    const aspectHeight = Math.round(colWidth * 0.75) + 40; // +40px panel header
    playfieldPanel.style.height = `${aspectHeight}px`;
  } else {
    playfieldPanel.style.height = '460px';
  }

  playfieldRenderer?.handleResize();
  playfieldRenderer?.render(timeBus.getCurrentTime());
}

function resetToIngestion(): void {
  // Abort any in-flight gradual-PP fill from a previous evaluation.
  evalRunCounter++;
  isEvaluating = false;
  wavesViewport?.classList.remove('is-covering', 'is-revealing');
  timeBus.pause();
  timeBus.seek(0);

  // 2. Stop audio player and clear source
  audioPlayer.pause();
  audioPlayer.removeAttribute('src');
  audioPlayer.load();

  // 3. Revoke audio & background blob URLs if present
  if (currentPackage?.audioBlobUrl) {
    try { URL.revokeObjectURL(currentPackage.audioBlobUrl); } catch { /* noop */ }
  }
  if (currentBackgroundBlobUrl) {
    try { URL.revokeObjectURL(currentBackgroundBlobUrl); } catch { /* noop */ }
  }

  // 4. Reset core state variables
  currentReplay = null;
  currentBeatmap = null;
  currentPackage = null;
  currentEval = null;
  currentBackgroundBlobUrl = null;
  currentDiffAttributes = null;
  maxPossiblePP = null;
  currentBeatmapStarRating = undefined;
  currentLazerDiff = null;
  precomputedLivePP = [];
  prefixStats = [];
  resetOdometers();
  lastLiveTime = 0;
  lastLiveIdx = -1;

  // 5. Reset UI components
  playfieldRenderer?.clear();
  scatterRenderer?.setData([]);
  scatterRenderer?.render(0);
  telemetryCharts?.destroy();
  incidentsDrawer?.setData([], []);
  playbackControls?.setIncidents([]);
  playbackControls?.setSkipInfo(0, []);

  // 6. Reset ingestion stage UI
  document.body.classList.add('ingestion-active');
  analyzerWorkspace.style.display = 'none';
  headerMetadata.style.display = 'none';
  if (beatmapDiffGrid) beatmapDiffGrid.style.display = 'none';

  if (ingestionStage) {
    ingestionStage.classList.remove('dock-active', 'fetching');
  }
  setProgress(0);
  if (dockReplayBar) dockReplayBar.style.display = 'none';
  if (diffLadder) diffLadder.style.display = 'none';
  if (dockSubmitBtn) dockSubmitBtn.style.display = 'none';
  if (diffButtons) diffButtons.innerHTML = '';
  if (replayInput) replayInput.value = '';
  if (beatmapInput) beatmapInput.value = '';

  // 7. Reset top header titles
  const rankTileReset = document.getElementById('meta-rank');
  if (rankTileReset) {
    rankTileReset.hidden = true;
    delete rankTileReset.dataset.currentRank;
    rankTileReset.innerHTML = '';
  }
  const srPillReset = document.getElementById('meta-sr-pill');
  if (srPillReset) srPillReset.hidden = true;
  const modsReset = document.getElementById('meta-mods-container');
  if (modsReset) {
    modsReset.innerHTML = '';
    modsReset.style.display = 'none';
  }
  const topTitle = document.getElementById('top-title');
  if (topTitle) topTitle.textContent = 'REPLAY ANALYZER';
  const topSubtitle = document.getElementById('top-subtitle');
  if (topSubtitle) topSubtitle.textContent = 'osu!standard • lazer ruleset';
}

function setupLayoutControls(): void {
  const brandHeader = document.getElementById('brand-header') || document.querySelector('.brand-cell');
  if (brandHeader) {
    brandHeader.addEventListener('click', () => {
      resetToIngestion();
    });
  }
  const importBtn = document.getElementById('btn-import') as HTMLButtonElement | null;
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      resetToIngestion();
    });
  }
  // Events minimize toggle lives inside the drawer-rendered tabs bar, so it is
  // bound via delegation (the button is recreated on every tab switch).
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
    updatePlayfieldDimensions();
  });

  const btnExpandPlayfield = document.getElementById('btn-expand-playfield') as HTMLButtonElement | null;
  const playfieldPanel = document.getElementById('playfield-panel') as HTMLElement | null;
  if (btnExpandPlayfield && playfieldPanel) {
    btnExpandPlayfield.addEventListener('click', (e) => {
      e.stopPropagation();
      const isExp = playfieldPanel.classList.toggle('expanded');
      btnExpandPlayfield.title = isExp ? 'Reset Playfield Size' : 'Expand Playfield (4:3 Max)';
      updatePlayfieldDimensions();
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

  if (playfieldRenderer) {
    updateChipState(btnToggleTrail, playfieldRenderer.isTrailEnabled(), 'Click to disable Cursor Trail', 'Click to enable Cursor Trail');
    updateChipState(btnTogglePathTrail, playfieldRenderer.isPathTrailEnabled(), 'Click to disable Long Path Trail', 'Click to enable Long Path Trail');
    updateChipState(btnToggleVectors, playfieldRenderer.isErrorVectorsEnabled(), 'Click to disable Error Vectors', 'Click to enable Error Vectors');
  }

  if (btnToggleTrail) {
    btnToggleTrail.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!playfieldRenderer) return;
      const isEnabled = playfieldRenderer.toggleTrail();
      updateChipState(btnToggleTrail, isEnabled, 'Click to disable Cursor Trail', 'Click to enable Cursor Trail');
    });
  }

  if (btnTogglePathTrail) {
    btnTogglePathTrail.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!playfieldRenderer) return;
      const isEnabled = playfieldRenderer.togglePathTrail();
      updateChipState(btnTogglePathTrail, isEnabled, 'Click to disable Long Path Trail', 'Click to enable Long Path Trail');
    });
  }

  if (btnToggleVectors) {
    btnToggleVectors.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!playfieldRenderer) return;
      const isEnabled = playfieldRenderer.toggleErrorVectors();
      updateChipState(btnToggleVectors, isEnabled, 'Click to disable Error Vectors', 'Click to enable Error Vectors');
    });
  }

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
      scatterRenderer?.handleResize();
      scatterRenderer?.render(timeBus.getCurrentTime());
    });
  }

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
      if (!telemetryCharts) return;
      const allExpanded = telemetryCharts.toggleExpandAll();
      updateExpandAllButton(allExpanded);
    });
  }

  if (telemetryCharts) {
    telemetryCharts.onExpandStateChange = (allExpanded) => {
      updateExpandAllButton(allExpanded);
    };
  }
}


initializeComponents();

// ========================================================
// INGESTION LOGIC & WAVE TRANSITION
// ========================================================
const sampleClick = new Audio(sampleClickUrl);
sampleClick.volume = 0.4;

function playLogoClick(): void {
  try {
    sampleClick.currentTime = 0;
    sampleClick.volume = 0.4;
    sampleClick.play().catch(() => { });
  } catch { }
}

function setProgress(fraction: number): void {
  if (!ringProgress) return;
  const circumference = 892.2;
  const offset = circumference * (1 - Math.max(0, Math.min(1, fraction)));
  ringProgress.style.strokeDashoffset = offset.toString();
}

function setupLogoRig(): void {
  if (!logoHoverContainer || !logoBounceContainer) return;

  logoHoverContainer.addEventListener('mouseenter', () => {
    logoHoverContainer.classList.add('hovered');
  });

  logoHoverContainer.addEventListener('mouseleave', () => {
    logoHoverContainer.classList.remove('hovered');
    logoBounceContainer.classList.remove('pressed');
  });

  logoBounceContainer.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    logoBounceContainer.classList.add('pressed');
  });

  window.addEventListener('mouseup', () => {
    logoBounceContainer.classList.remove('pressed');
  });

  logoBounceContainer.addEventListener('click', () => {
    playLogoClick();
    if (flashLayer) {
      flashLayer.classList.remove('flashing');
      void flashLayer.offsetWidth;
      flashLayer.classList.add('flashing');
      setTimeout(() => {
        flashLayer.classList.remove('flashing');
      }, 50);
    }
  });

  if (replayInput) {
    replayInput.addEventListener('change', async (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) handleReplayFile(file);
    });
  }

  if (beatmapInput) {
    beatmapInput.addEventListener('change', async (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) handleBeatmapOrPackageFile(file);
    });
  }

  if (dockSubmitBtn) {
    dockSubmitBtn.addEventListener('click', () => {
      if (currentReplay && currentBeatmap) {
        triggerEvaluation();
      }
    });
  }

  window.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
  });

  window.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.osr')) {
      handleReplayFile(file);
    } else if (lower.endsWith('.osu') || lower.endsWith('.osz') || lower.endsWith('.zip')) {
      handleBeatmapOrPackageFile(file);
    }
  });
}

function revealDock(): void {
  if (ingestionStage) {
    ingestionStage.classList.add('dock-active');
  }
  updateDockReplayInfo();
}

function updateDockReplayInfo(): void {
  if (!currentReplay) return;
  if (dockReplayBar) dockReplayBar.style.display = 'flex';
  if (dockPlayer) dockPlayer.textContent = currentReplay.playerName || 'Player';
  if (dockHash) dockHash.textContent = currentReplay.beatmapHash ? currentReplay.beatmapHash.slice(0, 10) + '...' : '';
  if (dockMods) {
    dockMods.textContent = '';
    renderModBadges(dockMods, currentReplay);
  }
}

async function handleReplayFile(file: File): Promise<void> {
  try {
    const buffer = await file.arrayBuffer();
    currentReplay = await parseOsrReplay(buffer);

    updateDockReplayInfo();

    if (!currentBeatmap && currentReplay.beatmapHash) {
      await autoFetchBeatmapFromMirror(currentReplay.beatmapHash);
    } else if (currentPackage) {
      matchPackageWithReplay();
    } else if (currentBeatmap) {
      triggerEvaluation();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    alert(`Error parsing replay: ${msg}`);
    revealDock();
  }
}

async function handleBeatmapOrPackageFile(file: File): Promise<void> {
  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith('.osz') || lower.endsWith('.zip')) {
      const buffer = await file.arrayBuffer();
      const targetHash = currentReplay?.beatmapHash;
      currentPackage = parseOszPackage(buffer, targetHash);

      if (currentPackage.audioBlobUrl) {
        audioPlayer.src = currentPackage.audioBlobUrl;
        audioPlayer.volume = timeBus.getVolume();
      }

      currentBackgroundBlobUrl = currentPackage.backgroundBlobUrl || null;
      playfieldRenderer?.setBackground(currentBackgroundBlobUrl);

      matchPackageWithReplay();
    } else {
      const text = await file.text();
      currentBeatmap = parseOsuBeatmap(text);
      if (currentReplay) {
        triggerEvaluation();
      } else {
        revealDock();
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    alert(`Error parsing beatmap: ${msg}`);
  }
}

function matchPackageWithReplay(): void {
  if (!currentPackage || currentPackage.difficulties.length === 0) return;

  let selectedDiff: OszDifficultyEntry | null = null;
  if (currentReplay?.beatmapHash) {
    const norm = currentReplay.beatmapHash.toLowerCase();
    selectedDiff = currentPackage.difficulties.find(d => d.checksum.toLowerCase() === norm) || null;
  }

  if (selectedDiff) {
    currentBeatmap = selectedDiff.beatmap;
    triggerEvaluation();
  } else {
    revealDock();
    renderDifficultySelector(currentPackage.difficulties);
    currentBeatmap = currentPackage.difficulties[0].beatmap;
  }
}

function renderDifficultySelector(diffs: OszDifficultyEntry[]): void {
  if (diffLadder) diffLadder.style.display = 'flex';
  if (dockSubmitBtn) dockSubmitBtn.style.display = 'block';
  if (!diffButtons) return;
  diffButtons.innerHTML = '';

  diffs.forEach((d) => {
    const row = document.createElement('div');
    row.className = `diff-row ${d.beatmap === currentBeatmap ? 'active' : ''}`;
    const estSR = PerformancePoints.estimateDifficultyAttributes(d.beatmap).starRating;
    row.innerHTML = `
      <span>${d.diffName}</span>
      <span class="diff-sr">★ ${estSR.toFixed(2)}</span>
    `;

    calculateLazerDifficulty(d.beatmap, currentReplay?.mods || 0, currentReplay ? currentReplayRate : undefined).then(attrs => {
      const srEl = row.querySelector('.diff-sr');
      if (srEl) srEl.textContent = `★ ${attrs.starRating.toFixed(2)}`;
    }).catch(() => { });

    row.onclick = () => {
      currentBeatmap = d.beatmap;
      document.querySelectorAll('.diff-row').forEach(b => b.classList.remove('active'));
      row.classList.add('active');
    };
    diffButtons.appendChild(row);
  });
}

async function autoFetchBeatmapFromMirror(hash: string): Promise<void> {
  if (ingestionStage) {
    ingestionStage.classList.add('fetching');
  }
  setProgress(0.2);

  let progress = 0.2;
  const progressTimer = setInterval(() => {
    if (progress < 0.85) {
      progress += 0.05;
      setProgress(progress);
    }
  }, 150);

  try {
    const result = await MirrorClient.fetchByMd5(hash, (_msg) => {
      progress = Math.max(progress, 0.65);
      setProgress(progress);
    });

    clearInterval(progressTimer);
    setProgress(1.0);

    currentBeatmap = result.beatmap.beatmap;
    currentBeatmapStarRating = result.difficultyRating;

    if (result.audioBlobUrl) {
      audioPlayer.src = result.audioBlobUrl;
      audioPlayer.volume = timeBus.getVolume();
    }

    currentBackgroundBlobUrl = result.backgroundBlobUrl || null;
    playfieldRenderer?.setBackground(currentBackgroundBlobUrl);

    setTimeout(() => {
      if (ingestionStage) {
        ingestionStage.classList.remove('fetching');
      }
      triggerEvaluation();
    }, 250);
  } catch (err: unknown) {
    clearInterval(progressTimer);
    if (ingestionStage) {
      ingestionStage.classList.remove('fetching');
    }
    setProgress(0);
    revealDock();
  }
}

/**
 * Triggers complete evaluation and switches view into the rich Analyzer Workspace
 * via a two-pass wavy transition, ensuring EVERYTHING IS DONE LOADING before reveal.
 */
let evalRunCounter = 0;
let isEvaluating = false;

async function triggerEvaluation(): Promise<void> {
  if (!currentReplay || !currentBeatmap) return;
  if (isEvaluating) return;
  isEvaluating = true;

  try {
    const isFromIngestion = document.body.classList.contains('ingestion-active');

    if (isFromIngestion && wavesViewport) {
      // 1. Phase 1: COVER
      // Waves rise up from bottom and blanket the screen
      wavesViewport.classList.remove('is-revealing');
      wavesViewport.classList.add('is-covering');

      // Wait for the final wave (w4: delay 210ms + duration 800ms) to settle and cover the screen
      await new Promise<void>((resolve) => setTimeout(resolve, 1050));

      // 2. WHILE 100% COVERED:
      // Switch views behind the solid wave cover
      document.body.classList.remove('ingestion-active');
      analyzerWorkspace.style.display = 'grid';
      headerMetadata.style.display = 'flex';
      if (beatmapDiffGrid) beatmapDiffGrid.style.display = 'grid';

      // Await complete evaluation so EVERYTHING is done loading:
      await performEvaluation();

      // Double requestAnimationFrame to ensure browser & GPU paint is complete
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      // 3. Phase 2: REVEAL
      // Waves continue rising off the top, revealing the analyzer from bottom up!
      wavesViewport.classList.remove('is-covering');
      wavesViewport.classList.add('is-revealing');

      // Wait for waves to clear off the top
      await new Promise<void>((resolve) => setTimeout(resolve, 1050));

      // Reset wave viewport state
      wavesViewport.classList.remove('is-revealing');
    } else {
      document.body.classList.remove('ingestion-active');
      analyzerWorkspace.style.display = 'grid';
      headerMetadata.style.display = 'flex';
      if (beatmapDiffGrid) beatmapDiffGrid.style.display = 'grid';
      await performEvaluation();
    }
  } finally {
    isEvaluating = false;
    wavesViewport?.classList.remove('is-covering', 'is-revealing');
  }
}

async function performEvaluation(): Promise<void> {
  if (!currentReplay || !currentBeatmap) return;
  const runToken = ++evalRunCounter;

  // Run evaluator
  currentEval = evaluateReplaySession(currentReplay, currentBeatmap);
  currentReplayRate = getGameplayRateFromMods(currentReplay.soloScoreInfo?.mods, currentReplay.mods);
  resetOdometers();
  lastLiveTime = 0;
  lastLiveIdx = -1;

  // Compute total duration and min lead-in time
  const firstFrameTime = currentReplay.frames[0]?.time || 0;
  const lastFrameTime = currentReplay.frames[currentReplay.frames.length - 1]?.time || 0;
  const lastObjTime = currentBeatmap.hitObjects[currentBeatmap.hitObjects.length - 1]?.time || 0;
  const totalDuration = Math.max(lastFrameTime, lastObjTime) + 1500;

  timeBus.setMinTime(Math.min(0, firstFrameTime));
  timeBus.setDuration(totalDuration);
  timeBus.setSkipGaps(currentReplay.skipGaps || []);

  updateTopBar();

  // Calculate layout and force resize on canvases now that they are visible
  updatePlayfieldDimensions();
  scatterRenderer?.handleResize();

  const firstTime = currentBeatmap.hitObjects[0]?.time || 0;

  // Precompute prefix stats for smooth 60fps top bar telemetry
  buildPrefixStats(currentEval.hitEvents);

  // Compute exact osu!lazer difficulty and performance points via rosu-pp WASM
  try {
    const lazerDiff = await calculateLazerDifficulty(currentBeatmap, currentReplay.mods, currentReplayRate);
    if (runToken !== evalRunCounter) return;
    currentLazerDiff = lazerDiff;
    currentDiffAttributes = {
      starRating: lazerDiff.starRating,
      aimDifficulty: lazerDiff.aimDifficulty,
      speedDifficulty: lazerDiff.speedDifficulty,
      readingDifficulty: lazerDiff.readingDifficulty,
      aimDifficultStrainCount: lazerDiff.aimDifficultStrainCount ?? 1,
      speedDifficultStrainCount: lazerDiff.speedDifficultStrainCount ?? 1,
      readingDifficultNoteCount: lazerDiff.readingDifficultNoteCount,
      sliderFactor: lazerDiff.sliderFactor,
      maxCombo: lazerDiff.maxCombo
    };

    const circles = currentBeatmap.hitObjects.filter(o => !(o.type & 2) && !(o.type & 8)).length;
    const sliders = currentBeatmap.hitObjects.filter(o => o.type & 2).length;
    const spinners = currentBeatmap.hitObjects.filter(o => o.type & 8).length;
    const eff = calculateEffectiveDifficulty(currentBeatmap.difficulty, currentReplay.mods, currentReplayRate);
    const rawEstimatedSR = PerformancePoints.estimateDifficultyAttributes(currentBeatmap, currentReplay.mods).starRating;
    const effectiveSR = Math.max(rawEstimatedSR, currentBeatmapStarRating || 0, lazerDiff.starRating || 0);
    const diffAttrs4Skill = PerformancePoints.estimateDifficultyAttributes(currentBeatmap, currentReplay.mods, effectiveSR);

    diffAttrs4Skill.aimDifficulty = lazerDiff.aimDifficulty || diffAttrs4Skill.aimDifficulty;
    diffAttrs4Skill.speedDifficulty = lazerDiff.speedDifficulty || diffAttrs4Skill.speedDifficulty;
    diffAttrs4Skill.starRating = lazerDiff.starRating || diffAttrs4Skill.starRating;
    diffAttrs4Skill.maxCombo = lazerDiff.maxCombo || diffAttrs4Skill.maxCombo;
    diffAttrs4Skill.readingDifficulty = lazerDiff.readingDifficulty || diffAttrs4Skill.readingDifficulty;
    diffAttrs4Skill.readingDifficultNoteCount = lazerDiff.readingDifficultNoteCount || diffAttrs4Skill.readingDifficultNoteCount;
    currentDiffAttributes = diffAttrs4Skill;

    const max4Skill = PerformancePoints.calculate({
      aimDifficulty: diffAttrs4Skill.aimDifficulty,
      speedDifficulty: diffAttrs4Skill.speedDifficulty,
      readingDifficulty: diffAttrs4Skill.readingDifficulty,
      overallDifficulty: eff.od,
      approachRate: eff.ar,
      circleSize: eff.cs,
      hitCircleCount: circles,
      sliderCount: sliders,
      spinnerCount: spinners,
      totalHits: currentBeatmap.hitObjects.length,
      maxCombo: diffAttrs4Skill.maxCombo,
      currentCombo: diffAttrs4Skill.maxCombo,
      count300: currentBeatmap.hitObjects.length,
      count100: 0,
      count50: 0,
      countMiss: 0,
      mods: currentReplay.mods
    }, diffAttrs4Skill);

    maxPossiblePP = max4Skill;

    const isStable = !currentReplay.soloScoreInfo;
    const stepper = await createLazerGradualPerformance(currentBeatmap, currentReplay.mods, currentReplayRate, !isStable);
    if (runToken !== evalRunCounter) {
      stepper.free();
      return;
    }
    precomputedLivePP = [];
    const totalEvents = prefixStats.length;
    let lastPP: LazerPerformanceBreakdown | null = null;
    for (let i = 0; i < totalEvents; i++) {
      const stat = prefixStats[i];
      if (stat.ppStep) {
        const stepPP = stepper.next({
          maxCombo: stat.maxComboSoFar,
          count300: stat.c300,
          count100: stat.c100,
          count50: stat.c50,
          countMiss: stat.cMiss,
          sliderEndHits: stat.endsHit,
          largeTickHits: stat.ticksHit
        });
        if (stepPP) {
          lastPP = {
            totalPP: stepPP.totalPP,
            aimPP: stepPP.aimPP,
            speedPP: stepPP.speedPP,
            accPP: stepPP.accPP,
            readingPP: stepPP.readingPP,
            flashlightPP: stepPP.flashlightPP,
            effectiveMissCount: stepPP.effectiveMissCount
          };
        }
      }
      precomputedLivePP.push(lastPP ?? {
        totalPP: 0,
        aimPP: 0,
        speedPP: 0,
        accPP: 0,
        readingPP: 0,
        flashlightPP: 0,
        effectiveMissCount: 0
      });
      if ((i & 255) === 255) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (runToken !== evalRunCounter) {
          stepper.free();
          return;
        }
      }
    }
    stepper.free();
  } catch (err) {
    console.warn('Rosu-pp calculation error, falling back to JS heuristic:', err);
    const rawEstimatedSR = PerformancePoints.estimateDifficultyAttributes(currentBeatmap, currentReplay.mods).starRating;
    const effectiveSR = Math.max(rawEstimatedSR, currentBeatmapStarRating || 0);
    currentDiffAttributes = PerformancePoints.estimateDifficultyAttributes(currentBeatmap, currentReplay.mods, effectiveSR);
    const eff = calculateEffectiveDifficulty(currentBeatmap.difficulty, currentReplay.mods, currentReplayRate);
    const circles = currentBeatmap.hitObjects.filter(o => !(o.type & 2) && !(o.type & 8)).length;
    const sliders = currentBeatmap.hitObjects.filter(o => o.type & 2).length;
    const spinners = currentBeatmap.hitObjects.filter(o => o.type & 8).length;

    maxPossiblePP = PerformancePoints.calculate({
      aimDifficulty: currentDiffAttributes.aimDifficulty,
      speedDifficulty: currentDiffAttributes.speedDifficulty,
      readingDifficulty: currentDiffAttributes.readingDifficulty,
      overallDifficulty: eff.od,
      approachRate: eff.ar,
      circleSize: eff.cs,
      hitCircleCount: circles,
      sliderCount: sliders,
      spinnerCount: spinners,
      totalHits: currentBeatmap.hitObjects.length,
      maxCombo: currentDiffAttributes.maxCombo,
      currentCombo: currentDiffAttributes.maxCombo,
      count300: currentBeatmap.hitObjects.length,
      count100: 0,
      count50: 0,
      countMiss: 0,
      mods: currentReplay.mods
    }, currentDiffAttributes);
  }

  if (runToken !== evalRunCounter) return;

  // Set initial replay rate based on the replay's actual clock
  const gameplayRate = currentReplayRate;
  playbackControls?.setInitialRate(gameplayRate);

  // Bind data to views
  const moddedBeatmap = getModdedBeatmap(currentBeatmap, currentReplay.mods);
  playfieldRenderer?.setBackground(currentBackgroundBlobUrl);
  playfieldRenderer?.setData(moddedBeatmap, currentReplay, currentEval.hitEvents, currentBackgroundBlobUrl);
  scatterRenderer?.setData(currentEval.hitEvents);
  telemetryCharts?.setData(currentEval, moddedBeatmap);
  incidentsDrawer?.setData(currentEval.hitEvents, currentEval.fingerLockEvents, currentEval.tapPatterns);
  playbackControls?.setIncidents(currentEval.hitEvents);
  playbackControls?.setSkipInfo(firstTime, currentReplay.skipGaps || []);

  // Update Top Bar Metadata
  updateTopBar();

  // Seek to first hit object (or after skip if skipped)
  const initialTime = Math.max(0, firstTime - 1000);
  timeBus.seek(initialTime);
  playfieldRenderer?.render(initialTime);
  scatterRenderer?.render(initialTime);
}

function buildPrefixStats(events: TimedHitEvent[]) {
  // Faithful per-object combo schedule (heads + slider repeats/tails/ticks,
  // miss resets). See ComboTracker for the combo model.
  const comboStats = buildPrefixCombo(events, currentBeatmap, {
    ticksHit: currentReplay?.sliderTicks?.hit,
    ticksMax: currentReplay?.sliderTicks?.max,
    endsHit: currentReplay?.sliderEnds?.hit,
    endsMax: currentReplay?.sliderEnds?.max
  });
  prefixStats = comboStats.map((s) => ({
    time: s.time,
    c300: s.c300,
    c100: s.c100,
    c50: s.c50,
    cMiss: s.cMiss,
    combo: s.combo,
    maxComboSoFar: s.maxComboSoFar,
    acc: calculateLazerAccuracy(s.c300, s.c100, s.c50, s.cMiss, s.ticksHit, s.maxTicks, s.endsHit, s.maxEnds),
    ticksHit: s.ticksHit,
    maxTicks: s.maxTicks,
    endsHit: s.endsHit,
    maxEnds: s.maxEnds,
    ppStep: s.ppStep,
    headIdx: s.headIdx
  }));
}

function handleAccuracyConditions(stat: PrefixHitStat): void {
  const metaRank = document.getElementById('meta-rank');
  if (!metaRank) return;

  const mods = typeof currentReplay?.soloScoreInfo?.mods === 'number'
    ? currentReplay.soloScoreInfo.mods
    : (typeof currentReplay?.mods === 'number' ? currentReplay.mods : 0);

  const isSilver = isHiddenFlashlightTraceableOrBlindsEnabled(mods);

  let badgeName = 'GradeSmall-D.svg';

  if (stat.acc < 70.0) {
    badgeName = 'GradeSmall-D.svg';
  } else if (stat.acc < 80.0) {
    badgeName = 'GradeSmall-C.svg';
  } else if (stat.acc < 90.0) {
    badgeName = 'GradeSmall-B.svg';
  } else if (stat.acc < 95.0 || (stat.acc >= 95.0 && stat.cMiss >= 1)) {
    badgeName = 'GradeSmall-A.svg';
  } else if (stat.acc >= 100.0) {
    badgeName = isSilver ? 'GradeSmall-SS-Silver.svg' : 'GradeSmall-SS.svg';
  } else if (stat.acc >= 95.0) {
    badgeName = isSilver ? 'GradeSmall-S-Silver.svg' : 'GradeSmall-S.svg';
  }

  const assetPath = BADGE_ICONS[`./assets/icons/Badges/${badgeName}`] || '';

  // Only update innerHTML if the badge has actually changed to prevent DOM thrashing
  if (metaRank.dataset.currentRank !== badgeName) {
    metaRank.dataset.currentRank = badgeName;
    metaRank.innerHTML = `<img src="${assetPath}" alt="Rank" class="rank-badge-svg" />`;
  }

  metaRank.hidden = false;
}

function isHiddenFlashlightTraceableOrBlindsEnabled(mods: number): boolean {
  const HIDDEN = 1 << 3;
  const FLASHLIGHT = 1 << 10;
  // Stable mods only; lazer mods are stored separately.
  return (mods & (HIDDEN | FLASHLIGHT)) !== 0;
}

/**
 * Stable PP row: persistent live/max spans so GSAP tweens never lose their
 * target to an innerHTML rewrite. Created once, then only textContent moves.
 */
function ensurePPDom(metaPP: HTMLElement, maxVal: number): HTMLElement | null {
  let liveEl = document.getElementById('meta-pp-live');
  let maxEl = document.getElementById('meta-max-pp');
  if (!liveEl || !maxEl || liveEl.parentElement !== metaPP) {
    metaPP.innerHTML = `<span class="meta-live" id="meta-pp-live">0pp</span> <span class="sv-sub" id="meta-max-pp">/ ${Math.round(maxVal)}pp</span>`;
    liveEl = document.getElementById('meta-pp-live');
    maxEl = document.getElementById('meta-max-pp');
  }
  if (maxEl) maxEl.textContent = `/ ${Math.round(maxVal)}pp`;
  return liveEl as HTMLElement | null;
}

function updateLiveStats(currentTimeMs: number) {
  if (!currentReplay || !currentEval || prefixStats.length === 0) return;

  const metaAcc = document.getElementById('meta-acc');
  const metaCombo = document.getElementById('meta-combo');
  const count300 = document.getElementById('meta-count-300');
  const count100 = document.getElementById('meta-count-100');
  const count50 = document.getElementById('meta-count-50');
  const countMiss = document.getElementById('meta-count-miss');
  const metaUR = document.getElementById('meta-ur');
  const metaPP = document.getElementById('meta-pp');
  const skillAim = document.getElementById('skill-aim');
  const skillSpeed = document.getElementById('skill-speed');
  const skillAcc = document.getElementById('skill-acc');
  const skillReading = document.getElementById('skill-reading');

  if (!metaAcc || !metaCombo || !count300 || !count100 || !count50 || !countMiss || !metaUR) return;

  // Fast binary search for latest hit event with time <= currentTimeMs
  let low = 0;
  let high = prefixStats.length - 1;
  let matchIdx = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (prefixStats[mid].time <= currentTimeMs) {
      matchIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Seek jumps (scrub, incident seek, skip gaps) snap instantly; linear
  // playback rolls each digit strip toward the new target with motion blur.
  const timeJump = Math.abs(currentTimeMs - lastLiveTime);
  const idxJump = Math.abs(matchIdx - lastLiveIdx);
  const snap = timeJump > 750 || idxJump > 12;
  lastLiveTime = currentTimeMs;
  lastLiveIdx = matchIdx;

  if (matchIdx < 0) {
    odoSet('acc', metaAcc, 100, ODO_ACC, snap);
    odoSet('combo', metaCombo, 0, ODO_COMBO, snap);
    odoSet('c300', count300, 0, ODO_INT, snap);
    odoSet('c100', count100, 0, ODO_INT, snap);
    odoSet('c50', count50, 0, ODO_INT, snap);
    odoSet('cmiss', countMiss, 0, ODO_INT, snap);
    odoSet('ur', metaUR, currentEval.overallUR, ODO_UR, snap);
    metaUR.title = `Overall UR: ${currentEval.overallUR.toFixed(2)}`;

    handleAccuracyConditions({
      time: 0,
      c300: 0,
      c100: 0,
      c50: 0,
      cMiss: 0,
      combo: 0,
      maxComboSoFar: 0,
      acc: 100.0,
      ticksHit: 0,
      maxTicks: 0,
      endsHit: 0,
      maxEnds: 0,
      ppStep: false,
      headIdx: -1
    });

    if (metaPP && maxPossiblePP) {
      const maxVal = maxPossiblePP.totalPP;
      const liveEl = ensurePPDom(metaPP, maxVal);
      odoSet('pp', liveEl, 0, ODO_PP, snap);
      metaPP.title = `osu!lazer Performance: 0pp / ${Math.round(maxVal)}pp`;
      if (skillAim) skillAim.textContent = 'Aim 0%';
      if (skillSpeed) skillSpeed.textContent = 'Spd 0%';
      if (skillAcc) skillAcc.textContent = 'Acc 0%';
      if (skillReading) skillReading.textContent = 'Read 0%';
    }
  } else {
    const stat = prefixStats[matchIdx];

    odoSet('acc', metaAcc, stat.acc, ODO_ACC, snap);
    odoSet('combo', metaCombo, stat.combo, ODO_COMBO, snap);
    odoSet('c300', count300, stat.c300, ODO_INT, snap);
    odoSet('c100', count100, stat.c100, ODO_INT, snap);
    odoSet('c50', count50, stat.c50, ODO_INT, snap);
    odoSet('cmiss', countMiss, stat.cMiss, ODO_INT, snap);

    handleAccuracyConditions(stat);

    // Dynamic Performance Points matching osu!lazer HUD
    if (metaPP && maxPossiblePP) {
      const maxVal = maxPossiblePP.totalPP;
      let displayTotal = 0;
      let displayAim = 0;
      let displaySpeed = 0;
      let displayAcc = 0;
      let displayReading = 0;

      if (matchIdx >= 0 && precomputedLivePP.length > matchIdx) {
        const live = precomputedLivePP[matchIdx];
        displayTotal = live.totalPP;
        displayAim = live.aimPP;
        displaySpeed = live.speedPP;
        displayAcc = live.accPP;
        displayReading = live.readingPP ?? 0;
      }

      const aimPct = maxPossiblePP.aimPP > 0 ? Math.round((displayAim / maxPossiblePP.aimPP) * 100) : 0;
      const spdPct = maxPossiblePP.speedPP > 0 ? Math.round((displaySpeed / maxPossiblePP.speedPP) * 100) : 0;
      const accPct = maxPossiblePP.accPP > 0 ? Math.round((displayAcc / maxPossiblePP.accPP) * 100) : 0;
      const readPct = maxPossiblePP.readingPP > 0 ? Math.round((displayReading / maxPossiblePP.readingPP) * 100) : 0;

      const liveEl = ensurePPDom(metaPP, maxVal);
      odoSet('pp', liveEl, displayTotal, ODO_PP, snap);
      metaPP.title = `osu!lazer Performance: ${Math.round(displayTotal)}pp / ${Math.round(maxVal)}pp | Aim: ${aimPct}% (${Math.round(displayAim)}pp) | Speed: ${spdPct}% (${Math.round(displaySpeed)}pp) | Acc: ${accPct}% (${Math.round(displayAcc)}pp) | Reading: ${readPct}% (${Math.round(displayReading)}pp)`;

      if (skillAim) {
        skillAim.textContent = `Aim ${aimPct}%`;
        skillAim.title = `Aim PP: ${aimPct}% (${Math.round(displayAim)}pp / ${Math.round(maxPossiblePP.aimPP)}pp)`;
      }
      if (skillSpeed) {
        skillSpeed.textContent = `Spd ${spdPct}%`;
        skillSpeed.title = `Speed PP: ${spdPct}% (${Math.round(displaySpeed)}pp / ${Math.round(maxPossiblePP.speedPP)}pp)`;
      }
      if (skillAcc) {
        skillAcc.textContent = `Acc ${accPct}%`;
        skillAcc.title = `Accuracy PP: ${accPct}% (${Math.round(displayAcc)}pp / ${Math.round(maxPossiblePP.accPP)}pp)`;
      }
      if (skillReading) {
        skillReading.textContent = `Read ${readPct}%`;
        skillReading.title = `Reading PP: ${readPct}% (${Math.round(displayReading)}pp / ${Math.round(maxPossiblePP.readingPP)}pp)`;
      }
    }

    // Cumulative UR matching osu! standard results. cumulativeUR is indexed
    // per hitobject head, while matchIdx walks sub-steps — index with the
    // entry's head so UR tracks the latest judged note instead of drifting
    // and freezing on the overall fallback.
    const headIdx = stat.headIdx;
    let urTarget = currentEval.overallUR;
    if (currentEval.cumulativeUR && currentEval.cumulativeUR.length > 0) {
      if (headIdx >= 0 && headIdx < currentEval.cumulativeUR.length && currentEval.cumulativeUR[headIdx] > 0) {
        urTarget = currentEval.cumulativeUR[headIdx];
      }
    }
    odoSet('ur', metaUR, urTarget, ODO_UR, snap);
    metaUR.title = `Overall UR: ${currentEval.overallUR.toFixed(2)}`;


  }
}

function updateTopBar() {
  if (!currentReplay || !currentBeatmap || !currentEval) return;

  const topTitle = document.getElementById('top-title')!;
  const topSubtitle = document.getElementById('top-subtitle')!;
  const metaModsContainer = document.getElementById('meta-mods-container')!;
  const srPill = document.getElementById('meta-sr-pill') as HTMLElement | null;

  const b = currentBeatmap;
  const r = currentReplay;
  const eff = calculateEffectiveDifficulty(b.difficulty, r.mods, currentReplayRate);
  const starRating = currentLazerDiff?.starRating ?? currentDiffAttributes?.starRating;

  const uninherited = (b.timingPoints || []).filter(tp => tp.uninherited || tp.beatLength > 0);
  const baseBpm = uninherited.length > 0 ? Math.round(60000 / uninherited[0].beatLength) : 0;
  const gameplayRate = currentReplayRate;
  const effectiveBpm = Math.round(baseBpm * gameplayRate);
  let bpmText = '';
  if (baseBpm > 0) {
    bpmText = gameplayRate !== 1.0 ? `${effectiveBpm} BPM (${baseBpm})` : `${baseBpm} BPM`;
  }

  topTitle.textContent = `${b.metadata.artist} - ${b.metadata.title} [${b.metadata.version}]`;
  const subParts = [r.playerName, b.metadata.creator, 'osu!standard', 'lazer ruleset'].filter((p) => p && p.length > 0);
  topSubtitle.textContent = subParts.join(' • ');
  const diffParts = [
    bpmText,
    `HP ${eff.hp.toFixed(1)}`,
    `CS ${eff.cs.toFixed(1)}`,
    `OD ${eff.od.toFixed(1)}`,
    `AR ${eff.ar.toFixed(1)}`,
  ].filter((p) => p && p.length > 0);
  topSubtitle.title = diffParts.join(' • ');

  // Update 2x2 Beatmap Difficulty Grid (CS, HP, OD, AR with buff/nerf indicator)
  if (beatmapDiffGrid) {
    beatmapDiffGrid.style.display = 'grid';

    const updateDiffCell = (valId: string, cellId: string, statName: string, baseVal: number, effVal: number) => {
      const valEl = document.getElementById(valId);
      const cellEl = document.getElementById(cellId);
      if (!valEl) return;

      valEl.textContent = effVal.toFixed(1);
      valEl.classList.remove('stat-buff', 'stat-nerf');

      const delta = effVal - baseVal;
      if (delta > 0.05) {
        valEl.classList.add('stat-buff');
        if (cellEl) cellEl.title = `${statName}: ${baseVal.toFixed(1)} → ${effVal.toFixed(1)} (Buffed by mods)`;
      } else if (delta < -0.05) {
        valEl.classList.add('stat-nerf');
        if (cellEl) cellEl.title = `${statName}: ${baseVal.toFixed(1)} → ${effVal.toFixed(1)} (Nerfed by mods)`;
      } else {
        if (cellEl) cellEl.title = `${statName}: ${baseVal.toFixed(1)}`;
      }
    };

    updateDiffCell('meta-diff-cs', 'cell-cs', 'Circle Size (CS)', b.difficulty.circleSize, eff.cs);
    updateDiffCell('meta-diff-hp', 'cell-hp', 'HP Drain (HP)', b.difficulty.hpDrainRate, eff.hp);
    updateDiffCell('meta-diff-od', 'cell-od', 'Overall Difficulty (OD)', b.difficulty.overallDifficulty, eff.od);
    updateDiffCell('meta-diff-ar', 'cell-ar', 'Approach Rate (AR)', b.difficulty.approachRate, eff.ar);
  }

  if (srPill) {
    if (starRating) {
      srPill.innerHTML = `<i id="meta-sr-star" class="sr-star fa-solid fa-star"></i> ${starRating.toFixed(2)}`;
      const srStar = document.getElementById('meta-sr-star') as HTMLElement | null;
      if (srStar) {
        srStar.style.color = getDiffTextColor(starRating)
        srStar.style.fontSize = '9.6px';
      };
      srPill.style.backgroundColor = getDiffColor(starRating);
      srPill.style.color = getDiffTextColor(starRating);
      srPill.hidden = false;
    } else {
      srPill.hidden = true;
    }
  }

  // if (rankTile) {
  //   const rank = (r.rank || '').toUpperCase();
  //   if (rank) {
  //     rankTile.textContent = rank;
  //     const cls = rank.startsWith('X') ? 'rk-ss' : rank.startsWith('S') ? 'rk-s' : rank === 'A' ? 'rk-a' : 'rk-other';
  //     rankTile.className = `rank-tile ${cls}`;
  //     rankTile.hidden = false;
  //   } else {
  //     rankTile.hidden = true;
  //   }
  // }

  // Render lazer-style Mod icons (frame + extender + type colours)
  renderModBadges(metaModsContainer, r);

  // Reserve worst-case widths for live numeric slots so digit growth
  // (12pp -> 2000pp, 9x -> 9999x) never reflows the header row.
  reserveHstatsWidths();

  updateLiveStats(timeBus.getCurrentTime());
}

/**
 * Sizes each live numeric slot in .hstats to its worst-case width for the
 * loaded map/score. Digit counts come from beatmap data (max combo, max PP,
 * object count); each slot is built from the font's actual widest digit plus
 * a redundant spacing slack, so growth consumes reserved space instead of
 * pushing siblings. Called on every updateTopBar so early calls (before PP
 * attributes exist) simply fill in more slots once the data arrives.
 */
let measureCtx: CanvasRenderingContext2D | null = null;
let measureCtxReady = false;

function ensureMeasureCtx(): CanvasRenderingContext2D | null {
  if (!measureCtxReady) {
    measureCtxReady = true;
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  return measureCtx;
}

/** Widest advance of 0-9 in the element's own rendered font. */
function widestDigitPx(el: Element): number {
  const ctx = ensureMeasureCtx();
  if (!ctx) return 0;
  const cs = getComputedStyle(el);
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  let w = 0;
  for (let d = 0; d <= 9; d++) {
    w = Math.max(w, ctx.measureText(String(d)).width);
  }
  return w;
}

/**
 * Worst-case pixel width for `digitCount` digits plus fixed prefix/suffix
 * text, measured in the element's real font with redundant slack.
 * Returns 0 when measurement is unavailable (caller keeps CSS fallback).
 */
function worstCaseWidth(el: Element, digitCount: number, prefix = '', suffix = '', slackPx = 4): number {
  const ctx = ensureMeasureCtx();
  if (!ctx) return 0;
  const digitW = widestDigitPx(el);
  if (digitW <= 0) return 0;
  const fixedW = ctx.measureText(prefix).width + ctx.measureText(suffix).width;
  return Math.ceil(digitW * Math.max(0, digitCount) + fixedW) + slackPx;
}

/** Reserves a worst-case width on a persistent (non-rewritten) element. */
function reserveWidth(elId: string, digitCount: number, prefix = '', suffix = ''): void {
  const el = document.getElementById(elId);
  if (!el) return;
  const w = worstCaseWidth(el, digitCount, prefix, suffix);
  if (w > 0) el.style.minWidth = `${w}px`;
}

function reserveHstatsWidths(): void {
  if (!currentBeatmap) return;
  const digits = (n: number) => String(Math.max(0, Math.round(n))).length;

  const mapMaxCombo = currentLazerDiff?.maxCombo
    ?? currentDiffAttributes?.maxCombo
    ?? currentReplay?.maxCombo
    ?? currentBeatmap.hitObjects.length;

  // Static ceiling: max combo achievable on this beatmap. Set once per load,
  // never touched by the per-frame live stats.
  const comboMaxEl = document.getElementById('meta-combo-max');
  if (comboMaxEl) comboMaxEl.textContent = `/ ${mapMaxCombo}x`;

  // Ghost digit slots: each odometer always renders this many integer
  // windows (invisible when leading), so values stay right-aligned and the
  // stat box width is inherently stable at the digit level.
  odoMinInt.set('combo', digits(mapMaxCombo));

  // Combo box fits the whole inline row (live + static ceiling); the small
  // row is static text, so the box is simply both worst cases back to back.
  const comboEl = document.getElementById('meta-combo');
  const comboBox = comboEl?.parentElement;
  if (comboEl && comboBox) {
    const comboDigits = digits(mapMaxCombo);
    const w = worstCaseWidth(comboEl, comboDigits, '', 'x ')
      + (comboMaxEl ? worstCaseWidth(comboMaxEl, comboDigits, '/ ', 'x') : 0);
    if (w > 0) comboBox.style.minWidth = `${w}px`;
  }

  reserveWidth('meta-acc', 3, '', '.00%');
  reserveWidth('meta-ur', 3, '', '.88');

  // PP box fits the whole inline row; the "/ max" suffix is static text.
  // The live span is recreated every frame, but the box persists — nothing
  // per-frame needed.
  const maxPP = maxPossiblePP ? Math.round(maxPossiblePP.totalPP) : 0;
  if (maxPP > 0) {
    odoMinInt.set('pp', digits(maxPP));
    const ppBox = document.getElementById('meta-pp');
    const liveEl = document.getElementById('meta-pp-live') ?? ppBox;
    const subEl = document.getElementById('meta-max-pp');
    if (ppBox && liveEl) {
      const ppDigits = digits(maxPP);
      const w = worstCaseWidth(liveEl, ppDigits, '', 'pp ')
        + (subEl ? worstCaseWidth(subEl, ppDigits, '/ ', 'pp') : 0);
      if (w > 0) ppBox.style.minWidth = `${w}px`;
    }
  }

  const countDigits = digits(currentBeatmap.hitObjects.length);
  for (const key of ['c300', 'c100', 'c50', 'cmiss']) odoMinInt.set(key, countDigits);
  for (const id of ['meta-count-300', 'meta-count-100', 'meta-count-50', 'meta-count-miss']) {
    reserveWidth(id, countDigits);
  }
}
