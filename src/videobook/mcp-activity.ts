/**
 * The composer's record of MCP tool calls.
 *
 * This used to be a single transient strip that showed only the newest call and
 * settled back to idle after 620ms. Every call now stays in the panel as its own
 * row until it ages out of the history, so a call is a record rather than a
 * status message: collapsed it is one line, expanded it shows what was sent and
 * what came back.
 */

export type McpCallPhase = 'running' | 'done' | 'failed'

/** One argument, already flattened to a string so the log never holds a payload. */
export interface McpCallArg {
  readonly name: string
  readonly value: string
}

export interface McpCall {
  readonly id: number
  readonly tool: string
  readonly args: readonly McpCallArg[]
  readonly phase: McpCallPhase
  readonly elapsedMs: number
  /** The error on a failure, or whatever the result could say for itself. */
  readonly detail: string
  readonly expanded: boolean
}

export interface McpCallLog {
  readonly calls: readonly McpCall[]
}

/** Success and failure still flash the panel rail once, then stop. */
export type McpFlash = 'success' | 'error' | null

export const emptyMcpCallLog: McpCallLog = { calls: [] }

/** Backstop only; the last-two-exchanges window is what bounds the panel. */
export const MCP_CALL_HISTORY = 256

/** A call shorter than this still reads as having run before it settles. */
export const MCP_CALL_MIN_VISIBLE_MS = 420

const MAX_ARG_CHARS = 140
const MAX_DETAIL_CHARS = 400

const toolLabels: Readonly<Record<string, string>> = {
  chat: 'Routing chat',
  chain: 'Running chained actions',
  list_chat_models: 'Loading chat models',
  list_prompt_history: 'Loading prompt history',
  plan_chat_command: 'Planning chat command',
  record_prompt: 'Saving prompt',
  slash_commands: 'Loading commands',
}

/**
 * Catalogs and pollers nobody asked for. They run on load and again on every
 * refresh, so a row apiece is how a freshly reloaded page ends up showing a
 * chat history the user never started.
 */
const QUIET_TOOLS: ReadonlySet<string> = new Set([
  'list_jobs',
  'list_chat_models',
  'list_prompt_history',
  'list_workspace_actions',
  'slash_commands',
])

export function shouldNotifyMcpActivity(tool: string): boolean {
  return !QUIET_TOOLS.has(tool)
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

function clamp(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit)}… (${flat.length} chars)`
}

function argValue(value: unknown): string {
  if (typeof value === 'string') return clamp(value, MAX_ARG_CHARS)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return clamp(JSON.stringify(value) ?? String(value), MAX_ARG_CHARS)
  } catch {
    return String(value)
  }
}

/**
 * Flatten a call's arguments for display. Values are truncated here rather than
 * at render time so an argument like an upload's base64 `data` never reaches
 * React state. Arguments with no value are dropped: an absent optional reads as
 * noise in a two-column list.
 */
export function mcpCallArgs(args: Record<string, unknown>): readonly McpCallArg[] {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => ({ name, value: argValue(value) }))
}

/**
 * What a result can say for itself, or '' when it cannot say anything worth a
 * line. Nothing here guesses at a summary: an expanded row earns its keep on the
 * arguments, which are always real.
 */
export function mcpResultSummary(value: unknown): string {
  if (typeof value === 'string') return clamp(value, MAX_DETAIL_CHARS)
  if (Array.isArray(value)) return value.length === 1 ? '1 item' : `${value.length} items`
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of ['message', 'error', 'status'] as const) {
    if (typeof record[key] === 'string' && record[key]) return clamp(record[key], MAX_DETAIL_CHARS)
  }
  return ''
}

export function formatMcpElapsed(elapsedMs: number): string {
  const ms = Math.max(0, elapsedMs)
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** The word in the row's trailing slot: how long it took, or that it is still going. */
export function mcpCallState(call: McpCall): string {
  if (call.phase === 'running') return 'working'
  if (call.phase === 'failed') return 'failed'
  return formatMcpElapsed(call.elapsedMs)
}

export function beginMcpCall(log: McpCallLog, call: {
  id: number
  tool: string
  args: readonly McpCallArg[]
}): McpCallLog {
  const started: McpCall = {
    id: call.id,
    tool: call.tool,
    args: call.args,
    phase: 'running',
    elapsedMs: 0,
    detail: '',
    expanded: false,
  }
  return { calls: [...log.calls, started].slice(-MCP_CALL_HISTORY) }
}

export function settleMcpCall(log: McpCallLog, id: number, outcome: {
  phase: 'done' | 'failed'
  elapsedMs: number
  detail: string
}): McpCallLog {
  if (!log.calls.some((call) => call.id === id)) return log
  return {
    calls: log.calls.map((call) => call.id === id
      ? { ...call, phase: outcome.phase, elapsedMs: outcome.elapsedMs, detail: outcome.detail }
      : call),
  }
}

export function toggleMcpCall(log: McpCallLog, id: number): McpCallLog {
  if (!log.calls.some((call) => call.id === id)) return log
  return {
    calls: log.calls.map((call) => call.id === id
      ? { ...call, expanded: !call.expanded }
      : call),
  }
}

export function mcpCallsRunning(log: McpCallLog): number {
  return log.calls.filter((call) => call.phase === 'running').length
}
