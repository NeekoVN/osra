export type TimeSubscriber = (timeMs: number) => void;
export type RateSubscriber = (rate: number) => void;

/**
 * High-precision centralized timeline bus synchronizing audio, canvas playfield,
 * and uPlot telemetry channels
 */
export class TimeBus {
  private currentTimeMs: number = 0;
  private minTimeMs: number = 0;
  private durationMs: number = 0;
  private isPlaying: boolean = false;
  private playbackRate: number = 1.0;
  private lastRafTime: number = 0;
  private rafId: number | null = null;
  private subscribers: Set<TimeSubscriber> = new Set();
  private rateSubscribers: Set<RateSubscriber> = new Set();
  private audioElement: HTMLAudioElement | null = null;
  private volume: number = 0.6;
  private skipGaps: Array<{ from: number; to: number }> = [];

  constructor() {
    this.loop = this.loop.bind(this);
  }

  public setAudioElement(audio: HTMLAudioElement | null): void {
    this.audioElement = audio;
    if (this.audioElement) {
      this.audioElement.playbackRate = this.playbackRate;
      this.audioElement.volume = this.volume;
      this.audioElement.onended = () => {
        this.pause();
      };
      this.audioElement.onpause = () => {
        if (this.isPlaying) {
          this.pause();
        }
      };
      this.audioElement.onplay = () => {
        if (!this.isPlaying) {
          this.play();
        }
      };
    }
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.audioElement) {
      this.audioElement.volume = this.volume;
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public setMinTime(minTimeMs: number): void {
    this.minTimeMs = minTimeMs;
  }

  public getMinTime(): number {
    return this.minTimeMs;
  }

  public setDuration(durationMs: number): void {
    this.durationMs = Math.max(0, durationMs);
  }

  public getDuration(): number {
    return this.durationMs;
  }

  public setSkipGaps(gaps: Array<{ from: number; to: number }>): void {
    this.skipGaps = [...gaps];
  }

  public getSkipGaps(): Array<{ from: number; to: number }> {
    return this.skipGaps;
  }

  public getCurrentTime(): number {
    return this.currentTimeMs;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
  }

  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.1, Math.min(4.0, rate));
    if (this.audioElement) {
      this.audioElement.playbackRate = this.playbackRate;
    }
    this.rateSubscribers.forEach(cb => cb(this.playbackRate));
  }

  public subscribeRate(cb: RateSubscriber): () => void {
    this.rateSubscribers.add(cb);
    cb(this.playbackRate);
    return () => this.rateSubscribers.delete(cb);
  }

  public subscribe(cb: TimeSubscriber): () => void {
    this.subscribers.add(cb);
    cb(this.currentTimeMs);
    return () => this.subscribers.delete(cb);
  }

  public seek(timeMs: number): void {
    this.currentTimeMs = Math.max(this.minTimeMs, Math.min(this.durationMs, timeMs));
    if (this.audioElement) {
      if (this.currentTimeMs >= 0) {
        const audioTargetSec = this.currentTimeMs / 1000;
        if (Math.abs(this.audioElement.currentTime - audioTargetSec) > 0.05) {
          this.audioElement.currentTime = audioTargetSec;
        }
        if (this.isPlaying && this.audioElement.paused) {
          this.audioElement.play().catch(() => { });
        }
      } else {
        this.audioElement.currentTime = 0;
        if (!this.audioElement.paused) {
          this.audioElement.pause();
        }
      }
    }
    this.notify();
  }

  public play(): void {
    if (this.isPlaying) return;
    if (this.currentTimeMs >= this.durationMs && this.durationMs > 0) {
      this.seek(Math.min(0, this.minTimeMs));
    }
    this.isPlaying = true;
    this.lastRafTime = performance.now();
    if (this.audioElement && this.currentTimeMs >= 0 && this.audioElement.paused) {
      this.audioElement.currentTime = this.currentTimeMs / 1000;
      this.audioElement.playbackRate = this.playbackRate;
      this.audioElement.play().catch(() => { });
    }
    this.notify();
    this.rafId = requestAnimationFrame(this.loop);
  }

  public pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.audioElement && !this.audioElement.paused) {
      this.audioElement.pause();
    }
    this.notify();
  }

  public togglePlay(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  private loop(now: number): void {
    if (!this.isPlaying) return;

    const delta = now - this.lastRafTime;
    this.lastRafTime = now;

    if (this.currentTimeMs < 0) {
      // Intro lead-in before audio starts
      this.currentTimeMs += delta * this.playbackRate;
      if (this.currentTimeMs >= 0 && this.audioElement && this.audioElement.paused) {
        this.audioElement.currentTime = this.currentTimeMs / 1000;
        this.audioElement.play().catch(() => { });
      }
    } else {
      // Audio playback range
      if (this.audioElement && !this.audioElement.paused && !this.audioElement.seeking) {
        const audioMs = this.audioElement.currentTime * 1000;
        if (Math.abs(audioMs - this.currentTimeMs) > 30) {
          this.currentTimeMs = audioMs;
        } else {
          this.currentTimeMs += delta * this.playbackRate;
        }
      } else {
        this.currentTimeMs += delta * this.playbackRate;
      }
    }

    // Automatically leap across any skipped gap (e.g. intro skip pressed by player in replay)
    for (const gap of this.skipGaps) {
      if (this.currentTimeMs >= gap.from && this.currentTimeMs < gap.to) {
        this.currentTimeMs = gap.to;
        if (this.audioElement) {
          this.audioElement.currentTime = Math.max(0, gap.to / 1000);
        }
        break;
      }
    }

    if (this.durationMs > 0 && this.currentTimeMs >= this.durationMs) {
      this.currentTimeMs = this.durationMs;
      this.pause();
      this.notify();
      return;
    }

    this.notify();
    this.rafId = requestAnimationFrame(this.loop);
  }

  private notify(): void {
    for (const sub of this.subscribers) {
      sub(this.currentTimeMs);
    }
  }
}
