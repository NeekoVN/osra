import { parseOsrReplay } from '../../core/binary/OsrParser.ts';
import { parseOsuBeatmap } from '../../core/binary/OsuParser.ts';
import { parseOszPackage, OszPackage, OszDifficultyEntry } from '../../core/binary/OszParser.ts';
import { MirrorClient } from '../../core/api/MirrorClient.ts';
import { OsrReplay } from '../../core/types/replay.ts';
import { Beatmap } from '../../core/types/beatmap.ts';
import { PerformancePoints } from '../../core/math/PerformancePoints.ts';
import { calculateLazerDifficulty } from '../../core/math/LazerDifficulty.ts';
import { renderModBadges } from '../../ui/components/ModBadges.ts';
import sampleClickUrl from '../../assets/sounds/osu-logo-select.wav';

export interface IngestionCallbacks {
  onReplayParsed: (replay: OsrReplay) => Promise<void> | void;
  onBeatmapParsed: (beatmap: Beatmap, starRating?: number, bgUrl?: string | null) => void;
  onPackageParsed: (pkg: OszPackage, bgUrl: string | null) => void;
  onTriggerEvaluation: () => void;
  onSetBackground: (bgUrl: string | null) => void;
  getVolume: () => number;
  getCurrentReplay: () => OsrReplay | null;
  getCurrentBeatmap: () => Beatmap | null;
  getCurrentPackage: () => OszPackage | null;
  getCurrentReplayRate: () => number;
}

export class IngestionController {
  private callbacks: IngestionCallbacks;
  private sampleClick: HTMLAudioElement;

  private ingestionStage = document.getElementById('ingestion-stage') as HTMLElement;
  private logoHoverContainer = document.getElementById('logo-hover-container') as HTMLElement;
  private logoBounceContainer = document.getElementById('logo-bounce-container') as HTMLElement;
  private flashLayer = document.getElementById('flash-layer') as HTMLElement;
  private ringProgress = document.getElementById('ring-progress') as SVGCircleElement | null;
  private replayInput = document.getElementById('replay-input') as HTMLInputElement;

  private dockReplayBar = document.getElementById('dock-replay-bar') as HTMLElement;
  private dockPlayer = document.getElementById('dock-player') as HTMLElement;
  private dockHash = document.getElementById('dock-hash') as HTMLElement;
  private dockMods = document.getElementById('dock-mods') as HTMLElement;
  private beatmapInput = document.getElementById('beatmap-input') as HTMLInputElement;
  private diffLadder = document.getElementById('diff-ladder') as HTMLElement;
  private diffButtons = document.getElementById('diff-buttons') as HTMLElement;
  private dockSubmitBtn = document.getElementById('dock-submit-btn') as HTMLButtonElement;
  private audioPlayer = document.getElementById('audio-player') as HTMLAudioElement;

  constructor(callbacks: IngestionCallbacks) {
    this.callbacks = callbacks;
    this.sampleClick = new Audio(sampleClickUrl);
    this.sampleClick.volume = 0.4;
  }

