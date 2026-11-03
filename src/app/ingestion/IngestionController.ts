import { parseOsrReplay } from '../../core/binary/OsrParser.ts';
import { parseOsuBeatmap } from '../../core/binary/OsuParser.ts';
import { parseOszPackage, OszPackage, OszDifficultyEntry } from '../../core/binary/OszParser.ts';
import { MirrorClient } from '../../core/api/MirrorClient.ts';
import { OsrReplay } from '../../core/types/replay.ts';
import { Beatmap } from '../../core/types/beatmap.ts';
import { PerformancePoints } from '../../core/math/PerformancePoints.ts';
import { calculateLazerDifficulty } from '../../core/math/LazerDifficulty.ts';
import { renderModBadges } from '../../ui/components/ModBadges.ts';
import { md5 } from '../../core/binary/md5.ts';
import sampleClickUrl from '../../assets/sounds/osu-logo-select.wav';

export interface IngestionCallbacks {
  onReplayParsed: (replay: OsrReplay) => Promise<void> | void;
  onBeatmapParsed: (beatmap: Beatmap, starRating?: number, bgUrl?: string | null, hash?: string) => void;
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

  private currentBeatmapHash: string | null = null;
  private currentFetchGeneration = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private delayedEvalTimer: ReturnType<typeof setTimeout> | null = null;
  private isFetching = false;

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
  private dockDropSpan = document.querySelector('#dock-drop span') as HTMLElement | null;

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
        if (this.isFetching) return;
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) this.handleReplayFile(file);
      });
    }

    if (this.beatmapInput) {
      this.beatmapInput.addEventListener('change', async (e: Event) => {
        if (this.isFetching) return;
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) this.handleBeatmapOrPackageFile(file);
      });
    }

    if (this.dockSubmitBtn) {
      this.dockSubmitBtn.addEventListener('click', () => {
        if (this.isFetching) return;
        const replay = this.callbacks.getCurrentReplay();
        const beatmap = this.callbacks.getCurrentBeatmap();
        if (replay && beatmap) {
          const replayHash = replay.beatmapHash ? replay.beatmapHash.toLowerCase().trim() : null;
          if (replayHash && this.currentBeatmapHash && this.currentBeatmapHash !== replayHash) {
            void this.autoFetchBeatmapFromMirror(replayHash);
          } else {
            this.callbacks.onTriggerEvaluation();
          }
        }
      });
    }

    window.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
    });

    window.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      if (this.isFetching) return;
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

  private cancelPendingFetch(): void {
    this.currentFetchGeneration++;
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.delayedEvalTimer !== null) {
      clearTimeout(this.delayedEvalTimer);
      this.delayedEvalTimer = null;
    }
    if (this.isFetching) {
      this.isFetching = false;
      this.setFetchingUi(false);
    }
  }

  private setFetchingUi(fetching: boolean): void {
    if (this.ingestionStage) {
      this.ingestionStage.classList.toggle('fetching', fetching);
    }
    const importBtn = document.getElementById('btn-import') as HTMLButtonElement | null;
    if (importBtn) {
      importBtn.disabled = fetching;
    }
    if (this.replayInput) this.replayInput.disabled = fetching;
    if (this.beatmapInput) this.beatmapInput.disabled = fetching;
  }

  public async handleReplayFile(file: File): Promise<void> {
    this.cancelPendingFetch();
    try {
      const buffer = await file.arrayBuffer();
      const replay = await parseOsrReplay(buffer);
      await this.callbacks.onReplayParsed(replay);

      this.updateDockReplayInfo();

      const beatmap = this.callbacks.getCurrentBeatmap();
      const pkg = this.callbacks.getCurrentPackage();
      const replayHash = replay.beatmapHash ? replay.beatmapHash.toLowerCase().trim() : null;

      if (!beatmap && replayHash) {
        await this.autoFetchBeatmapFromMirror(replayHash);
      } else if (pkg) {
        this.matchPackageWithReplay();
      } else if (beatmap) {
        if (replayHash && this.currentBeatmapHash && this.currentBeatmapHash !== replayHash) {
          await this.autoFetchBeatmapFromMirror(replayHash);
        } else {
          this.callbacks.onTriggerEvaluation();
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Error parsing replay: ${msg}`);
      this.revealDock();
    }
  }

  public async handleBeatmapOrPackageFile(file: File): Promise<void> {
    this.cancelPendingFetch();
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
        const hash = md5(text).toLowerCase().trim();
        this.currentBeatmapHash = hash;
        this.callbacks.onBeatmapParsed(beatmap, undefined, undefined, hash);
        const replay = this.callbacks.getCurrentReplay();
        if (replay) {
          const replayHash = replay.beatmapHash ? replay.beatmapHash.toLowerCase().trim() : null;
          if (replayHash && replayHash !== hash) {
            this.revealDock();
          } else {
            this.callbacks.onTriggerEvaluation();
          }
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
      const norm = replay.beatmapHash.toLowerCase().trim();
      selectedDiff = pkg.difficulties.find(d => d.checksum.toLowerCase().trim() === norm) || null;
    }

    if (selectedDiff) {
      this.currentBeatmapHash = selectedDiff.checksum.toLowerCase().trim();
      this.callbacks.onBeatmapParsed(selectedDiff.beatmap, undefined, undefined, this.currentBeatmapHash);
      this.callbacks.onTriggerEvaluation();
    } else {
      this.revealDock();
      this.renderDifficultySelector(pkg.difficulties);
      this.currentBeatmapHash = pkg.difficulties[0].checksum.toLowerCase().trim();
      this.callbacks.onBeatmapParsed(pkg.difficulties[0].beatmap, undefined, undefined, this.currentBeatmapHash);
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

      const nameSpan = document.createElement('span');
      nameSpan.textContent = d.diffName;

      const srSpan = document.createElement('span');
      srSpan.className = 'diff-sr';
      srSpan.textContent = `★ ${estSR.toFixed(2)}`;

      row.appendChild(nameSpan);
      row.appendChild(srSpan);

      calculateLazerDifficulty(d.beatmap, currentReplay?.mods || 0, currentReplay ? currentReplayRate : undefined)
        .then((attrs) => {
          srSpan.textContent = `★ ${attrs.starRating.toFixed(2)}`;
        })
        .catch(() => {});

      row.onclick = () => {
        this.currentBeatmapHash = d.checksum.toLowerCase().trim();
        this.callbacks.onBeatmapParsed(d.beatmap, undefined, undefined, this.currentBeatmapHash);
        document.querySelectorAll('.diff-row').forEach((b) => b.classList.remove('active'));
        row.classList.add('active');
      };
      this.diffButtons.appendChild(row);
    });
  }

  public async autoFetchBeatmapFromMirror(hash: string): Promise<void> {
    this.cancelPendingFetch();
    const generation = ++this.currentFetchGeneration;
    this.isFetching = true;
    this.setFetchingUi(true);
    this.setProgress(0.2);

    let progress = 0.2;
    this.progressTimer = setInterval(() => {
      if (this.currentFetchGeneration !== generation) return;
      if (progress < 0.85) {
        progress += 0.05;
        this.setProgress(progress);
      }
    }, 150);

    try {
      const result = await MirrorClient.fetchByMd5(hash, (_msg) => {
        if (this.currentFetchGeneration !== generation) return;
        progress = Math.max(progress, 0.65);
        this.setProgress(progress);
      });

      if (this.currentFetchGeneration !== generation) {
        return;
      }

      if (this.progressTimer !== null) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
      this.setProgress(1.0);

      const beatmap = result.beatmap.beatmap;
      const sr = result.difficultyRating;

      if (result.audioBlobUrl) {
        this.audioPlayer.src = result.audioBlobUrl;
        this.audioPlayer.volume = this.callbacks.getVolume();
      }

      const bgUrl = result.backgroundBlobUrl || null;
      this.currentBeatmapHash = (result.beatmap.checksum || hash).toLowerCase().trim();
      this.callbacks.onSetBackground(bgUrl);
      this.callbacks.onBeatmapParsed(beatmap, sr, bgUrl, this.currentBeatmapHash);

      this.delayedEvalTimer = setTimeout(() => {
        if (this.currentFetchGeneration !== generation) return;
        this.delayedEvalTimer = null;
        this.isFetching = false;
        this.setFetchingUi(false);
        this.callbacks.onTriggerEvaluation();
      }, 250);
    } catch {
      if (this.currentFetchGeneration !== generation) return;
      if (this.progressTimer !== null) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
      this.isFetching = false;
      this.setFetchingUi(false);
      this.setProgress(0);
      if (this.dockDropSpan) {
        this.dockDropSpan.textContent = 'Upload .osz / .osu beatmap';
      }
      this.revealDock();
    }
  }

  public reset(): void {
    this.cancelPendingFetch();
    this.currentBeatmapHash = null;
    this.setFetchingUi(false);
    this.setProgress(0);
    if (this.dockDropSpan) this.dockDropSpan.textContent = '.osz / .osu';
    if (this.dockReplayBar) this.dockReplayBar.style.display = 'none';
    if (this.diffLadder) this.diffLadder.style.display = 'none';
    if (this.dockSubmitBtn) this.dockSubmitBtn.style.display = 'none';
    if (this.diffButtons) this.diffButtons.innerHTML = '';
    if (this.replayInput) this.replayInput.value = '';
    if (this.beatmapInput) this.beatmapInput.value = '';
  }
}
