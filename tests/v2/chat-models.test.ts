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
  it('retains only Sol from the server catalog', () => {
    expect(asChatModelCatalog({
      defaultModel: 'gpt-5.6-terra',
      models: [
        {
          id: 'gpt-5.6-sol',
          label: 'Sol',
          description: 'Deep',
        },
        {
          id: 'gpt-5.6-terra',
          label: 'Terra',
          description: 'Fast',
        },
        { id: 'broken' },
      ],
    })).toEqual({
      defaultModel: 'gpt-5.6-sol',
      models: [
        { id: 'gpt-5.6-sol', label: 'Sol', description: 'Deep' },
      ],
    })
  })

  it('falls back when the payload or persisted selection is stale', () => {
    const catalog = asChatModelCatalog(null)
    expect(catalog).toEqual(fallbackChatModelCatalog)
    expect(resolveChatModelSelection(catalog, 'retired-model'))
      .toBe('gpt-5.6-sol')
  })
})

describe('MCP activity', () => {
  it('uses task-oriented labels and readable unknown tool names', () => {
    expect(mcpToolLabel('plan_chat_command')).toBe('Planning chat command')
    expect(mcpToolLabel('get_primary_sequence')).toBe('Get Primary Sequence')
  })

  it('keeps list_jobs polling out of user-facing notifications', () => {
    expect(shouldNotifyMcpActivity('list_jobs')).toBe(false)
    expect(shouldNotifyMcpActivity('get_notebook')).toBe(true)
  })
})
