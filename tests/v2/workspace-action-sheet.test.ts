import { BUILTIN_SOUNDS } from '../../server/src/sound-effects/catalog'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { scopedEngine } from '../../server/src/engine.js'
import { listModels, modelListing } from '../../server/src/media/listing.js'
import {
  generationModelIdForChange,
  generationProviderChoices,
} from '../../src/videobook/generation-frontier'
import { loadWorkspaceActionResources } from '../../src/videobook/workspace-action-resources'
import { WorkspaceGenerationModelField } from '../../src/components/videobook/WorkspaceGenerationModelField'
import { adaptCommandArgs, parseSlashCommandArgs, type ServerCommand } from '../../src/lib/command-registry'
import { getCanonicalCommands } from '../../server/src/tools/commands.js'
import { getAllToolDefs } from '../../server/src/tools/index.js'
import { buildWorkspaceActionCatalog } from '../../server/src/workspace-action-catalog.js'
import type { WorkspaceAction } from '../../server/src/workspace-action-contract.js'
import { TimelineClipSheet } from '../../src/components/videobook/TimelineClipSheet'
import { WorkspaceActionSheet } from '../../src/components/videobook/WorkspaceActionSheet'
import type { TimelineAsset } from '../../src/videobook/useTimelineAssembly'
import {
  effectiveWorkspaceActionValues,
  patchWorkspaceActionDraft,
  seedWorkspaceActionDraft,
  workspaceActionConfirmation,
  workspaceActionFields,
  workspaceActionRequired,
  workspaceActionReview,
  workspaceActionValidation,
  workspaceActionVariants,
  type WorkspaceActionDraft,
  type WorkspaceActionResult,
  type WorkspaceActionReview,
} from '../../src/videobook/workspace-action-draft'
import type { WorkspaceActionContext } from '../../src/videobook/workspace-actions'

const catalog = buildWorkspaceActionCatalog(getAllToolDefs(scopedEngine), getCanonicalCommands())

function catalogAction(id: string): WorkspaceAction {
  const action = catalog.actions.find((entry) => entry.id === id)
  if (!action) throw new Error(`The catalog has no ${id}`)
  return action
}

const context: WorkspaceActionContext = {
  bookId: 'book-1',
  notebookId: 'notebook-1',
  choices: {
    asset_id: [
      { value: 'image-1', label: '@a2 · Still', detail: 'image' },
      { value: 'video-1', label: '@a1 · Clip', detail: 'video' },
    ],
  },
  media: {
    'image-1': { url: '/files/book-1/image-1/original.png', type: 'image', width: 1920, height: 1080, objectHash: 'hash-image-1' },
  },
}

function renderActionSheet(action: WorkspaceAction, overrides: {
  draft?: WorkspaceActionDraft | null
  review?: WorkspaceActionReview
  result?: WorkspaceActionResult
  loading?: boolean
  context?: WorkspaceActionContext
  variants?: readonly WorkspaceAction[]
} = {}): string {
  return renderToStaticMarkup(createElement(WorkspaceActionSheet, {
    action,
    variants: overrides.variants ?? workspaceActionVariants(catalog.actions, action),
    context: overrides.context ?? context,
    draft: overrides.draft === undefined ? seedWorkspaceActionDraft(action, context) : overrides.draft,
    review: overrides.review ?? null,
    result: overrides.result ?? null,
    loading: overrides.loading ?? false,
    error: null,
    busy: false,
    applyFormId: 'command-composer-form',
    onChange: () => undefined,
    onPatch: () => undefined,
    onBack: () => undefined,
    onOpenAction: () => undefined,
    onCancel: () => undefined,
  }))
}

const clips: TimelineAsset[] = [
  { artifactId: 'video-1', label: 'portrait.mp4', type: 'video', status: 'ready', mediaUrl: '/files/book-1/video-1/proxy.mp4', thumbnailUrl: '/files/book-1/video-1/poster.jpg' },
  { artifactId: 'video-2', label: 'landscape.mp4', type: 'video', status: 'ready', mediaUrl: '/files/book-1/video-2/proxy.mp4', thumbnailUrl: null },
]

