export type McpActivityPhase = 'idle' | 'active' | 'success' | 'error'

export interface McpActivity {
  phase: McpActivityPhase
  tool: string
  count: number
  sequence: number
}

export const idleMcpActivity: McpActivity = {
  phase: 'idle',
  tool: '',
  count: 0,
  sequence: 0,
}

const toolLabels: Readonly<Record<string, string>> = {
  chat: 'Routing chat',
  list_chat_models: 'Loading chat models',
  list_prompt_history: 'Loading prompt history',
  plan_chat_command: 'Planning chat command',
  record_prompt: 'Saving prompt',
  slash_commands: 'Loading commands',
}

export function mcpToolLabel(tool: string): string {
  const known = toolLabels[tool]
  if (known) return known
  return tool
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}
