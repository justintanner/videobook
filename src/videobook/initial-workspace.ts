import type { Client } from '@modelcontextprotocol/client'
import { connectMcpClient } from './mcp-client'

export type InitialWorkspacePayload = {
  bookValue: unknown
  commandValue: unknown
  chatModelValue: unknown
  bookId: string
  notebookValue: unknown
  notebookId: string
  assetValue: unknown
  sequenceValue: unknown
  jobValue: unknown
  ingestStatusValue: unknown
  actionValue: unknown
  audioValue: unknown
}

type ToolResponse = {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

const mcpUrl = new URL('/mcp', window.location.origin).toString()

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function resultValue(value: unknown): unknown {
  const result = record(value) as ToolResponse | null
  if (!result || result.isError) throw new Error('Bootstrap tool failed')
  const text = result.content?.find((entry) => entry.type === 'text')?.text
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

async function callTool(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return resultValue(await client.callTool({ name: tool, arguments: args }))
}

function savedValue(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

async function loadInitialWorkspaceFromClient(
  client: Client,
): Promise<InitialWorkspacePayload | null> {
  const [bookValue, commandValue, chatModelValue] = await Promise.all([
    callTool(client, 'list_books', { sort: 'newest' }),
    callTool(client, 'slash_commands', {}),
    callTool(client, 'list_chat_models', {}),
  ])
  const books = Array.isArray(bookValue) ? bookValue : []
  const selected = books
    .map(record)
    .find((book) => book?.name === 'dancing')
    ?? books.map(record).find(Boolean)
  const bookId = typeof selected?.bookId === 'string' ? selected.bookId : ''
  if (!bookId) return null
  const [
    notebookValue,
    assetValue,
    sequenceValue,
    jobValue,
    ingestStatusValue,
    actionValue,
  ] = await Promise.all([
    callTool(client, 'list_notebooks', { book_id: bookId }),
    callTool(client, 'list_assets', {
      book_id: bookId,
      sort: 'newest',
      limit: 200,
      include_referenced: true,
    }),
    callTool(client, 'get_primary_sequence', { book_id: bookId }),
    callTool(client, 'list_jobs', { book_id: bookId, limit: 200 }),
    callTool(client, 'list_ingest_status', { book_id: bookId, limit: 200 }),
    callTool(client, 'list_notebook_actions', { book_id: bookId }),
  ])
  const notebooks = Array.isArray(notebookValue)
    ? notebookValue.map(record).filter((entry) => entry !== null)
    : []
  const remembered = savedValue(`videobook.active-notebook:${bookId}`)
  const notebook = notebooks.find((entry) => entry.id === remembered)
    ?? notebooks[0]
  const notebookId = typeof notebook?.id === 'string' ? notebook.id : ''
  const audioValue = notebookId
    ? await callTool(client, 'get_notebook_audio_spine', {
        book_id: bookId,
        notebook_id: notebookId,
      })
    : null
  return {
    bookValue,
    commandValue,
    chatModelValue,
    bookId,
    notebookValue,
    notebookId,
    assetValue,
    sequenceValue,
    jobValue,
    ingestStatusValue,
    actionValue,
    audioValue,
  }
}

export async function loadInitialWorkspace(): Promise<InitialWorkspacePayload | null> {
  const client = await connectMcpClient(mcpUrl, 'videobook-bootstrap')
  try {
    return await loadInitialWorkspaceFromClient(client)
  } finally {
    await client.close()
  }
}