function renderClipSheet(selectedArtifactId: string | null, extra: { error?: string; applyFormId?: string } = {}): string {
  return renderToStaticMarkup(createElement(TimelineClipSheet, {
    trackName: 'Audio 1',
    items: clips,
    selectedArtifactId,
    hasMore: true,
    busy: false,
    error: extra.error ?? '',
    ...(extra.applyFormId ? { applyFormId: extra.applyFormId } : {}),
    onSelect: () => undefined,
    onLoadMore: () => undefined,
    onCancel: () => undefined,
  }))
}

describe('workspace action sheet', () => {
  it('renders an action as a composer review instead of a modal dialog', () => {
    const crop = catalogAction('tool.crop_asset')
    const html = renderActionSheet(crop, { draft: seedWorkspaceActionDraft(crop, context, { asset_id: 'image-1' }) })
    expect(html).toContain('confirm-sheet confirm-sheet-workspace-action')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Workspace action review"')
    expect(html).not.toContain('<dialog')
    expect(html).not.toContain('aria-modal')
    expect(html).toContain('ACTION · MEDIA')
    expect(html).toContain('>Crop asset</h2>')
    expect(html).toContain('form="command-composer-form"')
    expect(html).toContain('class="confirm-sheet-apply">Run action <kbd>↵</kbd>')
    expect(html).toContain('data-action-id="tool.crop_asset"')
    expect(html).toContain('aria-label="Crop preview"')
  })

  it('shows a destructive action\'s review on the card and runs it with one Apply', () => {
    const remove = catalogAction('tool.delete_entity')
    const html = renderActionSheet(remove, { review: { message: 'Delete entity changes or removes the selected content.' } })
    expect(html).toContain('class="confirm-sheet-apply">Run action <kbd>↵</kbd>')
    expect(html).toContain('Changes or removes content')
    expect(html).toContain('Delete entity changes or removes the selected content.')
    expect(html).not.toContain('Cancel review')
    const priced = renderActionSheet(remove, { review: { message: 'May incur charges.', cost: 'Estimated cost: $0.0400' } })
    expect(priced).toContain('<strong>Estimated cost: $0.0400</strong>')
  })

  it('edits a single sound effect as plain fields and sends it as one entry', () => {
    const apply = catalogAction('tool.apply_sfx')
    expect(workspaceActionFields(apply).map(([name]) => name)).toEqual(expect.arrayContaining(['asset_id', 'sfx.timestamp', 'sfx.type', 'sfx.description']))
    expect(workspaceActionFields(apply).map(([name]) => name)).not.toContain('sfx')
    expect([...workspaceActionRequired(apply)]).toEqual(expect.arrayContaining(['asset_id', 'sfx.timestamp', 'sfx.type', 'sfx.description']))
    const draft = seedWorkspaceActionDraft(apply, context, { asset_id: 'video-1', sfx: [{ timestamp: 2.5, type: 'whoosh', description: 'fast transition' }] })
    expect(draft).toMatchObject({ 'sfx.timestamp': 2.5, 'sfx.type': 'whoosh', 'sfx.description': 'fast transition' })
    const edited = patchWorkspaceActionDraft(apply, context, draft, 'sfx.timestamp', 4)
    expect(effectiveWorkspaceActionValues(apply, edited).sfx).toEqual([{ timestamp: 4, type: 'whoosh', description: 'fast transition' }])
  })

  it('shows a free built-in sound as a flat cue with ten sound options', () => {
    const action = catalogAction('tool.apply_builtin_sfx')
    const fields = workspaceActionFields(action)
    expect(fields.map(([name]) => name)).toEqual(expect.arrayContaining(['sfx.sound', 'sfx.timestamp', 'sfx.volume']))
    expect(fields.map(([name]) => name)).not.toContain('sfx')
    const draft = seedWorkspaceActionDraft(action, context, { asset_id: 'video-1', sfx: [{ sound: 'zoom_in', timestamp: 2.5 }] })
    const html = renderActionSheet(action, { draft })
    for (const sound of BUILTIN_SOUNDS) expect(html).toContain(`>${sound.title}</option>`)
    expect(html).toContain('aria-label="Preview Zoom in"')
    expect(html).toContain(BUILTIN_SOUNDS[0]!.description)
    expect(html).toContain('<select')
    expect(html).not.toContain('May incur provider charges')
    const edited = patchWorkspaceActionDraft(action, context, draft, 'sfx.volume', 35)
    expect(effectiveWorkspaceActionValues(action, edited).sfx).toEqual([{ sound: 'zoom_in', timestamp: 2.5, volume: 35 }])
  })

  it('describes the selected built-in sound and leaves preview idle on render', () => {
    const action = catalogAction('tool.apply_builtin_sfx')
    for (const sound of BUILTIN_SOUNDS) {
      const draft = seedWorkspaceActionDraft(action, context, { asset_id: 'video-1', sfx: [{ sound: sound.id, timestamp: 1 }] })
      const html = renderActionSheet(action, { draft })
      expect(html).toContain(sound.description)
      expect(html).toContain(`aria-label="Preview ${sound.title}"`)
      expect(html).toContain('aria-pressed="false"')
    }
  })

  it('opens /zoom @a1 2.5-4 1.5 as one zoom of plain fields and runs it as one free entry', () => {
    const command = getCanonicalCommands().find((entry) => entry.command === '/zoom') as ServerCommand
    const args = adaptCommandArgs(command.mcpTool?.adapter, parseSlashCommandArgs(command, 'video-1 2.5-4 1.5'))
    const action = catalogAction('tool.zoom_video')
    expect(action.interaction).toBe('preview')
    const names = workspaceActionFields(action).map(([name]) => name)
    expect(names).toEqual(expect.arrayContaining([
      'asset_id', 'zooms.start_seconds', 'zooms.end_seconds', 'zooms.scale', 'zooms.focus_x', 'zooms.focus_y',
      'zooms.ramp_in_seconds', 'zooms.ramp_out_seconds', 'zooms.sound', 'zooms.return_sound',
    ]))
    expect(names).not.toContain('zooms')
    expect([...workspaceActionRequired(action)]).toEqual(expect.arrayContaining(['asset_id', 'zooms.start_seconds']))
    const draft = seedWorkspaceActionDraft(action, context, args)
    expect(draft).toMatchObject({ asset_id: 'video-1', 'zooms.start_seconds': 2.5, 'zooms.end_seconds': 4, 'zooms.scale': 1.5 })
    expect(effectiveWorkspaceActionValues(action, draft)).toMatchObject({ book_id: 'book-1', asset_id: 'video-1', zooms: [{ start_seconds: 2.5, end_seconds: 4, scale: 1.5 }] })
    const html = renderActionSheet(action, { draft })
    expect(html.match(/>Zoom out<\/option>/gu)).toHaveLength(2)
    expect(html.match(/aria-label="Preview sound"/gu)).toHaveLength(2)
    expect(html).not.toContain('May incur provider charges')
    const edited = patchWorkspaceActionDraft(action, context, draft, 'zooms.sound', 'zoom_in')
    expect(effectiveWorkspaceActionValues(action, edited).zooms).toEqual([{ start_seconds: 2.5, end_seconds: 4, scale: 1.5, sound: 'zoom_in' }])
    expect(workspaceActionConfirmation(action, effectiveWorkspaceActionValues(action, edited))).toBe('none')
  })

  it('previews a zoom over its video with the focus marker, sliders and play controls', () => {
    const zoom = catalogAction('tool.zoom_video')
    const zoomContext: WorkspaceActionContext = {
      ...context,
      media: { ...context.media, 'video-1': { url: '/files/book-1/video-1/proxy.mp4', type: 'video', width: 324, height: 576, objectHash: 'hash-video-1', duration: 4, fps: 30 } },
    }
    const draft = seedWorkspaceActionDraft(zoom, zoomContext, { asset_id: 'video-1', zooms: [{ start_seconds: 1, end_seconds: 2.5, scale: 1.5, focus_x: 0.25, focus_y: 0.75 }] })
    const html = renderActionSheet(zoom, { draft, context: zoomContext })
    expect(html).toContain('aria-label="Zoom preview"')
    expect(html).toContain('aria-label="Zoom focus point"')
    expect(html).toContain('<video src="/files/book-1/video-1/proxy.mp4"')
    expect(html).toMatch(/class="workspace-zoom-focus" aria-hidden="true" style="left:25%;top:75%"/u)
    for (const name of ['Horizontal zoom focus', 'Vertical zoom focus', 'Preview time']) expect(html).toContain(`aria-label="${name}"`)
    for (const name of ['Play zoom', 'Set start', 'Set end']) expect(html).toMatch(new RegExp(`<button type="button"[^>]*>${name}</button>`, 'u'))
    expect(html).not.toContain('class="workspace-zoom-message"')

    const invalid = renderActionSheet(zoom, { draft: { ...draft, 'zooms.scale': 5 }, context: zoomContext })
    expect(invalid).toContain('Zoom 1 scale must be from 1.05 to 3; got 5')
    expect(invalid).toMatch(/<button type="button" disabled="">Play zoom<\/button>/u)

    const crop = catalogAction('tool.crop_asset')
    expect(renderActionSheet(crop, { draft: seedWorkspaceActionDraft(crop, zoomContext, { asset_id: 'video-1' }), context: zoomContext })).not.toContain('Zoom preview')
    expect(renderActionSheet(zoom, { draft: seedWorkspaceActionDraft(zoom, zoomContext, { asset_id: 'image-1' }), context: zoomContext })).not.toContain('Zoom preview')
  })

  it('marks only the paid and destructive operations of video graphics and subtitles', () => {
    const effects = (id: string, values: WorkspaceActionDraft) => {
      const html = renderActionSheet(catalogAction(id), { draft: { book_id: 'book-1', asset_id: 'video-1', ...values } })
      return ['May incur provider charges', 'Changes or removes content', 'Leaves workspace'].filter((label) => html.includes(label))
    }
    const charges = ['May incur provider charges']
    const changes = ['Changes or removes content']
    const graphics: [WorkspaceActionDraft, string[]][] = [
      [{}, []], [{ op: 'get' }, []], [{ op: 'update' }, []], [{ op: 'render' }, []], [{ op: 'render', output: 'new' }, []],
      [{ op: 'check_placement' }, []], [{ op: 'save_template' }, []], [{ op: 'rename_template' }, []],
      [{ op: 'set_default_template' }, []], [{ op: 'copy_templates' }, []], [{ op: 'save_watermark' }, []],
      [{ op: 'set_watermark_template' }, []],
      [{ op: 'suggest' }, charges], [{ op: 'detect_regions' }, charges],
      [{ op: 'delete_template' }, changes], [{ op: 'render', output: 'replace' }, changes],
    ]
    for (const [values, expected] of graphics) expect(effects('tool.video_graphics', values), JSON.stringify(values)).toEqual(expected)
    const subtitles: [WorkspaceActionDraft, string[]][] = [
      [{}, []], [{ op: 'get' }, []], [{ op: 'update' }, []], [{ op: 'update', resolve: 'reseed' }, []], [{ op: 'render' }, []],
      [{ op: 'prepare' }, charges], [{ op: 'update', resolve: 'discard' }, changes], [{ op: 'render', output: 'replace' }, changes],
    ]
    for (const [values, expected] of subtitles) expect(effects('tool.caption_video', values), JSON.stringify(values)).toEqual(expected)
    expect(effects('tool.generate_image', {}), 'generate_image').toEqual(charges)
    expect(effects('tool.delete_entity', {}), 'delete_entity').toEqual(changes)
    expect(effects('tool.post', {}), 'post').toEqual(['Leaves workspace'])
  })

  it('reviews an operation without the internal cost adapter text', () => {
    const graphics = catalogAction('tool.video_graphics')
    const review = (values: WorkspaceActionDraft, estimate?: unknown) =>
      workspaceActionReview(graphics, workspaceActionConfirmation(graphics, values), estimate)
    const unpriced = { usd: 0, currency: 'USD', source: 'free', warnings: ["no cost adapter registered for tool 'video_graphics'"] }
    const paid = review({ op: 'suggest' }, unpriced)
    expect(paid).toEqual({
      cost: 'Cost estimate unavailable',
      message: 'Running this sends your prompt and selected media to a generation provider and may incur charges.',
      usd: 0,
      warnings: ["no cost adapter registered for tool 'video_graphics'"],
    })
    const html = renderActionSheet(graphics, { draft: { book_id: 'book-1', asset_id: 'video-1', op: 'suggest' }, review: paid })
    expect(html).toContain('<strong>Cost estimate unavailable</strong>')
    expect(html).not.toContain('no cost adapter')
    expect(review({ op: 'get' })).toBeUndefined()
    expect(review({ op: 'delete_template' })).toEqual({ message: `${graphics.title} changes or removes the selected content.` })
    const subtitles = catalogAction('tool.caption_video')
    expect(workspaceActionReview(subtitles, workspaceActionConfirmation(subtitles, { op: 'prepare' }), {
      usd: 0, warnings: ["no cost adapter registered for tool 'caption_video'"],
    })?.message).toBe('Running this sends your prompt and selected media to a generation provider and may incur charges.')
    const source = 'The Seedance edit source must be at most 15 seconds long.'
    expect(workspaceActionReview(catalogAction('tool.generate_video'), 'generation', { usd: 0, warnings: [source] }))
      .toEqual({ cost: 'Cost estimate unavailable', message: `Running this sends your prompt and selected media to a generation provider and may incur charges. ${source}`, usd: 0, warnings: [source] })
    expect(workspaceActionReview(catalogAction('tool.post'), 'external'))
      .toEqual({ message: `${catalogAction('tool.post').title} sends the selected content outside this workspace.` })
  })

  it('keeps a run result on the sheet and offers Close', () => {
    const html = renderActionSheet(catalogAction('tool.get_book'), {
      result: { message: 'Get book complete', value: { name: 'action-ui-project' } },
    })
    expect(html).toContain('aria-label="Action result"')
    expect(html).toContain('action-ui-project')
    expect(html).toContain('Close <kbd>Esc</kbd>')
  })

  it('lays short settings out as compact rows and keeps structured settings full width', () => {
    const trending = catalogAction('tool.trending_research')
    const html = renderActionSheet(trending, { draft: seedWorkspaceActionDraft(trending, context, { sources: [{ id: 'omkar' }] }) })
    const fieldClass = (label: string) => new RegExp(`<div class="([^"]+)"><label for="[^"]+">${label}</label>`).exec(html)?.[1]
    expect(fieldClass('Country')).toBe('workspace-action-field workspace-action-compact')
    expect(fieldClass('Samples per day')).toBe('workspace-action-field workspace-action-compact workspace-action-short')
    expect(fieldClass('Window')).toBe('workspace-action-field workspace-action-compact')
    expect(fieldClass('Criteria')).toBeDefined()
    expect(fieldClass('Downstream')).toBe('workspace-action-field workspace-action-compact workspace-action-structure')
    expect(fieldClass('Sources')).toBe('workspace-action-field workspace-action-wide workspace-action-structure')
  })

  it('blocks Apply while the action loads and when it needs an open notebook', () => {
    const rename = catalogAction('tool.rename_notebook')
    const loading = renderActionSheet(rename, { draft: null, loading: true })
    expect(loading).toContain('Loading action…')
    expect(loading).toContain('class="confirm-sheet-apply" disabled="">')
    expect(workspaceActionValidation({ action: rename, context: { ...context, notebookId: undefined }, loading: false, error: null, ready: true }))
      .toEqual({ blocking: 'Open a notebook first.', notice: null })
    expect(workspaceActionValidation({ action: null, context, loading: false, error: null, ready: false }))
      .toEqual({ blocking: 'This action is no longer available.', notice: null })
    expect(workspaceActionValidation({ action: rename, context, loading: false, error: null, ready: true }))
      .toEqual({ blocking: null, notice: null })
  })

  it('splits image and video generation into model and provider selects', async () => {
    const image = catalogAction('tool.generate_image')
    const loaded = await loadWorkspaceActionResources(image, {}, async (name, args) => {
      if (name !== 'list_generation_models') return {}
      return { models: listModels({ media: args.media === 'video' ? 'video' : 'image' }).map(modelListing) }
    })
    const choices = (loaded.choices.model ?? []).map(choice => ({ ...choice, available: true }))
    const sunburst = 'image:gpt-image-2-6-sunburst'
    const wavespeedText = 'wavespeed:openai/gpt-image-2.6-sunburst/text-to-image'
    const wavespeedEdit = 'wavespeed:openai/gpt-image-2.6-sunburst/edit'
    const nano = 'image:nano-banana-2-1'
    const withModels = { ...context, choices: { ...context.choices, model: choices } }
    const selectMarkup = (html: string, label: string) => {
      const start = html.indexOf(`aria-label="${label}"`)
      return html.slice(start, html.indexOf('</select>', start))
    }
    expect(generationProviderChoices(choices, sunburst, 'image', {}).find(choice => choice.provider === 'wavespeed')?.value).toBe(wavespeedText)
    expect(generationProviderChoices(choices, sunburst, 'image', { refs: { image: ['image-1'] } }).find(choice => choice.provider === 'wavespeed')?.value).toBe(wavespeedEdit)
    expect(generationModelIdForChange(choices, 'image', { model: wavespeedText }, { familyId: nano }))
      .toBe(generationProviderChoices(choices, nano, 'image', {}).find(choice => choice.provider === 'wavespeed')?.value)
    expect(generationModelIdForChange(choices, 'image', { model: wavespeedEdit, refs: { image: ['image-1'] } }, { familyId: nano }))
      .toBe(generationProviderChoices(choices, nano, 'image', { refs: { image: ['image-1'] } }).find(choice => choice.provider === 'wavespeed')?.value)
    expect(generationModelIdForChange(choices, 'image', { model: 'kie:nano-banana-2-1' }, { familyId: sunburst }, { [sunburst]: 'wavespeed' }))
      .toBe(wavespeedText)

    const draft = { ...seedWorkspaceActionDraft(image, withModels), model: wavespeedText }
    const html = renderActionSheet(image, { draft, context: withModels })
    const model = selectMarkup(html, 'Generation model')
    const provider = selectMarkup(html, 'Generation provider')
    expect(model).toMatch(/value="image:gpt-image-2-6-sunburst"[^>]*>#\d+ · GPT Image 2.6 Sunburst · Elo \d+/)
    expect(model).not.toMatch(/WaveSpeed|MachGen|Nunchux|>Fal</)
    expect(provider).toContain(`value="${wavespeedText}"`)
    expect(provider).toContain('>WaveSpeed')
    expect(provider).not.toContain('GPT Image 2.6 Sunburst')
    expect(html).toContain('>Choose model</option>')
    expect(html).not.toContain('Provider and model')
    expect(html).not.toContain('Advanced provider and model')
    const empty = renderActionSheet(image, { draft: seedWorkspaceActionDraft(image, withModels), context: withModels })
    expect(empty).toContain('>Choose model</option>')
    expect(empty).toContain('>Choose provider</option>')

    const edit = renderActionSheet(image, { draft: { ...draft, refs: { image: ['image-1'] } }, context: withModels })
    const editProvider = selectMarkup(edit, 'Generation provider')
    expect(editProvider).not.toContain(`value="${wavespeedText}"`)
    expect(editProvider).toContain(`<option value="${wavespeedEdit}">WaveSpeed</option>`)
    expect(editProvider.match(/>WaveSpeed</g)).toHaveLength(1)
    expect(editProvider).toContain('<option value="" selected="">Choose provider</option>')
    expect(editProvider).not.toMatch(/<select[^>]*disabled/)

    const unavailable = choices.map(choice => choice.value === wavespeedText ? { ...choice, available: false } : choice)
    const unavailableHtml = renderActionSheet(image, {
      draft,
      context: { ...context, choices: { ...context.choices, model: unavailable } },
    })
    expect(selectMarkup(unavailableHtml, 'Generation provider')).toContain(`value="${wavespeedText}" disabled="" selected="">WaveSpeed · not configured<`)

    const single = choices.map(choice => choice.family?.id).find((familyId, _index, familyIds) => {
      if (!familyId || familyIds.indexOf(familyId) !== _index) return false
      return generationProviderChoices(choices, familyId, 'image', {}).length === 1
    })
    expect(single).toBeTruthy()
    const only = generationProviderChoices(choices, single!, 'image', {})[0]!
    const singleHtml = renderActionSheet(image, {
      draft: { ...draft, model: only.value },
      context: withModels,
    })
    const singleProvider = selectMarkup(singleHtml, 'Generation provider')
    expect(singleProvider.startsWith('aria-label="Generation provider" disabled=""')).toBe(true)
    expect(singleProvider).toContain(`value="${only.value}" selected=""`)
    expect(singleProvider).not.toContain(choices.find(choice => choice.value === only.value)?.family?.title ?? 'missing-family')

    const optional = renderToStaticMarkup(createElement(WorkspaceGenerationModelField, {
      media: 'image', values: {}, value: '', choices, required: false, onChange: () => undefined,
    }))
    expect(optional).toContain('>Use default</option>')
    expect(optional).not.toContain('>Choose model</option>')

    const video = catalogAction('tool.generate_video')
    const videoLoaded = await loadWorkspaceActionResources(video, {}, async (name) => (
      name === 'list_generation_models' ? { models: listModels({ media: 'video' }).map(modelListing) } : {}
    ))
    const videoChoices = (videoLoaded.choices.model ?? []).map(choice => ({ ...choice, available: true }))
    const videoModel = videoChoices.find(choice => choice.family && choice.providerLabel)
    expect(videoModel?.family?.id.startsWith('video:')).toBe(true)
    const videoHtml = renderActionSheet(video, {
      draft: { ...seedWorkspaceActionDraft(video, context), model: videoModel!.value },
      context: { ...context, choices: { ...context.choices, model: videoChoices } },
    })
    expect(selectMarkup(videoHtml, 'Generation model')).toContain(`value="${videoModel!.family!.id}"`)
    expect(selectMarkup(videoHtml, 'Generation provider')).toContain(videoModel!.providerLabel!)
    expect(selectMarkup(videoHtml, 'Generation provider')).not.toContain(videoModel!.family!.title)
    expect(videoHtml).not.toContain('Provider and model')
  })

  it('keeps a generation variant switch on separate model and provider selects', () => {
    const base = catalogAction('tool.generate_image')
    const properties = { ...base.inputSchema.properties }
    delete properties.model
    const variant = (id: string, title: string, provider: string): WorkspaceAction => ({
      ...base,
      id,
      title,
      inputSchema: { ...base.inputSchema, properties },
      generation: { provider, operation: 'generate_image', mediaType: 'image' },
    })
    const fal = variant('gen.fal', 'GPT Image 2.6 Sunburst', 'fal')
    const wavespeed = variant('gen.wavespeed', 'GPT Image 2.6 Sunburst', 'wavespeed')
    const kie = variant('gen.kie', 'Nano Banana 2.1', 'kie')
    const html = renderActionSheet(fal, { variants: [fal, wavespeed, kie] })
    const model = html.slice(html.indexOf('aria-label="Generation model"'), html.indexOf('</select>', html.indexOf('aria-label="Generation model"')))
    const provider = html.slice(html.indexOf('aria-label="Generation provider"'), html.indexOf('</select>', html.indexOf('aria-label="Generation provider"')))
    expect(model).toContain('>GPT Image 2.6 Sunburst</option>')
    expect(model).toContain('>Nano Banana 2.1</option>')
    expect(model).not.toContain('fal ·')
    expect(provider).toContain('>fal</option>')
    expect(provider).toContain('>wavespeed</option>')
    expect(provider).not.toContain('Nano Banana')
    expect(html).not.toContain('Provider and model')
  })
})

describe('workspace action drafts', () => {
  it('seeds the chosen media and drops values the action does not take', () => {
    const crop = catalogAction('tool.crop_asset')
    const draft = seedWorkspaceActionDraft(crop, context, { asset_id: 'image-1', ratio: '9:16', unrelated: 'dropped' })
    expect(draft).toMatchObject({ book_id: 'book-1', asset_id: 'image-1', ratio: '9:16' })
    expect(draft).not.toHaveProperty('unrelated')
  })

  it('fits a crop ratio to the media and follows the target object hash', () => {
    const crop = catalogAction('tool.crop_asset')
    const draft = seedWorkspaceActionDraft(crop, context, { asset_id: 'image-1' })
    expect(patchWorkspaceActionDraft(crop, context, draft, 'ratio', '1:1'))
      .toMatchObject({ ratio: '1:1', x: 0.21875, y: 0, w: 0.5625, h: 1 })
    const subjects = catalogAction('tool.analyze_image_subjects')
    const subjectDraft = seedWorkspaceActionDraft(subjects, context)
    expect(patchWorkspaceActionDraft(subjects, context, subjectDraft, 'artifact_id', 'image-1'))
      .toMatchObject({ artifact_id: 'image-1', object_hash: 'hash-image-1' })
  })

  it('forces adaptive Seedance edits and keeps generation variants to one operation', () => {
    const video = catalogAction('tool.generate_video')
    const values = effectiveWorkspaceActionValues(video, { model: 'kie:bytedance/seedance-2-5', mode: 'v2v', options: { duration: 5, seed: 7 } })
    expect(values.options).toEqual({ duration: -1, aspect_ratio: 'adaptive', seed: 7 })
    expect(workspaceActionVariants(catalog.actions, video).map((entry) => entry.id)).toEqual(['tool.generate_video'])
    expect(workspaceActionVariants(catalog.actions, catalogAction('tool.crop_asset'))).toEqual([])
    const seeded = seedWorkspaceActionDraft(video, context, { _provider: 'elsewhere', prompt: 'A slow pan' })
    expect(seeded.prompt).toBe('A slow pan')
    expect(seeded).not.toHaveProperty('_provider')
  })
})

describe('timeline clip sheet', () => {
  it('docks the clip chooser as a review and blocks Apply until a clip is chosen', () => {
    const html = renderClipSheet(null, { applyFormId: 'command-composer-form' })
    expect(html).toContain('confirm-sheet confirm-sheet-timeline-clip')
    expect(html).toContain('aria-label="Add a timeline clip"')
    expect(html).not.toContain('<dialog')
    expect(html).toContain('>Add a clip to Audio 1</h2>')
    expect(html).toContain('Choose a clip to add.')
    expect(html).toContain('form="command-composer-form"')
    expect(html).toContain('class="confirm-sheet-apply" disabled="">')
    expect(html).toContain('Load more media')
  })

  it('names the chosen clip and applies through its own form outside the composer', () => {
    const html = renderClipSheet('video-2')
    expect(html).toContain('class="confirm-sheet-address">landscape.mp4')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('form="timeline-clip-form"')
    expect(html).toContain('class="confirm-sheet-apply">Add clip <kbd>↵</kbd>')
    const failed = renderClipSheet('video-2', { error: 'The timeline changed. Try again.' })
    expect(failed).toContain('The timeline changed. Try again.')
    expect(failed).toContain('class="confirm-sheet-apply">Add clip <kbd>↵</kbd>')
  })
})

it('reviews a selected graphics batch and lists each video result', () => {
  const action = catalogAction('tool.video_graphics.apply_template')
  expect(action.surfaces).toEqual(['launcher', 'cell-menu'])
  const draft = seedWorkspaceActionDraft(action, { ...context, assetIds: ['video-1', 'video-2'] })
  expect(draft).toMatchObject({ asset_ids: ['video-1', 'video-2'], op: 'apply_template', render: true, request_id: expect.any(String) })
  expect(workspaceActionFields(action).map(([name]) => name)).toEqual(['asset_ids', 'template_id', 'render'])
  const changed = patchWorkspaceActionDraft(action, context, draft, 'template_id', 'tiktok-title')
  expect(changed.request_id).not.toBe(draft.request_id)
  const markup = renderActionSheet(action, {
    draft, review: workspaceActionReview(action, 'destructive'),
    result: { message: 'Batch processed', value: { results: [
      { asset_id: 'video-1', label: 'First clip', status: 'rendering', render: { status: 'queued', error: null } },
      { asset_id: 'video-2', label: 'Second clip', status: 'error', error: { message: 'Video is busy' } },
    ] } },
  })
  expect(markup).toContain('keeps typed text by slot and preserves framing')
  expect(markup).toContain('First clip')
  expect(markup).toContain('Render queued')
  expect(markup).toContain('Video is busy')
})
