import { TimedHitEvent, HitJudgement, DesyncType } from '../../core/types/telemetry.ts';
import { TimeBus } from '../TimeBus.ts';
import { FingerLockEvent } from '../../core/evaluator/ReplayEvaluator.ts';
import { TapPattern } from '../../core/evaluator/TapPatternClassifier.ts';

export class IncidentsDrawer {
  private container: HTMLElement;
  private timeBus: TimeBus;
  private allEvents: TimedHitEvent[] = [];
  private fingerLocks: FingerLockEvent[] = [];
  private patterns: TapPattern[] = [];
  private currentFilter: 'all' | 'desync' | 'fingerlock' | 'patterns' | 'misses' = 'desync';

  constructor(container: HTMLElement, timeBus: TimeBus) {
    this.container = container;
    this.timeBus = timeBus;
  }

  public setData(
    hitEvents: TimedHitEvent[],
    fingerLocks: FingerLockEvent[],
    patterns: TapPattern[] = []
  ): void {
    this.allEvents = hitEvents;
    this.fingerLocks = fingerLocks;
    this.patterns = patterns;
    this.render();
  }

  public render(): void {
    this.container.innerHTML = '';

    // Tab bar
    const tabs = document.createElement('div');
    tabs.className = 'incident-tabs';

    const isTapDesync = (e: TimedHitEvent) => e.desyncType === DesyncType.EarlyTap || e.desyncType === DesyncType.LateTap || e.desyncType === DesyncType.SpeedMiss;
    const desyncsCount = this.allEvents.filter(isTapDesync).length;
    const missesCount = this.allEvents.filter(e => e.judgement === HitJudgement.Miss).length;

    const tabDefs = [
      { id: 'desync', label: `Tap Desync (${desyncsCount})` },
      { id: 'fingerlock', label: `Finger Lock (${this.fingerLocks.length})` },
      { id: 'patterns', label: `Patterns (${this.patterns.length})` },
      { id: 'misses', label: `Misses (${missesCount})` },
      { id: 'all', label: `All Incidents` }
    ];

    tabDefs.forEach(t => {
      const btn = document.createElement('button');
      btn.className = `incident-tab-btn ${this.currentFilter === t.id ? 'active' : ''}`;
      btn.textContent = t.label;
      btn.onclick = () => {
        this.currentFilter = t.id as typeof this.currentFilter;
        this.render();
      };
      tabs.appendChild(btn);
    });

    this.container.appendChild(tabs);

    // List container
    const list = document.createElement('div');
    list.className = 'incident-list';

    if (this.currentFilter === 'patterns') {
      if (this.patterns.length === 0) {
        list.innerHTML = '<div class="no-incidents">No streams, bursts, or alternating patterns detected in this beatmap.</div>';
      } else {
        this.patterns.forEach(p => {
          const item = document.createElement('div');
          item.className = 'incident-item';
          const mins = Math.floor(p.startTime / 60000);
          const secs = ((p.startTime % 60000) / 1000).toFixed(2);
          const isDeathstream = p.type === 'deathstream';
          const isStream = p.type === 'stream';
          const isTechAlt = p.type === 'tech_alt';
          const isAlt = p.type === 'alt';
          const badgeClass = isDeathstream ? 'red' : isStream ? 'purple' : isTechAlt ? 'orange' : isAlt ? 'gold' : 'cyan';
          const badgeLabel = isDeathstream
            ? 'DEATHSTREAM (40+)'
            : isStream
              ? 'STREAM (12-39)'
              : isTechAlt
                ? `TECH ALT (${p.noteCount})`
                : isAlt
                  ? `ALT (${p.noteCount})`
                  : 'BURST (3-11)';

          item.innerHTML = `
            <div class="incident-meta">
              <span class="incident-time">${mins}:${secs.padStart(5, '0')}</span>
              <span class="badge ${badgeClass}">${badgeLabel}</span>
              <span class="badge gold">${p.estimatedBpm} BPM</span>
            </div>
            <div class="incident-desc">${p.label} (avg spacing ${p.avgIntervalMs}ms)</div>
            <button class="btn-seek"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>Seek</button>
          `;
          item.querySelector('.btn-seek')?.addEventListener('click', () => {
            this.timeBus.seek(Math.max(0, p.startTime - 250));
          });
          list.appendChild(item);
        });
      }
    } else if (this.currentFilter === 'fingerlock') {
      if (this.fingerLocks.length === 0) {
        list.innerHTML = '<div class="no-incidents">No finger-lock overlaps detected in this replay.</div>';
      } else {
        this.fingerLocks.forEach(f => {
          const item = document.createElement('div');
          item.className = 'incident-item';
          const mins = Math.floor(f.time / 60000);
          const secs = ((f.time % 60000) / 1000).toFixed(2);

          const patternBadge = f.patternType === 'deathstream'
            ? `<span class="badge red">Deathstream Lock (${f.patternNoteCount} notes @ ${f.patternBpm} BPM)</span>`
            : f.patternType === 'stream'
              ? `<span class="badge purple">Stream Lock (${f.patternNoteCount} notes @ ${f.patternBpm} BPM)</span>`
              : f.patternType === 'tech_alt'
                ? `<span class="badge orange">Tech Alt Lock (${f.patternNoteCount} notes @ ${f.patternBpm} BPM)</span>`
                : f.patternType === 'alt'
                  ? `<span class="badge gold">Alt Lock (${f.patternNoteCount} notes @ ${f.patternBpm} BPM)</span>`
                  : f.patternType === 'burst'
                    ? `<span class="badge cyan">Burst Lock (${f.patternNoteCount} notes @ ${f.patternBpm} BPM)</span>`
                    : '';

          const desc = f.patternType
            ? `Alternating ${f.patternType} lock during ${f.patternLabel}: both ${f.key1} and ${f.key2} held for ${f.overlapMs}ms`
            : `Rapid alternating lock: both ${f.key1} and ${f.key2} held for ${f.overlapMs}ms`;

          item.innerHTML = `
            <div class="incident-meta">
              <span class="incident-time">${mins}:${secs.padStart(5, '0')}</span>
              <span class="badge gold">${f.overlapMs}ms Overlap</span>
              ${patternBadge}
            </div>
            <div class="incident-desc">${desc}</div>
            <button class="btn-seek"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>Seek</button>
          `;
          item.querySelector('.btn-seek')?.addEventListener('click', () => {
            this.timeBus.seek(Math.max(0, f.time - 300));
          });
          list.appendChild(item);
        });
      }
    } else {
      let filtered = this.allEvents.filter(e => {
        if (this.currentFilter === 'desync') return isTapDesync(e);
        if (this.currentFilter === 'misses') return e.judgement === HitJudgement.Miss;
        return isTapDesync(e) || e.judgement !== HitJudgement.Great;
      });

      if (filtered.length === 0) {
        list.innerHTML = '<div class="no-incidents">No incidents found matching current filter.</div>';
      } else {
        filtered.slice(0, 50).forEach(e => {
          const item = document.createElement('div');
          item.className = 'incident-item';
          const mins = Math.floor(e.targetTime / 60000);
          const secs = ((e.targetTime % 60000) / 1000).toFixed(2);

          const isDesync = isTapDesync(e);
          const badgeClass = isDesync ? 'purple' : (e.judgement === HitJudgement.Miss ? 'red' : 'gold');
          const badgeText = isDesync
            ? (e.desyncType === DesyncType.EarlyTap ? 'EARLY TAP'
              : e.desyncType === DesyncType.LateTap ? 'LATE TAP'
              : 'CURSOR DESYNC')
            : (e.judgement === HitJudgement.Miss ? (e.desyncType === DesyncType.MisaimInWindow ? 'MISAIM' : 'AIM MISS') : `${e.judgement} (${e.timeOffset > 0 ? '+' : ''}${e.timeOffset.toFixed(0)}ms)`);

          item.innerHTML = `
            <div class="incident-meta">
              <span class="incident-time">${mins}:${secs.padStart(5, '0')}</span>
              <span class="incident-object">#${e.objectIndex}</span>
              <span class="badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="incident-desc">
              ${e.desyncType === DesyncType.EarlyTap ? `Tapped ${Math.abs(e.timeOffset).toFixed(0)}ms early (cursor was ${e.distanceToCenter.toFixed(1)}px from center)` :
              e.desyncType === DesyncType.LateTap ? `Tapped ${e.timeOffset.toFixed(0)}ms late (cursor left circle)` :
              e.desyncType === DesyncType.SpeedMiss ? `Cursor moved past circle (tap was ${e.timeOffset > 0 ? '+' : ''}${e.timeOffset.toFixed(0)}ms, Δ ${e.distanceToCenter.toFixed(1)}px)` :
                e.desyncType === DesyncType.TrueAimMiss ? `Cursor missed circle by ${e.distanceToCenter.toFixed(1)}px (no tap in window)` :
                  e.desyncType === DesyncType.MisaimInWindow ? `Cursor missed circle by ${e.distanceToCenter.toFixed(1)}px during tap` :
                    `Hit offset: ${e.timeOffset > 0 ? '+' : ''}${e.timeOffset.toFixed(1)}ms | Distance: ${e.distanceToCenter.toFixed(1)}px (${e.marginUsagePercent.toFixed(0)}% margin)`}
            </div>
            <button class="btn-seek"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>Seek</button>
          `;
          item.querySelector('.btn-seek')?.addEventListener('click', () => {
            this.timeBus.seek(Math.max(0, e.targetTime - 300));
          });
          list.appendChild(item);
        });
      }
    }

    this.container.appendChild(list);
  }
}
