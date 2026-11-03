import { OsrReplay } from './core/types/replay.ts';
import { Beatmap } from './core/types/beatmap.ts';
import { OszPackage } from './core/binary/OszParser.ts';
import { getModdedBeatmap, EvaluationResult } from './core/evaluator/ReplayEvaluator.ts';
import { PerformanceBreakdown, DifficultyAttributes } from './core/math/PerformancePoints.ts';
import { LazerDifficultyAttributes, LazerPerformanceBreakdown } from './core/math/LazerDifficulty.ts';

// UI Components
import { TimeBus } from './ui/TimeBus.ts';
import { PlayfieldRenderer } from './ui/canvas/PlayfieldRenderer.ts';
import { HitScatterRenderer } from './ui/canvas/HitScatterRenderer.ts';
import { TelemetryCharts } from './ui/charts/TelemetryCharts.ts';
import { IncidentsDrawer } from './ui/components/IncidentsDrawer.ts';
import { PlaybackControls } from './ui/components/PlaybackControls.ts';

// App Controllers & Services
import { LiveStatsManager } from './app/stats/LiveStatsManager.ts';
import { WaveTransition } from './app/transition/WaveTransition.ts';
import { LayoutController } from './app/layout/LayoutController.ts';
import { IngestionController } from './app/ingestion/IngestionController.ts';
import { runEvaluationPipeline } from './app/evaluator/EvaluationService.ts';

// State
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
let currentReplayRate = 1.0;

let evalRunCounter = 0;
let isEvaluating = false;

// Time & Rendering Bus
const timeBus = new TimeBus();
const audioPlayer = document.getElementById('audio-player') as HTMLAudioElement;

// UI Containers & Elements
const analyzerWorkspace = document.getElementById('analyzer-workspace') as HTMLElement;
const headerMetadata = document.getElementById('header-metadata') as HTMLElement;
const beatmapDiffGrid = document.getElementById('beatmap-diff-grid') as HTMLElement;
const playfieldCanvas = document.getElementById('playfield-canvas') as HTMLCanvasElement;
const scatterCanvas = document.getElementById('scatter-canvas') as HTMLCanvasElement;
const incidentsContainer = document.getElementById('incidents-container') as HTMLElement;
const playbackContainer = document.getElementById('playback-container') as HTMLElement;
const chartsContainer = document.getElementById('charts-container') as HTMLElement;

// Managers & Controllers
const playfieldRenderer = new PlayfieldRenderer(playfieldCanvas);
const scatterRenderer = new HitScatterRenderer(scatterCanvas);
const telemetryCharts = new TelemetryCharts(chartsContainer, timeBus);
const incidentsDrawer = new IncidentsDrawer(incidentsContainer, timeBus);
const playbackControls = new PlaybackControls(playbackContainer, timeBus);

const liveStats = new LiveStatsManager();
const waveTransition = new WaveTransition();

const layoutController = new LayoutController({
  timeBus,
  getPlayfieldRenderer: () => playfieldRenderer,
  getScatterRenderer: () => scatterRenderer,
  getTelemetryCharts: () => telemetryCharts,
  onResetToIngestion: () => resetToIngestion()
});

const ingestionController = new IngestionController({
  onReplayParsed: (replay) => {
    currentReplay = replay;
  },
  onBeatmapParsed: (beatmap, starRating, bgUrl) => {
    currentBeatmap = beatmap;
    if (starRating !== undefined) currentBeatmapStarRating = starRating;
    if (bgUrl !== undefined) currentBackgroundBlobUrl = bgUrl;
  },
  onPackageParsed: (pkg, bgUrl) => {
    currentPackage = pkg;
    currentBackgroundBlobUrl = bgUrl;
  },
  onTriggerEvaluation: () => {
    void triggerEvaluation();
  },
  onSetBackground: (bgUrl) => {
    playfieldRenderer.setBackground(bgUrl);
  },
  getVolume: () => timeBus.getVolume(),
  getCurrentReplay: () => currentReplay,
  getCurrentBeatmap: () => currentBeatmap,
  getCurrentPackage: () => currentPackage,
  getCurrentReplayRate: () => currentReplayRate
});

// Initialization
function initialize(): void {
  timeBus.setAudioElement(audioPlayer);

  timeBus.subscribe((t) => {
    playfieldRenderer.render(t);
    scatterRenderer.render(t);
    liveStats.updateLiveStats(t);
  });

  timeBus.subscribeRate((rate) => {
    playfieldRenderer.setPlaybackRate(rate);
  });

  layoutController.setup();
  ingestionController.setup();
}

