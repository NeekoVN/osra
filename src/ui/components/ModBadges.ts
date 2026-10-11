import { OsuMods, OsrReplay } from '../../core/types/replay.ts';
import FRAME_URL from '../../assets/icons/BeatmapDetails/mod-icon.png';
import EXTENDER_URL from '../../assets/icons/BeatmapDetails/mod-icon-extender.png';

const MOD_ICONS = import.meta.glob<string>('../../assets/icons/Mods/*.png', { eager: true, import: 'default' });

/**
 * Lazer-style mod badges.
 *
 * Each badge composites three layers, mirroring `osu.Game.Rulesets.UI.ModIcon`:
 *  - hexagonal frame (`Icons/BeatmapDetails/mod-icon`) tinted with
 *    `OsuColour.ForModType(type)` (the "Basic" palette: Automation #66ccff,
 *    DifficultyIncrease #ff6666, DifficultyReduction #b2ff66, Conversion
 *    #8c66ff, Fun #ff66ab, System #ffcc22),
 *  - white glyph from `src/assets/icons/Mods/` (all shipped white) darkened
 *    to 10% black→base, as lazer does
 *    (`Interpolation.ValueAt(0.1, Black, backgroundColour)`),
 *  - optional extender pill (`mod-icon-extender`) with custom-stat text
 *    (e.g. DT `1.20x` from `speed_change`), darkened like lazer's
 *    `backgroundColour.Darken(2.8)`.
 *
 * Masking is used because the shipped PNGs are white: the frame/extender
 * masks paint the base colour through the silhouette, and a CSS drop-shadow
 * reproduces the shadow baked into the original frame asset.
 */

type ModTypeKey = 'Automation' | 'DifficultyIncrease' | 'DifficultyReduction' | 'Conversion' | 'Fun' | 'System';

/** `OsuColour.ForModType` — Basic palette (`OsuColour.cs`). */
const MOD_TYPE_COLORS: Record<ModTypeKey, string> = {
  Automation: '#66ccff', // Blue1
  DifficultyIncrease: '#ff6666', // Red1
  DifficultyReduction: '#b2ff66', // Lime1
  Conversion: '#8c66ff', // Purple1
  Fun: '#ff66ab', // Pink1
  System: '#ffcc22' // Yellow
};

interface ModDef {
  acronym: string;
  icon: string;
  type: ModTypeKey;
  label: string;
}


