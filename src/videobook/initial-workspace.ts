import type { Client } from '@modelcontextprotocol/client'
import { connectMcpClient } from './mcp-client'
import { recordValue } from './value-decoders'

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
}

type ToolResponse = {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

export function selectPreferredBook<T extends { bookId?: unknown }>(
  books: readonly T[],
  preferredBookId: string | null | undefined,
): T | null {
  if (preferredBookId) {
    const preferred = books.find((book) => book.bookId === preferredBookId)
    if (preferred) return preferred
  }
  return books.find((book) => typeof book.bookId === 'string' && book.bookId.length > 0)
    ?? null
}

function resultValue(value: unknown): unknown {
  const result = recordValue(value) as ToolResponse | null
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
  const selected = selectPreferredBook(
    books.map(recordValue).filter((book) => book !== null),
    savedValue('videobook.active-book'),
  )
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
    ? notebookValue.map(recordValue).filter((entry) => entry !== null)
    : []
  const remembered = savedValue(`videobook.active-notebook:${bookId}`)
  const notebook = notebooks.find((entry) => entry.id === remembered)
    ?? notebooks[0]
  const notebookId = typeof notebook?.id === 'string' ? notebook.id : ''
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
  }
}

export async function loadInitialWorkspace(): Promise<InitialWorkspacePayload | null> {
  const mcpUrl = new URL('/mcp', window.location.origin).toString()
  const client = await connectMcpClient(mcpUrl, 'videobook-bootstrap')
  try {
    return await loadInitialWorkspaceFromClient(client)
  } finally {
    await client.close()
  }
}
