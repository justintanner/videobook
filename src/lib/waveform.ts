/**
 * Downsample a waveform peak array to at most `maxBars` values by taking the
 * peak (max) within each contiguous bucket. Waveform strips are rendered into a
 * small fixed-width area with `preserveAspectRatio="none"`, so drawing one DOM
 * node per source sample (up to ~1000) is pure waste — thousands of SVG rects
 * across the several strips on screen stall the main thread on mount and on
 * every data refresh. Bucketing to a screen-resolution bar count keeps the
 * shape faithful (peaks aren't dropped the way index-subsampling drops them)
 * while cutting node count by ~10x.
 *
 * Pure: returns the input unchanged when it already fits, else a new array.
 */
export function downsamplePeaks(data: number[], maxBars: number): number[] {
  if (maxBars <= 0) return [];
  if (data.length <= maxBars) return data;
  const out = new Array<number>(maxBars);
  for (let i = 0; i < maxBars; i++) {
    const start = Math.floor((i * data.length) / maxBars);
    const end = Math.floor(((i + 1) * data.length) / maxBars);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const v = data[j];
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}
