import { Schema, type Node as EditorNode } from 'prosemirror-model'
import { TextSelection, type Transaction } from 'prosemirror-state'
import { isNotebookGridAddress, scanNotebookMentions } from 'videobook-engine/notebook-mentions'

export interface ComposerSelection {
  start: number
  end: number
  backward?: boolean
}

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'inline*' },
    text: { group: 'inline' },
    reference: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: true,
      attrs: { token: {} },
      leafText: node => String(node.attrs.token),
      toDOM: node => ['span', { 'data-reference': String(node.attrs.token), contenteditable: 'false' }, String(node.attrs.token)],
      parseDOM: [{ tag: 'span[data-reference]', getAttrs: element => {
        const token = element.getAttribute('data-reference') ?? ''
        return isNotebookGridAddress(token) ? { token } : false
      } }],
    },
  },
})

export function composerDocument(value: string, rich = true): EditorNode {
  const nodes: EditorNode[] = []
  let start = 0
  if (rich) for (const mention of scanNotebookMentions(value)) {
    if (mention.index > start) nodes.push(composerSchema.text(value.slice(start, mention.index)))
    nodes.push(composerSchema.nodes.reference!.create({ token: mention.raw }))
    start = mention.end
  }
  if (start < value.length) nodes.push(composerSchema.text(value.slice(start)))
  return composerSchema.nodes.doc!.create(null, nodes)
}

export function composerDocumentText(doc: EditorNode, from = 0, to = doc.content.size): string {
  return doc.textBetween(from, to, '', node => String(node.attrs.token ?? ''))
}

export function composerTextSelection(doc: EditorNode, anchor: number, head: number): ComposerSelection {
  return {
    start: composerDocumentText(doc, 0, Math.min(anchor, head)).length,
    end: composerDocumentText(doc, 0, Math.max(anchor, head)).length,
    backward: anchor > head,
  }
}

export function composerDocumentPosition(doc: EditorNode, offset: number, bias = 1): number {
  let plain = 0
  let position = doc.content.size
  doc.forEach((node, index) => {
    const length = node.isText ? node.text!.length : String(node.attrs.token ?? '').length
    if (offset >= plain && offset <= plain + length) {
      position = node.isText ? index + offset - plain
        : offset === plain || (offset < plain + length && bias < 0) ? index : index + node.nodeSize
    }
    plain += length
  })
  return Math.max(0, Math.min(doc.content.size, position))
}

export function selectComposerText(tr: Transaction, selection: ComposerSelection, bias = 1): Transaction {
  const start = composerDocumentPosition(tr.doc, selection.start, selection.start === selection.end ? bias : -1)
  const end = composerDocumentPosition(tr.doc, selection.end, bias)
  return tr.setSelection(TextSelection.create(tr.doc, selection.backward ? end : start, selection.backward ? start : end))
}

export function replaceComposerDocument(
  tr: Transaction,
  value: string,
  selection: ComposerSelection,
  rich = true,
): Transaction {
  const next = composerDocument(value, rich)
  const start = tr.doc.content.findDiffStart(next.content)
  if (start !== null) {
    const end = tr.doc.content.findDiffEnd(next.content)!
    const overlap = Math.max(0, start - Math.min(end.a, end.b))
    tr.replaceWith(start, end.a + overlap, next.content.cut(start, end.b + overlap))
  }
  return selectComposerText(tr, selection)
}
