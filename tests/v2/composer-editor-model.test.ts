import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { history, redo, undo } from 'prosemirror-history'
import {
  composerDocument,
  composerDocumentPosition,
  composerDocumentText,
  composerSchema,
  composerTextSelection,
  replaceComposerDocument,
  selectComposerText,
} from '../../src/videobook/composer-editor-model'
import {
  activeComposerMention,
  composerReferences,
  composerReferenceSuggestions,
  replaceComposerMention,
} from '../../src/videobook/composer-references'

describe('the composer document at command and history boundaries', () => {
  it('round trips exact text and grid tokens without presentation metadata', () => {
    const text = '/combine @a1, (@BL8) and @b2; @a12 and @bm1 stay text'
    const doc = composerDocument(text)
    doc.check()
    expect(composerDocumentText(doc)).toBe(text)
    expect(doc.toJSON().content.filter((node: { type: string }) => node.type === 'reference'))
      .toEqual(['@a1', '@BL8', '@b2'].map(token => ({ type: 'reference', attrs: { token } })))
    expect(composerDocument(text, false).childCount).toBe(1)
  })

  it('maps text selection around atomic references and deletes the whole selected reference', () => {
    const doc = composerDocument('Use @bl8, then @a1.')
    const state = EditorState.create({ schema: composerSchema, doc })
    const tr = selectComposerText(state.tr, { start: 5, end: 7 })
    expect(composerTextSelection(tr.doc, tr.selection.anchor, tr.selection.head)).toMatchObject({ start: 4, end: 8 })
    expect(composerDocumentText(tr.deleteSelection().doc)).toBe('Use , then @a1.')
    expect(composerDocumentPosition(doc, 6, -1)).toBe(4)
    expect(composerDocumentPosition(doc, 6, 1)).toBe(5)
  })

  it('keeps a reference insertion and its chip conversion in one undoable edit', () => {
    const doc = composerDocument('Use ')
    let state = EditorState.create({ schema: composerSchema, doc, selection: TextSelection.create(doc, 4), plugins: [history()] })
    const dispatch = (tr: Transaction) => { state = state.apply(tr) }
    const tr = state.tr.insertText('@a1')
    replaceComposerDocument(tr, composerDocumentText(tr.doc), composerTextSelection(tr.doc, tr.selection.anchor, tr.selection.head))
    dispatch(tr)
    expect(state.doc.lastChild?.type.name).toBe('reference')
    expect(undo(state, dispatch)).toBe(true)
    expect(composerDocumentText(state.doc)).toBe('Use ')
    expect(redo(state, dispatch)).toBe(true)
    expect(composerDocumentText(state.doc)).toBe('Use @a1')
    expect(state.doc.lastChild?.type.name).toBe('reference')
  })

  it('returns a completed chip to text when further typing invalidates its token', () => {
    const state = EditorState.create({ schema: composerSchema, doc: composerDocument('@a1') })
    const tr = state.tr.insertText('2', 1)
    replaceComposerDocument(tr, '@a12', { start: 4, end: 4 })
    expect(tr.doc.childCount).toBe(1)
    expect(tr.doc.firstChild?.isText).toBe(true)
    expect(composerDocumentText(tr.doc)).toBe('@a12')
  })
})

describe('chat reference presentation and caret completion', () => {
  const asset = {
    id: 'asset', artifactId: 'asset', type: 'image', label: 'Shared label', mediaUrl: '/files/book/image.png',
    thumbnailUrl: null, width: 24, height: 24, duration: null, status: 'ready',
  }
  const references = composerReferences([
    { id: 'first', slot: { row: 0, column: 0 }, type: 'image', outputArtifactId: asset.artifactId },
    { id: 'second', slot: { row: 0, column: 1 }, type: 'image', outputArtifactId: asset.artifactId },
    { id: 'missing', slot: { row: 0, column: 2 }, type: 'video', outputArtifactId: 'missing' },
    { id: 'text', slot: { row: 63, column: 7 }, type: 'prompt', label: 'Shared label' },
  ], [asset])

  it('preserves the full grid and distinct cells sharing an artifact or label', () => {
    expect(references.size).toBe(512)
    expect(references.get('@a1')).toMatchObject({ cellId: 'first', label: 'Shared label', asset })
    expect(references.get('@a2')).toMatchObject({ cellId: 'second', label: 'Shared label', asset })
    expect(references.get('@a3')).toMatchObject({ status: 'missing', asset: null })
    expect(references.get('@bl8')).toMatchObject({ type: 'prompt', label: 'Shared label', asset: null })
    expect(references.get('@bl7')).toMatchObject({ type: 'empty', status: 'empty', asset: null })
  })

  it('completes the mention at the caret and preserves the suffix and punctuation', () => {
    expect(activeComposerMention('Use @a2, then @b1.', 6)).toEqual({ start: 4, end: 7, prefix: 'a' })
    expect(replaceComposerMention('Use @a2, then @b1.', '@bl8', 6))
      .toEqual({ value: 'Use @bl8, then @b1.', caret: 8 })
    expect(replaceComposerMention('Use @a2 then @b1.', '@bl8', 6))
      .toEqual({ value: 'Use @bl8 then @b1.', caret: 9 })
    expect(replaceComposerMention('Use @', '@a1')).toEqual({ value: 'Use @a1 ', caret: 8 })
    expect(activeComposerMention('Use @a', 4, 6)).toBeNull()
  })

  it('keeps image-edit candidates compatible while retaining their own cell addresses', () => {
    expect(composerReferenceSuggestions(references, 'Use @', 5, 5, new Set(['asset'])).map(reference => reference.token))
      .toEqual(['@a1', '@a2'])
    expect(composerReferenceSuggestions(references, 'Use @', 5, 5, new Set())).toEqual([])
    expect(composerReferenceSuggestions(references, '@bl8')[0]?.token).toBe('@bl8')
    expect(composerReferenceSuggestions(references, '@Sharedlabel')).toEqual([])
  })
})
