import { fftInPlace } from "./fft.js";
import {
  RHYTHM_HOP_SAMPLES,
  RHYTHM_LATENCY_SAMPLES,
  RHYTHM_MAX_RETAINED_SAMPLES,
  RHYTHM_SAMPLE_RATE,
  RHYTHM_WINDOW_SAMPLES,
  type OnsetEnvelope,
} from "./contract.js";

const HANN = new Float64Array(RHYTHM_WINDOW_SAMPLES);
for (let index = 0; index < RHYTHM_WINDOW_SAMPLES; index += 1) {
  HANN[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (RHYTHM_WINDOW_SAMPLES - 1)));
}

export function createOnsetAccumulator(sampleRate = RHYTHM_SAMPLE_RATE): {
  push(chunk: Float32Array): void;
  retainedSamples(): number;
  hopCount(): number;
  finish(): OnsetEnvelope;
} {
  if (sampleRate !== RHYTHM_SAMPLE_RATE) {
    throw new Error(`Rhythm analysis requires ${RHYTHM_SAMPLE_RATE} Hz mono PCM`);
  }
  const window = new Float32Array(RHYTHM_WINDOW_SAMPLES);
  let filled = RHYTHM_LATENCY_SAMPLES;
  const previous = new Float64Array(RHYTHM_WINDOW_SAMPLES / 2);
  const real = new Float64Array(RHYTHM_WINDOW_SAMPLES);
  const imag = new Float64Array(RHYTHM_WINDOW_SAMPLES);
  const strength: number[] = [];
  let incoming: Float32Array = new Float32Array(0);

  const emitFrame = (): void => {
    for (let index = 0; index < RHYTHM_WINDOW_SAMPLES; index += 1) {
      real[index] = window[index]! * HANN[index]!;
      imag[index] = 0;
    }
    fftInPlace(real, imag);
    let flux = 0;
    const bins = RHYTHM_WINDOW_SAMPLES / 2;
    for (let bin = 1; bin < bins; bin += 1) {
      const magnitude = Math.hypot(real[bin]!, imag[bin]!);
      const rise = magnitude - previous[bin]!;
      if (rise > 0) flux += rise;
      previous[bin] = magnitude;
    }
    strength.push(flux);
    window.copyWithin(0, RHYTHM_HOP_SAMPLES);
    filled = RHYTHM_WINDOW_SAMPLES - RHYTHM_HOP_SAMPLES;
  };

  const drain = (): void => {
    let offset = 0;
    while (offset < incoming.length) {
      const needed = RHYTHM_WINDOW_SAMPLES - filled;
      const take = Math.min(needed, incoming.length - offset);
      window.set(incoming.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === RHYTHM_WINDOW_SAMPLES) emitFrame();
    }
    incoming = new Float32Array(0);
  };

  return {
    push(chunk: Float32Array): void {
      incoming = chunk;
      drain();
    },
    retainedSamples(): number {
      return filled + incoming.length;
    },
    hopCount(): number {
      return strength.length;
    },
    finish(): OnsetEnvelope {
      const raw = Float32Array.from(strength);
      whitenFlux(raw);
      return {
        sampleRate,
        hopSamples: RHYTHM_HOP_SAMPLES,
        windowSamples: RHYTHM_WINDOW_SAMPLES,
        strength: raw,
        frameCount: raw.length,
      };
    },
  };
}

export function onsetRetainedLimit(): number {
  return RHYTHM_MAX_RETAINED_SAMPLES;
}

function whitenFlux(strength: Float32Array): void {
  const width = 8;
  const local = new Float32Array(strength.length);
  for (let index = 0; index < strength.length; index += 1) {
    const start = Math.max(0, index - width);
    const end = Math.min(strength.length, index + width + 1);
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += strength[cursor]!;
    local[index] = Math.max(0, strength[index]! - sum / (end - start));
  }
  let peak = 0;
  for (const value of local) peak = Math.max(peak, value);
  const scale = peak > 0 ? 1 / peak : 1;
  for (let index = 0; index < strength.length; index += 1) {
    strength[index] = local[index]! * scale;
  }
}
