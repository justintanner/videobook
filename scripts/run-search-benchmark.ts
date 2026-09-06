import { readFile } from 'node:fs/promises'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import process from 'node:process'
import {
  createEngine,
  evaluateSearchBenchmark,
  type SearchBenchmarkReport,
} from 'videobook-engine'
import {
  registerLocalClapSearchProvider,
  registerLocalClipSearchProvider,
} from '../server/src/local-search-models.js'
import { FFMPEG } from '../server/src/ffmpeg.js'
import {
  validateSearchBenchmarkCorpus,
  type SearchBenchmarkCorpus,
} from './search-benchmark-corpus.js'

type BenchmarkEnvelope = {
  recordedAt: string
  corpusVersion: string
  sourceInventoryDigest: string
  judgmentsDigest: string
  rights: SearchBenchmarkCorpus['rights']
  device: {
    platform: string
    release: string
    architecture: string
    cpu: string
    logicalCpuCount: number
    totalMemoryBytes: number
    node: string
  }
  book: {
    bookId: string
    name: string
    revision: string
  }
  index: {
    manifests: ReturnType<ReturnType<typeof createEngine>['temporalSearch']['manifests']['list']>
    stats: ReturnType<ReturnType<typeof createEngine>['temporalSearch']['stats']>
  }
  report: SearchBenchmarkReport
}

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  if (index < 0 || !value || value.startsWith('--')) {
    throw new Error(`${name} is required`)
  }
  return value
}

async function main(): Promise<void> {
  const bookRoot = argument('--book-root')
  const corpusPath = argument('--corpus')
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8')) as SearchBenchmarkCorpus
  const validationFailures = validateSearchBenchmarkCorpus(corpus)
  if (validationFailures.length > 0) {
    throw new Error(`Invalid search benchmark corpus:\n${validationFailures.join('\n')}`)
  }
  const engine = createEngine({
    rootDir: bookRoot,
    initialBookName: 'benchmark',
  })
  try {
    await engine.ready
    registerLocalClipSearchProvider(engine)
    registerLocalClapSearchProvider(engine, FFMPEG)
    const manifests = engine.temporalSearch.manifests.list()
    const report = await evaluateSearchBenchmark(
      corpus.corpusVersion,
      manifests.map((manifest) => manifest.manifestId),
      corpus.cases,
      async (item) => {
        const result = await engine.temporalSearch.query({
          ...item.query,
          limit: Math.max(5, item.query.limit ?? 0),
        })
        if (!result.ok) throw new Error(`${item.caseId}: ${result.error.message}`)
        return result.value
      },
    )
    const cpuList = cpus()
    const envelope: BenchmarkEnvelope = {
      recordedAt: new Date().toISOString(),
      corpusVersion: corpus.corpusVersion,
      sourceInventoryDigest: corpus.sourceInventoryDigest,
      judgmentsDigest: corpus.judgmentsDigest,
      rights: corpus.rights,
      device: {
        platform: platform(),
        release: release(),
        architecture: arch(),
        cpu: cpuList[0]?.model ?? 'unknown',
        logicalCpuCount: cpuList.length,
        totalMemoryBytes: totalmem(),
        node: process.version,
      },
      book: {
        bookId: engine.book.get().bookId,
        name: engine.book.get().name,
        revision: engine.head,
      },
      index: {
        manifests,
        stats: engine.temporalSearch.stats(),
      },
      report,
    }
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`)
    if (!report.passed) process.exitCode = 1
  } finally {
    engine.close()
  }
}

await main()
