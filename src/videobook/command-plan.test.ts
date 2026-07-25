import { describe, expect, it } from 'vitest'
import {
  MVP_CONTRACT_FIXTURES,
  MVP_CONTRACT_VERSION,
  type EditIntent,
  type SearchQuery,
} from 'videobook-engine'
import {
  createCommandPlan,
  createEditCommandPlan,
  createSearchCommandPlan,
  equivalentEditOperations,
} from './command-plan'

describe('CommandPlan', () => {
  it('consumes engine EditIntent fixtures without shadow contract types', () => {
    const fixture = MVP_CONTRACT_FIXTURES.editIntent
    const intent: EditIntent = {
      ...fixture,
      intentVersion: MVP_CONTRACT_VERSION,
      operations: [fixture.operations[0]!],
      confirmationPolicy: 'reversible-single-step',
    }
    expect(createEditCommandPlan(intent, 'Insert the selected clip')).toMatchObject({
      planId: intent.commandId,
      planVersion: 1,
      sourceSurface: 'slash',
      confirmation: {
        required: false,
        policy: 'reversible-single-step',
      },
      stages: [{
        kind: 'edit',
        intent,
      }],
    })
  })

  it('normalizes equivalent UI slash and chat edit plans to one engine intent', () => {
    const fixture = MVP_CONTRACT_FIXTURES.editIntent
    const plans = (['ui', 'slash', 'chat'] as const).map((sourceSurface) => (
      createEditCommandPlan({
        ...fixture,
        intentVersion: MVP_CONTRACT_VERSION,
        sourceSurface,
      }, 'Apply the rough cut')
    ))
    expect(equivalentEditOperations(plans)).toBe(true)
  })

  it('never confirms a read-only semantic search plan', () => {
    const fixture: SearchQuery = {
      text: 'red van at dusk',
      modalities: ['visual', 'metadata'],
      limit: 20,
    }
    expect(createSearchCommandPlan(
      'search-red-van',
      'chat',
      fixture,
      'Find the red van at dusk',
    )).toMatchObject({
      stages: [{
        kind: 'search',
        query: fixture,
      }],
      confirmation: {
        required: false,
        reason: 'Search does not mutate the book',
      },
    })
  })

  it('requires disclosed spend and a revision-pinned continuation for generation', () => {
    const fixture = MVP_CONTRACT_FIXTURES.editIntent
    const plan = createCommandPlan({
      planId: fixture.commandId,
      sourceSurface: 'chat',
      actor: fixture.actor,
      bookId: '01900000-0000-7000-8000-000000000001',
      summary: 'Generate and insert workshop coverage',
      normalizedReferences: [],
      stages: [{
        stageId: `${fixture.commandId}:generation:0`,
        kind: 'queued',
        summary: 'Generate workshop coverage',
        jobType: 'generation',
        tool: 'generate_video',
        input: { prompt: 'workshop coverage' },
        provider: 'kie',
        model: 'kling-3.0',
        estimatedCostUsd: 0.42,
        insertsOutput: true,
        continuation: {
          sequenceId: fixture.sequenceId,
          baseRevision: fixture.baseRevision,
          destination: { trackId: 'video-2', startFrame: 0 },
        },
      }],
    })
    expect(plan.confirmation).toMatchObject({
      required: true,
      reason: 'This plan can incur provider spend',
    })
  })
})
