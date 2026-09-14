import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorState, type Transaction } from 'prosemirror-state'
import { EditorView, type NodeView } from 'prosemirror-view'
import { baseKeymap } from 'prosemirror-commands'
import { closeHistory, history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import type { Node as EditorNode } from 'prosemirror-model'
import {
  composerDocument,
  composerDocumentText,
  composerSchema,
  composerTextSelection,
  replaceComposerDocument,
  selectComposerText,
  type ComposerSelection,
} from '@/videobook/composer-editor-model'
import { composerReferenceDescription, type ComposerReference } from '@/videobook/composer-references'
import { ArtifactThumb } from './ArtifactThumb'
import 'prosemirror-view/style/prosemirror.css'
import './RichComposerEditor.css'

export interface ComposerEditorHandle {
  element: () => HTMLElement | null
  select: () => void
  selection: () => ComposerSelection
  setSelection: (selection: ComposerSelection) => void
  replace: (value: string, selection?: ComposerSelection) => void
}

interface RichComposerEditorProps {
  value: string
  session: string
  sessions: Map<string, EditorState>
  references: ReadonlyMap<string, ComposerReference>
  disabled: boolean
  rich?: boolean
  placeholder: string
  expanded: boolean
  controls?: string
  activeDescendant?: string
  onChange: (value: string, selection: ComposerSelection) => void
  onSelectionChange: (selection: ComposerSelection) => void
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent) => void
  onCompositionChange: (composing: boolean) => void
}

function ReferenceContent({ token, reference }: { token: string; reference?: ComposerReference }) {
  return <>
    <ArtifactThumb asset={reference?.asset} kindHint={reference?.type} thumbnailOnly />
    <span className="composer-reference-address">{token}</span>
  </>
}

function editorSelection(view: EditorView): ComposerSelection {
  return composerTextSelection(view.state.doc, view.state.selection.anchor, view.state.selection.head)
}

function editorAttributes(props: RichComposerEditorProps): Record<string, string> {
  return {
    class: 'command-rich-input',
    role: 'combobox',
    'aria-label': 'Videobook command input',
    'aria-autocomplete': 'list',
    'aria-expanded': String(props.expanded),
    'aria-disabled': String(props.disabled),
    'data-workspace-action-surface': 'slash',
    'data-placeholder': props.placeholder,
    'data-empty': String(props.value.length === 0),
    tabindex: props.disabled ? '-1' : '0',
    spellcheck: 'false',
    autocapitalize: 'none',
    ...(props.controls ? { 'aria-controls': props.controls } : {}),
    ...(props.activeDescendant ? { 'aria-activedescendant': props.activeDescendant } : {}),
  }
}

