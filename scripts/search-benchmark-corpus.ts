import type {
  IndexManifest,
  SearchBenchmarkCase,
  SearchBenchmarkClass,
} from 'videobook-engine'
import {
  LOCAL_CLAP_MANIFEST,
  LOCAL_CLIP_MANIFEST,
} from 'videobook-engine'

export interface SearchBenchmarkCorpus {
  corpusVersion: string
  sourceInventoryDigest: string
  judgmentsDigest: string
  rights: {
    status: 'verified'
    attestedBy: string
    attestedAt: string
  }
  durationHours: number
  artifactCount: number
  mediaClasses: string[]
  hardNegativeCount: number
  multilingualRobustnessCaseCount: number
  cases: SearchBenchmarkCase[]
}

interface PinnedSearchModel extends Omit<IndexManifest, 'createdAt'> {
  role: 'visual' | 'audio' | 'lexical'
  distribution: 'download-on-first-use'
  bundled: false
  licenseUrl: string
}

export const SEARCH_BENCHMARK_MINIMUMS = {
  durationHours: 50,
  artifactCount: 1_000,
  hardNegativeCount: 1,
  multilingualRobustnessCaseCount: 1,
  requiredMediaClasses: [
    'interview',
    'podcast',
    'talking-head',
    'b-roll',
    'screen-recording',
    'music',
    'ambience',
    'still-image',
    'generated-media',
  ],
  queryCounts: {
    'natural-language-visual': 150,
    'quoted-speech-ocr': 75,
    'reverse-video': 30,
    audio: 25,
  },
  reverseImageCount: 50,
} as const

export const PINNED_SEARCH_MODELS = [
  {
    role: 'visual',
    manifestId: LOCAL_CLIP_MANIFEST.manifestId,
    provider: LOCAL_CLIP_MANIFEST.provider,
    modelId: LOCAL_CLIP_MANIFEST.modelId,
    modelRevision: LOCAL_CLIP_MANIFEST.modelRevision,
    license: LOCAL_CLIP_MANIFEST.license,
    licenseUrl: 'https://huggingface.co/openai/clip-vit-base-patch32',
    embeddingSpace: LOCAL_CLIP_MANIFEST.embeddingSpace,
    dimensions: LOCAL_CLIP_MANIFEST.dimensions,
    modalities: LOCAL_CLIP_MANIFEST.modalities,
    supportedLanguages: LOCAL_CLIP_MANIFEST.supportedLanguages,
    preprocessingVersion: LOCAL_CLIP_MANIFEST.preprocessingVersion,
    extractorVersion: LOCAL_CLIP_MANIFEST.extractorVersion,
    distribution: 'download-on-first-use',
    bundled: false,
  },
  {
    role: 'audio',
    manifestId: LOCAL_CLAP_MANIFEST.manifestId,
    provider: LOCAL_CLAP_MANIFEST.provider,
    modelId: LOCAL_CLAP_MANIFEST.modelId,
    modelRevision: LOCAL_CLAP_MANIFEST.modelRevision,
    license: LOCAL_CLAP_MANIFEST.license,
    licenseUrl: 'https://huggingface.co/laion/clap-htsat-unfused',
    embeddingSpace: LOCAL_CLAP_MANIFEST.embeddingSpace,
    dimensions: LOCAL_CLAP_MANIFEST.dimensions,
    modalities: LOCAL_CLAP_MANIFEST.modalities,
    supportedLanguages: LOCAL_CLAP_MANIFEST.supportedLanguages,
    preprocessingVersion: LOCAL_CLAP_MANIFEST.preprocessingVersion,
    extractorVersion: LOCAL_CLAP_MANIFEST.extractorVersion,
    distribution: 'download-on-first-use',
    bundled: false,
  },
  {
    role: 'lexical',
    manifestId: 'minilm-l6-aff7a1d-preprocess-v1',
    provider: 'transformers.js',
    modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
    modelRevision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/onnx-community/all-MiniLM-L6-v2-ONNX',
    embeddingSpace: 'all-minilm-l6-v2-onnx-f32-v1',
    dimensions: 384,
    modalities: ['speech', 'ocr', 'metadata'],
    supportedLanguages: ['en'],
    preprocessingVersion: 'minilm-text-v1',
    extractorVersion: 'transformers-js-v3',
    distribution: 'download-on-first-use',
    bundled: false,
  },
] as const satisfies readonly PinnedSearchModel[]

