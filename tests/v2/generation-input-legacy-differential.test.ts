import { describe, expect, it } from 'vitest'
import type { NotebookDocument } from 'videobook-engine'
import { generationInputTarget, generationModeInputTarget } from '../../server/src/generation-input-policy.js'
import {
  generationInputMentions,
  remapGenerationInputPrompt,
  scanGenerationInputTokens,
  sortByKindSlot,
} from '../../server/src/generation-input-mentions.js'
import { notebookConnectionTargetInput } from '../../src/videobook/notebook-draft'
import {
  legacyGenerationInputMentions,
  legacyGenerationInputTarget,
  legacyGenerationModeInputTarget,
  legacyNotebookConnectionTargetInput,
  legacyRemapGenerationInputPrompt,
  legacyScanGenerationInputTokens,
  legacySortByKindSlot,
  type LegacyInputKind,
} from './fixtures/legacy-generation-inputs'

type VocabularyEntry = { name: string; kind: LegacyInputKind }

const VOCABULARY: readonly VocabularyEntry[] = [
  { name: 'image', kind: 'image' },
  { name: 'image_2', kind: 'image' },
  { name: 'image_3', kind: 'image' },
  { name: 'image_0', kind: 'image' },
  { name: 'image_10', kind: 'image' },
  { name: 'first_frame', kind: 'image' },
  { name: 'first_frame_2', kind: 'image' },
  { name: 'last_frame', kind: 'image' },
  { name: 'loop', kind: 'image' },
  { name: 'keyframe', kind: 'image' },
  { name: 'keyframe_2', kind: 'image' },
  { name: 'keyframe_3', kind: 'image' },
  { name: 'media', kind: 'image' },
  { name: 'video', kind: 'video' },
  { name: 'video_2', kind: 'video' },
  { name: 'first_frame', kind: 'video' },
  { name: 'audio', kind: 'audio' },
  { name: 'audio_2', kind: 'audio' },
  { name: 'replace_audio', kind: 'audio' },
  { name: 'scene_audio', kind: 'audio' },
  { name: 'loop', kind: 'audio' },
]

const MODES: readonly (string | undefined)[] = [undefined, 'default', 'i2v', 'r2v', 'loop', 'v2v']
const SORT_KINDS = ['image', 'video', 'audio', 'keyframe', 'first_frame']
const HANDLES: readonly (string | null)[] = [null, 'input', 'image', 'image_2', 'first_frame', 'last_frame', 'loop', 'keyframe', 'keyframe_3', 'video', 'audio', 'replace_audio', 'scene_audio']
const SOURCE_TYPES = ['image', 'generate_image', 'video', 'split_video', 'audio', 'extract_audio', 'prompt']
const TARGET_ID = '01900000-0000-7000-8000-00000000f000'

function combinations(size: number, start = 0): VocabularyEntry[][] {
  if (size === 0) return [[]]
  const out: VocabularyEntry[][] = []
  for (let index = start; index < VOCABULARY.length; index += 1) {
    for (const rest of combinations(size - 1, index + 1)) out.push([VOCABULARY[index]!, ...rest])
  }
  return out
}

function layouts(): VocabularyEntry[][] {
  const unique = [1, 2, 3].flatMap((size) => combinations(size))
    .filter((layout) => new Set(layout.map((entry) => entry.name)).size === layout.length)
  return [[], ...unique, ...unique.filter((layout) => layout.length > 1).map((layout) => [...layout].reverse())]
}

function documentFor(layout: readonly VocabularyEntry[], mode?: string): NotebookDocument {
  const sources = layout.map((entry, index) => ({
    id: `01900000-0000-7000-8000-0000000${String(index).padStart(5, '0')}`,
    type: entry.kind,
    slot: { row: 0, column: index },
  }))
  return {
    id: '01900000-0000-7000-8000-00000000e000',
    name: 'differential',
    createdAt: '2026-01-01T00:00:00.000Z',
    cells: [
      { id: TARGET_ID, type: 'generate_video', slot: { row: 1, column: 0 }, ...(mode ? { inputs: { generationMode: mode } } : {}) },
      ...sources,
    ],
    edges: layout.map((entry, index) => ({
      id: `01900000-0000-7000-8000-0000001${String(index).padStart(5, '0')}`,
      source: sources[index]!.id,
      target: TARGET_ID,
      targetInput: entry.name,
    })),
  }
}

