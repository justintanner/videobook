import { describe, expect, it } from 'vitest'
import {
  asChatModelCatalog,
  fallbackChatModelCatalog,
  resolveChatModelSelection,
} from '../../src/videobook/chat-models'
import { mcpToolLabel } from '../../src/videobook/mcp-activity'

describe('chat model catalog', () => {
  it('parses the server catalog and retains only complete options', () => {
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
      defaultModel: 'gpt-5.6-terra',
      models: [
        { id: 'gpt-5.6-sol', label: 'Sol', description: 'Deep' },
        { id: 'gpt-5.6-terra', label: 'Terra', description: 'Fast' },
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

describe('MCP activity labels', () => {
  it('uses task-oriented labels and readable unknown tool names', () => {
    expect(mcpToolLabel('plan_chat_command')).toBe('Planning chat command')
    expect(mcpToolLabel('get_primary_sequence')).toBe('Get Primary Sequence')
  })
})
