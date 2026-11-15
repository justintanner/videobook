import { describe, expect, it } from "vitest";
import { fftInPlace } from "../rhythm/fft.js";
import { BUILTIN_SOUND_IDS, BUILTIN_SOUNDS, builtinSound, builtinSoundId } from "./catalog.js";
import { renderBuiltinSound } from "./synth.js";

function rms(samples: Float32Array): number {
  return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
}

function spectrum(samples: Float32Array): { centroid: number; strongest: number; lowFraction: number } {
  const length = 2 ** Math.ceil(Math.log2(samples.length));
  const real = new Float64Array(length);
  const imag = new Float64Array(length);
  for (let index = 0; index < samples.length; index += 1) real[index] = samples[index]!;
  fftInPlace(real, imag);
  let total = 0;
  let weighted = 0;
  let low = 0;
  let strongest = 0;
  let peak = 0;
  for (let index = 1; index < length / 2; index += 1) {
    const power = real[index]! ** 2 + imag[index]! ** 2;
    const hz = index * 48_000 / length;
    total += power;
    weighted += power * hz;
    if (hz < 200) low += power;
    if (power > peak) { peak = power; strongest = hz; }
  }
  return { centroid: weighted / total, strongest, lowFraction: low / total };
}

function loudestWindow(left: Float32Array, right: Float32Array): number {
  const window = 480;
  let energy = 0;
  let peak = 0;
  let start = 0;
  for (let index = 0; index < left.length; index += 1) {
    energy += left[index]! ** 2 + right[index]! ** 2;
    if (index >= window) energy -= left[index - window]! ** 2 + right[index - window]! ** 2;
    if (index >= window - 1 && energy > peak) { peak = energy; start = index - window + 1; }
  }
  return start / 48_000;
}

describe("built-in sound synthesis", () => {
  it("keeps the picker order and normalizes user names", () => {
    expect(BUILTIN_SOUND_IDS).toEqual(["zoom_in", "zoom_out", "whoosh", "swish", "pop", "click", "ding", "impact", "riser", "glitch"]);
    expect(BUILTIN_SOUNDS.map((sound) => sound.id)).toEqual(BUILTIN_SOUND_IDS);
    for (const text of ["zoom-in", "Zoom In", "zoom in", " zoom_in "]) expect(builtinSoundId(text)).toBe("zoom_in");
    expect(builtinSoundId("unknown")).toBeNull();
  });

  it.each(BUILTIN_SOUND_IDS)("%s is deterministic, bounded and aligned to its accent", (id) => {
    const spec = builtinSound(id);
    const audio = renderBuiltinSound(id);
    const again = renderBuiltinSound(id);
    expect(audio.sampleRate).toBe(48_000);
    let peak = 0;
    for (const [channel, samples] of [audio.left, audio.right].entries()) {
      expect(samples).toEqual(channel === 0 ? again.left : again.right);
      expect(samples.length).toBe(Math.round(spec.durationSeconds * 48_000));
      expect(Math.abs(samples[0]!)).toBe(0);
      expect(Math.abs(samples.at(-1)!)).toBe(0);
      expect(Math.abs(samples.reduce((sum, value) => sum + value, 0) / samples.length)).toBeLessThan(0.01);
      for (const sample of samples) {
        if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new Error(`Invalid sample: ${sample}`);
        peak = Math.max(peak, Math.abs(sample));
      }
    }
    expect(peak).toBeGreaterThanOrEqual(0.45);
    expect(peak).toBeLessThanOrEqual(0.55);
    expect(Math.abs(loudestWindow(audio.left, audio.right) - spec.accentSeconds)).toBeLessThanOrEqual(0.03);
  });

  it("makes the zooms sweep in opposite directions", () => {
    for (const id of ["zoom_in", "zoom_out"] as const) {
      const samples = renderBuiltinSound(id).left;
      const third = Math.floor(samples.length / 3);
      const first = spectrum(samples.slice(0, third)).centroid;
      const last = spectrum(samples.slice(-third)).centroid;
      if (id === "zoom_in") {
        expect(last / first).toBeGreaterThanOrEqual(1.5);
        expect(builtinSound(id).accentSeconds).toBeGreaterThanOrEqual(builtinSound(id).durationSeconds * 0.75);
      } else {
        expect(first / last).toBeGreaterThanOrEqual(1.5);
        expect(builtinSound(id).accentSeconds).toBeLessThanOrEqual(builtinSound(id).durationSeconds * 0.25);
      }
    }
  });

  it("places the whoosh in the middle and keeps the swish short and bright", () => {
    const whoosh = builtinSound("whoosh");
    expect(whoosh.accentSeconds / whoosh.durationSeconds).toBeGreaterThanOrEqual(1 / 3);
    expect(whoosh.accentSeconds / whoosh.durationSeconds).toBeLessThanOrEqual(2 / 3);
    expect(builtinSound("swish").durationSeconds).toBeLessThanOrEqual(0.3);
    expect(spectrum(renderBuiltinSound("swish").left).centroid).toBeGreaterThan(2_000);
  });

  it("keeps pop and click short with immediate accents", () => {
    expect(builtinSound("pop").durationSeconds).toBeLessThanOrEqual(0.2);
    expect(builtinSound("click").durationSeconds).toBeLessThanOrEqual(0.08);
    for (const id of ["pop", "click"] as const) expect(builtinSound(id).accentSeconds).toBeLessThanOrEqual(0.02);
  });

  it("rings a high bell with a decaying tail", () => {
    const samples = renderBuiltinSound("ding").left;
    const quarter = samples.length / 4;
    expect(builtinSound("ding").durationSeconds).toBeGreaterThanOrEqual(0.8);
    expect(spectrum(samples).strongest).toBeGreaterThan(1_000);
    expect(rms(samples.slice(-quarter)) / rms(samples.slice(0, quarter))).toBeLessThan(0.1);
  });

  it("lands a bass-heavy impact", () => {
    expect(spectrum(renderBuiltinSound("impact").left).lowFraction).toBeGreaterThan(0.5);
    expect(builtinSound("impact").accentSeconds).toBeLessThanOrEqual(0.05);
  });

  it("raises both level and pitch through the riser", () => {
    const samples = renderBuiltinSound("riser").left;
    const third = Math.floor(samples.length / 3);
    const first = samples.slice(0, third);
    const last = samples.slice(-third);
    expect(builtinSound("riser").durationSeconds).toBeGreaterThanOrEqual(1.2);
    expect(rms(last)).toBeGreaterThan(rms(first));
    expect(spectrum(last).centroid).toBeGreaterThan(spectrum(first).centroid);
  });

  it("breaks the glitch into bursts with at least three internal silent gaps", () => {
    const { left, right } = renderBuiltinSound("glitch");
    let run = 0;
    let gaps = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] === 0 && right[index] === 0) run += 1;
      else { if (run >= 480) gaps += 1; run = 0; }
    }
    expect(builtinSound("glitch").durationSeconds).toBeLessThanOrEqual(0.4);
    expect(gaps).toBeGreaterThanOrEqual(3);
  });
});
