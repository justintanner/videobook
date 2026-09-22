import { describe, expect, it } from 'vitest'
import { analyzePcm } from '../../server/src/rhythm/analyze.js'
import { createOnsetAccumulator, onsetRetainedLimit } from '../../server/src/rhythm/onset.js'
import { scoreBeats } from '../../server/src/rhythm/score.js'
import {
  synthesizeClicks,
  synthesizePattern,
  synthesizeSilence,
  synthesizeSpeechLike,
  synthesizeTempoChange,
} from '../../server/src/rhythm/synthesize.js'
import { RHYTHM_SAMPLE_RATE } from '../../server/src/rhythm/contract.js'
import { fftInPlace } from '../../server/src/rhythm/fft.js'

const TOLERANCE_SECONDS = 0.07

async function expectMusical(samples: Float32Array, beats: number[], label: string): Promise<void> {
  const analysis = await analyzePcm(samples)
  const score = scoreBeats(beats, analysis.beats.map((beat) => beat.timeSeconds), TOLERANCE_SECONDS)
  expect(score, label).toMatchObject({
    referenceCount: beats.length,
  })
  expect(score.f1, `${label} f1 ${score.f1}`).toBeGreaterThanOrEqual(0.85)
  expect(score.medianAbsErrorSeconds ?? 1, `${label} error`).toBeLessThanOrEqual(0.025)
  expect(analysis.noBeats, label).toBe(false)
  expect(analysis.beats.every((beat) => beat.confidence === null || beat.confidence >= 0)).toBe(true)
  expect(analysis.onsets.length).toBeGreaterThan(0)
  expect(analysis.bpm).not.toBeNull()
}

describe('rhythm beat tracker', () => {
  it('transforms a bin-centered sine into one spectral peak', () => {
    const n = 1024
    const real = new Float64Array(n)
    const imag = new Float64Array(n)
    for (let index = 0; index < n; index += 1) real[index] = Math.sin((2 * Math.PI * 8 * index) / n)
    fftInPlace(real, imag)
    let peak = 0
    let peakBin = 0
    for (let bin = 0; bin < n / 2; bin += 1) {
      const magnitude = Math.hypot(real[bin]!, imag[bin]!)
      if (magnitude > peak) {
        peak = magnitude
        peakBin = bin
      }
    }
    expect(peakBin).toBe(8)
  })

  it('keeps only one analysis window of PCM', () => {
    const accumulator = createOnsetAccumulator()
    const chunk = new Float32Array(RHYTHM_SAMPLE_RATE * 3)
    accumulator.push(chunk)
    expect(accumulator.retainedSamples()).toBeLessThanOrEqual(onsetRetainedLimit())
    expect(accumulator.hopCount()).toBeGreaterThan(100)
  })

  it('tracks steady clicks inside 25 ms at several tempos', async () => {
    for (const bpm of [80, 120, 160]) {
      const clip = synthesizeClicks({ bpm, seconds: 12 })
      const analysis = await analyzePcm(clip.samples)
      const score = scoreBeats(
        clip.beatSeconds,
        analysis.beats.map((beat) => beat.timeSeconds),
        TOLERANCE_SECONDS,
      )
      expect(score.f1, `${bpm} f1`).toBeGreaterThanOrEqual(0.85)
      expect(score.medianAbsErrorSeconds ?? 1, `${bpm} median`).toBeLessThanOrEqual(0.025)
      expect(analysis.meter === null || analysis.meter.beatsPerBar > 0).toBe(true)
    }
  })

  it('does not invent beats for silence or speech-like audio', async () => {
    const silence = await analyzePcm(synthesizeSilence(4).samples)
    expect(silence.noBeats).toBe(true)
    expect(silence.beats).toEqual([])
    expect(silence.bars).toBeNull()
    const speech = await analyzePcm(synthesizeSpeechLike(6).samples)
    expect(speech.noBeats).toBe(true)
    expect(speech.beats).toEqual([])
    expect(speech.lowConfidence).toBe(true)
  })

  it('keeps leading silence free of beats', async () => {
    const clip = synthesizeClicks({ bpm: 120, seconds: 8, leadSilenceSeconds: 2 })
    const analysis = await analyzePcm(clip.samples)
    expect(analysis.beats[0]?.timeSeconds ?? 0).toBeGreaterThan(1.5)
    const score = scoreBeats(
      clip.beatSeconds,
      analysis.beats.map((beat) => beat.timeSeconds),
      TOLERANCE_SECONDS,
    )
    expect(score.f1).toBeGreaterThanOrEqual(0.85)
  })

  it('follows a tempo change without assuming 4/4', async () => {
    const clip = synthesizeTempoChange({
      firstBpm: 90,
      secondBpm: 140,
      changeAtSeconds: 6,
      seconds: 12,
    })
    await expectMusical(clip.samples, clip.beatSeconds, 'tempo change')
    const pattern = synthesizePattern({
      bpm: 108,
      seconds: 12,
      beatsPerBar: 3,
      accentEvery: 3,
    })
    const analysis = await analyzePcm(pattern.samples)
    const score = scoreBeats(
      pattern.beatSeconds,
      analysis.beats.map((beat) => beat.timeSeconds),
      TOLERANCE_SECONDS,
    )
    expect(score.f1).toBeGreaterThanOrEqual(0.85)
    expect(analysis.meter?.beatsPerBar ?? null).not.toBe(4)
  })

  it('marks percussive, syncopated, and vocal-heavy patterns', async () => {
    const percussive = synthesizePattern({
      bpm: 100,
      seconds: 12,
      beatsPerBar: 4,
      accentEvery: 2,
    })
    await expectMusical(percussive.samples, percussive.beatSeconds, 'percussive')
    const syncopated = synthesizePattern({
      bpm: 110,
      seconds: 12,
      beatsPerBar: 4,
      accentEvery: 4,
      syncopated: true,
    })
    await expectMusical(syncopated.samples, syncopated.beatSeconds, 'syncopated')
    const vocal = synthesizePattern({
      bpm: 96,
      seconds: 12,
      beatsPerBar: 4,
      accentEvery: 4,
      harmonic: true,
    })
    await expectMusical(vocal.samples, vocal.beatSeconds, 'vocal')
  })
})
