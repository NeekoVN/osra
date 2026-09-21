import { parseOsrReplay } from './core/binary/OsrParser.ts';
import { parseOsuBeatmap } from './core/binary/OsuParser.ts';
import { parseOszPackage, OszPackage, OszDifficultyEntry } from './core/binary/OszParser.ts';
import { MirrorClient } from './core/api/MirrorClient.ts';
import { calculateEffectiveDifficulty, getGameplayRateFromMods } from './core/math/HitWindows.ts';
import { calculateLazerAccuracy } from './core/math/RollingAccuracy.ts';
import { OsrReplay, OsuMods } from './core/types/replay.ts';
import { Beatmap } from './core/types/beatmap.ts';
import { evaluateReplaySession, getModdedBeatmap, EvaluationResult } from './core/evaluator/ReplayEvaluator.ts';
import { TimedHitEvent, HitJudgement } from './core/types/telemetry.ts';
import { PerformancePoints, PerformanceBreakdown, DifficultyAttributes } from './core/math/PerformancePoints.ts';
import {
  calculateLazerDifficulty,
  createLazerGradualPerformance,
  LazerDifficultyAttributes,
  LazerPerformanceBreakdown
} from './core/math/LazerDifficulty.ts';

// UI Components
import { TimeBus } from './ui/TimeBus.ts';
import { PlayfieldRenderer } from './ui/canvas/PlayfieldRenderer.ts';
import { HitScatterRenderer } from './ui/canvas/HitScatterRenderer.ts';
import { TelemetryCharts } from './ui/charts/TelemetryCharts.ts';
import { IncidentsDrawer } from './ui/components/IncidentsDrawer.ts';
import { PlaybackControls } from './ui/components/PlaybackControls.ts';

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

// DOM Elements
const replayDropzone = document.getElementById('replay-dropzone') as HTMLDivElement;
const replayInput = document.getElementById('replay-input') as HTMLInputElement;
const replayDesc = document.getElementById('replay-desc') as HTMLDivElement;

const beatmapDropzone = document.getElementById('beatmap-dropzone') as HTMLDivElement;
const beatmapInput = document.getElementById('beatmap-input') as HTMLInputElement;
const beatmapDesc = document.getElementById('beatmap-desc') as HTMLDivElement;

const mirrorMsg = document.getElementById('mirror-msg') as HTMLSpanElement;
const pulseIndicator = document.getElementById('pulse-indicator') as HTMLSpanElement;
const audioPlayer = document.getElementById('audio-player') as HTMLAudioElement;

const diffSelectorContainer = document.getElementById('diff-selector-container') as HTMLDivElement;
const diffButtons = document.getElementById('diff-buttons') as HTMLDivElement;

const ingestionSection = document.getElementById('ingestion-section') as HTMLElement;
const analyzerWorkspace = document.getElementById('analyzer-workspace') as HTMLElement;
const headerMetadata = document.getElementById('header-metadata') as HTMLElement;
const statusBadge = document.getElementById('status-badge') as HTMLSpanElement;

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
}
let prefixStats: PrefixHitStat[] = [];

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

  setupLayoutControls();
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
  // 1. Pause playback and reset time
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

  // 5. Reset UI components
  playfieldRenderer?.clear();
  scatterRenderer?.setData([]);
  scatterRenderer?.render(0);
  telemetryCharts?.destroy();
  incidentsDrawer?.setData([], []);
  playbackControls?.setIncidents([]);
  playbackControls?.setSkipInfo(0, []);

  // 6. Reset dropzones UI state
  replayDropzone.classList.remove('loaded');
  replayDesc.textContent = 'Drag & drop your .osr replay here, or click to browse';
  replayInput.value = '';

  beatmapDropzone.classList.remove('loaded');
  beatmapDesc.textContent = 'Drag & drop .osz archive or .osu file, or auto-fetch from mirror';
  beatmapInput.value = '';

  // 7. Reset diff selector and mirror status banner
  diffSelectorContainer.style.display = 'none';
  diffButtons.innerHTML = '';
  setMirrorStatus('Auto-fetch: Enabled (queries public mirrors automatically on .osr drop)', false);

  // 8. Hide workspace & header metadata, reveal dropzone ingestion section
  analyzerWorkspace.style.display = 'none';
  headerMetadata.style.display = 'none';
  ingestionSection.style.display = 'block';

  // 9. Reset status badge and top header titles
  statusBadge.className = 'badge';
  statusBadge.textContent = 'Awaiting Files';
  const topTitle = document.getElementById('top-title');
  if (topTitle) topTitle.textContent = 'REPLAY ANALYZER';
  const topSubtitle = document.getElementById('top-subtitle');
  if (topSubtitle) topSubtitle.textContent = 'osu!standard • lazer ruleset';
}

