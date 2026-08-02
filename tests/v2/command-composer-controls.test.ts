import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommandComposer } from '../../src/components/videobook/CommandComposer'
import { fallbackChatModelCatalog } from '../../src/videobook/chat-models'
import { idleMcpActivity } from '../../src/videobook/mcp-activity'

function renderComposer(modelSelectionDisabled: boolean): string {
  return renderToStaticMarkup(createElement(CommandComposer, {
    commands: [],
    assets: [],
    bookId: 'book-1',
    callTool: async () => ({}),
    chatModels: fallbackChatModelCatalog.models,
    disabled: true,
    modelSelectionDisabled,
    connectionLabel: 'Working',
    mcpActivity: idleMcpActivity,
    promptSession: null,
    selectedModel: fallbackChatModelCatalog.defaultModel,
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
  it('keeps model selection available while command execution is busy', () => {
    const html = renderComposer(false)

    expect(controlMarkup(html, 'Videobook command input')).toContain('disabled')
    expect(controlMarkup(html, 'Chat model')).not.toContain('disabled')
  })

  it('disables model selection when its own availability guard is active', () => {
    expect(controlMarkup(renderComposer(true), 'Chat model')).toContain('disabled')
  })
})