const MOD_DEFS: Record<string, ModDef> = {
  EZ: { acronym: 'EZ', icon: 'mod-easy.png', type: 'DifficultyReduction', label: 'Easy' },
  NF: { acronym: 'NF', icon: 'mod-no-fail.png', type: 'DifficultyReduction', label: 'No Fail' },
  HT: { acronym: 'HT', icon: 'mod-half-time.png', type: 'DifficultyReduction', label: 'Half Time' },
  DC: { acronym: 'DC', icon: 'mod-daycore.png', type: 'DifficultyReduction', label: 'Daycore' },
  HR: { acronym: 'HR', icon: 'mod-hard-rock.png', type: 'DifficultyIncrease', label: 'Hard Rock' },
  SD: { acronym: 'SD', icon: 'mod-sudden-death.png', type: 'DifficultyIncrease', label: 'Sudden Death' },
  PF: { acronym: 'PF', icon: 'mod-perfect.png', type: 'DifficultyIncrease', label: 'Perfect' },
  DT: { acronym: 'DT', icon: 'mod-double-time.png', type: 'DifficultyIncrease', label: 'Double Time' },
  NC: { acronym: 'NC', icon: 'mod-nightcore.png', type: 'DifficultyIncrease', label: 'Nightcore' },
  HD: { acronym: 'HD', icon: 'mod-hidden.png', type: 'DifficultyIncrease', label: 'Hidden' },
  FL: { acronym: 'FL', icon: 'mod-flashlight.png', type: 'DifficultyIncrease', label: 'Flashlight' },
  BL: { acronym: 'BL', icon: 'mod-blinds.png', type: 'DifficultyIncrease', label: 'Blinds' },
  ST: { acronym: 'ST', icon: 'mod-strict-tracking.png', type: 'DifficultyIncrease', label: 'Strict Tracking' },
  AC: { acronym: 'AC', icon: 'mod-accuracy-challenge.png', type: 'DifficultyIncrease', label: 'Accuracy Challenge' },
  AT: { acronym: 'AT', icon: 'mod-autoplay.png', type: 'Automation', label: 'Autoplay' },
  CN: { acronym: 'CN', icon: 'mod-cinema.png', type: 'Automation', label: 'Cinema' },
  RX: { acronym: 'RX', icon: 'mod-relax.png', type: 'Automation', label: 'Relax' },
  AP: { acronym: 'AP', icon: 'mod-autopilot.png', type: 'Automation', label: 'Autopilot' },
  SO: { acronym: 'SO', icon: 'mod-spun-out.png', type: 'Automation', label: 'Spun Out' },
  MR: { acronym: 'MR', icon: 'mod-mirror.png', type: 'Conversion', label: 'Mirror' },
  TP: { acronym: 'TP', icon: 'mod-target-practice.png', type: 'Fun', label: 'Target Practice' },
  TR: { acronym: 'TR', icon: 'mod-transform.png', type: 'Fun', label: 'Transform' },
  WG: { acronym: 'WG', icon: 'mod-wiggle.png', type: 'Fun', label: 'Wiggle' },
  SI: { acronym: 'SI', icon: 'mod-spin-in.png', type: 'Fun', label: 'Spin In' },
  GR: { acronym: 'GR', icon: 'mod-grow.png', type: 'Fun', label: 'Grow' },
  DF: { acronym: 'DF', icon: 'mod-deflate.png', type: 'Fun', label: 'Deflate' },
  WU: { acronym: 'WU', icon: 'mod-wind-up.png', type: 'Fun', label: 'Wind Up' },
  WD: { acronym: 'WD', icon: 'mod-wind-down.png', type: 'Fun', label: 'Wind Down' },
  BR: { acronym: 'BR', icon: 'mod-barrel-roll.png', type: 'Fun', label: 'Barrel Roll' },
  AD: { acronym: 'AD', icon: 'mod-approach-different.png', type: 'Fun', label: 'Approach Different' },
  FF: { acronym: 'FF', icon: 'mod-floating-fruits.png', type: 'Fun', label: 'Floating Fruits' },
  MU: { acronym: 'MU', icon: 'mod-muted.png', type: 'Fun', label: 'Muted' },
  NS: { acronym: 'NS', icon: 'mod-no-scope.png', type: 'Fun', label: 'No Scope' },
  MG: { acronym: 'MG', icon: 'mod-magnetised.png', type: 'Fun', label: 'Magnetised' },
  RP: { acronym: 'RP', icon: 'mod-repel.png', type: 'Fun', label: 'Repel' },
  AS: { acronym: 'AS', icon: 'mod-adaptive-speed.png', type: 'Fun', label: 'Adaptive Speed' },
  FR: { acronym: 'FR', icon: 'mod-freeze-frame.png', type: 'Fun', label: 'Freeze Frame' },
  BU: { acronym: 'BU', icon: 'mod-bubbles.png', type: 'Fun', label: 'Bubbles' },
  MF: { acronym: 'MF', icon: 'mod-moving-fast.png', type: 'Fun', label: 'Moving Fast' },
  SY: { acronym: 'SY', icon: 'mod-synesthesia.png', type: 'Fun', label: 'Synesthesia' },
  DP: { acronym: 'DP', icon: 'mod-depth.png', type: 'Fun', label: 'Depth' },
  BM: { acronym: 'BM', icon: 'mod-bloom.png', type: 'Fun', label: 'Bloom' },
  TC: { acronym: 'TC', icon: 'mod-traceable.png', type: 'Fun', label: 'Traceable' },
  RD: { acronym: 'RD', icon: 'mod-random.png', type: 'Fun', label: 'Random' },
  CL: { acronym: 'CL', icon: 'mod-classic.png', type: 'System', label: 'Classic' },
  SV2: { acronym: 'SV2', icon: 'mod-score-v2.png', type: 'System', label: 'Score V2' },
  TD: { acronym: 'TD', icon: 'mod-touch-device.png', type: 'System', label: 'Touch Device' },
  DA: { acronym: 'DA', icon: 'mod-difficulty-adjust.png', type: 'System', label: 'Difficulty Adjust' },
  '1K': { acronym: '1K', icon: 'mod-one-key.png', type: 'Conversion', label: 'One Key' },
  '2K': { acronym: '2K', icon: 'mod-two-keys.png', type: 'Conversion', label: 'Two Keys' },
  '3K': { acronym: '3K', icon: 'mod-three-keys.png', type: 'Conversion', label: 'Three Keys' },
  '4K': { acronym: '4K', icon: 'mod-four-keys.png', type: 'Conversion', label: 'Four Keys' },
  '5K': { acronym: '5K', icon: 'mod-five-keys.png', type: 'Conversion', label: 'Five Keys' },
  '6K': { acronym: '6K', icon: 'mod-six-keys.png', type: 'Conversion', label: 'Six Keys' },
  '7K': { acronym: '7K', icon: 'mod-seven-keys.png', type: 'Conversion', label: 'Seven Keys' },
  '8K': { acronym: '8K', icon: 'mod-eight-keys.png', type: 'Conversion', label: 'Eight Keys' },
  '9K': { acronym: '9K', icon: 'mod-nine-keys.png', type: 'Conversion', label: 'Nine Keys' },
  '10K': { acronym: '10K', icon: 'mod-ten-keys.png', type: 'Conversion', label: 'Ten Keys' }
};