function promptFor(tokens: readonly string[]): string {
  return [...tokens.map((token) => `@${token}`), '@image9', '@IMAGE1', '@loop-ish', 'plain'].join(' and ')
}

const ALL_LAYOUTS = layouts()

describe('generation input naming matches the frozen legacy rules', () => {
  it('classifies every name and kind the same way', () => {
    for (const entry of VOCABULARY) {
      expect(generationInputTarget(entry.kind, entry.name)).toBe(legacyGenerationInputTarget(entry.kind, entry.name))
      for (const mode of MODES) {
        const target = legacyGenerationInputTarget(entry.kind, entry.name)
        expect(generationModeInputTarget(mode, entry.kind, target)).toBe(legacyGenerationModeInputTarget(mode, entry.kind, target))
      }
    }
  })

  it('orders every layout the same way for each kind', () => {
    for (const layout of ALL_LAYOUTS) {
      const entries = layout.map((entry) => ({ targetInput: entry.name }))
      for (const kind of SORT_KINDS) {
        expect(sortByKindSlot(entries, kind)).toEqual(legacySortByKindSlot(entries, kind))
      }
    }
  })

  it('names the same prompt tokens for every layout and mode', () => {
    for (const layout of ALL_LAYOUTS) {
      for (const mode of MODES) {
        const configured = documentFor(layout, mode)
        const unconfigured = documentFor(layout)
        expect(generationInputMentions(TARGET_ID, configured.cells, configured.edges))
          .toEqual(legacyGenerationInputMentions(TARGET_ID, configured.cells, configured.edges))
        expect(generationInputMentions(TARGET_ID, unconfigured.cells, unconfigured.edges, mode))
          .toEqual(legacyGenerationInputMentions(TARGET_ID, unconfigured.cells, unconfigured.edges, mode))
      }
    }
  })

  it('remaps and scans prompts the same way between neighbouring layouts', () => {
    for (let index = 1; index < ALL_LAYOUTS.length; index += 1) {
      for (const mode of MODES) {
        const before = documentFor(ALL_LAYOUTS[index - 1]!)
        const after = documentFor(ALL_LAYOUTS[index]!)
        const previous = legacyGenerationInputMentions(TARGET_ID, before.cells, before.edges, mode)
        const next = legacyGenerationInputMentions(TARGET_ID, after.cells, after.edges, mode)
        const prompt = promptFor(previous.map((mention) => mention.token))
        expect(remapGenerationInputPrompt(prompt, previous, next))
          .toBe(legacyRemapGenerationInputPrompt(prompt, previous, next))
        expect(scanGenerationInputTokens(prompt)).toEqual(legacyScanGenerationInputTokens(prompt))
      }
    }
  })

  it('names canvas connections the same way', () => {
    for (const layout of ALL_LAYOUTS.filter((candidate) => candidate.length < 3)) {
      const document = documentFor(layout)
      for (const sourceType of SOURCE_TYPES) {
        const source = { id: '01900000-0000-7000-8000-00000000d000', type: sourceType, slot: { row: 2, column: 0 } }
        const withSource = { ...document, cells: [...document.cells, source] } as NotebookDocument
        for (const handle of HANDLES) {
          const connection = { source: source.id, target: TARGET_ID, targetHandle: handle }
          expect(notebookConnectionTargetInput(withSource, connection))
            .toBe(legacyNotebookConnectionTargetInput(withSource.cells, withSource.edges, connection))
        }
      }
    }
  })
})
