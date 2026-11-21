import { builtinSound } from "./catalog.js";
import type { SynthSoundId } from "./catalog.js";

const SAMPLE_RATE = 48_000;
type Curve = (u: number) => number;

export interface BuiltinAudio {
  sampleRate: 48000;
  left: Float32Array;
  right: Float32Array;
}

function noise(length: number, seed: number): Float32Array {
  let state = seed;
  return Float32Array.from({ length }, () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 2_147_483_648 - 1;
  });
}

function bandpass(samples: Float32Array, cutoff: Curve): Float32Array {
  let low = 0;
  let band = 0;
  return samples.map((sample, index) => {
    const hz = Math.max(20, Math.min(7_000, cutoff(index / (samples.length - 1))));
    const f = 2 * Math.sin(Math.PI * hz / SAMPLE_RATE);
    const high = sample - low - band / 1.2;
    band += f * high;
    low += f * band;
    return band;
  });
}

function sine(length: number, pitch: Curve): Float32Array {
  let phase = 0;
  return Float32Array.from({ length }, (_, index) => {
    const sample = Math.sin(phase);
    phase = (phase + 2 * Math.PI * pitch(index / (length - 1)) / SAMPLE_RATE) % (2 * Math.PI);
    return sample;
  });
}

function sweep(from: number, to: number): Curve {
  return (u) => from * (to / from) ** u;
}

function swell(peak: number): Curve {
  return (u) => u <= peak ? (u / peak) ** 2.2 : ((1 - u) / (1 - peak)) ** 1.6;
}

function decay(seconds: number, attack = 0.002): Curve {
  return (u) => Math.min(1, u / attack) * Math.exp(-u / seconds);
}

function envelope(samples: Float32Array, level: Curve): Float32Array {
  return samples.map((value, index) => value * level(index / (samples.length - 1)));
}

function mix(a: Float32Array, b: Float32Array, gain: number): Float32Array {
  return a.map((value, index) => value + b[index]! * gain);
}

function rush(length: number, pitch: Curve, peak: number, seed: number): Float32Array {
  const air = bandpass(noise(length, seed), pitch);
  const tone = sine(length, (u) => pitch(u) / 4);
  return envelope(mix(air, tone, 0.12), swell(peak));
}

function glitch(length: number): Float32Array {
  const digital = mix(sine(length, (u) => Math.floor(u * 16) % 2 ? 2_700 : 900), noise(length, 81), 0.25);
  return envelope(digital, (u) => {
    const burst = Math.floor(u * 5);
    const local = (u * 5) % 1;
    if (local >= 0.6) return 0;
    return Math.min(1, local / 0.08, (0.6 - local) / 0.08) * (1 - burst * 0.13);
  });
}

function errorTone(length: number): Float32Array {
  const tone = sine(length, (u) => u < 0.45 ? 330 : 220);
  const peak = 0.015 / 0.35;
  return envelope(tone, (u) => {
    if (u < 0.38) {
      return Math.min(1, u / peak, (0.38 - u) / 0.04) * Math.exp(-Math.max(0, u - peak) / 0.14);
    }
    if (u < 0.52) return 0;
    const local = (u - 0.52) / 0.48;
    return 0.78 * Math.min(1, local / 0.08, (1 - local) / 0.12) * Math.exp(-local / 0.5);
  });
}

const recipes: Record<SynthSoundId, (length: number) => Float32Array> = {
  zoom_in: (length) => rush(length, sweep(220, 5_200), 0.82, 11),
  zoom_out: (length) => rush(length, sweep(5_200, 220), 0.18, 11),
  whoosh: (length) => rush(length, (u) => 350 * (3_500 / 350) ** Math.sin(Math.PI * u), 0.5, 23),
  swish: (length) => envelope(bandpass(noise(length, 37), sweep(4_000, 6_000)), swell(0.41)),
  pop: (length) => envelope(sine(length, sweep(700, 350)), decay(0.12, 0.002 / 0.14)),
  click: (length) => envelope(sine(length, sweep(2_800, 2_100)), decay(0.12)),
  ding: (length) => envelope(mix(mix(sine(length, () => 1_600), sine(length, () => 3_240), 0.25), sine(length, () => 4_680), 0.1), decay(0.16)),
  impact: (length) => envelope(mix(sine(length, sweep(110, 45)), envelope(noise(length, 51), decay(0.018)), 0.12), decay(0.18)),
  riser: (length) => rush(length, sweep(180, 6_000), 0.95, 67),
  glitch,
  error: errorTone,
};

function pan(samples: Float32Array, position: Curve): BuiltinAudio {
  const left = new Float32Array(samples.length);
  const right = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const angle = (position(index / (samples.length - 1)) + 1) * Math.PI / 4;
    left[index] = samples[index]! * Math.cos(angle);
    right[index] = samples[index]! * Math.sin(angle);
  }
  return { sampleRate: SAMPLE_RATE, left, right };
}

function fade(samples: Float32Array): void {
  const length = Math.round(0.003 * SAMPLE_RATE);
  for (let index = 0; index < length; index += 1) {
    samples[index] = samples[index]! * index / length;
    const end = samples.length - 1 - index;
    samples[end] = samples[end]! * index / length;
  }
}

function normalize(audio: BuiltinAudio): void {
  let peak = 0;
  for (const channel of [audio.left, audio.right]) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  }
  if (peak === 0) return;
  for (const channel of [audio.left, audio.right]) {
    for (let index = 0; index < channel.length; index += 1) channel[index] = channel[index]! * 0.5 / peak;
  }
}

export function renderBuiltinSound(id: SynthSoundId): BuiltinAudio {
  const length = Math.round(builtinSound(id).durationSeconds * SAMPLE_RATE);
  const audio = pan(recipes[id](length), (u) => -0.2 + 0.4 * u);
  fade(audio.left);
  fade(audio.right);
  normalize(audio);
  return audio;
}
