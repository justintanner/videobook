import {
  RHYTHM_ANALYZER_ID,
  RHYTHM_ANALYZER_VERSION,
  RHYTHM_LATENCY_SAMPLES,
  RHYTHM_SCHEMA_VERSION,
  type OnsetEnvelope,
  type RhythmAnalysis,
  type RhythmBar,
  type RhythmBeat,
  type RhythmMeter,
  type RhythmOnset,
  type RhythmTempoAmbiguity,
} from "./contract.js";

const MIN_BPM = 55;
const MAX_BPM = 200;
const TIGHTNESS = 80;
const LOW_CONFIDENCE = 0.42;

export function trackBeats(envelope: OnsetEnvelope): RhythmAnalysis {
  const hopSeconds = envelope.hopSamples / envelope.sampleRate;
  const latencySeconds = RHYTHM_LATENCY_SAMPLES / envelope.sampleRate;
  const onsets = pickOnsets(envelope.strength, hopSeconds);
  const tempo = estimateTempo(envelope.strength, hopSeconds, onsets);
  const tracked = tempo.periodHops === null
    ? []
    : beatTrack(envelope.strength, tempo.periodHops);
  const beatTimes = tracked
    .map((frame) => frame * hopSeconds)
    .filter((time) => time >= 0);
  const confidences = beatConfidences(envelope.strength, tracked);
  const global = globalConfidence(confidences, envelope.strength, tracked);
  const noBeats = tempo.bpm === null || global < LOW_CONFIDENCE || beatTimes.length < 2;
  const lowConfidence = noBeats || beatTimes.length < 8 || tempo.ambiguity !== "stable";
  const beats: RhythmBeat[] = noBeats
    ? []
    : beatTimes.map((timeSeconds, index) => ({
      timeSeconds,
      confidence: confidences[index] ?? null,
    }));
  const detectedMeter = noBeats ? null : detectMeter(envelope.strength, tracked);
  const meter = detectedMeter
    ? { beatsPerBar: detectedMeter.beatsPerBar, confidence: detectedMeter.confidence }
    : null;
  const bars = detectedMeter ? barStarts(beats, detectedMeter) : null;
  return {
    schemaVersion: RHYTHM_SCHEMA_VERSION,
    analyzerId: RHYTHM_ANALYZER_ID,
    analyzerVersion: RHYTHM_ANALYZER_VERSION,
    sampleRate: envelope.sampleRate,
    hopSamples: envelope.hopSamples,
    windowSamples: envelope.windowSamples,
    latencySeconds,
    beats,
    onsets,
    bpm: noBeats ? null : tempo.bpm,
    bpmConfidence: tempo.confidence,
    tempoAmbiguity: tempo.ambiguity,
    meter: noBeats ? null : meter,
    bars: noBeats ? null : bars,
    noBeats,
    lowConfidence,
  };
}

function pickOnsets(strength: Float32Array, hopSeconds: number): RhythmOnset[] {
  if (strength.length < 3) return [];
  let mean = 0;
  for (const value of strength) mean += value;
  mean /= strength.length;
  let variance = 0;
  for (const value of strength) variance += (value - mean) ** 2;
  const deviation = Math.sqrt(variance / strength.length);
  const threshold = Math.max(0.08, mean + deviation * 0.4);
  const minGap = Math.max(1, Math.round(0.05 / hopSeconds));
  const onsets: RhythmOnset[] = [];
  let last = -minGap;
  for (let index = 1; index < strength.length - 1; index += 1) {
    const value = strength[index]!;
    if (value < threshold) continue;
    if (value < strength[index - 1]! || value < strength[index + 1]!) continue;
    if (index - last < minGap) {
      const previous = onsets[onsets.length - 1];
      if (previous && value > previous.strength) {
        onsets[onsets.length - 1] = { timeSeconds: index * hopSeconds, strength: value };
        last = index;
      }
      continue;
    }
    onsets.push({ timeSeconds: index * hopSeconds, strength: value });
    last = index;
  }
  return onsets;
}

