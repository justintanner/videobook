import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SegmentSource } from '../../server/src/auto-edit/plan'
import { buildAutoEditPlan, DEFAULT_AUTO_EDIT_SECTIONS, type AutoEditAnchors } from '../../server/src/auto-edit/style'
import { AutoEditBody, AutoEditSheet } from '@/components/videobook/auto-edit/AutoEditSheet'
import { buildAutoEditSegmentRanges } from '@/videobook/auto-edit-preview'
import type { AutoEditEditor, AutoEditState } from '@/videobook/useAutoEdit'

const SOURCE: SegmentSource = {
  artifactId: '0195a000-0000-7000-8000-000000000010',
  sourceHash: 'hash-fixed',
  fps: 30,
  frames: 300,
  width: 1080,
  height: 1920,
  hasAudio: true,
}

const FIXED_ANCHORS: AutoEditAnchors = {
  hook: { start: 1.5, end: 3.5 },
  moment: { start: 6.0, peak: 6.5, end: 7.2 },
  focus: {
    start: { x: 0.35, y: 0.4 },
    peak: { x: 0.65, y: 0.6 },
    end: { x: 0.5, y: 0.5 },
  },
  keep: { start: 0.5, end: 9.0 },
  cuts: [],
}

function makeEditor(overrides: Partial<AutoEditState> = {}): AutoEditEditor {
  const sections = overrides.sections ?? DEFAULT_AUTO_EDIT_SECTIONS
  const built = buildAutoEditPlan(SOURCE, overrides.anchors ?? FIXED_ANCHORS, sections)
  const state: AutoEditState = {
    target: {
      artifactId: SOURCE.artifactId,
      label: 'Clip',
      mediaUrl: '/files/book/clip/original.mp4',
      address: 'a1',
      notebookId: 'nb-1',
    },
    bookId: 'book-1',
    loading: false,
    rendering: false,
    error: null,
    source: {
      artifact_id: SOURCE.artifactId,
      label: 'Clip',
      source_hash: SOURCE.sourceHash,
      duration: 10,
      fps: SOURCE.fps,
      frames: SOURCE.frames,
      width: SOURCE.width,
      height: SOURCE.height,
      has_audio: true,
    },
    anchors: built.anchors,
    sections,
    plan: built.plan,
    cues: built.cues,
    changes: overrides.changes ?? built.changes,
    analysisAvailable: overrides.analysisAvailable ?? true,
    analysisPhase: overrides.analysisPhase ?? { step: 'idle' },
    focusAnchor: 'peak',
    playheadSeconds: 1.5,
    ...overrides,
  }
  return {
    state,
    open: () => undefined,
    close: () => undefined,
    setAnchors: () => undefined,
    setSection: () => undefined,
    setFocusAnchor: () => undefined,
    setFocusPoint: () => undefined,
    setPlayheadSeconds: () => undefined,
    requestAnalysisEstimate: async () => undefined,
    dismissAnalysisEstimate: () => undefined,
    confirmAnalysis: async () => undefined,
    render: async () => ({ ok: true, message: 'done' }),
  }
}

describe('AutoEditSheet server render', () => {
  it('renders segment strip blocks with names and proportional widths, switches, and key-missing reason', () => {
    const editor = makeEditor({ analysisAvailable: false })
    const html = renderToStaticMarkup(createElement(AutoEditBody, { editor }))
    const ranges = buildAutoEditSegmentRanges(editor.state.plan!)

    const blockMatches = [...html.matchAll(/<button[^>]*class="auto-edit-strip-block"[^>]*>([^<]+)<\/button>/g)]
    expect(blockMatches.map((m) => m[1])).toEqual(['Cold open', 'Body', 'Replay', 'Punch-in', 'Push-in', 'Crash', 'Body'])
    expect(blockMatches).toHaveLength(ranges.length)
    for (const [index, range] of ranges.entries()) {
      expect(blockMatches[index]![0]).toContain(`width:${range.widthPercent.toFixed(2)}%`)
    }

    for (const label of ['Cold open', 'Replays', 'Push-in', 'Crash', 'Sounds']) {
      expect(html).toContain(`role="switch" checked=""`)
      expect(html).toContain(`<span>${label}</span>`)
    }

    expect(html).toContain('disabled=""')
    expect(html).toContain('OPENAI_API_KEY')
    expect(html).toContain('Preview approximates looks and slow motion; the render is exact.')
  })

  it('omits switched-off blocks and shows normalizeAnchors changes as non-blocking notices', () => {
    const notice = 'Trimmed the cold-open hook to end before the moment peak.'
    const editor = makeEditor({
      sections: { ...DEFAULT_AUTO_EDIT_SECTIONS, coldOpen: false, crash: false },
      changes: [notice],
      analysisPhase: { step: 'ready', summary: 'Person leaps across sofa.', confidence: 'high' },
    })
    const html = renderToStaticMarkup(createElement(AutoEditSheet, {
      editor,
      applyFormId: 'composer-form',
      onClose: () => undefined,
    }))

    const blockMatches = [...html.matchAll(/<button[^>]*class="auto-edit-strip-block"[^>]*>([^<]+)<\/button>/g)]
    expect(blockMatches.map((m) => m[1])).toEqual(['Body', 'Replay', 'Punch-in', 'Push-in', 'Body'])

    expect(html).toContain(`role="status"`)
    expect(html).toContain(notice)
    expect(html).toContain('high confidence:')
    expect(html).toContain('Person leaps across sofa.')

    const renderPos = html.indexOf('Render <kbd>↵</kbd>')
    const cancelPos = html.indexOf('Cancel <kbd>Esc</kbd>')
    expect(renderPos).toBeGreaterThan(-1)
    expect(cancelPos).toBeGreaterThan(renderPos)
  })
})
