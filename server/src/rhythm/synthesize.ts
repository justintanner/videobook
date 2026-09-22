import { RHYTHM_SAMPLE_RATE } from "./contract.js";

export interface SynthesizedAudio {
  sampleRate: number;
  samples: Float32Array;
  beatSeconds: number[];
  barSeconds: number[] | null;
}

export function synthesizeClicks(options: {
  bpm: number;
  seconds: number;
  leadSilenceSeconds?: number;
  sampleRate?: number;
}): SynthesizedAudio {
  const sampleRate = options.sampleRate ?? RHYTHM_SAMPLE_RATE;
  const lead = options.leadSilenceSeconds ?? 0;
  const samples = new Float32Array(Math.ceil(options.seconds * sampleRate));
  const beatSeconds: number[] = [];
  const interval = 60 / options.bpm;
  for (let time = lead; time < options.seconds - 0.05; time += interval) {
    beatSeconds.push(time);
    addClick(samples, sampleRate, time, 1);
  }
  return { sampleRate, samples, beatSeconds, barSeconds: null };
}

export function synthesizePattern(options: {
  bpm: number;
  seconds: number;
  beatsPerBar: number;
  accentEvery: number;
  syncopated?: boolean;
  harmonic?: boolean;
  sampleRate?: number;
}): SynthesizedAudio {
  const sampleRate = options.sampleRate ?? RHYTHM_SAMPLE_RATE;
  const samples = new Float32Array(Math.ceil(options.seconds * sampleRate));
  const beatSeconds: number[] = [];
  const barSeconds: number[] = [];
  const interval = 60 / options.bpm;
  let index = 0;
  for (let time = 0.1; time < options.seconds - 0.05; time += interval) {
    beatSeconds.push(time);
    if (index % options.beatsPerBar === 0) barSeconds.push(time);
    const accent = index % options.accentEvery === 0 ? 1 : 0.55;
    addClick(samples, sampleRate, time, accent);
    if (options.syncopated) addClick(samples, sampleRate, time + interval * 0.5, 0.35);
    index += 1;
  }
  if (options.harmonic) addFormant(samples, sampleRate);
  return {
    sampleRate,
    samples,
    beatSeconds,
    barSeconds,
  };
}

export function synthesizeTempoChange(options: {
  firstBpm: number;
  secondBpm: number;
  changeAtSeconds: number;
  seconds: number;
  sampleRate?: number;
}): SynthesizedAudio {
  const sampleRate = options.sampleRate ?? RHYTHM_SAMPLE_RATE;
  const samples = new Float32Array(Math.ceil(options.seconds * sampleRate));
  const beatSeconds: number[] = [];
  let time = 0.1;
  let bpm = options.firstBpm;
  while (time < options.seconds - 0.05) {
    if (time >= options.changeAtSeconds) bpm = options.secondBpm;
    beatSeconds.push(time);
    addClick(samples, sampleRate, time, 1);
    time += 60 / bpm;
  }
  return { sampleRate, samples, beatSeconds, barSeconds: null };
}

export function synthesizeSpeechLike(seconds: number, sampleRate = RHYTHM_SAMPLE_RATE): SynthesizedAudio {
  const samples = new Float32Array(Math.ceil(seconds * sampleRate));
  let cursor = 0.05;
  let salt = 17;
  while (cursor < seconds - 0.1) {
    salt = (salt * 1_103_515_245 + 12_345) % 2_147_483_648;
    const gap = 0.07 + (salt % 430) / 1_000;
    const length = 0.03 + (salt % 90) / 1_000;
    addNoiseBurst(samples, sampleRate, cursor, length);
    cursor += gap;
  }
  return { sampleRate, samples, beatSeconds: [], barSeconds: null };
}

export function synthesizeSilence(seconds: number, sampleRate = RHYTHM_SAMPLE_RATE): SynthesizedAudio {
  return {
    sampleRate,
    samples: new Float32Array(Math.ceil(seconds * sampleRate)),
    beatSeconds: [],
    barSeconds: null,
  };
}

function addClick(
  samples: Float32Array,
  sampleRate: number,
  timeSeconds: number,
  gain: number,
): void {
  const start = Math.max(0, Math.floor(timeSeconds * sampleRate));
  const length = Math.floor(0.012 * sampleRate);
  for (let index = 0; index < length && start + index < samples.length; index += 1) {
    const envelope = Math.exp(-index / (0.0022 * sampleRate));
    const tone = Math.sin((2 * Math.PI * 1_400 * index) / sampleRate);
    const noise = ((index * 17) % 11) / 11 - 0.5;
    samples[start + index] = Math.max(-1, Math.min(1,
      samples[start + index]! + gain * envelope * (0.7 * tone + 0.6 * noise)));
  }
}

function addFormant(samples: Float32Array, sampleRate: number): void {
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
    const vowel = 0.18 * (
      Math.sin(2 * Math.PI * 220 * time)
      + 0.5 * Math.sin(2 * Math.PI * 440 * time)
      + 0.25 * Math.sin(2 * Math.PI * 880 * time)
    );
    samples[index] = Math.max(-1, Math.min(1, samples[index]! * 0.75 + vowel));
  }
}

function addNoiseBurst(
  samples: Float32Array,
  sampleRate: number,
  timeSeconds: number,
  lengthSeconds: number,
): void {
  const start = Math.floor(timeSeconds * sampleRate);
  const length = Math.floor(lengthSeconds * sampleRate);
  for (let index = 0; index < length && start + index < samples.length; index += 1) {
    const envelope = Math.sin((Math.PI * index) / length);
    const noise = Math.sin(index * 12.9898) * 43_758.5453;
    samples[start + index] = (noise - Math.floor(noise) - 0.5) * envelope;
  }
}