function estimateTempo(
  strength: Float32Array,
  hopSeconds: number,
  onsets: RhythmOnset[],
): {
  bpm: number | null;
  confidence: number | null;
  ambiguity: RhythmTempoAmbiguity | null;
  periodHops: number | null;
} {
  const minLag = Math.max(2, Math.round(60 / MAX_BPM / hopSeconds));
  const maxLag = Math.min(strength.length - 2, Math.round(60 / MIN_BPM / hopSeconds));
  if (maxLag <= minLag + 1 || onsets.length < 2) {
    return { bpm: null, confidence: null, ambiguity: null, periodHops: null };
  }
  const correlation = autocorrelate(strength, minLag, maxLag);
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = correlation[lag - minLag]!;
    if (value > best) {
      best = value;
      bestLag = lag;
    }
  }
  const onsetPeriod = onsetInterval(onsets, hopSeconds, minLag, maxLag);
  const resolved = resolveOctave(bestLag, correlation, minLag, onsetPeriod);
  const bpm = 60 / (resolved.lag * hopSeconds);
  const mean = correlation.reduce((sum, value) => sum + value, 0) / correlation.length;
  const peakiness = best <= 0 ? 0 : (best - mean) / best;
  const confidence = best <= 0 ? 0 : Math.max(0, Math.min(1, peakiness));
  if (peakiness < 0.55) {
    return { bpm: null, confidence, ambiguity: null, periodHops: null };
  }
  return {
    bpm,
    confidence,
    ambiguity: resolved.ambiguity,
    periodHops: resolved.lag,
  };
}

function autocorrelate(strength: Float32Array, minLag: number, maxLag: number): Float64Array {
  const values = new Float64Array(maxLag - minLag + 1);
  let energy = 0;
  for (const value of strength) energy += value * value;
  const norm = Math.sqrt(energy) || 1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let index = 0; index + lag < strength.length; index += 1) {
      sum += strength[index]! * strength[index + lag]!;
    }
    values[lag - minLag] = sum / norm;
  }
  return values;
}

function onsetInterval(
  onsets: RhythmOnset[],
  hopSeconds: number,
  minLag: number,
  maxLag: number,
): number | null {
  const gaps: number[] = [];
  for (let index = 1; index < onsets.length; index += 1) {
    const hops = Math.round((onsets[index]!.timeSeconds - onsets[index - 1]!.timeSeconds) / hopSeconds);
    if (hops >= minLag && hops <= maxLag) gaps.push(hops);
  }
  if (gaps.length === 0) return null;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)]!;
}

function resolveOctave(
  lag: number,
  correlation: Float64Array,
  minLag: number,
  onsetPeriod: number | null,
): { lag: number; ambiguity: RhythmTempoAmbiguity | null } {
  const candidates = [lag, Math.round(lag / 2), lag * 2].filter((value) => {
    const index = value - minLag;
    return value >= minLag && index >= 0 && index < correlation.length;
  });
  const unique = [...new Set(candidates)];
  let chosen = lag;
  let bestScore = -Infinity;
  for (const candidate of unique) {
    const auto = correlation[candidate - minLag] ?? 0;
    const onsetScore = onsetPeriod === null
      ? 0
      : 1 - Math.min(1, Math.abs(candidate - onsetPeriod) / onsetPeriod);
    const score = auto + onsetScore * Math.max(auto, 1);
    if (score > bestScore) {
      bestScore = score;
      chosen = candidate;
    }
  }
  let ambiguity: RhythmTempoAmbiguity | null = "stable";
  const half = correlation[Math.round(chosen / 2) - minLag];
  const double = correlation[chosen * 2 - minLag];
  const self = correlation[chosen - minLag] ?? 0;
  if (half !== undefined && self > 0 && half > self * 0.92) ambiguity = "half";
  else if (double !== undefined && self > 0 && double > self * 0.92) ambiguity = "double";
  if (chosen !== lag && chosen < lag) ambiguity = "double";
  if (chosen !== lag && chosen > lag) ambiguity = "half";
  return { lag: chosen, ambiguity };
}

