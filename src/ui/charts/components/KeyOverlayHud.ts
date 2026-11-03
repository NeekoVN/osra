import { EvaluationResult, KeyInterval } from '../../../core/evaluator/types.ts';
import { TapPatternClassifier } from '../../../core/evaluator/TapPatternClassifier.ts';

export class KeyOverlayHud {
  private keyTileK1: HTMLElement | null = null;
  private keyTileK2: HTMLElement | null = null;
  private keyCountK1: HTMLElement | null = null;
  private keyCountK2: HTMLElement | null = null;
  private keyBpmK1: HTMLElement | null = null;
  private keyBpmK2: HTMLElement | null = null;
  private keyLiveBpm: HTMLElement | null = null;

  public attach(parent: HTMLElement): void {
    const hud = document.createElement('div');
    hud.className = 'key-overlay-hud';
    hud.innerHTML = `
      <div class="argon-key argon-key-k1" id="key-tile-k1" title="K1 Keypress Counter (Cyan)">
        <div class="argon-key-indicator"></div>
        <span class="argon-key-count" id="key-count-k1">0</span>
      </div>
      <div class="argon-key argon-key-k2" id="key-tile-k2" title="K2 Keypress Counter (Pink)">
        <div class="argon-key-indicator"></div>
        <span class="argon-key-count" id="key-count-k2">0</span>
      </div>
      <div class="argon-bpm-badge" id="key-live-bpm">-- Stream BPM</div>
    `;
    parent.appendChild(hud);

    this.keyTileK1 = hud.querySelector('#key-tile-k1');
    this.keyTileK2 = hud.querySelector('#key-tile-k2');
    this.keyCountK1 = hud.querySelector('#key-count-k1');
    this.keyCountK2 = hud.querySelector('#key-count-k2');
    this.keyBpmK1 = hud.querySelector('#key-bpm-k1');
    this.keyBpmK2 = hud.querySelector('#key-bpm-k2');
    this.keyLiveBpm = hud.querySelector('#key-live-bpm');
  }

  public update(
    currentTimeMs: number,
    evalResult: EvaluationResult | null,
    k1CumulativeTaps: Uint32Array | null,
    k2CumulativeTaps: Uint32Array | null
  ): void {
    if (!evalResult || !this.keyTileK1 || !this.keyTileK2) return;
    const keyTimes = evalResult.keyTimes;
    if (keyTimes.length === 0) return;

    // Binary search for frame at or just before currentTimeMs
    let low = 0;
    let high = keyTimes.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (keyTimes[mid] <= currentTimeMs) low = mid + 1;
      else high = mid - 1;
    }
    const idx = Math.max(0, Math.min(keyTimes.length - 1, low - 1));

    const isK1 = evalResult.k1Frames[idx] === 1;
    const isK2 = evalResult.k2Frames[idx] === 1;

    this.keyTileK1.classList.toggle('is-pressed', isK1);
    this.keyTileK2.classList.toggle('is-pressed', isK2);

    if (this.keyCountK1 && k1CumulativeTaps) {
      this.keyCountK1.textContent = (k1CumulativeTaps[idx] || 0).toLocaleString();
    }
    if (this.keyCountK2 && k2CumulativeTaps) {
      this.keyCountK2.textContent = (k2CumulativeTaps[idx] || 0).toLocaleString();
    }

    const clockRate = evalResult.gameplayRate || 1.0;

    // Per-key BPM calculation from discrete keypress intervals
    const getRecentKeyBpm = (intervals: KeyInterval[]): number => {
      if (!intervals || intervals.length < 2) return 0;
      let l = 0;
      let h = intervals.length - 1;
      while (l <= h) {
        const m = (l + h) >> 1;
        if (intervals[m].pressTime <= currentTimeMs) l = m + 1;
        else h = m - 1;
      }
      const currIdx = l - 1;
      if (currIdx < 1) return 0;

      const curr = intervals[currIdx];
      if (currentTimeMs - curr.pressTime > 650) return 0;

      const count = Math.min(currIdx, 3);
      const oldest = intervals[currIdx - count];
      const dtAudio = (curr.pressTime - oldest.pressTime) / count;
      const dtReal = dtAudio / clockRate;

      if (dtReal >= 30 && dtReal <= 750) {
        return Math.round(30000 / dtReal);
      }
      return 0;
    };

    const k1Bpm = getRecentKeyBpm(evalResult.k1Intervals);
    const k2Bpm = getRecentKeyBpm(evalResult.k2Intervals);

    if (this.keyBpmK1) {
      this.keyBpmK1.textContent = k1Bpm > 0 ? `${k1Bpm} BPM` : '-- BPM';
    }
    if (this.keyBpmK2) {
      this.keyBpmK2.textContent = k2Bpm > 0 ? `${k2Bpm} BPM` : '-- BPM';
    }

    if (this.keyLiveBpm) {
      const activePattern = evalResult.tapPatterns
        ? TapPatternClassifier.findPatternAt(evalResult.tapPatterns, currentTimeMs)
        : null;

      if (activePattern) {
        const typePrefix =
          activePattern.type === 'tech_alt'
            ? 'Tech Alt'
            : activePattern.type === 'alt'
            ? 'Alt'
            : 'Stream';
        this.keyLiveBpm.textContent = `${activePattern.estimatedBpm} ${typePrefix} BPM`;
      } else if (k1Bpm > 140 && k2Bpm > 140) {
        const avgStreamBpm = Math.round((k1Bpm + k2Bpm) / 2);
        this.keyLiveBpm.textContent = `${avgStreamBpm} Stream BPM`;
      } else {
        this.keyLiveBpm.textContent = '-- Stream BPM';
      }
    }
  }

  public destroy(): void {
    this.keyTileK1 = null;
    this.keyTileK2 = null;
    this.keyCountK1 = null;
    this.keyCountK2 = null;
    this.keyBpmK1 = null;
    this.keyBpmK2 = null;
    this.keyLiveBpm = null;
  }
}
