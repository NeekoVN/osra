/**
 * Odometer-style rolling numbers for the top-bar stats.
 *
 * Each digit lives in a fixed-height window (`1em`) with a vertical strip
 * of 0-9 inside. Changing values translates the strip, and the CSS
 * transition interpolates the travel — with a short blur while rolling for
 * a motion-blur feel. Non-digit characters (`.`, `%`, `x`, `pp`) render as
 * static literals inline with the digit windows.
 *
 * No animation library needed: the browser interpolates `transform`, which
 * stays smooth even though `updateLiveStats` only pushes stepwise targets
 * at TimeBus rate. Seek jumps use `snap` (transitions disabled) so scrubbing
 * never spins through hundreds of digits.
 */

export interface OdometerOptions {
  /** Fixed fractional digits, e.g. 2 for `98.34`. Default 0. */
  decimals?: number;
  /** Static trailing text, e.g. `%`, `x`, `pp`. Default ''. */
  suffix?: string;
  /**
   * Minimum integer digit windows to always render. Shortfalls are filled
   * with invisible (space-occupying) ghost slots on the left, so the value
   * stays right-aligned in a fixed-width box and digits never shift as the
   * number grows (e.g. combo `___7x` -> `1234x`). Values needing more digits
   * grow beyond the reservation. Default 0.
   */
  minIntDigits?: number;
  /** Roll duration in ms. Default 450. */
  durationMs?: number;
  /** Per-column cascade delay from the rightmost digit. Default 35. */
  staggerMs?: number;
}

interface DigitColumn {
  window: HTMLElement;
  strip: HTMLElement;
  digit: number;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export class Odometer {
  private pattern: string | null = null;
  private cols: DigitColumn[] = [];
  private lastText: string | null = null;
  private rollTimer: number | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly opts: OdometerOptions = {},
  ) {
    this.el.classList.add('odo');
    // Inline (beats any slot-specific display rules, e.g. the judgement
    // count slots) so the digit windows always lay out as one reel row.
    this.el.style.display = 'inline-flex';
    this.el.innerHTML = '';
  }

  get element(): HTMLElement {
    return this.el;
  }

  /**
   * Update the minimum integer slot reservation (e.g. when a new map loads
   * with a different max combo). Forces a rebuild on the next `set` so the
   * ghost slots resize even if the displayed value is unchanged.
   */
  setMinIntDigits(n: number): void {
    if ((this.opts.minIntDigits ?? 0) === n) return;
    this.opts.minIntDigits = n;
    this.pattern = null;
    this.lastText = null;
  }

  /** Roll toward `value`, or snap when `snap` / reduced motion. */
  set(value: number, snap = false): void {
    const decimals = this.opts.decimals ?? 0;
    const suffix = this.opts.suffix ?? '';
    const num = decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
    const intLen = num.split('.')[0].length;
    const ghosts = Math.max(0, (this.opts.minIntDigits ?? 0) - intLen);
    const text = num + suffix;
    if (text === this.lastText) return;
    this.lastText = text;

    const pattern = `g${ghosts}:` + [...num].map((ch) => (ch >= '0' && ch <= '9' ? 'd' : ch)).join('') + (suffix ? `#${suffix}` : '');
    if (pattern !== this.pattern) {
      this.rebuild(num, suffix, ghosts);
      this.pattern = pattern;
      return;
    }

    const duration = this.opts.durationMs ?? 450;
    const stagger = this.opts.staggerMs ?? 35;
    const instant = snap || prefersReducedMotion() || duration <= 0;

    let di = 0;
    const digitChars = [...num];
    for (let i = 0; i < digitChars.length; i++) {
      const ch = digitChars[i];
      if (ch < '0' || ch > '9') continue;
      const col = this.cols[di++];
      if (!col) continue;
      const digit = ch.charCodeAt(0) - 48;
      if (digit === col.digit) {
        col.strip.style.transitionDelay = '0ms';
        continue;
      }
      col.digit = digit;
      // Cascade from the right: least significant digit leads.
      col.strip.style.transitionDelay = instant ? '0ms' : `${(this.cols.length - di) * stagger}ms`;
      if (instant) {
        col.strip.classList.add('no-anim');
        col.strip.style.transform = `translateY(${-digit}em)`;
        // Force reflow so the snap applies before transitions return.
        void col.strip.offsetHeight;
        col.strip.classList.remove('no-anim');
        col.strip.classList.remove('is-rolling');
      } else {
        col.strip.style.transform = `translateY(${-digit}em)`;
        col.strip.classList.add('is-rolling');
      }
    }

    if (!instant) {
      if (this.rollTimer !== null) window.clearTimeout(this.rollTimer);
      const total = duration + stagger * this.cols.length + 60;
      this.rollTimer = window.setTimeout(() => {
        this.rollTimer = null;
        for (const col of this.cols) col.strip.classList.remove('is-rolling');
      }, total);
    }
  }

  /**
   * Full (re)build for a new shape, e.g. `99.98%` -> `100.00%`. Snaps in.
   * `ghosts` leading slots render invisible but space-occupying so the
   * visible digits stay right-aligned in a fixed-width box.
   */
  private rebuild(num: string, suffix: string, ghosts: number): void {
    if (this.rollTimer !== null) {
      window.clearTimeout(this.rollTimer);
      this.rollTimer = null;
    }
    this.el.innerHTML = '';
    this.cols = [];

    for (let g = 0; g < ghosts; g++) {
      const ghost = document.createElement('span');
      ghost.className = 'odo-digit odo-ghost';
      ghost.setAttribute('aria-hidden', 'true');
      const strip = document.createElement('span');
      strip.className = 'odo-strip';
      strip.style.transform = 'translateY(0em)';
      for (let d = 0; d <= 9; d++) {
        const cell = document.createElement('span');
        cell.className = 'odo-cell';
        cell.textContent = String(d);
        strip.appendChild(cell);
      }
      ghost.appendChild(strip);
      this.el.appendChild(ghost);
    }

    for (const ch of num) {
      if (ch >= '0' && ch <= '9') {
        const digit = ch.charCodeAt(0) - 48;
        const windowEl = document.createElement('span');
        windowEl.className = 'odo-digit';
        const strip = document.createElement('span');
        strip.className = 'odo-strip';
        for (let d = 0; d <= 9; d++) {
          const cell = document.createElement('span');
          cell.className = 'odo-cell';
          cell.textContent = String(d);
          strip.appendChild(cell);
        }
        strip.style.transform = `translateY(${-digit}em)`;
        windowEl.appendChild(strip);
        this.el.appendChild(windowEl);
        this.cols.push({ window: windowEl, strip, digit });
      } else {
        const lit = document.createElement('span');
        lit.className = 'odo-lit';
        lit.textContent = ch;
        this.el.appendChild(lit);
      }
    }
    if (suffix) {
      const lit = document.createElement('span');
      lit.className = 'odo-lit odo-suffix';
      lit.textContent = suffix;
      this.el.appendChild(lit);
    }
  }
}

/** Duration per stat: snappy counters, heavier PP roll. */
export const ODO_ACC: OdometerOptions = { decimals: 2, suffix: '%', durationMs: 500 };
export const ODO_COMBO: OdometerOptions = { decimals: 0, suffix: 'x', durationMs: 320 };
export const ODO_UR: OdometerOptions = { decimals: 2, durationMs: 500 };
export const ODO_PP: OdometerOptions = { decimals: 0, suffix: 'pp', durationMs: 600 };
export const ODO_INT: OdometerOptions = { decimals: 0, durationMs: 320 };
