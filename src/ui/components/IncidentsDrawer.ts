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
  private currentFilter: 'all' | 'desync' | 'fingerlock' | 'patterns' | 'misses' = 'all';

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

    const isTapDesync = (e: TimedHitEvent) => e.desyncType === DesyncType.EarlyTap || e.desyncType === DesyncType.LateTap || e.desyncType === DesyncType.SpeedMiss;
    const desyncsCount = this.allEvents.filter(isTapDesync).length;
    const missesCount = this.allEvents.filter(e => e.judgement === HitJudgement.Miss).length;

    // Tabs bar: the tabs ARE the panel header (Penpot design), with the
    // minimize toggle pinned at the right end of the same row.
    const tabsbar = document.createElement('div');
    tabsbar.className = 'incident-tabsbar';

    const tabs = document.createElement('div');
    tabs.className = 'incident-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Incident categories');

    const tabDefs = [
      { id: 'all', label: 'All Incidents' },
      { id: 'desync', label: `Tap Desync (${desyncsCount})` },
      { id: 'fingerlock', label: `Finger Lock (${this.fingerLocks.length})` },
      { id: 'patterns', label: `Patterns (${this.patterns.length})` },
      { id: 'misses', label: `Misses (${missesCount})` }
    ];

    tabDefs.forEach(t => {
      const btn = document.createElement('button');
      btn.className = `incident-tab-btn ${this.currentFilter === t.id ? 'active' : ''}`;
      btn.textContent = t.label;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', this.currentFilter === t.id ? 'true' : 'false');
      btn.onclick = () => {
        this.currentFilter = t.id as typeof this.currentFilter;
        this.render();
      };
      btn.onkeydown = (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const btns = [...tabs.querySelectorAll('.incident-tab-btn')];
          const idx = btns.indexOf(btn);
          const ni = Math.max(0, Math.min(btns.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1)));
          (btns[ni] as HTMLElement).focus();
          (btns[ni] as HTMLElement).click();
        }
      };
      tabs.appendChild(btn);
    });

    tabsbar.appendChild(tabs);

    const panel = document.getElementById('incidents-panel');
    const isMin = panel?.classList.contains('minimized') ?? false;
    const toggle = document.createElement('button');
    toggle.className = 'btn-panel-action';
    toggle.id = 'btn-toggle-events';
    toggle.title = isMin ? 'Expand Events Panel' : 'Minimize Events Panel';
    toggle.innerHTML = isMin
      ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
    tabsbar.appendChild(toggle);

    this.container.appendChild(tabsbar);

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
            <span class="flag ${badgeClass}"></span>
            <span class="incident-time">${mins}:${secs.padStart(5, '0')}</span>
            <span class="incident-what">${badgeLabel}</span>
            <span class="incident-desc" title="${p.label} (avg spacing ${p.avgIntervalMs}ms)">${p.label} (avg spacing ${p.avgIntervalMs}ms) · ${p.estimatedBpm} BPM</span>
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

          const desc = f.patternType
            ? `Alternating ${f.patternType} lock during ${f.patternLabel}: both ${f.key1} and ${f.key2} held for ${f.overlapMs}ms`
            : `Rapid alternating lock: both ${f.key1} and ${f.key2} held for ${f.overlapMs}ms`;
          const flagClass = f.patternType === 'deathstream' ? 'red'
            : f.patternType === 'stream' ? 'purple'
            : f.patternType === 'tech_alt' ? 'orange'
            : f.patternType === 'alt' ? 'gold'
            : f.patternType === 'burst' ? 'cyan' : 'gold';

          const whatLabel = f.patternType === 'deathstream' ? 'DEATHSTREAM LOCK'
            : f.patternType === 'stream' ? 'STREAM LOCK'
            : f.patternType === 'tech_alt' ? 'TECH ALT LOCK'
            : f.patternType === 'alt' ? 'ALT LOCK'
            : f.patternType === 'burst' ? 'BURST LOCK' : 'FINGER LOCK';

          item.innerHTML = `
            <span class="flag ${flagClass}"></span>
            <span class="incident-time">${mins}:${secs.padStart(5, '0')}</span>
            <span class="incident-what">${whatLabel}</span>
            <span class="incident-desc" title="${desc}">${desc}</span>
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
          const flagClass = isDesync ? 'purple' : (e.judgement === HitJudgement.Miss ? 'red' : 'gold');
          const whatText = isDesync
            ? (e.desyncType === DesyncType.EarlyTap ? 'EARLY TAP'
              : e.desyncType === DesyncType.LateTap ? 'LATE TAP'
              : 'CURSOR DESYNC')
            : (e.judgement === HitJudgement.Miss ? (e.desyncType === DesyncType.MisaimInWindow ? 'MISAIM' : 'AIM MISS') : `${e.judgement} (${e.timeOffset > 0 ? '+' : ''}${e.timeOffset.toFixed(0)}ms)`);
          const noteText = e.desyncType === DesyncType.EarlyTap ? `Tapped ${Math.abs(e.timeOffset).toFixed(0)}ms early (cursor was ${e.distanceToCenter.toFixed(1)}px from center)` :
            e.desyncType === DesyncType.LateTap ? `Tapped ${e.timeOffset.toFixed(0)}ms late (cursor left circle)` :
            e.desyncType === DesyncType.SpeedMiss ? `Cursor moved past circle (tap was ${e.timeOffset > 0 ? '+' : ''}${e.timeOffset.toFixed(0)}ms, Δ ${e.distanceToCenter.toFixed(1)}px)` :
              e.desyncType === DesyncType.TrueAimMiss ? `Cursor missed circle by ${e.distanceToCenter.toFixed(1)}px (no tap in window)` :
                e.desyncType === DesyncType.MisaimInWindow ? `Cursor missed circle by ${e.distanceToCenter.toFixed(1)}px during tap` :
                  `Hit offset: ${e.timeOffset > 0 ? '+' : ''}${e.timeOffset.toFixed(1)}ms | Distance: ${e.distanceToCenter.toFixed(1)}px (${e.marginUsagePercent.toFixed(0)}% margin)`;

          item.innerHTML = `
            <span class="flag ${flagClass}"></span>
            <span class="incident-time">${mins}:${secs.padStart(5, '0')}</span>
            <span class="incident-object">#${e.objectIndex}</span>
            <span class="incident-what">${whatText}</span>
            <span class="incident-desc" title="${noteText}">${noteText}</span>
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
