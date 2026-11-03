import {
  Beatmap,
  BeatmapDifficulty,
  BeatmapMetadata,
  HitObject,
  TimingPoint
} from '../types/beatmap.ts';
import { computeStacking } from './parsers/OsuStacking.ts';
import { computeSliderVelocitiesAndDurations } from './parsers/OsuSliderTiming.ts';
import { parseHitObjectLine } from './parsers/HitObjectParser.ts';

// Re-export sub-modules for backwards-compatibility and public API surface
export { computeStacking } from './parsers/OsuStacking.ts';
export { computeSliderVelocitiesAndDurations } from './parsers/OsuSliderTiming.ts';
export { parseHitObjectLine } from './parsers/HitObjectParser.ts';
export * from '../math/PathApproximator.ts';

/**
 * Parses raw .osu text file into structured Beatmap object with stack height calculations
 */
export function parseOsuBeatmap(content: string): Beatmap {
  const lines = content.split(/\r?\n/);
  let currentSection = '';

  let formatVersion = 14;
  let stackLeniency = 0.7;

  const metadata: BeatmapMetadata = {
    title: '',
    titleUnicode: '',
    artist: '',
    artistUnicode: '',
    creator: '',
    version: '',
    source: '',
    tags: [],
    beatmapId: 0,
    beatmapSetId: 0
  };

  const difficulty: BeatmapDifficulty = {
    hpDrainRate: 5,
    circleSize: 5,
    overallDifficulty: 5,
    approachRate: 5,
    sliderMultiplier: 1.4,
    sliderTickRate: 1
  };

  const timingPoints: TimingPoint[] = [];
  const rawHitObjects: HitObject[] = [];
  const comboColours: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith('//')) continue;

    if (rawLine.startsWith('osu file format v')) {
      const v = parseInt(rawLine.replace('osu file format v', ''), 10);
      if (!isNaN(v)) formatVersion = v;
      continue;
    }

    if (rawLine.startsWith('[') && rawLine.endsWith(']')) {
      currentSection = rawLine.substring(1, rawLine.length - 1);
      continue;
    }

    switch (currentSection) {
      case 'General': {
        const [key, ...vals] = rawLine.split(':');
        if (key.trim() === 'StackLeniency') {
          const val = parseFloat(vals.join(':').trim());
          if (!isNaN(val)) stackLeniency = val;
        }
        break;
      }
      case 'Metadata': {
        const [key, ...vals] = rawLine.split(':');
        const val = vals.join(':').trim();
        const k = key.trim();
        if (k === 'Title') metadata.title = val;
        else if (k === 'TitleUnicode') metadata.titleUnicode = val;
        else if (k === 'Artist') metadata.artist = val;
        else if (k === 'ArtistUnicode') metadata.artistUnicode = val;
        else if (k === 'Creator') metadata.creator = val;
        else if (k === 'Version') metadata.version = val;
        else if (k === 'Source') metadata.source = val;
        else if (k === 'Tags') metadata.tags = val.split(' ').filter(Boolean);
        else if (k === 'BeatmapID') metadata.beatmapId = parseInt(val, 10) || 0;
        else if (k === 'BeatmapSetID') metadata.beatmapSetId = parseInt(val, 10) || 0;
        break;
      }
      case 'Difficulty': {
        const [key, ...vals] = rawLine.split(':');
        const val = parseFloat(vals.join(':').trim()) || 0;
        const k = key.trim();
        if (k === 'HPDrainRate') difficulty.hpDrainRate = val;
        else if (k === 'CircleSize') difficulty.circleSize = val;
        else if (k === 'OverallDifficulty') {
          difficulty.overallDifficulty = val;
          // osu! default: if AR is not explicitly set, AR = OD
          if (difficulty.approachRate === 5) difficulty.approachRate = val;
        } else if (k === 'ApproachRate') difficulty.approachRate = val;
        else if (k === 'SliderMultiplier') difficulty.sliderMultiplier = val;
        else if (k === 'SliderTickRate') difficulty.sliderTickRate = val;
        break;
      }
      case 'Colours': {
        const [key, ...vals] = rawLine.split(':');
        const k = key.trim();
        if (k.startsWith('Combo')) {
          const rgbParts = vals.join(':').split(',').map(s => parseInt(s.trim(), 10));
          if (rgbParts.length >= 3 && !rgbParts.some(isNaN)) {
            const hex = '#' + rgbParts.slice(0, 3).map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
            comboColours.push(hex.toUpperCase());
          }
        }
        break;
      }
      case 'TimingPoints': {
        const parts = rawLine.split(',');
        if (parts.length >= 2) {
          const time = parseFloat(parts[0]);
          const beatLength = parseFloat(parts[1]);
          const meter = parts.length > 2 ? parseInt(parts[2], 10) || 4 : 4;
          const sampleSet = parts.length > 3 ? parseInt(parts[3], 10) || 0 : 0;
          const sampleIndex = parts.length > 4 ? parseInt(parts[4], 10) || 0 : 0;
          const volume = parts.length > 5 ? parseInt(parts[5], 10) || 100 : 100;
          const uninherited = parts.length > 6 ? parts[6].trim() === '1' : true;
          const effects = parts.length > 7 ? parseInt(parts[7], 10) || 0 : 0;

          timingPoints.push({
            time,
            beatLength,
            meter,
            sampleSet,
            sampleIndex,
            volume,
            uninherited,
            effects
          });
        }
        break;
      }
      case 'HitObjects': {
        const obj = parseHitObjectLine(rawLine);
        if (obj) rawHitObjects.push(obj);
        break;
      }
    }
  }

  // Sort timing points and hit objects by time
  timingPoints.sort((a, b) => a.time - b.time);
  rawHitObjects.sort((a, b) => a.time - b.time);

  // Compute authentic combo numbers and combo colors
  const defaultColors = ['#00D8FF', '#88FF66', '#FF66AB', '#FFD966', '#B87BFF'];
  const palette = comboColours.length > 0 ? comboColours : defaultColors;
  let colorIndex = 0;
  let comboNum = 1;

  for (let i = 0; i < rawHitObjects.length; i++) {
    const obj = rawHitObjects[i];
    if (i === 0) {
      comboNum = 1;
      colorIndex = 0;
    } else if (obj.isNewCombo) {
      const skip = ((obj.type >> 4) & 7) + 1;
      colorIndex = (colorIndex + skip) % palette.length;
      comboNum = 1;
    }
    obj.comboIndex = comboNum++;
    obj.comboColor = palette[colorIndex];
  }

  // Apply Stacking logic and compute stack offsets
  computeStacking(rawHitObjects, difficulty.circleSize, difficulty.approachRate, stackLeniency);

  // Compute slider velocities and durations
  computeSliderVelocitiesAndDurations(rawHitObjects, timingPoints, difficulty.sliderMultiplier);

  return {
    formatVersion,
    metadata,
    difficulty,
    timingPoints,
    hitObjects: rawHitObjects,
    stackLeniency,
    colours: {
      combos: palette
    },
    rawContent: content
  };
}
