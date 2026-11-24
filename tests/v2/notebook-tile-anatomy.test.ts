import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import type { PostView } from '../../server/src/posts/post-contract'
import { CellNode } from '../../src/components/videobook/NotebookCanvasNodes'
import {
  CellActionsContext,
  GenerationCatalogContext,
  MediaSlotContext,
  type GenerationCatalogEntry,
  type MediaSlotState,
} from '../../src/components/videobook/notebook-canvas-context'
import type { CanvasCellData, CanvasNode } from '../../src/videobook/notebook-canvas'
import type { AssetRecord } from '../../src/videobook/workspace-responses'

function asset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: 'asset-d3',
    artifactId: 'artifact-d3',
    label: 'pool',
    objectHash: null,
    type: 'video',
    createdAt: '2026-11-20T12:00:00.000Z',
    mediaUrl: '/media/d3.mp4',
    thumbnailUrl: '/media/d3.jpg',
    status: 'ready',
    origin: null,
    prompt: null,
    width: 720,
    height: 1280,
    duration: 15,
    fps: 24,
    waveform: null,
    audioInfo: null,
    analysisInfo: null,
    transcript: null,
    visionAnalysis: null,
    tags: null,
    ...overrides,
  }
}

function video(overrides: Partial<CanvasCellData> = {}): CanvasCellData {
  return {
    kind: 'video',
    subtitle: 'VIDEO · CELL',
    slot: { row: 3, column: 2 },
    status: 'completed',
    outputArtifactId: 'artifact-d3',
    asset: asset(),
    videoAspectRatio: '9:16',
    videoDurationSeconds: 15,
    ...overrides,
  }
}

function generation(overrides: Partial<CanvasCellData> = {}): CanvasCellData {
  return {
    kind: 'generate_video',
    subtitle: 'GEN VIDEO · CELL',
    slot: { row: 1, column: 1 },
    status: 'completed',
    provider: 'kie',
    model: 'kie:wan/3-0-video-prime',
    prompt: 'Slow dolly across the pool. Start on @image1.',
    inputs: {
      generationMode: 'i2v',
      generationSettings: { duration: '10', aspect_ratio: '9:16' },
    },
    ...overrides,
  }
}

function postView(runtime: Partial<PostView['runtime']> = {}, sourced = true): PostView {
  return {
    id: 'post-d6',
    notebookId: 'notebook-1',
    address: '@d6',
    label: 'Post · x',
    definition: {
      version: 1,
      platform: 'x',
      account: '',
      caption: 'Sunday at the pool, one take. Which frame wins?',
      credits: '',
      notes: '',
      createdAt: '2026-11-20T09:00:00.000Z',
      source: sourced
        ? { cellId: 'video-d3', artifactId: 'artifact-d3', revision: 'r1', objectHash: 'h1', filename: 'pool.mp4', snapshotArtifactId: 'artifact-d3' }
        : null,
      lineage: [],
    },
    runtime: { status: 'draft', metrics: [], ...runtime },
  }
}

function post(postRecord: PostView, overrides: Partial<CanvasCellData> = {}): CanvasCellData {
  return {
    kind: 'post',
    subtitle: 'POST · CELL',
    slot: { row: 3, column: 5 },
    status: postRecord.runtime.status,
    post: postRecord,
    postSource: postRecord.definition.source ? { address: '@d3', asset: asset() } : undefined,
    incomingRoutes: postRecord.definition.source ? [{ address: '@d3', tokens: [], type: 'video' }] : [],
    ...overrides,
  }
}

type TileContext = {
  ready?: boolean
  slotStates?: Record<string, MediaSlotState>
}

const idle = async () => undefined

function renderTile(
  data: CanvasCellData,
  catalog: ReadonlyMap<string, GenerationCatalogEntry> = new Map(),
  context: TileContext = {},
): string {
  const props: NodeProps<CanvasNode> = {
    id: `cell-${data.kind}`,
    data,
    type: 'cell',
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    selected: false,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  }
  const actions = {
    ready: context.ready ?? false,
    deleteCell: idle,
    repairCell: idle,
    retryCell: idle,
    retryDownload: idle,
    setPostSource: idle,
    retryPost: idle,
  }
  const slots = {
    ready: true,
    states: context.slotStates ?? {},
    onFile: () => undefined,
    onFileError: () => undefined,
    onOpenLibrary: () => undefined,
  }
  return renderToStaticMarkup(createElement(
    ReactFlowProvider,
    null,
    createElement(CellActionsContext.Provider, { value: actions },
      createElement(MediaSlotContext.Provider, { value: slots },
        createElement(GenerationCatalogContext.Provider, { value: catalog }, createElement(CellNode, props)))),
  ))
}

function footerOf(html: string): string {
  return html.slice(html.indexOf('<footer'), html.indexOf('</footer>'))
}

