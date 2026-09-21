import { TimeBus } from '../TimeBus.ts';
import { TimedHitEvent, HitJudgement, DesyncType } from '../../core/types/telemetry.ts';

const ICONS = {
  play: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="margin-left: 2px;"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>`,
  pause: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`,
  skipIntro: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><polygon points="13 19 22 12 13 5 13 19"></polygon><polygon points="2 19 11 12 2 5 2 19"></polygon></svg>`,
  volumeHigh: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
  volumeMed: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
  volumeMute: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`
};

export class PlaybackControls {
  private container: HTMLElement;
  private timeBus: TimeBus;
  private playBtn!: HTMLButtonElement;
  private skipBtn!: HTMLButtonElement;
  private timeDisplay!: HTMLElement;
  private progressBar!: HTMLElement;
  private progressThumb!: HTMLElement;
  private ticksContainer!: HTMLElement;
  private isDragging: boolean = false;
  private firstObjectTime: number = 0;
  private currentEvents: TimedHitEvent[] = [];
  private currentSkipGaps: Array<{ from: number; to: number }> = [];
  private lastIsPlaying: boolean | null = null;

  constructor(container: HTMLElement, timeBus: TimeBus) {
    this.container = container;
    this.timeBus = timeBus;
    this.buildUI();
    this.setupKeybindings();
    this.timeBus.subscribe((t) => this.onTimeUpdate(t));
  }

