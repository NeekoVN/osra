import {
  HitCircleObject,
  HitObject,
  HitObjectType,
  SliderObject,
  SpinnerObject
} from '../../types/beatmap.ts';
import { parseSliderPath } from '../../math/PathApproximator.ts';

export function parseHitObjectLine(line: string): HitObject | null {
  const parts = line.split(',');
  if (parts.length < 5) return null;

  const x = parseFloat(parts[0]);
  const y = parseFloat(parts[1]);
  const time = parseFloat(parts[2]);
  const type = parseInt(parts[3], 10);
  const hitSound = parseInt(parts[4], 10);
  const isNewCombo = (type & HitObjectType.NewCombo) !== 0;

  const base = {
    x,
    y,
    time,
    type,
    hitSound,
    isNewCombo,
    comboIndex: 1,
    stackHeight: 0,
    stackedX: x,
    stackedY: y
  };

  if (type & HitObjectType.Circle) {
    const circle: HitCircleObject = {
      ...base,
      objectType: 'circle'
    };
    return circle;
  }

  if (type & HitObjectType.Slider) {
    const curveRaw = parts[5] || '';
    const repeatCount = parts.length > 6 ? parseInt(parts[6], 10) || 1 : 1;
    const pixelLength = parts.length > 7 ? parseFloat(parts[7]) || 0 : 0;

    // Parse multi-segment slider path matching ConvertHitObjectParser.convertPathString
    const approximatedPath = parseSliderPath(curveRaw, x, y, pixelLength);
    const curveType = (curveRaw.split('|')[0] || 'B').toUpperCase();
    const sliderEnd = approximatedPath.length > 0 ? approximatedPath[approximatedPath.length - 1] : { x, y };

    const slider: SliderObject = {
      ...base,
      objectType: 'slider',
      curveType,
      curvePoints: approximatedPath,
      repeatCount,
      pixelLength,
      duration: 0,
      endTime: time,
      ticks: [],
      sliderEnd
    };
    return slider;
  }

  if (type & HitObjectType.Spinner) {
    const endTime = parts.length > 5 ? parseFloat(parts[5]) || time : time;
    const spinner: SpinnerObject = {
      ...base,
      objectType: 'spinner',
      endTime
    };
    return spinner;
  }

  return null;
}