describe('the tile footer', () => {
  it('drops the grip and makes the address the reference handle', () => {
    const html = renderTile(video())

    expect(html).not.toContain('cell-ref-grip')
    expect(footerOf(html)).toContain(
      '<strong class="cell-ref-address cell-ref-address-draggable nodrag nopan" draggable="true" title="Drag into an input slot">@d3</strong>',
    )
  })

  it('keeps an address with nothing to hand over as plain text', () => {
    const html = renderTile(video({ outputArtifactId: undefined, asset: undefined, status: 'ready' }))

    expect(footerOf(html)).toContain('<strong class="cell-ref-address">@d3</strong>')
    expect(html).toContain('cell-media-slot')
  })

  it('reads address, shape and length, then the menu, on a ready video with no flag', () => {
    const footer = footerOf(renderTile(video()))

    expect(footer).toContain('<time class="cell-node-footer-meter" dateTime="PT15S" title="Duration">0:15</time>')
    expect(footer).toContain('<span class="cell-media-badge" title="Aspect ratio">9:16</span>')
    expect(footer).not.toContain('cell-state-flag')
    expect(footer).not.toContain('cell-status')
  })

  it('lets a flag take the place of the facts while a picture is being edited', () => {
    const html = renderTile(video({ status: 'trimming' }))
    const footer = footerOf(html)

    expect(footer).toContain('<span class="cell-state-flag" data-tone="working" title="Trimming"><span>Trimming</span></span>')
    expect(footer).not.toContain('cell-node-footer-meta')
    expect(html).toContain('cell-state-overlay-over-picture')
  })

  it('swaps the kind icon for what the clock is doing', () => {
    expect(renderTile(video({ status: 'queued' }))).toContain('lucide-hourglass')
    expect(renderTile(video({ status: 'downloading' }))).toContain('lucide-download')
    expect(renderTile(video({ status: 'trimming' }))).toContain('lucide-scissors')
    expect(renderTile(video({ status: 'generating', outputArtifactId: undefined, asset: undefined, targetConnectionCount: 1 })))
      .toContain('lucide-video')
  })

  it('names the file while it uploads into an empty slot', () => {
    const html = renderTile(
      video({ outputArtifactId: undefined, asset: undefined, status: 'ready' }),
      new Map(),
      { slotStates: { 'cell-video': { operation: 'upload', error: null, fileName: 'IMG_4412.HEIC' } } },
    )

    expect(html).toContain('<span class="cell-media-slot-file">IMG_4412.HEIC</span>')
    expect(footerOf(html)).toContain('title="Uploading"')
  })

  it('counts versions in the footer of a media tile', () => {
    const footer = footerOf(renderTile(video({
      inputs: { outputVersionArtifactIds: ['artifact-d3-a', 'artifact-d3'] },
    })))

    expect(footer).toContain('aria-label="Current output version 2 of 2"')
  })

  it('names a take\'s model by its catalog title in the source chip and keeps the id in the tooltip', () => {
    const html = renderTile(video({
      inputs: { mediaRole: 'generate-video-output' },
      provider: 'fal',
      model: 'fal:blackforestlabs/flux-3/text-to-video',
      incomingRoutes: [{ address: '@b2', tokens: [], type: 'generate_video' }],
    }), new Map([
      ['fal:blackforestlabs/flux-3/text-to-video', { title: 'FLUX.3 Text to Video', promptRequired: true }],
    ]))

    expect(html).toContain('class="cell-route-generator" title="Fal · blackforestlabs/flux-3/text-to-video"')
    expect(html).toContain('<span class="cell-generator-model">FLUX.3 T2V</span>')
  })

  it('gives image and video tiles no header row', () => {
    const html = renderTile(video())

    expect(html).toContain('cell-node-bare')
    expect(html).not.toContain('class="cell-node-header')
  })
})

