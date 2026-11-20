import { describe, expect, it } from 'vitest'
import { listNotebookActions } from '../../server/src/notebook-action-catalog'
import {
  asNotebookGenerationActions,
  generationActionIsCompatible,
  type GenerationConnectedInput,
  type NotebookGenerationAction,
} from '../../src/videobook/notebook-generation-actions'
import {
  actionForFamily,
  generationFamilyGroups,
  generationProviderOptions,
} from '../../src/videobook/generation-provider-picker'

const catalog = asNotebookGenerationActions({ actions: listNotebookActions() })
  .map(action => ({ ...action, available: true }))
const imageActions = catalog.filter(action => action.cellTypes.includes('generate_image') && !action.existingCellOnly)
const videoActions = catalog.filter(action => action.cellTypes.includes('generate_video'))
const sunburst = 'image:gpt-image-2-6-sunburst'

function compatibleWith(inputs: GenerationConnectedInput[]) {
  return (action: NotebookGenerationAction) => generationActionIsCompatible(action, inputs)
}

function unavailable(actions: NotebookGenerationAction[], hidden: (action: NotebookGenerationAction) => boolean) {
  return actions.map(action => hidden(action) ? { ...action, available: false } : action)
}

describe('generation provider picker', () => {
  it('parses the family and variant and falls back to the action itself', () => {
    expect(catalog.find(action => action.model === 'fal:bytedance/seedance-2.5/us/text-to-video')).toMatchObject({
      family: { id: 'video:seedance-2-5', title: 'Seedance 2.5' },
      variant: 'US',
    })
    expect(catalog.find(action => action.model === 'kie:bytedance/seedance-2-5')).not.toHaveProperty('variant')
    const [bare] = asNotebookGenerationActions({ actions: [{
      ...listNotebookActions().find(action => action.model === 'kie:nano-banana-2-1'),
      family: undefined,
      variant: undefined,
    }] })
    expect(bare).toMatchObject({ family: { id: 'generation.kie:nano-banana-2-1', title: 'Nano Banana 2.1' } })
    expect(bare).not.toHaveProperty('variant')
  })

  it('lists one row per family ranked by its best available endpoint', () => {
    const groups = generationFamilyGroups(imageActions, 't2i')
    expect(groups.map(group => group.label)).toEqual(['Frontier models', 'Other models'])
    const [frontier] = groups
    expect(frontier!.rows[0]).toMatchObject({ family: { id: sunburst, title: 'GPT Image 2.6 Sunburst' }, ranking: { type: 't2i', rank: 1 }, available: true })
    expect(frontier!.rows[0]!.actions.map(action => action.provider).sort()).toEqual(['fal', 'fal', 'kie', 'kie', 'machgen', 'wavespeed', 'wavespeed'])
    expect(frontier!.rows.map(row => row.ranking!.rank)).toEqual(frontier!.rows.map(row => row.ranking!.rank).sort((left, right) => left - right))
    const ids = groups.flatMap(group => group.rows.map(row => row.family.id))
    expect(ids).toEqual([...new Set(ids)])
    expect(ids.length).toBe(new Set(imageActions.map(action => action.family.id)).size)
  })

  it('keeps a family available while any provider is, and unranked once its ranked endpoints are not', () => {
    const rankedGone = unavailable(imageActions, action => action.family.id === sunburst && Boolean(action.frontier?.some(ranking => ranking.type === 't2i')))
    const rankedGoneGroups = generationFamilyGroups(rankedGone, 't2i')
    const other = rankedGoneGroups.find(group => group.label === 'Other models')!
    expect(other.rows.find(row => row.family.id === sunburst)).toMatchObject({ available: true })
    expect(other.rows.find(row => row.family.id === sunburst)).not.toHaveProperty('ranking')
    const allGone = unavailable(imageActions, action => action.family.id === sunburst)
    const unavailableGroup = generationFamilyGroups(allGone, 't2i').find(group => group.label === 'Unavailable · provider not configured')!
    expect(unavailableGroup.rows.map(row => row.family.id)).toEqual([sunburst])
    expect(unavailableGroup.rows[0]).toMatchObject({ available: false, ranking: { rank: 1 } })
  })

  it('offers one endpoint per provider that fits the request, with its price, availability and compatibility', () => {
    const text = generationProviderOptions(imageActions, sunburst, { frontierType: 't2i', compatible: compatibleWith([]) })
    expect(text.map(option => [option.label, option.action.model])).toEqual([
      ['Fal', 'fal:openai/gpt-image-2.6/sunburst/text-to-image'],
      ['Kie', 'kie:gpt-image-2-6/sunburst-text-to-image'],
      ['MachGen', 'machgen:GPT-Image-2.6-Sunburst'],
      ['WaveSpeed', 'wavespeed:openai/gpt-image-2.6-sunburst/text-to-image'],
    ])
    for (const option of text) expect(option).toMatchObject({ ranking: { type: 't2i', rank: 1 }, priceLabel: expect.any(String), available: true, compatible: true })
    const edit = generationProviderOptions(imageActions, sunburst, { frontierType: 'i2i', compatible: compatibleWith([{ kind: 'image', target: 'image' }]) })
    expect(edit.map(option => [option.label, option.action.model])).toEqual([
      ['Fal', 'fal:openai/gpt-image-2.6/sunburst/edit'],
      ['Kie', 'kie:gpt-image-2-6/sunburst-image-to-image'],
      ['MachGen', 'machgen:GPT-Image-2.6-Sunburst'],
      ['WaveSpeed', 'wavespeed:openai/gpt-image-2.6-sunburst/edit'],
    ])
    expect(edit.every(option => option.compatible && option.ranking?.type === 'i2i')).toBe(true)
  })

  it('names variants beside the provider and marks endpoints the inputs do not fit', () => {
    const seedance = generationProviderOptions(videoActions, 'video:seedance-2-5', { frontierType: 't2v', compatible: compatibleWith([]) })
    expect(seedance.map(option => option.label)).toEqual(['Fal', 'Fal · US', 'Kie', 'MachGen', 'Nunchux', 'WaveSpeed'])
    expect(seedance.find(option => option.label === 'Fal · US')?.action.model).toBe('fal:bytedance/seedance-2.5/us/text-to-video')
    const frames = compatibleWith([{ kind: 'image', target: 'first_frame' }])
    const framed = generationProviderOptions(videoActions, 'video:seedance-2-5', { frontierType: 'i2v', compatible: frames })
    expect(framed.find(option => option.label === 'Fal')?.action.model).toBe('fal:bytedance/seedance-2.5/image-to-video')
    expect(framed.every(option => option.compatible)).toBe(true)
    const flux = generationProviderOptions(videoActions, 'video:flux-3', { frontierType: 't2v', compatible: compatibleWith([]) })
    expect(flux.find(option => option.label === 'Fal')?.action.model).toBe('fal:blackforestlabs/flux-3/text-to-video')
    expect(flux.find(option => option.label === 'Fal · Draft')?.action.model).toBe('fal:blackforestlabs/flux-3/text-to-video/draft')
    const keyframes = flux.find(option => option.label === 'Fal · Keyframes')!
    expect(keyframes).toMatchObject({ compatible: false, priceLabel: null })
    expect(keyframes).not.toHaveProperty('ranking')
  })

  it('keeps the current provider when it serves the new family, else takes the best ranked usable endpoint', () => {
    const options = { frontierType: 't2i' as const, compatible: compatibleWith([]) }
    expect(actionForFamily(imageActions, 'image:nano-banana-2-1', { ...options, currentProvider: 'wavespeed' })?.model)
      .toBe('wavespeed:google/nano-banana-2.1/text-to-image')
    expect(actionForFamily(imageActions, 'image:nano-banana-2-1', { ...options, currentProvider: 'xai' })?.model)
      .toBe('fal:google/nano-banana-2.1')
    const falGone = unavailable(imageActions, action => action.provider === 'fal')
    expect(actionForFamily(falGone, 'image:nano-banana-2-1', { ...options, currentProvider: 'fal' })?.model)
      .toBe('kie:nano-banana-2-1')
    const ranksOnlyOnFal = imageActions.map(action => action.family.id === 'image:nano-banana-2-1' && action.provider !== 'fal' ? { ...action, frontier: [] } : action)
    expect(actionForFamily(ranksOnlyOnFal, 'image:nano-banana-2-1', { ...options, currentProvider: 'xai' })?.model)
      .toBe('fal:google/nano-banana-2.1')
    const noneUsable = unavailable(imageActions, action => action.family.id === sunburst)
    expect(actionForFamily(noneUsable, sunburst, options)?.model).toBe('fal:openai/gpt-image-2.6/sunburst/text-to-image')
    expect(actionForFamily(imageActions, 'image:no-such-family', options)).toBeNull()
  })

  it('falls back to the first usable endpoint in catalog order for an unranked family', () => {
    const unranked = generationProviderOptions(imageActions, 'image:seedream-5-flash', { frontierType: 't2i', compatible: compatibleWith([]) })
    expect(unranked.map(option => [option.label, option.action.model])).toEqual([
      ['Fal', 'fal:bytedance/seedream/v5/flash/text-to-image'],
      ['Kie', 'kie:seedream/5-flash-text-to-image'],
    ])
    const falGone = unavailable(imageActions, action => action.provider === 'fal')
    expect(actionForFamily(falGone, 'image:seedream-5-flash', { frontierType: 't2i', compatible: compatibleWith([]), currentProvider: 'fal' })?.model)
      .toBe('kie:seedream/5-flash-text-to-image')
  })
})