function resetToIngestion(): void {
  evalRunCounter++;
  isEvaluating = false;
  waveTransition.reset();

  timeBus.pause();
  timeBus.seek(0);

  audioPlayer.pause();
  audioPlayer.removeAttribute('src');
  audioPlayer.load();

  if (currentPackage?.audioBlobUrl) {
    try { URL.revokeObjectURL(currentPackage.audioBlobUrl); } catch { /* noop */ }
  }
  if (currentBackgroundBlobUrl) {
    try { URL.revokeObjectURL(currentBackgroundBlobUrl); } catch { /* noop */ }
  }

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

  playfieldRenderer.clear();
  scatterRenderer.setData([]);
  scatterRenderer.render(0);
  telemetryCharts.destroy();
  incidentsDrawer.setData([], []);
  playbackControls.setIncidents([]);
  playbackControls.setSkipInfo(0, []);

  document.body.classList.add('ingestion-active');
  analyzerWorkspace.style.display = 'none';
  headerMetadata.style.display = 'none';
  if (beatmapDiffGrid) beatmapDiffGrid.style.display = 'none';

  liveStats.reset();
  ingestionController.reset();
}

async function triggerEvaluation(): Promise<void> {
  if (!currentReplay || !currentBeatmap) return;
  if (isEvaluating) return;
  isEvaluating = true;

  try {
    const isFromIngestion = document.body.classList.contains('ingestion-active');

    if (isFromIngestion) {
      await waveTransition.run(async () => {
        document.body.classList.remove('ingestion-active');
        analyzerWorkspace.style.display = 'grid';
        headerMetadata.style.display = 'flex';
        if (beatmapDiffGrid) beatmapDiffGrid.style.display = 'grid';

        await performEvaluation();
      });
    } else {
      document.body.classList.remove('ingestion-active');
      analyzerWorkspace.style.display = 'grid';
      headerMetadata.style.display = 'flex';
      if (beatmapDiffGrid) beatmapDiffGrid.style.display = 'grid';
      await performEvaluation();
    }
  } finally {
    isEvaluating = false;
    waveTransition.reset();
  }
}

async function performEvaluation(): Promise<void> {
  if (!currentReplay || !currentBeatmap) return;
  const runToken = ++evalRunCounter;

  // Pre-seed liveStats to generate prefix stats needed for gradual PP stepper
  liveStats.setSession(
    currentBeatmap,
    currentReplay,
    null,
    null,
    [],
    null,
    null
  );

  const pipeline = await runEvaluationPipeline(
    currentReplay,
    currentBeatmap,
    currentBeatmapStarRating,
    liveStats.getPrefixStats(),
    () => runToken !== evalRunCounter
  );

  if (!pipeline || runToken !== evalRunCounter) return;

  currentEval = pipeline.evalResult;
  currentReplayRate = pipeline.gameplayRate;
  currentLazerDiff = pipeline.lazerDiff;
  currentDiffAttributes = pipeline.diffAttributes;
  maxPossiblePP = pipeline.maxPossiblePP;
  precomputedLivePP = pipeline.precomputedLivePP;

  timeBus.setMinTime(Math.min(0, pipeline.firstFrameTime));
  timeBus.setDuration(pipeline.totalDuration);
  timeBus.setSkipGaps(currentReplay.skipGaps || []);

  liveStats.setSession(
    currentBeatmap,
    currentReplay,
    currentEval,
    maxPossiblePP,
    precomputedLivePP,
    currentLazerDiff,
    currentDiffAttributes
  );

  liveStats.updateTopBar(currentReplayRate, timeBus.getCurrentTime());

  layoutController.updatePlayfieldDimensions();
  scatterRenderer.handleResize();

  playbackControls.setInitialRate(currentReplayRate);

  const moddedBeatmap = getModdedBeatmap(currentBeatmap, currentReplay.mods);
  playfieldRenderer.setBackground(currentBackgroundBlobUrl);
  playfieldRenderer.setData(moddedBeatmap, currentReplay, currentEval.hitEvents, currentBackgroundBlobUrl);
  scatterRenderer.setData(currentEval.hitEvents);
  await telemetryCharts.setData(currentEval, moddedBeatmap, currentReplay.mods, currentReplayRate);
  incidentsDrawer.setData(currentEval.hitEvents, currentEval.fingerLockEvents, currentEval.tapPatterns);
  playbackControls.setIncidents(currentEval.hitEvents);
  playbackControls.setSkipInfo(pipeline.firstTime, currentReplay.skipGaps || []);

  liveStats.updateTopBar(currentReplayRate, timeBus.getCurrentTime());

  const initialTime = Math.max(0, pipeline.firstTime - 1000);
  timeBus.seek(initialTime);
  playfieldRenderer.render(initialTime);
  scatterRenderer.render(initialTime);
}

// Start
initialize();