describe('the gen tile', () => {
  it('names the kind in its header and moves length and shape into the footer', () => {
    const html = renderTile(generation())

    expect(html).toContain('<span class="cell-node-type-label" aria-hidden="true">GEN VIDEO</span>')
    expect(html).not.toContain('class="cell-aspect-ratio"')
    expect(footerOf(html)).toContain(
      '<span class="cell-media-badge" title="Duration">10s</span><span class="cell-media-badge" title="Aspect ratio">9:16</span>',
    )
  })

  it('puts the provider before the model and marks the input slots in the prompt', () => {
    const html = renderTile(generation())

    expect(html).toContain(
      '<span class="cell-generation-model"><span class="cell-generator-provider">Kie</span><span class="cell-model-line" title="wan/3-0-video-prime · I2V">wan/3-0-video-prime · I2V</span></span>',
    )
    expect(html).toContain('<span class="cell-prompt-token" data-family="image">@image1</span>')
  })

  it('prefers the catalog title for the model line', () => {
    const html = renderTile(generation(), new Map([
      ['kie:wan/3-0-video-prime', { title: 'Wan 3.0 Prime Image to Video', promptRequired: true }],
    ]))

    expect(html).toContain('<span class="cell-model-line" title="Wan 3.0 Prime I2V">Wan 3.0 Prime I2V</span>')
  })

  it('keeps its prompt readable and docks a band while its takes run', () => {
    const html = renderTile(generation({
      runningTakes: { count: 2, startedAt: '2026-11-24T10:00:00.000Z' },
    }))

    expect(html).toContain('class="cell-state-dock cell-state-dock-clock"')
    expect(html).toContain('<span class="cell-state-dock-label">2 takes running</span>')
    expect(html).toContain('Slow dolly across the pool.')
    expect(footerOf(html)).toContain('title="Running"')
    expect(html).not.toContain('cell-state-overlay')
  })

  it('flags a missing prompt only when the model needs one', () => {
    const needs = renderTile(generation({ prompt: undefined }), new Map([
      ['kie:wan/3-0-video-prime', { title: 'Wan 3.0 Prime', promptRequired: true }],
    ]))
    const optional = renderTile(generation({ prompt: undefined }), new Map([
      ['kie:wan/3-0-video-prime', { title: 'Wan 3.0 Prime', promptRequired: false }],
    ]))

    expect(footerOf(needs)).toContain('<span class="cell-state-flag" data-tone="attention" title="No prompt"><span>No prompt</span></span>')
    expect(needs).toContain('cell-node-attention')
    expect(optional).not.toContain('cell-node-attention')
    expect(needs).toContain('Add a prompt. Name inputs like @image1.')
    expect(footerOf(optional)).not.toContain('cell-state-flag')
    expect(optional).toContain('Prompt optional')
  })

  it('asks for a generation action when no model is chosen', () => {
    const html = renderTile(generation({ provider: undefined, model: undefined, prompt: undefined, inputs: {} }))

    expect(html).toContain('<strong>Choose a generation action</strong>')
    expect(footerOf(html)).not.toContain('cell-state-flag')
  })
})

describe('the post tile', () => {
  it('sets the clip beside the caption and names the platform in the footer', () => {
    const html = renderTile(post(postView()))

    expect(html).toContain('cell-node-bare')
    expect(html).not.toContain('class="cell-node-header')
    expect(html).toContain('<div class="post-tile"><div class="post-tile-media">')
    expect(html).toContain('<img src="/media/d3.jpg" alt="" draggable="false"/>')
    expect(html).toContain('Sunday at the pool, one take. Which frame wins?')
    expect(html).not.toContain('from @d3')
    expect(html).toContain('<span class="cell-route-address">d3</span>')
    expect(footerOf(html)).toContain('<span class="cell-media-badge" title="Platform">X</span>')
    expect(footerOf(html)).not.toContain('cell-state-flag')
  })

  it('turns the next step amber and flags the tile once the clip is on the phone', () => {
    const html = renderTile(post(postView({ icloud: { folder: 'pool', completedAt: '2026-11-21T08:00:00.000Z' } })))

    expect(html).toContain('post-tile-hint post-tile-next post-tile-hint-attention')
    expect(html).toContain('cell-node-attention')
    expect(html).toContain('<span class="post-badge">')
    expect(footerOf(html)).toContain('title="Needs link"')
  })

  it('shows the latest numbers on a posted tile', () => {
    const html = renderTile(post(postView({
      status: 'posted',
      url: 'https://x.com/a/status/1',
      postedAt: '2026-11-22T10:00:00.000Z',
      metrics: [{ observedAt: '2026-11-23T10:00:00.000Z', source: 'manual', values: { views: 12400, likes: 318 } }],
    })))

    expect(html).toContain('class="post-tile-stats"')
    expect(html).toContain(' views</span>')
    expect(footerOf(html)).toContain('data-tone="done"')
  })

  it('shows the platform error on a failed post', () => {
    const html = renderTile(post(postView({ status: 'failed', error: 'X turned it down: the video runs over 2:20.' })))

    expect(html).toContain('<span class="post-tile-error">X turned it down: the video runs over 2:20.</span>')
    expect(html).toContain('cell-node-error')
    expect(footerOf(html)).toContain('data-tone="failed"')
  })

  it('offers Retry on a failed X post once the canvas is ready', () => {
    const failed = postView({ status: 'failed', error: 'X turned it down.' })
    const tiktok: PostView = { ...failed, definition: { ...failed.definition, platform: 'tiktok' } }

    expect(renderTile(post(failed), new Map(), { ready: true })).toContain('class="post-tile-retry nodrag"')
    expect(renderTile(post(failed))).not.toContain('post-tile-retry')
    expect(renderTile(post(tiktok), new Map(), { ready: true })).not.toContain('post-tile-retry')
  })

  it('offers an empty clip slot to a post without a source', () => {
    const html = renderTile(post(postView({}, false)))

    expect(html).toContain('class="post-tile-media post-tile-slot"')
    expect(html).toContain('Choose a clip to post')
  })
})