  public setup(): void {
    if (!this.logoHoverContainer || !this.logoBounceContainer) return;

    this.logoHoverContainer.addEventListener('mouseenter', () => {
      this.logoHoverContainer.classList.add('hovered');
    });

    this.logoHoverContainer.addEventListener('mouseleave', () => {
      this.logoHoverContainer.classList.remove('hovered');
      this.logoBounceContainer.classList.remove('pressed');
    });

    this.logoBounceContainer.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      this.logoBounceContainer.classList.add('pressed');
    });

    window.addEventListener('mouseup', () => {
      this.logoBounceContainer.classList.remove('pressed');
    });

    this.logoBounceContainer.addEventListener('click', () => {
      this.playLogoClick();
      if (this.flashLayer) {
        this.flashLayer.classList.remove('flashing');
        void this.flashLayer.offsetWidth;
        this.flashLayer.classList.add('flashing');
        setTimeout(() => {
          this.flashLayer.classList.remove('flashing');
        }, 50);
      }
    });

    if (this.replayInput) {
      this.replayInput.addEventListener('change', async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) this.handleReplayFile(file);
      });
    }

    if (this.beatmapInput) {
      this.beatmapInput.addEventListener('change', async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) this.handleBeatmapOrPackageFile(file);
      });
    }

    if (this.dockSubmitBtn) {
      this.dockSubmitBtn.addEventListener('click', () => {
        if (this.callbacks.getCurrentReplay() && this.callbacks.getCurrentBeatmap()) {
          this.callbacks.onTriggerEvaluation();
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
        this.handleReplayFile(file);
      } else if (lower.endsWith('.osu') || lower.endsWith('.osz') || lower.endsWith('.zip')) {
        this.handleBeatmapOrPackageFile(file);
      }
    });
  }

  public playLogoClick(): void {
    try {
      this.sampleClick.currentTime = 0;
      this.sampleClick.volume = 0.4;
      this.sampleClick.play().catch(() => {});
    } catch {}
  }

  public setProgress(fraction: number): void {
    if (!this.ringProgress) return;
    const circumference = 892.2;
    const offset = circumference * (1 - Math.max(0, Math.min(1, fraction)));
    this.ringProgress.style.strokeDashoffset = offset.toString();
  }

  public revealDock(): void {
    if (this.ingestionStage) {
      this.ingestionStage.classList.add('dock-active');
    }
    this.updateDockReplayInfo();
  }

  public updateDockReplayInfo(): void {
    const replay = this.callbacks.getCurrentReplay();
    if (!replay) return;
    if (this.dockReplayBar) this.dockReplayBar.style.display = 'flex';
    if (this.dockPlayer) this.dockPlayer.textContent = replay.playerName || 'Player';
    if (this.dockHash) this.dockHash.textContent = replay.beatmapHash ? replay.beatmapHash.slice(0, 10) + '...' : '';
    if (this.dockMods) {
      this.dockMods.textContent = '';
      renderModBadges(this.dockMods, replay);
    }
  }

  public async handleReplayFile(file: File): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      const replay = await parseOsrReplay(buffer);
      await this.callbacks.onReplayParsed(replay);

      this.updateDockReplayInfo();

      const beatmap = this.callbacks.getCurrentBeatmap();
      const pkg = this.callbacks.getCurrentPackage();

      if (!beatmap && replay.beatmapHash) {
        await this.autoFetchBeatmapFromMirror(replay.beatmapHash);
      } else if (pkg) {
        this.matchPackageWithReplay();
      } else if (beatmap) {
        this.callbacks.onTriggerEvaluation();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Error parsing replay: ${msg}`);
      this.revealDock();
    }
  }

  public async handleBeatmapOrPackageFile(file: File): Promise<void> {
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith('.osz') || lower.endsWith('.zip')) {
        const buffer = await file.arrayBuffer();
        const replay = this.callbacks.getCurrentReplay();
        const targetHash = replay?.beatmapHash;
        const pkg = parseOszPackage(buffer, targetHash);

        if (pkg.audioBlobUrl) {
          this.audioPlayer.src = pkg.audioBlobUrl;
          this.audioPlayer.volume = this.callbacks.getVolume();
        }

        const bgUrl = pkg.backgroundBlobUrl || null;
        this.callbacks.onSetBackground(bgUrl);
        this.callbacks.onPackageParsed(pkg, bgUrl);

        this.matchPackageWithReplay();
      } else {
        const text = await file.text();
        const beatmap = parseOsuBeatmap(text);
        this.callbacks.onBeatmapParsed(beatmap);
        if (this.callbacks.getCurrentReplay()) {
          this.callbacks.onTriggerEvaluation();
        } else {
          this.revealDock();
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Error parsing beatmap: ${msg}`);
    }
  }

  public matchPackageWithReplay(): void {
    const pkg = this.callbacks.getCurrentPackage();
    const replay = this.callbacks.getCurrentReplay();
    if (!pkg || pkg.difficulties.length === 0) return;

    let selectedDiff: OszDifficultyEntry | null = null;
    if (replay?.beatmapHash) {
      const norm = replay.beatmapHash.toLowerCase();
      selectedDiff = pkg.difficulties.find(d => d.checksum.toLowerCase() === norm) || null;
    }

    if (selectedDiff) {
      this.callbacks.onBeatmapParsed(selectedDiff.beatmap);
      this.callbacks.onTriggerEvaluation();
    } else {
      this.revealDock();
      this.renderDifficultySelector(pkg.difficulties);
      this.callbacks.onBeatmapParsed(pkg.difficulties[0].beatmap);
    }
  }

  public renderDifficultySelector(diffs: OszDifficultyEntry[]): void {
    if (this.diffLadder) this.diffLadder.style.display = 'flex';
    if (this.dockSubmitBtn) this.dockSubmitBtn.style.display = 'block';
    if (!this.diffButtons) return;
    this.diffButtons.innerHTML = '';

    const currentBeatmap = this.callbacks.getCurrentBeatmap();
    const currentReplay = this.callbacks.getCurrentReplay();
    const currentReplayRate = this.callbacks.getCurrentReplayRate();

    diffs.forEach((d) => {
      const row = document.createElement('div');
      row.className = `diff-row ${d.beatmap === currentBeatmap ? 'active' : ''}`;
      const estSR = PerformancePoints.estimateDifficultyAttributes(d.beatmap).starRating;
      row.innerHTML = `
        <span>${d.diffName}</span>
        <span class="diff-sr">★ ${estSR.toFixed(2)}</span>
      `;

      calculateLazerDifficulty(d.beatmap, currentReplay?.mods || 0, currentReplay ? currentReplayRate : undefined)
        .then((attrs) => {
          const srEl = row.querySelector('.diff-sr');
          if (srEl) srEl.textContent = `★ ${attrs.starRating.toFixed(2)}`;
        })
        .catch(() => {});

      row.onclick = () => {
        this.callbacks.onBeatmapParsed(d.beatmap);
        document.querySelectorAll('.diff-row').forEach((b) => b.classList.remove('active'));
        row.classList.add('active');
      };
      this.diffButtons.appendChild(row);
    });
  }

  public async autoFetchBeatmapFromMirror(hash: string): Promise<void> {
    if (this.ingestionStage) {
      this.ingestionStage.classList.add('fetching');
    }
    this.setProgress(0.2);

    let progress = 0.2;
    const progressTimer = setInterval(() => {
      if (progress < 0.85) {
        progress += 0.05;
        this.setProgress(progress);
      }
    }, 150);

    try {
      const result = await MirrorClient.fetchByMd5(hash, (_msg) => {
        progress = Math.max(progress, 0.65);
        this.setProgress(progress);
      });

      clearInterval(progressTimer);
      this.setProgress(1.0);

      const beatmap = result.beatmap.beatmap;
      const sr = result.difficultyRating;

      if (result.audioBlobUrl) {
        this.audioPlayer.src = result.audioBlobUrl;
        this.audioPlayer.volume = this.callbacks.getVolume();
      }

      const bgUrl = result.backgroundBlobUrl || null;
      this.callbacks.onSetBackground(bgUrl);
      this.callbacks.onBeatmapParsed(beatmap, sr, bgUrl);

      setTimeout(() => {
        if (this.ingestionStage) {
          this.ingestionStage.classList.remove('fetching');
        }
        this.callbacks.onTriggerEvaluation();
      }, 250);
    } catch {
      clearInterval(progressTimer);
      if (this.ingestionStage) {
        this.ingestionStage.classList.remove('fetching');
      }
      this.setProgress(0);
      this.revealDock();
    }
  }

  public reset(): void {
    if (this.ingestionStage) {
      this.ingestionStage.classList.remove('dock-active', 'fetching');
    }
    this.setProgress(0);
    if (this.dockReplayBar) this.dockReplayBar.style.display = 'none';
    if (this.diffLadder) this.diffLadder.style.display = 'none';
    if (this.dockSubmitBtn) this.dockSubmitBtn.style.display = 'none';
    if (this.diffButtons) this.diffButtons.innerHTML = '';
    if (this.replayInput) this.replayInput.value = '';
    if (this.beatmapInput) this.beatmapInput.value = '';
  }
}
