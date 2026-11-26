import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { estimateDubCost } from '../../server/src/dub-video'
import { DUB_VIDEO_MODELS } from '../../server/src/dub-video-contract'
import { scopedEngine } from '../../server/src/engine.js'
import { resolveModel } from '../../server/src/media/descriptor'
import { modelListing } from '../../server/src/media/listing'
import { getCanonicalCommands } from '../../server/src/tools/commands.js'
import { getAllToolDefs } from '../../server/src/tools/index.js'
import { buildWorkspaceActionCatalog } from '../../server/src/workspace-action-catalog.js'
import type { WorkspaceAction } from '../../server/src/workspace-action-contract.js'
import { WorkspaceActionSheet } from '../../src/components/videobook/WorkspaceActionSheet'
import {
  dubFormDraft,
  dubPrice,
  dubSheetEffect,
  dubSheetState,
  dubSlashCommand,
  dubValidation,
  filterDubLanguages,
  isDubVideoAction,
  toggleDubLanguage,
} from '../../src/videobook/dub-video-form'
import {
  seedWorkspaceActionDraft,
  workspaceActionReview,
  type WorkspaceActionDraft,
  type WorkspaceActionReview,
} from '../../src/videobook/workspace-action-draft'
import { loadWorkspaceActionResources } from '../../src/videobook/workspace-action-resources'
import type { WorkspaceActionContext } from '../../src/videobook/workspace-actions'

const catalog = buildWorkspaceActionCatalog(getAllToolDefs(scopedEngine), getCanonicalCommands())
const dubAction = catalog.actions.find((entry) => isDubVideoAction(entry)) as WorkspaceAction

async function languageChoices() {
  const models = Object.values(DUB_VIDEO_MODELS).map((id) => modelListing(resolveModel(id)))
  const loaded = await loadWorkspaceActionResources(dubAction, {}, async (name) => name === 'list_generation_models' ? { models } : { notebooks: [] })
  return loaded.choices.language ?? []
}

function dubContext(language: readonly { value: string; label: string }[]): WorkspaceActionContext {
  return {
    bookId: 'book-1',
    notebookId: 'notebook-1',
    choices: {
      asset_id: [
        { value: 'video-3', label: '@c3 · Seedance 2.5', detail: 'video' },
        { value: 'image-1', label: '@a1 · Still', detail: 'image' },
      ],
      language,
    },
    media: {
      'video-3': { url: '/files/book-1/video-3/original.mp4', type: 'video', width: 1920, height: 1080, objectHash: 'hash-3', duration: 9.4 },
    },
  }
}

function render(context: WorkspaceActionContext, draft: WorkspaceActionDraft, review: WorkspaceActionReview | null, reviewing = false): string {
  return renderToStaticMarkup(createElement(WorkspaceActionSheet, {
    action: dubAction,
    variants: [],
    context,
    draft,
    review,
    result: null,
    loading: false,
    error: null,
    busy: false,
    reviewing,
    applyFormId: 'command-composer-form',
    onChange: () => undefined,
    onPatch: () => undefined,
    onBack: () => undefined,
    onOpenAction: () => undefined,
    onCancel: () => undefined,
  }))
}

describe('dub video action form', () => {
  it('loads the HeyGen language list as the language choices', async () => {
    const choices = await languageChoices()
    expect(choices.length).toBeGreaterThan(100)
    expect(choices.map((choice) => choice.value)).toEqual(expect.arrayContaining(['Thai (Thailand)', 'Spanish (Mexico)', 'Turkish (Türkiye)']))
  })

  it('resolves typed languages the way the server does and keeps unknown ones visible', async () => {
    const names = (await languageChoices()).map((choice) => choice.value)
    const draft = dubFormDraft({ language: 'thai, spanish (mexico) and klingon', quality: 'precision', lip_sync: false }, names)
    expect(draft.languages).toEqual(['Thai (Thailand)', 'Spanish (Mexico)'])
    expect(draft.unknown).toEqual(['klingon'])
    expect(draft.quality).toBe('precision')
    expect(draft.lipSync).toBe(false)
    expect(dubValidation(draft)).toBe('Unknown language: klingon. Remove it and pick from the list.')
    expect(dubSlashCommand('@c3', draft)).toBe('/dub @c3 Thai (Thailand), Spanish (Mexico) precision voice-only')
  })

  it('caps the selection at five and searches without accents', async () => {
    const names = (await languageChoices()).map((choice) => choice.value)
    const five = ['English', 'Spanish', 'French', 'Hindi', 'Italian']
    expect(toggleDubLanguage(five, 'German')).toEqual(five)
    expect(toggleDubLanguage(five, 'French')).toEqual(['English', 'Spanish', 'Hindi', 'Italian'])
    expect(filterDubLanguages(names, 'turkiye')).toEqual(['Turkish (Türkiye)'])
    expect(dubValidation(dubFormDraft({ language: [] }, names))).toBe('Pick at least one language.')
  })

  it('renders the dropdown, the priced rows and a run label that counts languages', async () => {
    const language = await languageChoices()
    const context = dubContext(language)
    const draft = { ...seedWorkspaceActionDraft(dubAction, context, { asset_id: 'video-3' }), language: ['Thai (Thailand)', 'Spanish (Mexico)'] }
    const estimate = estimateDubCost({ durationSeconds: 9.4, quality: 'speed', languageCount: 2 })
    const review = workspaceActionReview(dubAction, 'generation', estimate) ?? null
    const html = render(context, draft, review)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Add another language')
    expect(html).toContain('Dub into 2 languages')
    expect(html).toContain('At least $1.00 · 2 new videos')
    expect(html).toContain('2 × 0:10 × $0.05/s')
    expect(html).toContain('confirm-sheet confirm-sheet-dub-video')
    expect(html).toContain('/dub @c3 Thai (Thailand), Spanish (Mexico)')
    expect(html.match(/\$0\.50/gu)?.length).toBe(2)
    expect(html).not.toContain('String')
    expect(html).not.toContain('Notebook')

    const state = dubSheetState(dubAction, context, draft, review, false)
    expect(state.address).toBe('@c3')
    expect(state.sources.map((choice) => choice.value)).toEqual(['video-3'])
    expect(dubSheetEffect(state)).toEqual({ label: 'At least $1.00 · 2 new videos', tone: 'warning' })
  })

  it('blocks running until a language is picked and shows a pending estimate', async () => {
    const context = dubContext(await languageChoices())
    const empty = render(context, seedWorkspaceActionDraft(dubAction, context, { asset_id: 'video-3' }), null)
    expect(empty).toContain('Pick a language to see the price')
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Dub video/u)

    const draft = { ...seedWorkspaceActionDraft(dubAction, context, { asset_id: 'video-3' }), language: ['Thai (Thailand)'] }
    expect(render(context, draft, null, true)).toContain('Estimating price…')
    expect(dubPrice(dubFormDraft(draft, ['Thai (Thailand)']), false, null)).toEqual({ state: 'unavailable' })
  })
})
