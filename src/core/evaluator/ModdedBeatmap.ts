import { Beatmap } from '../types/beatmap.ts';
import { OsuMods } from '../types/replay.ts';

/**
 * Returns a cloned beatmap with hit objects and slider curves transformed
 * to match the visual and playable space for active mods (e.g. Hard Rock vertical flip).
 */
export function getModdedBeatmap(beatmap: Beatmap, mods: number = OsuMods.None): Beatmap {
  if (!(mods & OsuMods.HardRock)) {
    return beatmap;
  }
  if ((beatmap as any).__isFlippedHR) {
    return beatmap;
  }
  const moddedObjects = beatmap.hitObjects.map(obj => {
    const flippedY = 384 - obj.y;
    const flippedStackedY = 384 - obj.stackedY;
    if (obj.objectType === 'slider') {
      return {
        ...obj,
        y: flippedY,
        stackedY: flippedStackedY,
        curvePoints: obj.curvePoints ? obj.curvePoints.map(p => ({ x: p.x, y: 384 - p.y })) : [],
        sliderEnd: obj.sliderEnd ? { x: obj.sliderEnd.x, y: 384 - obj.sliderEnd.y } : { x: obj.x, y: flippedY },
        ticks: obj.ticks ? obj.ticks.map(t => ({ ...t })) : []
      };
    }
    return {
      ...obj,
      y: flippedY,
      stackedY: flippedStackedY
    };
  });
  return {
    ...beatmap,
    hitObjects: moddedObjects,
    __isFlippedHR: true
  } as Beatmap;
}
