import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { scopedEngine } from '../../server/src/engine.js'
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
} = {}): string {
  return renderToStaticMarkup(createElement(WorkspaceActionSheet, {
    action,
    variants: workspaceActionVariants(catalog.actions, action),
    context,
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
      .toEqual({ cost: 'Cost estimate unavailable', message: `Running this sends your prompt and selected media to a generation provider and may incur charges. ${source}` })
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