  private buildUI(): void {
    this.container.innerHTML = `
      <div class="playback-bar">
        <div class="playback-buttons">
          <button class="btn-play" id="btn-play-toggle" title="Play / Pause (Space)">${ICONS.play}</button>
          <button class="btn-skip-intro" id="btn-skip-intro" style="display: none;" title="Skip Intro (Space)">${ICONS.skipIntro}Skip Intro</button>
          <div class="playback-rates">
            <button class="rate-btn" data-rate="0.5">0.5x</button>
            <button class="rate-btn" data-rate="0.75">0.75x</button>
            <button class="rate-btn active" data-rate="1.0">1.0x</button>
            <button class="rate-btn" data-rate="1.5">1.5x</button>
          </div>
          <span class="playback-time" id="playback-time-text">00:00.00 / 00:00.00</span>
        </div>
        <div class="scrubber-track" id="scrubber-track">
          <div class="scrubber-fill" id="scrubber-fill"></div>
          <div class="scrubber-ticks" id="scrubber-ticks"></div>
          <div class="scrubber-thumb" id="scrubber-thumb"></div>
        </div>
        <div class="playback-volume">
          <button class="btn-volume" id="btn-volume" title="Mute / Unmute">${ICONS.volumeMed}</button>
          <input type="range" id="volume-slider" class="volume-slider" min="0" max="1" step="0.05" value="0.6" title="Volume: 40%">
        </div>
      </div>
    `;

    this.playBtn = this.container.querySelector('#btn-play-toggle') as HTMLButtonElement;
    this.skipBtn = this.container.querySelector('#btn-skip-intro') as HTMLButtonElement;
    this.timeDisplay = this.container.querySelector('#playback-time-text') as HTMLElement;
    this.progressBar = this.container.querySelector('#scrubber-fill') as HTMLElement;
    this.progressThumb = this.container.querySelector('#scrubber-thumb') as HTMLElement;
    this.ticksContainer = this.container.querySelector('#scrubber-ticks') as HTMLElement;

    const volumeBtn = this.container.querySelector('#btn-volume') as HTMLButtonElement;
    const volumeSlider = this.container.querySelector('#volume-slider') as HTMLInputElement;

    const updateVolumeIcon = (vol: number) => {
      volumeBtn.innerHTML = vol === 0 ? ICONS.volumeMute : (vol < 0.5 ? ICONS.volumeMed : ICONS.volumeHigh);
    };

    volumeSlider.addEventListener('input', () => {
      const vol = parseFloat(volumeSlider.value);
      this.timeBus.setVolume(vol);
      updateVolumeIcon(vol);
      volumeSlider.title = `Volume: ${Math.round(vol * 100)}%`;
    });

    volumeBtn.onclick = () => {
      if (this.timeBus.getVolume() > 0) {
        this.timeBus.setVolume(0);
        volumeSlider.value = '0';
        updateVolumeIcon(0);
      } else {
        this.timeBus.setVolume(0.4);
        volumeSlider.value = '0.4';
        updateVolumeIcon(0.4);
      }
    };

    const updatePlayBtn = () => {
      const isPlaying = this.timeBus.getIsPlaying();
      if (this.lastIsPlaying !== isPlaying) {
        this.lastIsPlaying = isPlaying;
        this.playBtn.innerHTML = isPlaying ? ICONS.pause : ICONS.play;
        this.playBtn.title = isPlaying ? 'Pause (Space)' : 'Play (Space)';
      }
    };

    this.playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.timeBus.togglePlay();
      updatePlayBtn();
    });

    this.skipBtn.onclick = () => {
      this.skipIntro();
    };

    // Playback rates
    this.container.querySelectorAll('.rate-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const rate = parseFloat((e.target as HTMLElement).dataset.rate || '1.0');
        this.timeBus.setPlaybackRate(rate);
        this.container.querySelectorAll('.rate-btn').forEach(b => b.classList.remove('active'));
        (e.target as HTMLElement).classList.add('active');
      });
    });

    // Scrubber track click / drag
    const track = this.container.querySelector('#scrubber-track') as HTMLElement;

    const handleScrub = (e: MouseEvent) => {
      const rect = track.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.timeBus.seek(pos * this.timeBus.getDuration());
    };

    track.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      handleScrub(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) handleScrub(e);
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });
  }

  private setupKeybindings(): void {
    window.addEventListener('keydown', (e) => {
      // Don't trigger if user is focused on an input element
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (this.timeBus.getIsPlaying()) {
          this.timeBus.pause();
        } else {
          const cur = this.timeBus.getCurrentTime();
          if (this.firstObjectTime > 1500 && cur < this.firstObjectTime - 1000) {
            this.skipIntro();
          } else {
            this.timeBus.play();
          }
        }
        this.updatePlayBtnState();
      }

      // Frame-by-frame scrubbing: Left/Right arrow keys
      // Shift + arrow: ±500ms jump, normal arrow: ±16ms (single frame ~16ms)
      if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        e.preventDefault();
        const stepMs = e.shiftKey ? 500 : (e.altKey ? 100 : 16);
        const direction = e.code === 'ArrowRight' ? 1 : -1;
        const cur = this.timeBus.getCurrentTime();
        const wasPlaying = this.timeBus.getIsPlaying();
        if (wasPlaying) {
          this.timeBus.pause();
          this.updatePlayBtnState();
        }
        this.timeBus.seek(cur + direction * stepMs);
      }
    });
  }

  private updatePlayBtnState(): void {
    const isPlaying = this.timeBus.getIsPlaying();
    if (this.lastIsPlaying !== isPlaying) {
      this.lastIsPlaying = isPlaying;
      this.playBtn.innerHTML = isPlaying ? ICONS.pause : ICONS.play;
      this.playBtn.title = isPlaying ? 'Pause (Space)' : 'Play (Space)';
    }
  }

  public skipIntro(): void {
    if (this.firstObjectTime > 0) {
      const targetTime = Math.max(0, this.firstObjectTime - 1000);
      this.timeBus.seek(targetTime);
    }
  }

  public setSkipInfo(firstObjectTime: number, skipGaps: Array<{ from: number; to: number }>): void {
    this.firstObjectTime = firstObjectTime;
    this.currentSkipGaps = [...skipGaps];
    this.renderTicks();
  }

  public setIncidents(events: TimedHitEvent[]): void {
    this.currentEvents = [...events];
    this.renderTicks();
  }

  private renderTicks(): void {
    const duration = this.timeBus.getDuration();
    if (duration <= 0) return;

    this.ticksContainer.innerHTML = '';

    // 1. Shaded Intro band on scrubber track
    if (this.firstObjectTime > 0) {
      const introPct = Math.min(100, (this.firstObjectTime / duration) * 100);
      const introBand = document.createElement('div');
      introBand.className = 'scrubber-intro-band';
      introBand.style.width = `${introPct}%`;
      introBand.title = `Intro: until ${(this.firstObjectTime / 1000).toFixed(1)}s`;
      this.ticksContainer.appendChild(introBand);
    }

    // 2. Hatched Skip Gap segments (where player pressed skip in replay)
    for (const gap of this.currentSkipGaps) {
      const leftPct = (gap.from / duration) * 100;
      const widthPct = Math.max(0.5, ((gap.to - gap.from) / duration) * 100);
      const gapEl = document.createElement('div');
      gapEl.className = 'scrubber-skip-gap';
      gapEl.style.left = `${leftPct}%`;
      gapEl.style.width = `${widthPct}%`;
      gapEl.title = `Intro Skipped (${(gap.from / 1000).toFixed(1)}s → ${(gap.to / 1000).toFixed(1)}s)`;
      this.ticksContainer.appendChild(gapEl);
    }

    // 3. Incident ticks (misses and desyncs)
    this.currentEvents.forEach(e => {
      const isDesync = e.desyncType === DesyncType.EarlyTap || e.desyncType === DesyncType.LateTap || e.desyncType === DesyncType.SpeedMiss;
      if (isDesync || e.judgement === HitJudgement.Miss) {
        const tick = document.createElement('div');
        const pos = (e.targetTime / duration) * 100;
        tick.className = `scrubber-tick ${isDesync ? 'purple' : 'red'}`;
        tick.style.left = `${pos}%`;
        const desyncLabel = e.desyncType === DesyncType.EarlyTap ? 'Early Tap'
          : e.desyncType === DesyncType.LateTap ? 'Late Tap'
          : 'Cursor Desync';
        tick.title = isDesync ? `Tap Desync (${desyncLabel})` : 'Miss';
        this.ticksContainer.appendChild(tick);
      }
    });
  }

  private onTimeUpdate(currentTimeMs: number): void {
    const duration = this.timeBus.getDuration();
    const progress = duration > 0 ? (currentTimeMs / duration) * 100 : 0;

    this.progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    this.progressThumb.style.left = `${Math.max(0, Math.min(100, progress))}%`;

    // Toggle Skip Intro button visibility
    const canSkip = this.firstObjectTime > 1500 && currentTimeMs < this.firstObjectTime - 1000;
    this.skipBtn.style.display = canSkip ? 'inline-flex' : 'none';
    this.updatePlayBtnState();

    const curMins = Math.floor(Math.abs(currentTimeMs) / 60000);
    const curSecs = ((Math.abs(currentTimeMs) % 60000) / 1000).toFixed(2);
    const sign = currentTimeMs < 0 ? '-' : '';

    const durMins = Math.floor(duration / 60000);
    const durSecs = ((duration % 60000) / 1000).toFixed(2);

    this.timeDisplay.textContent = `${sign}${curMins}:${curSecs.padStart(5, '0')} / ${durMins}:${durSecs.padStart(5, '0')}`;
  }

  public setInitialRate(rate: number): void {
    this.timeBus.setPlaybackRate(rate);
    const rateBtns = this.container.querySelectorAll('.rate-btn');
    rateBtns.forEach(btn => {
      const btnRate = parseFloat((btn as HTMLElement).dataset.rate || '1.0');
      if (Math.abs(btnRate - rate) < 0.05) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }
}