/** Rate-adjust mods whose extender shows the custom clock rate. */
const RATE_MODS = new Set(['DT', 'NC', 'HT', 'DC', 'WU', 'WD', 'AS']);

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Lerp black → base by t (lazer icon tint uses t = 0.1). */
function lerpFromBlack(base: string, t: number): string {
  const [r, g, b] = hexToRgb(base);
  return rgbToHex(r * t, g * t, b * t);
}

/** Darken base by factor (lazer extender uses a deep shade of the base). */
function darken(base: string, factor: number): string {
  const [r, g, b] = hexToRgb(base);
  return rgbToHex(r * (1 - factor), g * (1 - factor), b * (1 - factor));
}

function formatRate(speed: unknown): string | null {
  if (typeof speed !== 'number' || !isFinite(speed)) return null;
  return `${parseFloat(speed.toFixed(2))}x`;
}

function getSpeedSetting(settings?: Record<string, unknown>): unknown {
  if (!settings) return undefined;
  return settings['speed_change'] ?? settings['speed_rate'];
}

interface ResolvedMod {
  def: ModDef;
  extendedText: string | null;
  hasSettings: boolean;
  tooltip: string;
}

function resolveLazerMods(replay: OsrReplay): ResolvedMod[] | null {
  const soloMods = replay.soloScoreInfo?.mods;
  if (!soloMods || soloMods.length === 0) return null;
  const out: ResolvedMod[] = [];
  for (const m of soloMods) {
    const acronym = (m.acronym || '').toUpperCase();
    if (!acronym) continue;
    const def = MOD_DEFS[acronym] || {
      acronym,
      icon: '',
      type: 'Fun' as ModTypeKey,
      label: acronym
    };
    const settings = (m.settings || {}) as Record<string, unknown>;
    const settingKeys = Object.keys(settings);
    let extendedText: string | null = null;
    if (RATE_MODS.has(acronym)) {
      extendedText = formatRate(getSpeedSetting(settings));
    }
    const tooltip = extendedText ? `${def.label} (${extendedText})` : def.label;
    out.push({ def, extendedText, hasSettings: settingKeys.length > 0, tooltip });
  }
  return out;
}

