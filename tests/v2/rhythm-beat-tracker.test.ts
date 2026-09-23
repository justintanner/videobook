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
      expect(analysis.meter).toEqual({ beatsPerBar: 4, confidence: 0 })
      expect(analysis.barSource).toBe('estimated')
      expect(analysis.bars!.length).toBeGreaterThan(2)
      expect(analysis.bars!.every(bar => analysis.beats.some(beat => beat.timeSeconds === bar.timeSeconds))).toBe(true)
    }
  })

  it('does not invent beats for silence or speech-like audio', async () => {
    const silence = await analyzePcm(synthesizeSilence(4).samples)
    expect(silence.noBeats).toBe(true)
    expect(silence.beats).toEqual([])
    expect(silence.bars).toBeNull()
    expect(silence.barSource).toBeNull()
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

  it('retains coherent beats under changing loudness as uncertain candidates', async () => {
    for (const bpm of [80, 108, 120, 160]) {
      const clip = synthesizeClicks({ bpm, seconds: 24, leadSilenceSeconds: 0.5 })
      for (let index = 0; index < clip.samples.length; index += 1) {
        const time = index / clip.sampleRate
        const gain = time < 1 ? 0.95 : 0.2 * (1 + 0.3 * Math.sin(time))
        clip.samples[index] = clip.samples[index]! * gain + 0.06 * Math.sin(2 * Math.PI * 220 * time)
      }
      await expectMusical(clip.samples, clip.beatSeconds, `changing loudness ${bpm}`)
      const analysis = await analyzePcm(clip.samples)
      expect(analysis.lowConfidence).toBe(true)
      expect(analysis.barSource).toBe('estimated')
      expect(analysis.meter).toEqual({ beatsPerBar: 4, confidence: 0 })
      expect(analysis.bars!.length).toBeGreaterThan(6)
      expect(analysis.bars![0]!.timeSeconds).toBe(analysis.beats[0]!.timeSeconds)
      expect(analysis.bars!.every(bar => bar.confidence === 0 && analysis.beats.some(beat => beat.timeSeconds === bar.timeSeconds))).toBe(true)
    }
  })

  it('assigns a bar start even when only a few beats fit in a short clip', async () => {
    const clip = synthesizeClicks({ bpm: 120, seconds: 2, leadSilenceSeconds: 0.2 })
    const analysis = await analyzePcm(clip.samples)
    expect(analysis.noBeats).toBe(false)
    expect(analysis.barSource).toBe('estimated')
    expect(analysis.bars).toEqual([{ timeSeconds: analysis.beats[0]!.timeSeconds, confidence: 0 }])
  })

  it('keeps estimated bars in phase across a missing beat without adding or moving beats', async () => {
    const clip = synthesizeClicks({ bpm: 120, seconds: 12, leadSilenceSeconds: 0.5 })
    const missingTime = clip.beatSeconds[6]!
    clip.samples.fill(0, Math.round(missingTime * clip.sampleRate), Math.round((missingTime + 0.1) * clip.sampleRate))
    const analysis = await analyzePcm(clip.samples)
    expect(analysis.barSource).toBe('estimated')
    expect(analysis.beats.every(beat => Math.abs(beat.timeSeconds - missingTime) > TOLERANCE_SECONDS)).toBe(true)
    expect(analysis.bars!.every(bar => analysis.beats.some(beat => beat.timeSeconds === bar.timeSeconds))).toBe(true)
    expect(scoreBeats(clip.beatSeconds.filter((_, index) => index % 4 === 0), analysis.bars!.map(bar => bar.timeSeconds), TOLERANCE_SECONDS).f1).toBe(1)
  })

  it('rejects unstructured noise even when a short excerpt has a spurious tempo peak', async () => {
    for (const seconds of [2, 6, 12]) {
      const samples = new Float32Array(RHYTHM_SAMPLE_RATE * seconds)
      let seed = 12345
      for (let index = 0; index < samples.length; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        samples[index] = seed / 4294967296 * 2 - 1
      }
      const analysis = await analyzePcm(samples)
      expect(analysis.noBeats).toBe(true)
      expect(analysis.beats).toEqual([])
      expect(analysis.bars).toBeNull()
    }
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
    expect(analysis.meter?.beatsPerBar).toBe(3)
    expect(analysis.barSource).toBe('detected')
    expect(scoreBeats(pattern.barSeconds!, analysis.bars!.map(bar => bar.timeSeconds), TOLERANCE_SECONDS).f1).toBeGreaterThanOrEqual(0.85)
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