export function RichComposerEditor({ ref: editorRef, ...props }: RichComposerEditorProps & { ref: Ref<ComposerEditorHandle> }) {
  const [initialMarkup] = useState({ value: props.value, disabled: props.disabled })
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const propsRef = useRef(props)
  const sessionRef = useRef(props.session)
  const composingRef = useRef(false)
  const compositionFrameRef = useRef(0)
  const referenceViews = useRef(new Set<() => void>())

  useImperativeHandle(editorRef, () => ({
    element: () => viewRef.current?.dom ?? null,
    selection: () => viewRef.current ? editorSelection(viewRef.current) : { start: 0, end: 0 },
    select: () => {
      const view = viewRef.current
      if (!view) return
      view.dispatch(selectComposerText(view.state.tr, { start: 0, end: composerDocumentText(view.state.doc).length }))
    },
    setSelection: selection => {
      const view = viewRef.current
      if (!view) return
      const bias = selection.start < editorSelection(view).start ? -1 : 1
      view.dispatch(selectComposerText(view.state.tr, selection, bias).scrollIntoView())
    },
    replace: (value, selection = { start: value.length, end: value.length }) => {
      const view = viewRef.current
      if (!view) return
      view.dispatch(closeHistory(replaceComposerDocument(view.state.tr, value, selection, propsRef.current.rich !== false)).scrollIntoView())
    },
  }), [])

  useLayoutEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const initial = propsRef.current
    const cached = initial.sessions.get(initial.session)
    let initialState = cached ?? EditorState.create({
      schema: composerSchema,
      doc: composerDocument(initial.value, initial.rich !== false),
      plugins: [history(), keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo }), keymap(baseKeymap)],
    })
    if (composerDocumentText(initialState.doc) !== initial.value) initialState = initialState.apply(closeHistory(replaceComposerDocument(
      initialState.tr, initial.value, { start: initial.value.length, end: initial.value.length }, initial.rich !== false,
    )))
    const createReference = (node: EditorNode): NodeView => {
      let token = String(node.attrs.token)
      const dom = document.createElement('span')
      dom.className = 'composer-reference-chip'
      dom.contentEditable = 'false'
      dom.setAttribute('role', 'img')
      const root = createRoot(dom)
      const render = () => {
        const reference = propsRef.current.references.get(token.toLowerCase())
        const description = reference ? composerReferenceDescription(reference) : 'Unavailable reference'
        const label = [token, reference?.label, description].filter(Boolean).join(' · ')
        dom.dataset.reference = token
        dom.setAttribute('aria-label', label)
        dom.title = label
        root.render(<ReferenceContent token={token} reference={reference} />)
      }
      render()
      referenceViews.current.add(render)
      return {
        dom,
        update(next) {
          if (next.type !== node.type) return false
          token = String(next.attrs.token)
          render()
          return true
        },
        ignoreMutation: mutation => mutation.type !== 'selection',
        destroy() {
          referenceViews.current.delete(render)
          queueMicrotask(() => root.unmount())
        },
      }
    }
    const publish = (transaction: Transaction) => {
      const view = viewRef.current
      if (!view) return
      if (!view.composing && !composingRef.current && (transaction.docChanged || transaction.getMeta('normalizeReferences'))) {
        const selection = composerTextSelection(transaction.doc, transaction.selection.anchor, transaction.selection.head)
        replaceComposerDocument(transaction, composerDocumentText(transaction.doc), selection, propsRef.current.rich !== false)
      }
      const previous = view.state
      view.updateState(previous.apply(transaction))
      propsRef.current.sessions.set(sessionRef.current, view.state)
      const selection = editorSelection(view)
      if (!previous.doc.eq(view.state.doc)) propsRef.current.onChange(composerDocumentText(view.state.doc), selection)
      else if (!previous.selection.eq(view.state.selection)) propsRef.current.onSelectionChange(selection)
    }
    const copy = (view: EditorView, event: ClipboardEvent, cut: boolean) => {
      if (!event.clipboardData || view.state.selection.empty) return false
      event.preventDefault()
      event.clipboardData.clearData()
      event.clipboardData.setData('text/plain', composerDocumentText(view.state.doc, view.state.selection.from, view.state.selection.to))
      if (cut && !propsRef.current.disabled) view.dispatch(closeHistory(view.state.tr.deleteSelection()))
      return true
    }
    const view = new EditorView({ mount }, {
      state: initialState,
      editable: () => !propsRef.current.disabled,
      attributes: editorAttributes(initial),
      dispatchTransaction: publish,
      nodeViews: { reference: createReference },
      clipboardTextSerializer: slice => slice.content.textBetween(0, slice.content.size, '', node => String(node.attrs.token ?? '')),
      handleKeyDown: (editor, event) => {
        if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !editor.state.selection.empty) return false
        const { $from } = editor.state.selection
        const backward = event.key === 'Backspace'
        if (!backward && event.key !== 'Delete') return false
        const node = backward ? $from.nodeBefore : $from.nodeAfter
        if (node?.type.name !== 'reference') return false
        const from = backward ? $from.pos - node.nodeSize : $from.pos
        editor.dispatch(closeHistory(editor.state.tr.delete(from, from + node.nodeSize)).scrollIntoView())
        return true
      },
      handlePaste: (editor, event) => {
        if (!event.clipboardData) return false
        event.preventDefault()
        const text = event.clipboardData.getData('text/plain').replace(/\r\n?/gu, '\n')
        editor.dispatch(closeHistory(editor.state.tr.insertText(text)).scrollIntoView())
        return true
      },
      handleDOMEvents: {
        focus: () => { propsRef.current.onFocus(); return false },
        keydown: (_editor, event) => { propsRef.current.onKeyDown(event); return event.defaultPrevented },
        copy: (editor, event) => copy(editor, event, false),
        cut: (editor, event) => copy(editor, event, true),
        compositionstart: () => {
          composingRef.current = true
          propsRef.current.onCompositionChange(true)
          return false
        },
        compositionend: () => {
          composingRef.current = false
          propsRef.current.onCompositionChange(false)
          window.cancelAnimationFrame(compositionFrameRef.current)
          compositionFrameRef.current = window.requestAnimationFrame(() => {
            const editor = viewRef.current
            if (editor && !editor.composing) editor.dispatch(editor.state.tr.setMeta('normalizeReferences', true))
          })
          return false
        },
      },
    })
    viewRef.current = view
    return () => {
      window.cancelAnimationFrame(compositionFrameRef.current)
      propsRef.current.sessions.set(sessionRef.current, view.state)
      viewRef.current = null
      view.destroy()
    }
  }, [])

  useLayoutEffect(() => {
    const view = viewRef.current
    const oldReferences = propsRef.current.references
    propsRef.current = props
    if (!view) return
    const sessionChanged = sessionRef.current !== props.session
    if (sessionChanged) {
      if (sessionRef.current.includes(':actions-')) props.sessions.delete(sessionRef.current)
      else props.sessions.set(sessionRef.current, view.state)
      const cached = props.sessions.get(props.session)
      let state = cached ?? EditorState.create({
        schema: composerSchema,
        doc: composerDocument(props.value, props.rich !== false),
        plugins: view.state.plugins,
      })
      if (composerDocumentText(state.doc) !== props.value) state = state.apply(closeHistory(replaceComposerDocument(
        state.tr, props.value, { start: props.value.length, end: props.value.length }, props.rich !== false,
      )))
      sessionRef.current = props.session
      composingRef.current = false
      view.updateState(state)
    } else if (!view.composing && composerDocumentText(view.state.doc) !== props.value) {
      const selection = { start: props.value.length, end: props.value.length }
      view.updateState(view.state.apply(replaceComposerDocument(view.state.tr, props.value, selection, props.rich !== false).setMeta('addToHistory', false)))
    }
    view.setProps({ attributes: editorAttributes(props), editable: () => !propsRef.current.disabled })
    if (sessionChanged) props.onSelectionChange(editorSelection(view))
    if (oldReferences !== props.references) for (const refresh of referenceViews.current) refresh()
  }, [props])

  return <div className="command-editor-mount"><div ref={mountRef} role="combobox"
    aria-label="Videobook command input" aria-disabled={initialMarkup.disabled}
    contentEditable={!initialMarkup.disabled} suppressContentEditableWarning>{initialMarkup.value}</div></div>
}
