import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommandComposer } from '../../src/components/videobook/CommandComposer'
import { fallbackChatModelCatalog } from '../../src/videobook/chat-models'
import { idleMcpActivity } from '../../src/videobook/mcp-activity'

function renderComposer(
  modelSelectionDisabled: boolean,
  context: { description: string; label: string } | null = null,
): string {
  return renderToStaticMarkup(createElement(CommandComposer, {
    commands: [],
    references: new Map(),
    actions: [],
    actionContext: { bookId: 'book-1', choices: {} },
    actionDiscovery: null,
    actionStatus: { loading: false, error: null },
    actionsDisabled: false,
    onOpenActions: () => undefined,
    onCloseActionSearch: () => undefined,
    bookId: 'book-1',
    callTool: async () => ({}),
    chatModels: fallbackChatModelCatalog.models,
    disabled: true,
    modelSelectionDisabled,
    connectionLabel: 'Working',
    mcpActivity: idleMcpActivity,
    inputSession: 'chat',
    selectedModel: fallbackChatModelCatalog.defaultModel,
    context,
    onEnsureCatalog: async () => undefined,
    onExecute: async () => ({ ok: true, message: 'Done' }),
    onModelChange: () => undefined,
    onSuccessfulExecute: () => undefined,
  }))
}

function controlMarkup(html: string, label: string): string {
  return html.match(new RegExp(`<[^>]+aria-label="${label}"[^>]*>`))?.[0] ?? ''
}

describe('CommandComposer controls', () => {
  it('shows the complete selected model identifier', () => {
    const html = renderComposer(true)

    expect(html).toContain('>gpt-6-astra</option>')
  })

  it('keeps model selection available while command execution is busy', () => {
    const html = renderComposer(false)

    expect(controlMarkup(html, 'Videobook command input')).toContain('disabled')
    expect(controlMarkup(html, 'Chat model')).not.toContain('disabled')
  })

  it('disables model selection when its own availability guard is active', () => {
    expect(controlMarkup(renderComposer(true), 'Chat model')).toContain('disabled')
  })

  it('shows image edit context instead of the chat model selector', () => {
    const html = renderComposer(false, {
      description: 'Two selected subjects',
      label: '@C3 IMAGE EDIT',
    })

    expect(html).toContain('@C3 IMAGE EDIT')
    expect(html).not.toContain('aria-label="Chat model"')
  })
})