function setupLayoutControls(): void {
  const brandHeader = document.getElementById('brand-header') || document.querySelector('.brand');
  if (brandHeader) {
    brandHeader.addEventListener('click', () => {
      if (analyzerWorkspace.style.display !== 'none') {
        resetToIngestion();
      }
    });
  }
  const btnToggleEvents = document.getElementById('btn-toggle-events') as HTMLButtonElement | null;
  const incidentsPanel = document.getElementById('incidents-panel') as HTMLElement | null;
  if (btnToggleEvents && incidentsPanel) {
    btnToggleEvents.addEventListener('click', (e) => {
      e.stopPropagation();
      const isMin = incidentsPanel.classList.toggle('minimized');
      btnToggleEvents.innerHTML = isMin
        ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`
        : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
      btnToggleEvents.title = isMin ? 'Expand Events Panel' : 'Minimize Events Panel';
      updatePlayfieldDimensions();
    });
  }

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
  if (btnToggleTrail) {
    btnToggleTrail.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!playfieldRenderer) return;
      const isEnabled = playfieldRenderer.toggleTrail();
      btnToggleTrail.textContent = isEnabled ? 'Trail: On' : 'Trail: Off';
      btnToggleTrail.classList.toggle('off', !isEnabled);
      btnToggleTrail.title = isEnabled ? 'Click to disable Cursor Trail' : 'Click to enable Cursor Trail';
    });
  }

  const btnTogglePathTrail = document.getElementById('btn-toggle-path-trail') as HTMLButtonElement | null;
  if (btnTogglePathTrail) {
    btnTogglePathTrail.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!playfieldRenderer) return;
      const isEnabled = playfieldRenderer.togglePathTrail();
      btnTogglePathTrail.textContent = isEnabled ? 'Path Trail: On' : 'Path Trail: Off';
      btnTogglePathTrail.classList.toggle('off', !isEnabled);
      btnTogglePathTrail.title = isEnabled ? 'Click to disable Long Path Trail' : 'Click to enable Long Path Trail';
    });
  }

  const btnToggleVectors = document.getElementById('btn-toggle-vectors') as HTMLButtonElement | null;
  if (btnToggleVectors) {
    btnToggleVectors.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!playfieldRenderer) return;
      const isEnabled = playfieldRenderer.toggleErrorVectors();
      btnToggleVectors.textContent = isEnabled ? 'Error Vectors: On' : 'Error Vectors: Off';
      btnToggleVectors.classList.toggle('off', !isEnabled);
      btnToggleVectors.title = isEnabled ? 'Click to disable Error Vectors' : 'Click to enable Error Vectors';
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

function setMirrorStatus(msg: string, isLoading: boolean = false) {
  mirrorMsg.textContent = msg;
  if (isLoading) pulseIndicator.classList.add('loading');
  else pulseIndicator.classList.remove('loading');
}

// Ingestion Handlers
replayInput.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) handleReplayFile(file);
});

replayDropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  replayDropzone.classList.add('dragover');
});
replayDropzone.addEventListener('dragleave', () => replayDropzone.classList.remove('dragover'));
replayDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  replayDropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files[0];
  if (file) handleReplayFile(file);
});

async function handleReplayFile(file: File) {
  try {
    const buffer = await file.arrayBuffer();
    currentReplay = await parseOsrReplay(buffer);

    replayDropzone.classList.add('loaded');
    replayDesc.textContent = `Loaded: ${file.name} (${currentReplay.playerName})`;

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
  }
}

beatmapInput.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) handleBeatmapOrPackageFile(file);
});

beatmapDropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  beatmapDropzone.classList.add('dragover');
});
beatmapDropzone.addEventListener('dragleave', () => beatmapDropzone.classList.remove('dragover'));
beatmapDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  beatmapDropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files[0];
  if (file) handleBeatmapOrPackageFile(file);
});

async function handleBeatmapOrPackageFile(file: File) {
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

      beatmapDropzone.classList.add('loaded');
      beatmapDesc.textContent = `Loaded .osz: ${file.name} (${currentPackage.difficulties.length} diffs)`;
      matchPackageWithReplay();
    } else {
      const text = await file.text();
      currentBeatmap = parseOsuBeatmap(text);
      beatmapDropzone.classList.add('loaded');
      beatmapDesc.textContent = `Loaded .osu: ${currentBeatmap.metadata.title} [${currentBeatmap.metadata.version}]`;
      triggerEvaluation();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    alert(`Error parsing beatmap: ${msg}`);
  }
}

function matchPackageWithReplay() {
  if (!currentPackage || currentPackage.difficulties.length === 0) return;

  let selectedDiff: OszDifficultyEntry | null = null;
  if (currentReplay?.beatmapHash) {
    const norm = currentReplay.beatmapHash.toLowerCase();
    selectedDiff = currentPackage.difficulties.find(d => d.checksum.toLowerCase() === norm) || null;
  }

  if (selectedDiff) {
    currentBeatmap = selectedDiff.beatmap;
    diffSelectorContainer.style.display = 'none';
  } else {
    renderDifficultySelector(currentPackage.difficulties);
    currentBeatmap = currentPackage.difficulties[0].beatmap;
  }

  triggerEvaluation();
}

function renderDifficultySelector(diffs: OszDifficultyEntry[]) {
  diffSelectorContainer.style.display = 'block';
  diffButtons.innerHTML = '';

  diffs.forEach((d) => {
    const btn = document.createElement('button');
    btn.className = `diff-btn ${d.beatmap === currentBeatmap ? 'active' : ''}`;
    const estSR = PerformancePoints.estimateDifficultyAttributes(d.beatmap).starRating;
    btn.textContent = `${d.diffName} (★ ${estSR.toFixed(2)})`;

    calculateLazerDifficulty(d.beatmap, currentReplay?.mods || 0, currentReplay ? currentReplayRate : undefined).then(attrs => {
      btn.textContent = `${d.diffName} (★ ${attrs.starRating.toFixed(2)})`;
    }).catch(() => {
      // Keep estimate
    });

    btn.onclick = () => {
      currentBeatmap = d.beatmap;
      document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      triggerEvaluation();
    };
    diffButtons.appendChild(btn);
  });
}

async function autoFetchBeatmapFromMirror(hash: string) {
  setMirrorStatus(`Looking up beatmap on public mirror for replay hash ${hash.slice(0, 8)}...`, true);
  try {
    const result = await MirrorClient.fetchByMd5(hash, (msg) => {
      setMirrorStatus(msg, true);
    });

    currentBeatmap = result.beatmap.beatmap;
    currentBeatmapStarRating = result.difficultyRating;
    beatmapDropzone.classList.add('loaded');
    beatmapDesc.textContent = `Auto-fetched: ${currentBeatmap.metadata.title} [${currentBeatmap.metadata.version}]`;

    if (result.audioBlobUrl) {
      audioPlayer.src = result.audioBlobUrl;
      audioPlayer.volume = timeBus.getVolume();
    }

    currentBackgroundBlobUrl = result.backgroundBlobUrl || null;
    playfieldRenderer?.setBackground(currentBackgroundBlobUrl);

    setMirrorStatus(`Mirror: Loaded beatmap #${result.beatmapId} (Set #${result.beatmapsetId})`, false);
    triggerEvaluation();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setMirrorStatus(`Mirror: Auto-fetch unavailable (${msg}). Please drop your .osz or .osu manually.`, false);
  }
}

/**
 * Triggers complete evaluation and switches view into the rich Analyzer Workspace
 */
async function triggerEvaluation() {
  if (!currentReplay || !currentBeatmap) return;

  // Run evaluator
  currentEval = evaluateReplaySession(currentReplay, currentBeatmap);
  currentReplayRate = getGameplayRateFromMods(currentReplay.soloScoreInfo?.mods, currentReplay.mods);

  // Compute total duration and min lead-in time
  const firstFrameTime = currentReplay.frames[0]?.time || 0;
  const lastFrameTime = currentReplay.frames[currentReplay.frames.length - 1]?.time || 0;
  const lastObjTime = currentBeatmap.hitObjects[currentBeatmap.hitObjects.length - 1]?.time || 0;
  const totalDuration = Math.max(lastFrameTime, lastObjTime) + 1500;

  timeBus.setMinTime(Math.min(0, firstFrameTime));
  timeBus.setDuration(totalDuration);
  timeBus.setSkipGaps(currentReplay.skipGaps || []);

  // Reveal workspace & collapse dropzones FIRST so DOM layout calculates canvas bounding rect
  ingestionSection.style.display = 'none';
  analyzerWorkspace.style.display = 'grid';

  headerMetadata.style.display = 'flex';
  statusBadge.className = 'badge green';
  statusBadge.textContent = 'Telemetry Loaded';
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

    // Precompute gradual note-by-note live PP matching osu!lazer HUD. Replays
    // without a soloScoreInfo payload follow stable/classic score semantics.
    const isStable = !currentReplay.soloScoreInfo;
    const stepper = await createLazerGradualPerformance(currentBeatmap, currentReplay.mods, currentReplayRate, !isStable);
    precomputedLivePP = [];
    const totalEvents = prefixStats.length;
    for (let i = 0; i < totalEvents; i++) {
      const stat = prefixStats[i];
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
        precomputedLivePP.push({
          totalPP: stepPP.totalPP,
          aimPP: stepPP.aimPP,
          speedPP: stepPP.speedPP,
          accPP: stepPP.accPP,
          readingPP: stepPP.readingPP,
          flashlightPP: stepPP.flashlightPP,
          effectiveMissCount: stepPP.effectiveMissCount
        });
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

  // Set initial replay rate based on the replay's actual clock (e.g. DT@1.2x, DT@1.5x, HT@0.75x)
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
  prefixStats = [];
  let c300 = 0;
  let c100 = 0;
  let c50 = 0;
  let cMiss = 0;
  let combo = 0;
  let maxCombo = 0;
  const declaredMaxCombo = currentReplay?.maxCombo ?? 0;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.judgement === HitJudgement.Great) {
      c300++;
      combo++;
    } else if (e.judgement === HitJudgement.Ok) {
      c100++;
      combo++;
    } else if (e.judgement === HitJudgement.Meh) {
      c50++;
      combo++;
    } else {
      cMiss++;
      combo = 0;
    }
    const progress = events.length > 0 ? (i + 1) / events.length : 1;
    const ticksHit = currentReplay?.sliderTicks ? Math.round(currentReplay.sliderTicks.hit * progress) : 0;
    const maxTicks = currentReplay?.sliderTicks ? Math.round(currentReplay.sliderTicks.max * progress) : 0;
    const endsHit = currentReplay?.sliderEnds ? Math.round(currentReplay.sliderEnds.hit * progress) : 0;
    const maxEnds = currentReplay?.sliderEnds ? Math.round(currentReplay.sliderEnds.max * progress) : 0;

    // In-game combo also increments on slider ticks and slider tails. For
    // replays without soloScoreInfo the tick/tail split is unknown, so scale
    // the replay's declared max combo by progress as the live estimate (the
    // final step lands exactly on the declared value).
    const recordedCombo = Math.min(combo + ticksHit + endsHit, declaredMaxCombo || combo + ticksHit + endsHit);
    const estimateMaxCombo = declaredMaxCombo > 0 ? Math.round(declaredMaxCombo * Math.min(1, progress)) : 0;
    const maxComboSoFar = Math.max(maxCombo, recordedCombo, estimateMaxCombo);
    maxCombo = maxComboSoFar;

    const acc = calculateLazerAccuracy(c300, c100, c50, cMiss, ticksHit, maxTicks, endsHit, maxEnds);
    prefixStats.push({
      time: e.targetTime,
      c300,
      c100,
      c50,
      cMiss,
      combo: recordedCombo,
      maxComboSoFar,
      acc,
      ticksHit,
      maxTicks,
      endsHit,
      maxEnds
    });
  }
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

  if (matchIdx < 0) {
    metaAcc.textContent = '100.00%';
    metaCombo.textContent = '0x';
    count300.textContent = '0';
    count100.textContent = '0';
    count50.textContent = '0';
    countMiss.textContent = '0';
    metaUR.textContent = currentEval.overallUR.toFixed(2);
    metaUR.title = `Overall UR: ${currentEval.overallUR.toFixed(2)}`;

    if (metaPP && maxPossiblePP) {
      const maxVal = maxPossiblePP.totalPP;
      metaPP.innerHTML = `0pp <span class="meta-sub" id="meta-max-pp" style="font-size: 11px; color: var(--text-secondary); font-weight: normal;">/ ${Math.round(maxVal)}pp</span>`;
      metaPP.title = `osu!lazer Performance: 0pp / ${Math.round(maxVal)}pp`;
      if (skillAim) skillAim.textContent = 'Aim 0%';
      if (skillSpeed) skillSpeed.textContent = 'Spd 0%';
      if (skillAcc) skillAcc.textContent = 'Acc 0%';
      if (skillReading) skillReading.textContent = 'Read 0%';
    }
  } else {
    const stat = prefixStats[matchIdx];

    metaAcc.textContent = `${stat.acc.toFixed(2)}%`;
    metaCombo.textContent = `${stat.combo}x`;
    count300.textContent = String(stat.c300);
    count100.textContent = String(stat.c100);
    count50.textContent = String(stat.c50);
    countMiss.textContent = String(stat.cMiss);

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

      metaPP.innerHTML = `${Math.round(displayTotal)}pp <span class="meta-sub" id="meta-max-pp" style="font-size: 11px; color: var(--text-secondary); font-weight: normal;">/ ${Math.round(maxVal)}pp</span>`;
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

    // Cumulative UR matching osu! standard results
    if (currentEval.cumulativeUR && currentEval.cumulativeUR.length > 0) {
      if (matchIdx >= 0 && matchIdx < currentEval.cumulativeUR.length && currentEval.cumulativeUR[matchIdx] > 0) {
        metaUR.textContent = currentEval.cumulativeUR[matchIdx].toFixed(2);
      } else {
        metaUR.textContent = currentEval.overallUR.toFixed(2);
      }
    } else {
      metaUR.textContent = currentEval.overallUR.toFixed(2);
    }
    metaUR.title = `Overall UR: ${currentEval.overallUR.toFixed(2)}`;
  }
}

function updateTopBar() {
  if (!currentReplay || !currentBeatmap || !currentEval) return;

  const topTitle = document.getElementById('top-title')!;
  const topSubtitle = document.getElementById('top-subtitle')!;
  const metaPlayer = document.getElementById('meta-player')!;
  const metaModsContainer = document.getElementById('meta-mods-container')!;

  const b = currentBeatmap;
  const r = currentReplay;
  const eff = calculateEffectiveDifficulty(b.difficulty, r.mods, currentReplayRate);
  const starRating = currentLazerDiff?.starRating ?? currentDiffAttributes?.starRating;
  const srText = starRating ? `★ ${starRating.toFixed(2)} • ` : '';

  const uninherited = (b.timingPoints || []).filter(tp => tp.uninherited || tp.beatLength > 0);
  const baseBpm = uninherited.length > 0 ? Math.round(60000 / uninherited[0].beatLength) : 0;
  const gameplayRate = currentReplayRate;
  const effectiveBpm = Math.round(baseBpm * gameplayRate);
  let bpmText = '';
  if (baseBpm > 0) {
    bpmText = gameplayRate !== 1.0 ? `${effectiveBpm} BPM (${baseBpm}) • ` : `${baseBpm} BPM • `;
  }

  topTitle.textContent = `${b.metadata.artist} - ${b.metadata.title}`;
  topSubtitle.textContent = `[${b.metadata.version}] • ${srText}${bpmText}HP ${eff.hp.toFixed(1)} • CS ${eff.cs.toFixed(1)} • OD ${eff.od.toFixed(1)} • AR ${eff.ar.toFixed(1)}`;

  metaPlayer.textContent = r.playerName;

  // Render Slider Tracking Badges if present in soloScoreInfo
  const slidersContainer = document.getElementById('meta-sliders-container');
  const metaTicks = document.getElementById('meta-slider-ticks');
  const metaEnds = document.getElementById('meta-slider-ends');
  if (slidersContainer && (r.sliderTicks || r.sliderEnds)) {
    slidersContainer.style.display = 'flex';
    if (metaTicks && r.sliderTicks) {
      metaTicks.textContent = `${r.sliderTicks.hit}/${r.sliderTicks.max}`;
    }
    if (metaEnds && r.sliderEnds) {
      metaEnds.textContent = `${r.sliderEnds.hit}/${r.sliderEnds.max}`;
    }
  } else if (slidersContainer) {
    slidersContainer.style.display = 'none';
  }

  // Render Mod Badges
  metaModsContainer.innerHTML = '';
  if (r.mods === 0) {
    metaModsContainer.innerHTML = '<span class="badge">NM</span>';
  } else {
    if (r.mods & OsuMods.Hidden) metaModsContainer.innerHTML += '<span class="badge gold" style="margin-right:4px;">HD</span>';
    if (r.mods & OsuMods.HardRock) metaModsContainer.innerHTML += '<span class="badge red" style="margin-right:4px;">HR</span>';
    if (r.mods & OsuMods.DoubleTime) metaModsContainer.innerHTML += '<span class="badge pink" style="margin-right:4px;">DT</span>';
    if (r.mods & OsuMods.Easy) metaModsContainer.innerHTML += '<span class="badge cyan" style="margin-right:4px;">EZ</span>';
    if (r.mods & OsuMods.HalfTime) metaModsContainer.innerHTML += '<span class="badge" style="margin-right:4px;">HT</span>';
  }

  updateLiveStats(timeBus.getCurrentTime());
}
