import { describe, expect, it } from 'vitest'
import type { NotebookDocument } from 'videobook-engine'
import {
  generationInputPort,
  generationInputTarget,
  generationInputTokenPattern,
  generationModeInputTarget,
  nextGenerationInputPort,
  sequentialGenerationInputPorts,
  sortByGenerationInputPort,
} from '../../server/src/generation-input-targets.js'
import {
  generationInputMentions,
  remapGenerationInputPrompt,
  scanGenerationInputTokens,
} from '../../server/src/generation-input-mentions.js'
import { notebookConnectionTargetInput } from '../../src/videobook/notebook-draft'
import {
  LEGACY_SLOT_TOKEN_SOURCE,
  legacyGenerationInputMentions,
  legacyGenerationInputTarget,
  legacyGenerationModeInputTarget,
  legacyNextGenerationTargetInput,
  legacyNotebookConnectionTargetInput,
  legacyPinTargetInput,
  legacyRemapGenerationInputPrompt,
  legacyScanGenerationInputTokens,
  legacySortByKindSlot,
  legacyUniqueConnectionTargets,
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
        expect(sortByGenerationInputPort(entries, kind)).toEqual(legacySortByKindSlot(entries, kind))
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

  it('numbers new and sequential ports the same way', () => {
    const bases = ['image', 'keyframe', 'video', 'audio', 'replace_audio', 'first_frame']
    for (const layout of ALL_LAYOUTS) {
      const used = new Set(layout.map((entry) => entry.name))
      for (const base of bases) {
        expect(nextGenerationInputPort(base, used)).toBe(legacyNextGenerationTargetInput(base, used))
      }
      const targets = layout.map((entry) => ({ target: legacyGenerationInputTarget(entry.kind, entry.name) }))
      expect(sequentialGenerationInputPorts(targets.map((input) => input.target))).toEqual(legacyUniqueConnectionTargets(targets))
    }
    for (const field of ['refs.image', 'refs.keyframe', 'refs.first_frame', 'replace_audio_with', 'video']) {
      for (const index of [null, -1, 0, 1, 2, 9]) {
        const role = field.split('.').pop() ?? field
        const base = role === 'replace_audio_with' ? 'replace_audio' : role
        expect(generationInputPort(base, (index ?? 0) + 1)).toBe(legacyPinTargetInput({ field, index }))
      }
    }
  })

  it('matches prompt tokens with the same groups as the legacy dialect pattern', () => {
    const prompts = [
      '@image1 @Image12 @video2 @audio3 @keyframe4 @firstframe @LastFrame @loop',
      '@image @image1x @image1-2 email@image1 @loops @keyframe @image01',
      'a @firstframe, then @keyframe2. End on @lastframe! @audio9?',
    ]
    for (const prompt of prompts) {
      const current = [...prompt.matchAll(generationInputTokenPattern())].map((match) => [match.index, match[0], match[1], match[2], match[3]])
      const legacy = [...prompt.matchAll(new RegExp(LEGACY_SLOT_TOKEN_SOURCE, 'giu'))].map((match) => [match.index, match[0], match[1], match[2], match[3]])
      expect(current).toEqual(legacy)
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
