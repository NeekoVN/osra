import * as d3 from 'd3';

const difficultyColorSpectrum = d3.scaleLinear<string>()
  .domain([0.1, 1.25, 2, 2.5, 3.3, 4.2, 4.9, 5.8, 6.7, 7.7, 9])
  .clamp(true)
  .range(['#4290FB', '#4FC0FF', '#4FFFD5', '#7CFF4F', '#F6F05C', '#FF8068', '#FF4E6F', '#C645B8', '#6563DE', '#18158E', '#000000'])
  .interpolate(d3.interpolateRgb.gamma(2.2));

const difficultyTextColorSpectrum = d3.scaleLinear<string>()
  .domain([9, 9.9, 10.6, 11.5, 12.4])
  .clamp(true)
  .range(['#F6F05C', '#FF8068', '#FF4E6F', '#C645B8', '#6563DE', '#18158E'])
  .interpolate(d3.interpolateRgb.gamma(2.2));

export function getDiffColor(rating: number) {
  if (rating < 0.1) return '#AAAAAA';
  if (rating >= 9) return '#000000';
  return difficultyColorSpectrum(rating);
}

export function getDiffTextColor(rating: number) {
  if (rating < 6.5) return '#000000';
  if (rating < 9) return '#F6F05C';
  return difficultyTextColorSpectrum(rating);
}

export function getDifficultyStrokeColor(rating: number) {
  if (rating <= 0.05) return 'rgba(255, 255, 255, 0.2)';
  if (rating < 6.5) return '#FFFFFF';
  return getDiffTextColor(rating);
}