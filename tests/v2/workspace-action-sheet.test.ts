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
    onCancelReview: () => undefined,
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

  it('reviews a destructive action before Apply runs it', () => {
    const remove = catalogAction('tool.delete_entity')
    const reviewing = renderActionSheet(remove)
    expect(reviewing).toContain('class="confirm-sheet-apply">Review action <kbd>↵</kbd>')
    expect(reviewing).toContain('Changes or removes content')
    expect(reviewing).not.toContain('Cancel review')
    const confirming = renderActionSheet(remove, { review: { message: 'Delete entity changes or removes the selected content.' } })
    expect(confirming).toContain('class="confirm-sheet-apply">Confirm and run <kbd>↵</kbd>')
    expect(confirming).toContain('>Cancel review</button>')
    expect(confirming).toContain('Delete entity changes or removes the selected content.')
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
