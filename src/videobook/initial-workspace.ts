export type InitialWorkspacePayload = {
  bookValue: unknown
  commandValue: unknown
  bookId: string
  notebookValue: unknown
  notebookId: string
  assetValue: unknown
  sequenceValue: unknown
  jobValue: unknown
  ingestStatusValue: unknown
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
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: tool,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Bootstrap ${tool} failed: ${response.status}`)
  const body = await response.text()
  const data = body
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6)
  if (!data) throw new Error(`Bootstrap ${tool} returned no data`)
  const envelope = record(JSON.parse(data) as unknown)
  if (!envelope || envelope.error) {
    throw new Error(`Bootstrap ${tool} returned an error`)
  }
  return resultValue(envelope.result)
}

function savedValue(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export async function loadInitialWorkspace(): Promise<InitialWorkspacePayload | null> {
  const [bookValue, commandValue] = await Promise.all([
    callTool('list_books', { sort: 'newest' }),
    callTool('slash_commands', {}),
  ])
  const books = Array.isArray(bookValue) ? bookValue : []
  const selected = books
    .map(record)
    .find((book) => book?.slug === 'multyculty')
    ?? books.map(record).find(Boolean)
  const bookId = typeof selected?.bookId === 'string' ? selected.bookId : ''
  if (!bookId) return null
  const [
    notebookValue,
    assetValue,
    sequenceValue,
    jobValue,
    ingestStatusValue,
  ] = await Promise.all([
    callTool('list_notebooks', { book_id: bookId }),
    callTool('list_assets', {
      book_id: bookId,
      sort: 'newest',
      limit: 200,
      include_referenced: true,
    }),
    callTool('get_primary_sequence', { book_id: bookId }),
    callTool('list_jobs', { book_id: bookId, limit: 200 }),
    callTool('list_ingest_status', { book_id: bookId, limit: 200 }),
  ])
  const notebooks = Array.isArray(notebookValue)
    ? notebookValue.map(record).filter((entry) => entry !== null)
    : []
  const remembered = savedValue(`videobook.active-notebook:${bookId}`)
  const notebook = notebooks.find((entry) => entry.id === remembered)
    ?? notebooks[0]
  const notebookId = typeof notebook?.id === 'string' ? notebook.id : ''
  const audioValue = notebookId
    ? await callTool('get_notebook_audio_spine', {
        book_id: bookId,
        notebook_id: notebookId,
      })
    : null
  return {
    bookValue,
    commandValue,
    bookId,
    notebookValue,
    notebookId,
    assetValue,
    sequenceValue,
    jobValue,
    ingestStatusValue,
    audioValue,
  }
}
