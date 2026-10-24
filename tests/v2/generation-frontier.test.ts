import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { listNotebookActions } from '../../server/src/notebook-action-catalog'
import { asNotebookGenerationActions, initialGenerationSelection } from '../../src/videobook/notebook-generation-actions'
import { WorkspaceActionField } from '../../src/components/videobook/WorkspaceActionField'
import { frontierPickerGroups, generationFrontierType, generationModelChoices } from '../../src/videobook/generation-frontier'
import { GenerationBody } from '../../src/components/videobook/confirm/bodies/GenerationBody'

const actions = asNotebookGenerationActions({ actions: listNotebookActions() })
  .filter(action => action.cellTypes.includes('generate_image'))
  .map(action => ({ ...action, available: true }))
const nano = actions.find(action => action.model === 'kie:nano-banana-2-1')!
const sunburst = actions.find(action => action.model === 'kie:gpt-image-2-5-sunburst-text-to-image')!
const flare = actions.find(action => action.model === 'kie:gpt-image-2-5-flare-text-to-image')!

describe('frontier model picker', () => {
  it('ranks configured models while retaining other model order and default selection', () => {
    const groups = frontierPickerGroups(actions, 't2i')
    const ranked = groups[0]!.rows
    expect(ranked[0]!.action.id).toBe(sunburst.id)
    expect(ranked.map(row => row.ranking!.rank)).toEqual(ranked.map(row => row.ranking!.rank).sort((a, b) => a - b))
    expect(groups[1]!.rows.map(row => row.action)).toEqual(actions.filter(action => !action.frontier?.some(row => row.type === 't2i')))
    expect(initialGenerationSelection({ type: 'generate_image' }, actions)?.model).toBe(nano.model)
    expect(initialGenerationSelection({ type: 'generate_image', model: flare.model }, actions)?.model).toBe(flare.model)
  })

  it('ranks HeyGen video endpoints and keeps Kling 4 in the other group', () => {
    const videoActions = asNotebookGenerationActions({ actions: listNotebookActions() })
      .filter(action => action.cellTypes.includes('generate_video'))
      .map(action => ({ ...action, available: true }))
    for (const [type, suffix] of [['t2v', 'text-to-video'], ['r2v', 'reference-to-video']] as const) {
      const groups = frontierPickerGroups(videoActions, type)
      expect(groups[0]!.rows.some(row => row.action.model === `fal:heygen/heygen-video/${suffix}` && row.ranking?.type === type)).toBe(true)
      expect(groups[1]!.rows.some(row => row.action.model === `fal:kling/v4/${suffix}`)).toBe(true)
    }
  })

  it('selects the matching operation board, including explicit video reference/edit modes', () => {
    expect(generationFrontierType('generate_image', 'default', 'text_to_image', [])).toBe('t2i')
    expect(generationFrontierType('generate_image', 'default', 'text_to_image', [{ type: 'prompt' }])).toBe('t2i')
    expect(generationFrontierType('generate_image', 'default', 'text_to_image', [{ type: 'image' }])).toBe('i2i')
    for (const mode of ['t2v', 'i2v', 'r2v', 'v2v']) {
      expect(generationFrontierType('generate_video', mode, 'text_to_video', [])).toBe(mode)
    }
    expect(generationFrontierType('generate_video', 'default', 'edit_video', [])).toBe('v2v')
    expect(generationFrontierType('generate_video', 'default', 'reference_to_video', [{ type: 'video' }])).toBe('r2v')
    expect(generationFrontierType('generate_audio', 'default', 'speech', [])).toBeNull()
  })

  it('ranks the generic command model field by its current operation and preserves its value', () => {
    const choices = actions.map(action => ({ value: action.model, label: action.title, available: action.model !== sunburst.model, frontier: action.frontier }))
    const text = generationModelChoices(choices, 'image', { operation: 'text_to_image' })
    const edit = generationModelChoices(choices, 'image', { operation: 'edit_image' })
    expect(text.find(choice => choice.value === nano.model)?.detail).toContain('Elo 1176')
    expect(edit.find(choice => choice.value === nano.model)?.detail).toContain('Elo 1152')
    const html = renderToStaticMarkup(createElement(WorkspaceActionField, {
      name: 'model', schema: { type: 'string' }, value: nano.model,
      choices: { model: text }, onChange: () => undefined,
    }))
    expect(html).toContain('optgroup label="Frontier models"')
    expect(html).toContain('optgroup label="Other models"')
    expect(html).toContain(`value="${sunburst.model}" disabled=""`)
    expect(html).toContain(`value="${nano.model}" selected=""`)
  })

  it('renders ranked options, a divider, prices and disabled unavailable providers without switching selection', () => {
    const unavailable = { ...sunburst, available: false }
    const other = actions.find(action => !action.frontier?.length)!
    const html = renderToStaticMarkup(createElement(GenerationBody, {
      actions: [nano, other, unavailable, flare],
      busy: false,
      draft: {
        action: nano,
        cell: { id: '00000000-0000-7000-8000-000000000001', type: 'generate_image', slot: { row: 0, column: 0 }, prompt: 'A tree' },
        connections: [], sourceCellIds: [], sourceAddresses: [],
      },
      modes: nano.inputContract.modes,
      preview: null, previewError: null, previewLoading: false, previewStale: false,
      sources: [], sourceOptions: [],
      onActionChange: () => undefined, onAddSource: () => undefined,
      onModeChange: () => undefined, onPromptChange: () => undefined,
      onRefreshPreview: () => undefined, onRemoveSource: () => undefined,
      onSelectSource: () => undefined, onSettingChange: () => undefined,
    }))
    expect(html).toContain('optgroup label="Frontier models"')
    expect(html).toContain('optgroup label="Other models"')
    expect(html).toContain('Unavailable · provider not configured')
    expect(html).toContain('Elo 1207')
    expect(html).toContain('0.03-0.08 USD/image')
    expect(html).toContain(`value="${nano.id}" selected=""`)
    expect(html).toContain(`value="${sunburst.id}" disabled=""`)
    expect(html.indexOf(`value="${flare.id}"`)).toBeLessThan(html.indexOf(`value="${nano.id}"`))
  })
})