const digestPattern = /^sha256:[0-9a-f]{64}$/

export function validateSearchBenchmarkCorpus(
  corpus: SearchBenchmarkCorpus,
): string[] {
  const failures: string[] = []
  if (!corpus.corpusVersion.trim()) failures.push('corpusVersion is required')
  if (!digestPattern.test(corpus.sourceInventoryDigest)) {
    failures.push('sourceInventoryDigest must be a sha256 digest')
  }
  if (!digestPattern.test(corpus.judgmentsDigest)) {
    failures.push('judgmentsDigest must be a sha256 digest')
  }
  if (corpus.rights.status !== 'verified') {
    failures.push('corpus rights must be verified')
  }
  if (!corpus.rights.attestedBy.trim() || !isIsoDate(corpus.rights.attestedAt)) {
    failures.push('rights verification requires an attestor and ISO timestamp')
  }
  if (!Number.isFinite(corpus.durationHours)
    || corpus.durationHours < SEARCH_BENCHMARK_MINIMUMS.durationHours) {
    failures.push('corpus must contain at least 50 hours')
  }
  if (!Number.isSafeInteger(corpus.artifactCount)
    || corpus.artifactCount < SEARCH_BENCHMARK_MINIMUMS.artifactCount) {
    failures.push('corpus must contain at least 1000 artifacts')
  }
  for (const mediaClass of SEARCH_BENCHMARK_MINIMUMS.requiredMediaClasses) {
    if (!corpus.mediaClasses.includes(mediaClass)) {
      failures.push(`missing media class: ${mediaClass}`)
    }
  }
  if (!Number.isSafeInteger(corpus.hardNegativeCount)
    || corpus.hardNegativeCount < SEARCH_BENCHMARK_MINIMUMS.hardNegativeCount) {
    failures.push('corpus must include hard negatives')
  }
  if (
    !Number.isSafeInteger(corpus.multilingualRobustnessCaseCount)
    || corpus.multilingualRobustnessCaseCount
    < SEARCH_BENCHMARK_MINIMUMS.multilingualRobustnessCaseCount
  ) {
    failures.push('corpus must include a multilingual robustness subset')
  }
  const counts = benchmarkClassCounts(corpus.cases)
  for (const [className, minimum] of Object.entries(
    SEARCH_BENCHMARK_MINIMUMS.queryCounts,
  )) {
    if ((counts.get(className as SearchBenchmarkClass) ?? 0) < minimum) {
      failures.push(`${className} requires at least ${minimum} cases`)
    }
  }
  const reverseImages = (counts.get('reverse-image-exact') ?? 0)
    + (counts.get('reverse-image-semantic') ?? 0)
  if (reverseImages < SEARCH_BENCHMARK_MINIMUMS.reverseImageCount) {
    failures.push('reverse image/frame requires at least 50 cases')
  }
  if ((counts.get('reverse-image-exact') ?? 0) === 0) {
    failures.push('reverse image cases must include exact/near matches')
  }
  if ((counts.get('reverse-image-semantic') ?? 0) === 0) {
    failures.push('reverse image cases must include semantic matches')
  }
  const caseIds = new Set<string>()
  for (const item of corpus.cases) {
    if (!item.caseId.trim() || caseIds.has(item.caseId)) {
      failures.push(`case IDs must be non-empty and unique: ${item.caseId}`)
    }
    caseIds.add(item.caseId)
    if (item.judgments.length === 0 || item.judgments.some((item) => !item.range)) {
      failures.push(`${item.caseId} requires time-range judgments`)
    }
  }
  return failures
}

function benchmarkClassCounts(
  cases: SearchBenchmarkCase[],
): Map<SearchBenchmarkClass, number> {
  const counts = new Map<SearchBenchmarkClass, number>()
  for (const item of cases) {
    counts.set(item.class, (counts.get(item.class) ?? 0) + 1)
  }
  return counts
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && value.includes('T')
}