function resolveBitmaskMods(mods: number): ResolvedMod[] {
  const has = (flag: OsuMods) => (mods & flag) !== 0;
  const picks: string[] = [];
  // Stable quirk: NC implies DT, PF implies SD — show only the stronger mod.
  const showDT = has(OsuMods.DoubleTime) && !has(OsuMods.Nightcore);
  const showSD = has(OsuMods.SuddenDeath) && !has(OsuMods.Perfect);
  if (has(OsuMods.Easy)) picks.push('EZ');
  if (has(OsuMods.NoFail)) picks.push('NF');
  if (has(OsuMods.HalfTime)) picks.push('HT');
  if (has(OsuMods.HardRock)) picks.push('HR');
  if (showSD) picks.push('SD');
  if (has(OsuMods.Perfect)) picks.push('PF');
  if (showDT) picks.push('DT');
  if (has(OsuMods.Nightcore)) picks.push('NC');
  if (has(OsuMods.Hidden)) picks.push('HD');
  if (has(OsuMods.Flashlight)) picks.push('FL');
  if (has(OsuMods.Relax)) picks.push('RX');
  if (has(OsuMods.Autopilot)) picks.push('AP');
  if (has(OsuMods.Autoplay)) picks.push('AT');
  if (has(OsuMods.Cinema)) picks.push('CN');
  if (has(OsuMods.SpunOut)) picks.push('SO');
  if (has(OsuMods.TouchDevice)) picks.push('TD');
  if (has(OsuMods.Random)) picks.push('RD');
  if (has(OsuMods.TargetPractice)) picks.push('TP');
  if (has(OsuMods.Mirror)) picks.push('MR');
  if (has(OsuMods.ScoreV2)) picks.push('SV2');
  return picks
    .map(a => MOD_DEFS[a])
    .filter((d): d is ModDef => !!d)
    .map(def => ({ def, extendedText: null, hasSettings: false, tooltip: def.label }));
}

/** Renders lazer-style mod icons into the header container. */
export function renderModBadges(container: HTMLElement, replay: OsrReplay): void {
  container.innerHTML = '';

  let resolved = resolveLazerMods(replay);
  if (!resolved) resolved = resolveBitmaskMods(replay.mods);

  // No Mod: show nothing at all (matches lazer — no icon for NM).
  if (resolved.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = '';

  for (const m of resolved) {
    container.appendChild(buildModElement(m.def, m.extendedText, m.hasSettings, m.tooltip));
  }
}

function buildModElement(
  def: ModDef,
  extendedText: string | null,
  hasSettings: boolean,
  tooltip: string
): HTMLElement {
  const base = MOD_TYPE_COLORS[def.type];
  const ink = lerpFromBlack(base, 0.1);
  const deep = darken(base, 0.68);

  const root = document.createElement('span');
  root.className = 'mod';
  root.title = tooltip;
  root.style.setProperty('--mod', base);
  root.style.setProperty('--mod-ink', ink);
  root.style.setProperty('--mod-deep', deep);

  if (extendedText) {
    const ext = document.createElement('span');
    ext.className = 'mod-ext';
    ext.style.setProperty('--ext-mask', `url("${EXTENDER_URL}")`);
    const extText = document.createElement('span');
    extText.className = 'mod-ext-text';
    extText.textContent = extendedText;
    ext.appendChild(extText);
    root.appendChild(ext);
  }

  const main = document.createElement('span');
  main.className = 'mod-main';
  main.style.setProperty('--frame-mask', `url("${FRAME_URL}")`);

  if (def.icon) {
    const glyph = document.createElement('span');
    glyph.className = 'mod-glyph';
    const iconUrl = MOD_ICONS[`../../assets/icons/Mods/${def.icon}`] || '';
    glyph.style.setProperty('--glyph-mask', `url("${iconUrl}")`);
    glyph.setAttribute('aria-hidden', 'true');
    main.appendChild(glyph);
  } else {
    const acronym = document.createElement('span');
    acronym.className = 'mod-acronym';
    acronym.textContent = def.acronym;
    main.appendChild(acronym);
  }

  root.appendChild(main);

  if (hasSettings && !extendedText) {
    // Lazer shows a cog when a mod has non-default settings.
    const marker = document.createElement('span');
    marker.className = 'mod-marker';
    marker.title = `${def.label}: custom settings`;
    root.appendChild(marker);
  }

  return root;
}