function beatTrack(strength: Float32Array, period: number): number[] {
  const count = strength.length;
  const score = new Float64Array(count);
  const back = new Int32Array(count);
  back.fill(-1);
  const minLag = Math.max(1, Math.round(period * 0.55));
  const maxLag = Math.max(minLag + 1, Math.round(period * 1.7));
  for (let index = 0; index < count; index += 1) {
    let best = strength[index]!;
    let link = -1;
    const start = Math.max(0, index - maxLag);
    const end = index - minLag;
    for (let previous = start; previous <= end; previous += 1) {
      const lag = index - previous;
      const penalty = TIGHTNESS * (Math.log(lag / period) ** 2);
      const candidate = score[previous]! + strength[index]! - penalty;
      if (candidate > best) {
        best = candidate;
        link = previous;
      }
    }
    score[index] = link < 0 ? strength[index]! : best;
    back[index] = link;
  }
  let cursor = -1;
  let bestScore = -Infinity;
  const tail = Math.max(0, count - Math.round(period * 2));
  for (let index = tail; index < count; index += 1) {
    if (score[index]! > bestScore) {
      bestScore = score[index]!;
      cursor = index;
    }
  }
  const frames: number[] = [];
  const guard = new Set<number>();
  while (cursor >= 0 && !guard.has(cursor)) {
    guard.add(cursor);
    if (strength[cursor]! > 0.02) frames.push(cursor);
    cursor = back[cursor]!;
  }
  frames.reverse();
  return thinBeats(frames, period);
}

function thinBeats(frames: number[], period: number): number[] {
  const minimum = Math.max(1, Math.round(period * 0.55));
  const kept: number[] = [];
  for (const frame of frames) {
    const previous = kept[kept.length - 1];
    if (previous === undefined || frame - previous >= minimum) kept.push(frame);
    else kept[kept.length - 1] = frame;
  }
  return kept;
}

function beatConfidences(strength: Float32Array, frames: number[]): Array<number | null> {
  return frames.map((frame) => {
    const value = strength[frame] ?? 0;
    return value > 0 ? Math.max(0, Math.min(1, value)) : null;
  });
}

function globalConfidence(
  confidences: Array<number | null>,
  strength: Float32Array,
  frames: number[],
): number {
  if (frames.length < 2) return 0;
  let sum = 0;
  let known = 0;
  for (const value of confidences) {
    if (value === null) continue;
    sum += value;
    known += 1;
  }
  if (known === 0) return 0;
  const mean = sum / known;
  let noise = 0;
  let samples = 0;
  for (let index = 0; index < strength.length; index += 8) {
    noise += strength[index]!;
    samples += 1;
  }
  const floor = samples ? noise / samples : 0;
  return Math.max(0, Math.min(1, mean - floor));
}

function detectMeter(
  strength: Float32Array,
  frames: number[],
): (RhythmMeter & { phase: number }) | null {
  if (frames.length < 8) return null;
  let best: (RhythmMeter & { phase: number }) | null = null;
  for (const beatsPerBar of [3, 4, 5, 6]) {
    if (frames.length < beatsPerBar * 4) continue;
    let bestPhase = 0;
    let bestMean = -Infinity;
    let other = 0;
    for (let phase = 0; phase < beatsPerBar; phase += 1) {
      let sum = 0;
      let count = 0;
      for (let index = phase; index < frames.length; index += beatsPerBar) {
        sum += strength[frames[index]!] ?? 0;
        count += 1;
      }
      const mean = count ? sum / count : 0;
      if (mean > bestMean) {
        other = bestMean;
        bestMean = mean;
        bestPhase = phase;
      } else if (mean > other) {
        other = mean;
      }
    }
    const confidence = bestMean <= 0 ? 0 : (bestMean - Math.max(0, other)) / bestMean;
    if (confidence < 0.18) continue;
    if (!best || confidence > best.confidence) {
      best = { beatsPerBar, confidence, phase: bestPhase };
    }
  }
  if (!best || best.confidence < 0.4) return null;
  return best;
}

function barStarts(beats: RhythmBeat[], meter: RhythmMeter & { phase: number }): RhythmBar[] | null {
  const phase = meter.phase;
  if (beats.length <= phase) return null;
  const bars: RhythmBar[] = [];
  for (let index = phase; index < beats.length; index += meter.beatsPerBar) {
    const beat = beats[index];
    if (!beat) continue;
    bars.push({ timeSeconds: beat.timeSeconds, confidence: meter.confidence });
  }
  return bars.length > 1 ? bars : null;
}
