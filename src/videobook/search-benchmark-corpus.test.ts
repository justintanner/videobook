import { describe, expect, it } from 'vitest'
import type {
  SearchBenchmarkCase,
  SearchBenchmarkClass,
} from 'videobook-engine'
import {
  PINNED_SEARCH_MODELS,
  SEARCH_BENCHMARK_MINIMUMS,
  validateSearchBenchmarkCorpus,
  type SearchBenchmarkCorpus,
} from './search-benchmark-corpus'

function cases(
  className: SearchBenchmarkClass,
  count: number,
): SearchBenchmarkCase[] {
  return Array.from({ length: count }, (_, index) => ({
    caseId: `${className}-${index}`,
    class: className,
    query: { text: `${className} query ${index}` },
    judgments: [{
      artifactId: `artifact-${index}`,
      range: {
        streamId: `stream-${index}`,
        objectHash: `object-${index}`,
        startTick: index * 1_000,
        durationTicks: 1_000,
        timeBase: { numerator: 1, denominator: 1_000 },
      },
    }],
  }))
}

function validCorpus(): SearchBenchmarkCorpus {
  return {
    corpusVersion: 'private-beta-v1',
    sourceInventoryDigest: `sha256:${'1'.repeat(64)}`,
    judgmentsDigest: `sha256:${'2'.repeat(64)}`,
    rights: {
      status: 'verified',
      attestedBy: 'benchmark-owner',
      attestedAt: '2026-07-24T00:00:00.000Z',
    },
    durationHours: SEARCH_BENCHMARK_MINIMUMS.durationHours,
    artifactCount: SEARCH_BENCHMARK_MINIMUMS.artifactCount,
    mediaClasses: [...SEARCH_BENCHMARK_MINIMUMS.requiredMediaClasses],
    hardNegativeCount: 25,
    multilingualRobustnessCaseCount: 20,
    cases: [
      ...cases('natural-language-visual', 150),
      ...cases('quoted-speech-ocr', 75),
      ...cases('reverse-image-exact', 25),
      ...cases('reverse-image-semantic', 25),
      ...cases('reverse-video', 30),
      ...cases('audio', 25),
    ],
  }
}

describe('search benchmark corpus contract', () => {
  it('pins immutable, licensed, download-on-demand model manifests', () => {
    expect(PINNED_SEARCH_MODELS).toHaveLength(3)
    for (const model of PINNED_SEARCH_MODELS) {
      expect(model.modelRevision).toMatch(/^[0-9a-f]{40}$/)
      expect(model.license).toBeTruthy()
      expect(model.distribution).toBe('download-on-first-use')
      expect(model.bundled).toBe(false)
    }
  })

  it('accepts a frozen rights-cleared corpus at every PRD minimum', () => {
    expect(validateSearchBenchmarkCorpus(validCorpus())).toEqual([])
  })

  it('rejects an undersized corpus and artifact-only judgments', () => {
    const corpus = validCorpus()
    corpus.durationHours = 1
    corpus.cases[0]!.judgments[0]!.range = undefined
    expect(validateSearchBenchmarkCorpus(corpus)).toEqual(expect.arrayContaining([
      'corpus must contain at least 50 hours',
      `${corpus.cases[0]!.caseId} requires time-range judgments`,
    ]))
  })
})
