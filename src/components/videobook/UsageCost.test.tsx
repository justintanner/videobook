import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Engine, UsageEntry, UsageInput } from 'videobook-engine'
import { createEngineForTest } from '../../../server/src/engine'
import { UsageCallRow, UsageCostSummary } from './UsageCost'

const RUN = '01990000-0000-7000-8000-0000000000aa'
const CELL = '01990000-0000-7000-8000-0000000000bb'

function call(overrides: Partial<UsageEntry>): UsageEntry {
  return {
    id: 'call', provider: 'openai', model: 'gpt-5.6', activity: 'chat', status: 'completed', basis: 'estimated',
    externalId: null, inputTokens: null, outputTokens: null, cachedTokens: null, tokenBased: false, costUsd: null,
    units: null, unit: null, rateSource: null, pricingVersion: null, artifactId: null, operation: null, warnings: [],
    estimateUsd: null, estimateSource: null, estimateRateAsOf: null, actualBasis: null, cacheWriteTokens: null,
    listUsd: null, notebookId: null, cellId: null, jobId: null, runId: null, createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

const ENTITIES: Record<string, string> = { '&#x27;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>', '&amp;': '&' }

function text(markup: string): string {
  return markup.replace(/<[^>]+>/gu, ' ').replace(/&#x27;|&quot;|&lt;|&gt;|&amp;/gu, (entity) => ENTITIES[entity]!).replace(/\s+/gu, ' ').trim()
}

function row(entry: UsageEntry): string {
  return text(renderToStaticMarkup(<ul><UsageCallRow entry={entry} /></ul>))
}

describe('a notebook cell call cost', () => {
  it('shows only the estimate while the call is running', () => {
    expect(row(call({ status: 'pending', estimateUsd: 0.42, costUsd: 0.42 }))).toBe('gpt-5.6 Estimate ~$0.42 Waiting for the actual')
  })

  it('shows a provider-billed actual as billed, with the estimate and list price beside it', () => {
    const billed = call({ model: 'Seedance-2.5', basis: 'reported', actualBasis: 'stated', costUsd: 6, listUsd: 6.82344, estimateUsd: 6.82344 })
    expect(row(billed)).toBe('Seedance-2.5 Billed $6.00 est. $6.82 $6.82 list price before credits')
    expect(renderToStaticMarkup(<ul><UsageCallRow entry={billed} /></ul>)).toContain('usage-cost-call-stated')
  })

  it('shows an actual calculated from usage as approximate, distinct from a billed one', () => {
    const derived = call({ actualBasis: 'derived', costUsd: 0.41, estimateUsd: 0.42, inputTokens: 1200, outputTokens: 300, tokenBased: true })
    expect(row(derived)).toBe('gpt-5.6 Calculated ~$0.41 est. $0.42 1,500 tokens, priced at the bundled rate')
    expect(renderToStaticMarkup(<ul><UsageCallRow entry={derived} /></ul>)).toContain('usage-cost-call-derived')
  })

  it('shows usage the provider reported when there is no rate to price it', () => {
    expect(row(call({ provider: 'kie', model: 'suno', basis: 'unknown', actualBasis: 'usage-only', units: 5, unit: 'credits', estimateUsd: 0.06 })))
      .toBe('suno Usage only est. $0.06 5 credits, no rate to price it')
  })

  it('shows why a free call costs nothing', () => {
    expect(row(call({ provider: 'elevenlabs', model: 'auto-convert', basis: 'free', costUsd: 0, warnings: ['auto_convert is false or absent: the content is stored, not converted'] })))
      .toBe('auto-convert Free $0.00 auto_convert is false or absent: the content is stored, not converted')
  })

  it('shows why a price is unavailable', () => {
    expect(row(call({ provider: 'machgen', model: 'Topaz-Video-Precision', basis: 'unknown', warnings: ["model 'Topaz-Video-Precision' not found in pricing table for provider 'machgen'"] })))
      .toBe("Topaz-Video-Precision Unavailable model 'Topaz-Video-Precision' not found in pricing table for provider 'machgen'")
  })
})

describe('a notebook run total', () => {
  let root: string
  let engine: Engine

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-usage-cost-'))
    engine = createEngineForTest(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  function record(input: UsageInput): void {
    const written = engine.usage.record({ runId: RUN, cellId: CELL, jobId: 'run-notebook-1', ...input })
    if (!written.ok) throw new Error(written.error.message)
  }

  function render(): string {
    const calls = engine.usage.recent(10).filter((entry) => entry.runId === RUN).reverse()
    return text(renderToStaticMarkup(<UsageCostSummary label="Run total" totals={engine.usage.rollup({ runId: RUN }).totals} calls={calls} />))
  }

  it('lists each of three calls and marks the total partial until the last one settles', () => {
    record({ id: 'a', provider: 'machgen', model: 'Seedance-2.5', activity: 'video', status: 'completed', basis: 'reported', actualBasis: 'stated', costUsd: 0.4, estimateUsd: 0.45, createdAt: 1 })
    record({ id: 'b', provider: 'openai', model: 'gpt-5.6', activity: 'chat', status: 'completed', basis: 'estimated', actualBasis: 'derived', costUsd: 0.41, estimateUsd: 0.42, inputTokens: 1200, outputTokens: 300, tokenBased: true, createdAt: 2 })
    record({ id: 'c', provider: 'wavespeed', model: 'runwayml/aleph-2', activity: 'video', status: 'pending', basis: 'estimated', costUsd: 1.85, estimateUsd: 1.85, createdAt: 3 })
    const running = render()
    expect(running).toContain('Run total ~$0.81 est. $0.87')
    expect(running).toContain('Partial: 2 of 3 calls settled')
    expect(running).toContain('1 in progress · $1.85 estimated, excluded from total')
    expect(running).toContain('Seedance-2.5 Billed $0.40 est. $0.45')
    expect(running).toContain('gpt-5.6 Calculated ~$0.41 est. $0.42')
    expect(running).toContain('runwayml/aleph-2 Estimate ~$1.85 Waiting for the actual')

    record({ id: 'c', provider: 'wavespeed', model: 'runwayml/aleph-2', activity: 'video', status: 'completed', basis: 'reported', actualBasis: 'stated', costUsd: 1.85, estimateUsd: 1.85, createdAt: 3 })
    const settled = render()
    expect(settled).toContain('Run total ~$2.66 est. $2.72')
    expect(settled).not.toContain('Partial')
    expect(settled).not.toContain('in progress')
    expect(settled).toContain('runwayml/aleph-2 Billed $1.85 est. $1.85')
  })

  it('keeps an unpriced call from settling the total', () => {
    record({ id: 'a', provider: 'openai', model: 'gpt-5.6', activity: 'chat', status: 'completed', basis: 'estimated', actualBasis: 'derived', costUsd: 0.41, estimateUsd: 0.42, inputTokens: 1200, outputTokens: 300, tokenBased: true })
    record({ id: 'b', provider: 'machgen', model: 'Topaz-Video-Precision', activity: 'video', status: 'completed', basis: 'unknown', warnings: ['Price unavailable for this model'] })
    expect(render()).toContain('Partial: 1 of 2 calls settled, 1 call unpriced')
  })

  it('renders nothing before the run makes a call', () => {
    expect(render()).toBe('')
  })

  it('folds the calls behind a closed disclosure and keeps every figure when collapsible', () => {
    const markup = (collapsible: boolean): string => renderToStaticMarkup(
      <UsageCostSummary
        label="Cell cost"
        totals={engine.usage.rollup({ cellId: CELL }).totals}
        calls={engine.usage.recent(10).filter((entry) => entry.cellId === CELL).reverse()}
        collapsible={collapsible}
      />,
    )
    record({ id: 'a', provider: 'machgen', model: 'Seedance-2.5', activity: 'video', status: 'completed', basis: 'reported', actualBasis: 'stated', costUsd: 0.4, estimateUsd: 0.45, createdAt: 1 })
    expect(markup(true)).toContain('<details class="usage-cost-details"><summary>1 call</summary><ol')

    record({ id: 'b', provider: 'openai', model: 'gpt-5.6', activity: 'chat', status: 'completed', basis: 'estimated', actualBasis: 'derived', costUsd: 0.41, estimateUsd: 0.42, inputTokens: 1200, outputTokens: 300, tokenBased: true, createdAt: 2 })
    record({ id: 'c', provider: 'wavespeed', model: 'runwayml/aleph-2', activity: 'video', status: 'pending', basis: 'estimated', costUsd: 1.85, estimateUsd: 1.85, createdAt: 3 })
    const folded = markup(true)
    const listed = markup(false)
    expect(folded).toContain('class="usage-cost usage-cost-collapsible"')
    expect(folded).toContain('<details class="usage-cost-details"><summary>3 calls</summary><ol')
    expect(listed).not.toContain('<details')
    expect(listed).not.toContain('usage-cost-collapsible')
    expect(text(folded)).toContain('Cell cost ~$0.81 est. $0.87 Partial: 2 of 3 calls settled 1 in progress · $1.85 estimated, excluded from total 3 calls Seedance-2.5 Billed $0.40 est. $0.45')
    expect(text(folded).replace(' 3 calls Seedance', ' Seedance')).toBe(text(listed))
  })
})
