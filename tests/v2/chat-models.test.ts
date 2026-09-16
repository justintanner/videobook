import { describe, expect, it } from 'vitest'
import {
  asChatModelCatalog,
  fallbackChatModelCatalog,
  resolveChatModelSelection,
} from '../../src/videobook/chat-models'
import {
  mcpToolLabel,
  shouldNotifyMcpActivity,
} from '../../src/videobook/mcp-activity'

describe('chat model catalog', () => {
  it('retains only Astra from the server catalog', () => {
    expect(asChatModelCatalog({
      defaultModel: 'gpt-5.6-terra',
      models: [
        {
          id: 'gpt-6-astra',
          label: 'Astra',
          description: 'Deep',
        },
        {
          id: 'gpt-5.6-sol',
          label: 'Sol',
          description: 'Historical',
        },
        {
          id: 'gpt-5.6-terra',
          label: 'Terra',
          description: 'Fast',
        },
        { id: 'broken' },
      ],
    })).toEqual({
      defaultModel: 'gpt-6-astra',
      models: [
        { id: 'gpt-6-astra', label: 'Astra', description: 'Deep' },
      ],
    })
  })

  it('falls back when the payload or persisted selection is stale', () => {
    const catalog = asChatModelCatalog(null)
    expect(catalog).toEqual(fallbackChatModelCatalog)
    expect(resolveChatModelSelection(catalog, 'retired-model'))
      .toBe('gpt-6-astra')
    expect(resolveChatModelSelection(catalog, 'gpt-5.6-sol'))
      .toBe('gpt-6-astra')
  })

  it('recovers a persisted Sol selection to Astra', () => {
    const catalog = asChatModelCatalog({
      defaultModel: 'gpt-6-astra',
      models: [{
        id: 'gpt-6-astra',
        label: 'Astra',
        description: 'Routes every composer request and configures its tools',
      }],
    })
    expect(resolveChatModelSelection(catalog, 'gpt-5.6-sol')).toBe('gpt-6-astra')
  })
})

describe('MCP activity', () => {
  it('uses task-oriented labels and readable unknown tool names', () => {
    expect(mcpToolLabel('plan_chat_command')).toBe('Planning chat command')
    expect(mcpToolLabel('get_primary_sequence')).toBe('Get Primary Sequence')
  })

  it('keeps the reads the app makes for itself out of user-facing notifications', () => {
    expect(shouldNotifyMcpActivity('list_jobs')).toBe(false)
    // Board refreshes are the app keeping its own picture current, not work the
    // user asked for -- a row apiece is what filled a fresh reload with history.
    expect(shouldNotifyMcpActivity('get_notebook')).toBe(false)
    expect(shouldNotifyMcpActivity('run_notebook_cell')).toBe(true)
  })
})
