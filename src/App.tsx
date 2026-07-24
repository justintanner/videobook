import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import {
  Activity,
  BookOpen,
  Check,
  ChevronDown,
  CircleDot,
  Film,
  FolderKanban,
  Image,
  Library,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  Video,
} from 'lucide-react'
import { useMcp } from 'use-mcp/react'
import type { NotebookCellType, NotebookDocument } from 'videobook-engine'
import {
  adaptCommandArgs,
  parseCommandArgs,
  selectCommandForInput,
  type CommandToolArgs,
  type ServerCommand,
} from '@/lib/command-registry'
import {
  CommandComposer,
  type ComposerOutcome,
} from '@/components/videobook/CommandComposer'
import {
  notebookEdges,
  notebookNodes,
  type NotebookCellData,
} from '@/videobook/notebook-draft'
import {
  nextNotebookGridSlot,
  notebookGridPosition,
  notebookGridSlot,
} from '@/videobook/notebook-grid'

type Screen = 'notebook' | 'books' | 'library' | 'timeline' | 'jobs' | 'settings'

type ToolResponse = {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

type BookSummary = {
  bookId: string
  slug: string
  createdAt: number
  artifactCount: number
  notebookCount: number
}

type AssetRecord = {
  id: string
  artifactId: string
  type: string
  createdAt: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  status: string
  prompt: string | null
  width: number | null
  height: number | null
}

type TimelineSlot = {
  id: string
  artifactId: string
  volume?: number
  audioFadeIn?: number
  audioFadeOut?: number
}

type TimelineAudio = {
  id: string
  artifactId: string
  startFrame: number
  durationFrames: number
  volume?: number
  fadeIn?: number
  fadeOut?: number
}

type TimelineRecord = {
  bookId: string
  render: 'landscape' | 'portrait' | 'square'
  slots: TimelineSlot[]
  audio: TimelineAudio[]
}

type JobRecord = {
  id: number
  type: string
  state: string
  artifactId: string | null
  error: { message: string } | null
  enqueuedAt: number
}

type ProviderRecord = {
  envKey: string
  provider: string
  label: string
  keyStatus: string
  maskedKey: string | null
}

const supportedUiActions = new Set([
  'switch_book',
  'open_notebook',
  'open_projects',
  'open_provider_keys',
])

interface CanvasCellData extends NotebookCellData {
  asset?: AssetRecord
  onRun?: () => void
}

type CanvasNode = Node<CanvasCellData>

const mcpUrl = new URL('/mcp', window.location.origin).toString()

const screenNavigation: Array<{
  id: Exclude<Screen, 'notebook'>
  label: string
  icon: typeof BookOpen
}> = [
  { id: 'books', label: 'Books', icon: FolderKanban },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'timeline', label: 'Timeline', icon: Film },
  { id: 'jobs', label: 'Jobs', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
]

const cellPalette: Array<{
  type: NotebookCellType
  label: string
  icon: typeof BookOpen
}> = [
  { type: 'prompt', label: 'Prompt', icon: CircleDot },
  { type: 'image', label: 'Image', icon: Image },
  { type: 'video', label: 'Video', icon: Video },
  { type: 'character', label: 'Character', icon: BookOpen },
  { type: 'scene', label: 'Scene', icon: Film },
]

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function responseText(result: unknown): string | null {
  const response = result as ToolResponse
  return response.content?.find((item) => item.type === 'text')?.text ?? null
}

function parseResult(result: unknown): unknown {
  const response = result as ToolResponse
  const text = responseText(result)
  if (response.isError) throw new Error(text ?? 'MCP tool failed')
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function messageFor(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value
  const item = record(value)
  if (!item) return fallback
  for (const key of ['message', 'job_id', 'notebook_id', 'slug', 'bookId']) {
    const candidate = asString(item[key])
    if (candidate) return `${fallback}: ${candidate}`
  }
  return fallback
}

function asBooks(value: unknown): BookSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = record(entry)
    const bookId = item && asString(item.bookId)
    const slug = item && asString(item.slug)
    const createdAt = item && asNumber(item.createdAt)
    if (!item || !bookId || !slug || createdAt === null) return []
    return [{
      bookId,
      slug,
      createdAt,
      artifactCount: asNumber(item.artifactCount) ?? 0,
      notebookCount: asNumber(item.notebookCount) ?? 0,
    }]
  })
}

function asNotebookCell(value: unknown): NotebookDocument['cells'][number] | null {
  const item = record(value)
  const id = item && asString(item.id)
  const type = item && asString(item.type)
  const title = item && asString(item.title)
  const position = item && record(item.position)
  const x = position && asNumber(position.x)
  const y = position && asNumber(position.y)
  if (!item || !id || !title || x === null || y === null) return null
  if (!['prompt', 'character', 'scene', 'asset', 'image', 'video'].includes(type ?? '')) return null
  const inputs = record(item.inputs)
  return {
    id,
    type: type as NotebookCellType,
    title,
    position: { x, y },
    ...(asString(item.entity_id ?? item.entityId)
      ? { entityId: asString(item.entity_id ?? item.entityId)! }
      : {}),
    ...(asString(item.prompt) !== null ? { prompt: asString(item.prompt)! } : {}),
    ...(asString(item.model) !== null ? { model: asString(item.model)! } : {}),
    ...(inputs ? { inputs } : {}),
    ...(asString(item.output_artifact_id ?? item.outputArtifactId)
      ? { outputArtifactId: asString(item.output_artifact_id ?? item.outputArtifactId)! }
      : {}),
  }
}

function asNotebook(value: unknown): NotebookDocument | null {
  const item = record(value)
  const id = item && asString(item.id)
  const name = item && asString(item.name)
  const createdAt = item && asString(item.created_at ?? item.createdAt)
  if (!item || !id || !name || !createdAt) return null
  const cells = Array.isArray(item.cells)
    ? item.cells.flatMap((cell) => {
      const parsed = asNotebookCell(cell)
      return parsed ? [parsed] : []
    })
    : []
  const edges = Array.isArray(item.edges)
    ? item.edges.flatMap((edge) => {
      const parsed = record(edge)
      const edgeId = parsed && asString(parsed.id)
      const source = parsed && asString(parsed.source)
      const target = parsed && asString(parsed.target)
      const targetInput = parsed && asString(parsed.targetInput ?? parsed.target_input)
      return edgeId && source && target && targetInput
        ? [{ id: edgeId, source, target, targetInput }]
        : []
    })
    : []
  return {
    id,
    name,
    createdAt,
    ...(record(item.properties) ? { properties: record(item.properties)! } : {}),
    cells,
    edges,
  }
}

function asNotebooks(value: unknown): NotebookDocument[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const notebook = asNotebook(entry)
      return notebook ? [notebook] : []
    })
    : []
}

function asAssets(value: unknown): AssetRecord[] {
  const container = record(value)
  const source = Array.isArray(value)
    ? value
    : Array.isArray(container?.assets)
      ? container.assets
      : []
  return source.flatMap((entry) => {
    const item = record(entry)
    const id = item && asString(item.id)
    const artifactId = item && asString(item.artifact_id ?? item.artifactId)
    const type = item && asString(item.type)
    if (!item || !id || !artifactId || !type) return []
    return [{
      id,
      artifactId,
      type,
      createdAt: asString(item.created_at ?? item.createdAt) ?? '',
      mediaUrl: asString(item.media_url ?? item.mediaUrl),
      thumbnailUrl: asString(item.thumbnail_url ?? item.thumbnailUrl),
      status: asString(item.status) ?? 'ready',
      prompt: asString(item.prompt),
      width: asNumber(item.width),
      height: asNumber(item.height),
    }]
  })
}

function asTimeline(value: unknown): TimelineRecord {
  const item = record(value)
  const render = asString(item?.render)
  const slots = Array.isArray(item?.slots) ? item!.slots.flatMap((entry) => {
    const slot = record(entry)
    const id = slot && asString(slot.id)
    const artifactId = slot && asString(slot.artifact_id ?? slot.artifactId)
    return id && artifactId
      ? [{
        id,
        artifactId,
        ...(asNumber(slot.volume) !== null ? { volume: asNumber(slot.volume)! } : {}),
        ...(asNumber(slot.audioFadeIn) !== null ? { audioFadeIn: asNumber(slot.audioFadeIn)! } : {}),
        ...(asNumber(slot.audioFadeOut) !== null ? { audioFadeOut: asNumber(slot.audioFadeOut)! } : {}),
      }]
      : []
  }) : []
  const audio = Array.isArray(item?.audio) ? item!.audio.flatMap((entry) => {
    const clip = record(entry)
    const id = clip && asString(clip.id)
    const artifactId = clip && asString(clip.artifact_id ?? clip.artifactId)
    const startFrame = clip && asNumber(clip.startFrame ?? clip.start_frame)
    const durationFrames = clip && asNumber(clip.durationFrames ?? clip.duration_frames)
    return id && artifactId && startFrame !== null && durationFrames !== null
      ? [{ id, artifactId, startFrame, durationFrames }]
      : []
  }) : []
  return {
    bookId: asString(item?.book_id ?? item?.bookId) ?? '',
    render: render === 'portrait' || render === 'square' ? render : 'landscape',
    slots,
    audio,
  }
}

function asJobs(value: unknown): JobRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = record(entry)
    const id = item && asNumber(item.id)
    const type = item && asString(item.type)
    const state = item && asString(item.state)
    if (!item || id === null || !type || !state) return []
    const error = record(item.error)
    return [{
      id,
      type,
      state,
      artifactId: asString(item.artifactId ?? item.artifact_id),
      error: error && asString(error.message) ? { message: asString(error.message)! } : null,
      enqueuedAt: asNumber(item.enqueuedAt ?? item.enqueued_at) ?? 0,
    }]
  })
}

function asCommands(value: unknown): ServerCommand[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ServerCommand => {
      const item = record(entry)
      const uiAction = item && asString(item.uiAction)
      return item !== null
        && typeof item.command === 'string'
        && typeof item.description === 'string'
        && (!uiAction || supportedUiActions.has(uiAction))
    })
    : []
}

function asProviders(value: unknown): ProviderRecord[] {
  const item = record(value)
  if (!Array.isArray(item?.providers)) return []
  return item.providers.flatMap((entry) => {
    const provider = record(entry)
    const envKey = provider && asString(provider.envKey)
    const label = provider && asString(provider.label)
    const group = provider && asString(provider.provider)
    if (!provider || !envKey || !label || !group) return []
    return [{
      envKey,
      provider: group,
      label,
      keyStatus: asString(provider.keyStatus) ?? 'missing',
      maskedKey: asString(provider.maskedKey),
    }]
  })
}

function savedValue(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function saveValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    return
  }
}

function artifactForCell(
  assets: ReadonlyMap<string, AssetRecord>,
  outputArtifactId: string | undefined,
): AssetRecord | undefined {
  return outputArtifactId ? assets.get(outputArtifactId) : undefined
}

function cellExecutionStatus(
  document: NotebookDocument,
  cellId: string,
): string {
  const execution = record(document.properties?.execution)
  const item = execution && record(execution[cellId])
  if (!item) return 'ready'
  if (asString(item.error)) return 'error'
  return asString(item.status) ?? 'ready'
}

function canvasNodes(
  document: NotebookDocument,
  assets: AssetRecord[],
  onRun: (cellId: string) => void,
): CanvasNode[] {
  const byArtifactId = new Map(assets.map((asset) => [asset.artifactId, asset]))
  return notebookNodes(document).map((node) => ({
    ...node,
    data: {
      ...node.data,
      status: cellExecutionStatus(document, node.id),
      asset: artifactForCell(byArtifactId, node.data.outputArtifactId),
      onRun: () => onRun(node.id),
    },
  }))
}

function CellNode({ data, selected }: NodeProps<CanvasNode>) {
  const Icon = data.kind === 'video'
    ? Video
    : data.kind === 'image'
      ? Image
      : data.kind === 'scene'
        ? Film
        : data.kind === 'prompt'
          ? CircleDot
          : BookOpen
  const mediaUrl = data.asset?.mediaUrl
  const thumbnailUrl = data.asset?.thumbnailUrl
  const canRun = data.kind === 'image' || data.kind === 'video'

  return (
    <article className={`cell-node ${selected ? 'cell-node-selected' : ''}`}>
      <Handle type="target" position={Position.Top} id="input" />
      <section className="cell-node-shell">
        <header className="cell-node-header">
          <span><Icon size={14} />{data.kind.toUpperCase()}</span>
          {canRun && (
            <button
              type="button"
              className="cell-run-button nodrag"
              onClick={(event) => {
                event.stopPropagation()
                data.onRun?.()
              }}
            >
              Run
            </button>
          )}
        </header>
        {mediaUrl || thumbnailUrl ? (
          <div className="cell-media">
            {data.kind === 'video' && mediaUrl ? (
              <video src={mediaUrl} poster={thumbnailUrl ?? undefined} muted playsInline preload="metadata" />
            ) : (
              <img src={thumbnailUrl ?? mediaUrl ?? ''} alt={data.title} />
            )}
          </div>
        ) : (
          <div className={`cell-copy ${data.kind === 'prompt' ? 'cell-copy-prompt' : ''}`}>
            {data.kind === 'prompt' ? <p>{data.prompt || data.title}</p> : <Sparkles size={28} />}
            {data.kind !== 'prompt' && <span>{data.prompt || data.title}</span>}
          </div>
        )}
        <footer className="cell-node-footer">
          <strong>{data.title}</strong>
          <strong>{data.status}</strong>
        </footer>
      </section>
      <Handle type="source" position={Position.Bottom} id="output" />
    </article>
  )
}

const nodeTypes = { cell: CellNode }

function App() {
  const mcp = useMcp({
    url: mcpUrl,
    clientName: 'videobook',
    transportType: 'http',
    autoReconnect: 3000,
  })
  const [screen, setScreen] = useState<Screen>('notebook')
  const [books, setBooks] = useState<BookSummary[]>([])
  const [bookId, setBookId] = useState(() => savedValue('videobook.active-book'))
  const [notebooks, setNotebooks] = useState<NotebookDocument[]>([])
  const [notebook, setNotebook] = useState<NotebookDocument | null>(null)
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [timeline, setTimeline] = useState<TimelineRecord>(() => asTimeline(null))
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [commands, setCommands] = useState<ServerCommand[]>([])
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [storage, setStorage] = useState<unknown>(null)
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null)
  const [bookMenuOpen, setBookMenuOpen] = useState(false)
  const [notebookMenuOpen, setNotebookMenuOpen] = useState(false)
  const [createSlug, setCreateSlug] = useState('')
  const [renameSlug, setRenameSlug] = useState('')
  const [deleteSlug, setDeleteSlug] = useState('')
  const [newNotebookName, setNewNotebookName] = useState('')
  const [renameNotebookName, setRenameNotebookName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [timelineAssetId, setTimelineAssetId] = useState('')
  const [secretKey, setSecretKey] = useState('KIE_API_KEY')
  const [secretValue, setSecretValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('Connect to the server, then load your books.')
  const flowRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null)

  const activeBook = useMemo(
    () => books.find((book) => book.bookId === bookId) ?? null,
    [bookId, books],
  )
  const selectedCell = useMemo(
    () => nodes.find((node) => node.id === selectedCellId) ?? null,
    [nodes, selectedCellId],
  )
  const assetById = useMemo(
    () => new Map(assets.map((asset) => [asset.artifactId, asset])),
    [assets],
  )

  const call = useCallback(async (tool: string, args: Record<string, unknown>) => {
    if (mcp.state !== 'ready') throw new Error('MCP server is not ready')
    return parseResult(await mcp.callTool(tool, args))
  }, [mcp])

  const runCell = useCallback(async (cellId: string) => {
    if (!bookId || !notebook) return
    setBusy(true)
    try {
      const result = await call('run_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell_id: cellId,
      })
      setNotice(messageFor(result, 'Cell queued'))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [bookId, call, notebook])

  const applyNotebook = useCallback((next: NotebookDocument, nextAssets: AssetRecord[]) => {
    setNotebook(next)
    setNodes(canvasNodes(next, nextAssets, (cellId) => void runCell(cellId)))
    setEdges(notebookEdges(next))
    setSelectedCellId(null)
    setRenameNotebookName(next.name)
  }, [runCell])

  const refreshNotebook = useCallback(async (targetBookId: string, notebookId: string) => {
    const value = await call('get_notebook', {
      book_id: targetBookId,
      notebook_id: notebookId,
    })
    const next = asNotebook(value)
    if (!next) throw new Error('The server returned an invalid notebook')
    setNotebooks((current) => current.map((entry) => entry.id === next.id ? next : entry))
    applyNotebook(next, assets)
    return next
  }, [applyNotebook, assets, call])

  const refreshBookData = useCallback(async (targetBookId: string, preferredNotebookId?: string) => {
    const [notebookValue, assetValue, timelineValue, jobValue] = await Promise.all([
      call('list_notebooks', { book_id: targetBookId }),
      call('list_assets', { book_id: targetBookId, sort: 'newest' }),
      call('get_timeline', { book_id: targetBookId }),
      call('list_jobs', { book_id: targetBookId }),
    ])
    const nextNotebooks = asNotebooks(notebookValue)
    const nextAssets = asAssets(assetValue)
    const remembered = savedValue(`videobook.active-notebook:${targetBookId}`)
    const nextNotebook = nextNotebooks.find((entry) => entry.id === preferredNotebookId)
      ?? nextNotebooks.find((entry) => entry.id === remembered)
      ?? nextNotebooks[0]
      ?? null
    setBookId(targetBookId)
    saveValue('videobook.active-book', targetBookId)
    setNotebooks(nextNotebooks)
    setAssets(nextAssets)
    setTimeline(asTimeline(timelineValue))
    setJobs(asJobs(jobValue))
    if (!nextNotebook) {
      setNotebook(null)
      setNodes([])
      setEdges([])
      return
    }
    saveValue(`videobook.active-notebook:${targetBookId}`, nextNotebook.id)
    applyNotebook(nextNotebook, nextAssets)
  }, [applyNotebook, call])

  const loadBooks = useCallback(async (preferredBookId?: string) => {
    setBusy(true)
    try {
      const [bookValue, commandValue] = await Promise.all([
        call('list_books', { sort: 'newest' }),
        call('slash_commands', {}),
      ])
      const nextBooks = asBooks(bookValue)
      setBooks(nextBooks)
      setCommands(asCommands(commandValue))
      const target = nextBooks.find((book) => book.bookId === preferredBookId)
        ?? nextBooks.find((book) => book.bookId === bookId)
        ?? nextBooks[0]
      if (target) {
        await refreshBookData(target.bookId)
        setNotice(`Loaded ${target.slug}`)
      } else {
        setBookId('')
        setNotebooks([])
        setNotebook(null)
        setAssets([])
        setNodes([])
        setEdges([])
        setNotice('Create your first book to start a notebook.')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [bookId, call, refreshBookData])

  const chooseBook = useCallback(async (nextBookId: string) => {
    setBusy(true)
    try {
      await refreshBookData(nextBookId)
      const next = books.find((book) => book.bookId === nextBookId)
      setNotice(next ? `Opened ${next.slug}` : 'Book opened')
      setScreen('notebook')
      setBookMenuOpen(false)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [books, refreshBookData])

  const chooseNotebook = useCallback(async (nextNotebook: NotebookDocument) => {
    if (!bookId) return
    setBusy(true)
    try {
      const loaded = await refreshNotebook(bookId, nextNotebook.id)
      saveValue(`videobook.active-notebook:${bookId}`, loaded.id)
      setNotebookMenuOpen(false)
      setNotice(`Opened ${loaded.name}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [bookId, refreshNotebook])

  const createBook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!createSlug.trim()) return
    setBusy(true)
    try {
      const value = record(await call('create_book', { slug: createSlug.trim() }))
      const nextBookId = asString(value?.bookId)
      if (!nextBookId) throw new Error('The server did not return a book identity')
      setCreateSlug('')
      setBookMenuOpen(false)
      await loadBooks(nextBookId)
      setScreen('notebook')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const renameBook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeBook || !renameSlug.trim()) return
    setBusy(true)
    try {
      await call('rename_book', { book_id: activeBook.bookId, slug: renameSlug.trim() })
      await loadBooks(activeBook.bookId)
      setNotice(`Renamed book to ${renameSlug.trim()}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const deleteBook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeBook) return
    setBusy(true)
    try {
      await call('delete_book', { book_id: activeBook.bookId, confirm_slug: deleteSlug })
      setDeleteSlug('')
      setBookMenuOpen(false)
      await loadBooks()
      setNotice(`Deleted ${activeBook.slug}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const createNotebook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!bookId || !newNotebookName.trim()) return
    setBusy(true)
    try {
      const created = asNotebook(await call('create_notebook', {
        book_id: bookId,
        name: newNotebookName.trim(),
      }))
      if (!created) throw new Error('The server did not return a notebook')
      setNewNotebookName('')
      await refreshBookData(bookId, created.id)
      setNotebookMenuOpen(false)
      setNotice(`Created ${created.name}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const renameNotebook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!bookId || !notebook || !renameNotebookName.trim()) return
    setBusy(true)
    try {
      await call('rename_notebook', {
        book_id: bookId,
        notebook_id: notebook.id,
        name: renameNotebookName.trim(),
      })
      await refreshBookData(bookId, notebook.id)
      setNotice(`Renamed notebook to ${renameNotebookName.trim()}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const deleteNotebook = async () => {
    if (!bookId || !notebook || notebooks.length <= 1) return
    setBusy(true)
    try {
      await call('delete_notebook', { book_id: bookId, notebook_id: notebook.id })
      await refreshBookData(bookId)
      setNotebookMenuOpen(false)
      setNotice(`Deleted ${notebook.name}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const createCell = async (type: NotebookCellType, position?: { x: number; y: number }) => {
    if (!bookId || !notebook) return
    const slot = position ? notebookGridSlot(position) : nextNotebookGridSlot(nodes)
    const cellPosition = notebookGridPosition(slot)
    const labels: Record<NotebookCellType, string> = {
      prompt: 'Prompt',
      character: 'Character',
      scene: 'Scene',
      asset: 'Asset',
      image: 'Image generation',
      video: 'Video generation',
    }
    const defaults: Partial<Record<NotebookCellType, string>> = {
      image: 'generate_kie_gpt_image_2_text_to_image',
      video: 'generate_kie_wan_2_7_text_to_video',
    }
    setBusy(true)
    try {
      await call('create_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell: {
          type,
          title: labels[type],
          position: cellPosition,
          ...(type === 'prompt' || type === 'image' || type === 'video'
            ? { prompt: '' }
            : {}),
          ...(defaults[type] ? { model: defaults[type] } : {}),
        },
      })
      await refreshBookData(bookId, notebook.id)
      setNotice(`Added ${labels[type].toLowerCase()} cell`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const updateCell = async (patch: Record<string, unknown>) => {
    if (!bookId || !notebook || !selectedCell) return
    setBusy(true)
    try {
      await call('update_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell_id: selectedCell.id,
        cell: patch,
      })
      await refreshNotebook(bookId, notebook.id)
      setNotice('Cell saved')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const deleteSelectedCell = async () => {
    if (!bookId || !notebook || !selectedCell) return
    setBusy(true)
    try {
      await call('delete_notebook_cell', {
        book_id: bookId,
        notebook_id: notebook.id,
        cell_id: selectedCell.id,
      })
      await refreshBookData(bookId, notebook.id)
      setNotice('Cell deleted')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const persistPositions = async (nextNodes: CanvasNode[]) => {
    if (!bookId || !notebook) return
    try {
      await call('move_notebook_cells', {
        book_id: bookId,
        notebook_id: notebook.id,
        positions: nextNodes.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
      })
      await refreshNotebook(bookId, notebook.id)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const connectCells = async (connection: Connection) => {
    if (!bookId || !notebook || !connection.source || !connection.target) return
    setBusy(true)
    try {
      await call('connect_notebook_cells', {
        book_id: bookId,
        notebook_id: notebook.id,
        source_cell_id: connection.source,
        target_cell_id: connection.target,
        target_input: connection.targetHandle ?? 'input',
      })
      await refreshNotebook(bookId, notebook.id)
      setNotice('Cells connected')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const removeEdges = async (edgeIds: string[]) => {
    if (!bookId || !notebook || edgeIds.length === 0) return
    try {
      await Promise.all(edgeIds.map((edgeId) => call('disconnect_notebook_cells', {
        book_id: bookId,
        notebook_id: notebook.id,
        edge_id: edgeId,
      })))
      await refreshNotebook(bookId, notebook.id)
      setNotice('Connection removed')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const runNotebook = async () => {
    if (!bookId || !notebook) return
    setBusy(true)
    try {
      const result = await call('run_notebook', { book_id: bookId, notebook_id: notebook.id })
      setNotice(messageFor(result, 'Notebook queued'))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !bookId) return
    setUploading(true)
    try {
      const response = await fetch(
        `/api/books/${encodeURIComponent(bookId)}/upload?filename=${encodeURIComponent(file.name)}`,
        { method: 'POST', body: file },
      )
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Upload failed')
      await refreshBookData(bookId, notebook?.id)
      setNotice(`Uploaded ${file.name}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

  const saveTimeline = async (next: TimelineRecord) => {
    if (!bookId) return
    setBusy(true)
    try {
      const value = await call('set_timeline', {
        book_id: bookId,
        render: next.render,
        slots: next.slots.map((slot) => ({
          ...(slot.id ? { id: slot.id } : {}),
          artifact_id: slot.artifactId,
          volume: slot.volume,
          audioFadeIn: slot.audioFadeIn,
          audioFadeOut: slot.audioFadeOut,
        })),
        audio: next.audio.map((clip) => ({
          id: clip.id,
          artifact_id: clip.artifactId,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          volume: clip.volume,
          fadeIn: clip.fadeIn,
          fadeOut: clip.fadeOut,
        })),
      })
      setTimeline(asTimeline(value))
      setNotice('Timeline saved')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const refreshSettings = async () => {
    setBusy(true)
    try {
      const status = await call('provider_key_status', {})
      setProviders(asProviders(status))
      if (bookId) setStorage(await call('storage_status', { book_id: bookId }))
      setNotice('Settings refreshed')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const storeSecret = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!secretValue) return
    setBusy(true)
    try {
      await call('set_env_secret', { key: secretKey, value: secretValue })
      setSecretValue('')
      await refreshSettings()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const executeCommand = async (input: string): Promise<ComposerOutcome> => {
    try {
      if (!bookId) return { ok: false, message: 'Load or create a book first.' }
      if (!input.startsWith('/')) {
        const value = await call('chat', { book_id: bookId, prompt: input })
        await refreshBookData(bookId, notebook?.id)
        return { ok: true, message: messageFor(value, 'Request sent') }
      }
      const [commandToken, ...restParts] = input.trim().split(/\s+/)
      const rest = restParts.join(' ')
      const command = selectCommandForInput(commands, commandToken, rest)
      if (!command) return { ok: false, message: `Unknown command: ${commandToken}` }
      if (command.uiAction === 'switch_book') {
        const slug = command.command.slice(1)
        const target = books.find((book) => book.slug === slug)
        if (!target) return { ok: false, message: `Book not found: ${slug}` }
        await chooseBook(target.bookId)
        return { ok: true, message: `Opened ${slug}` }
      }
      if (command.uiAction === 'open_projects') {
        setScreen('books')
        return { ok: true, message: 'Book library opened' }
      }
      if (command.uiAction === 'open_notebook') {
        setScreen('notebook')
        return { ok: true, message: 'Notebook opened' }
      }
      if (command.uiAction === 'open_provider_keys') {
        setScreen('settings')
        await refreshSettings()
        return { ok: true, message: 'Settings opened' }
      }
      if (!command.mcpTool) return { ok: false, message: `${command.command} is available from its workspace.` }
      const parsed = parseCommandArgs(rest, command.params)
      const adapted = adaptCommandArgs(command.mcpTool.adapter, command.mcpTool.tool, parsed)
      const args: CommandToolArgs = {
        ...adapted,
        ...(command.mcpTool.injectParams ?? {}),
      }
      if (command.mcpTool.autoInject?.includes('book_id')) args.book_id = bookId
      const result = await call(command.mcpTool.tool, args)
      await refreshBookData(bookId, notebook?.id)
      return { ok: true, message: messageFor(result, `${command.command} complete`) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const navigate = (next: Screen) => {
    setScreen(next)
    if (next === 'settings') void refreshSettings()
    if ((next === 'library' || next === 'timeline' || next === 'jobs') && bookId) {
      void refreshBookData(bookId, notebook?.id).catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error))
      })
    }
  }

  const emptyWorkspace = (
    <section className="workspace-screen">
      <header>
        <div>
          <span className="section-label">VIDEOBOOK ENGINE 2.0.1</span>
          <h1>Books contain real notebooks.</h1>
          <p>Create a book to get a Main notebook, then add connected prompt, image, and video cells.</p>
        </div>
        <button type="button" disabled={busy || mcp.state !== 'ready'} onClick={() => void loadBooks()}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
          Load books
        </button>
      </header>
      <form className="project-create" onSubmit={createBook}>
        <label>
          New book slug
          <input value={createSlug} onChange={(event) => setCreateSlug(event.target.value)} placeholder="summer-promo" />
        </label>
        <button type="submit" disabled={busy || !createSlug.trim()}>Create book</button>
      </form>
      <span className="workspace-notice">{notice}</span>
    </section>
  )

  return (
    <main className={`app-shell app-screen-${screen}`}>
      <header className="topbar">
        <div className="topbar-book-controls">
          <div className="brand-project">
            <div className="brand-project-trigger">
              <button
                type="button"
                className="brand-project-home"
                title="Open notebook"
                onClick={() => navigate('notebook')}
              >
                <BookOpen size={18} />
                <span>/videobook</span>
              </button>
              <button
                type="button"
                className="brand-project-menu-toggle"
                aria-expanded={bookMenuOpen}
                aria-haspopup="menu"
                onClick={() => setBookMenuOpen((open) => !open)}
              >
                <strong>{activeBook?.slug ?? 'select-book'}</strong>
                <ChevronDown size={14} />
              </button>
            </div>
            {bookMenuOpen && (
              <div className="project-menu book-menu" role="menu">
                <span>BOOKS</span>
                {books.map((book) => (
                  <button
                    key={book.bookId}
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    className={book.bookId === bookId ? 'active' : ''}
                    onClick={() => void chooseBook(book.bookId)}
                  >
                    <span>{book.slug}</span>
                    <small>{book.notebookCount} notebooks</small>
                    {book.bookId === bookId && <Check size={13} />}
                  </button>
                ))}
                <form className="menu-form" onSubmit={createBook}>
                  <input value={createSlug} onChange={(event) => setCreateSlug(event.target.value)} placeholder="new-book" aria-label="New book slug" />
                  <button type="submit" disabled={busy || !createSlug.trim()}><Plus size={13} />Create</button>
                </form>
                {activeBook && (
                  <>
                    <form className="menu-form" onSubmit={renameBook}>
                      <input value={renameSlug} onChange={(event) => setRenameSlug(event.target.value)} placeholder={activeBook.slug} aria-label="Rename book" />
                      <button type="submit" disabled={busy || !renameSlug.trim()}>Rename</button>
                    </form>
                    <form className="menu-form menu-form-danger" onSubmit={deleteBook}>
                      <input value={deleteSlug} onChange={(event) => setDeleteSlug(event.target.value)} placeholder={`Type ${activeBook.slug} to delete`} aria-label="Confirm book deletion" />
                      <button type="submit" disabled={busy || deleteSlug !== activeBook.slug}><Trash2 size={13} />Delete</button>
                    </form>
                  </>
                )}
                {books.length === 0 && <button type="button" onClick={() => void loadBooks()}>Refresh book list</button>}
              </div>
            )}
          </div>
          {activeBook && (
            <div className="notebook-selector">
              <button type="button" onClick={() => setNotebookMenuOpen((open) => !open)} aria-expanded={notebookMenuOpen}>
                <span>NOTEBOOK</span>
                <strong>{notebook?.name ?? 'select'}</strong>
                <ChevronDown size={13} />
              </button>
              {notebookMenuOpen && (
                <div className="notebook-menu" role="menu">
                  {notebooks.map((entry) => (
                    <button key={entry.id} type="button" role="menuitem" className={entry.id === notebook?.id ? 'active' : ''} onClick={() => void chooseNotebook(entry)}>
                      {entry.name}{entry.id === notebook?.id && <Check size={13} />}
                    </button>
                  ))}
                  <form className="menu-form" onSubmit={createNotebook}>
                    <input value={newNotebookName} onChange={(event) => setNewNotebookName(event.target.value)} placeholder="New notebook" aria-label="New notebook name" />
                    <button type="submit" disabled={busy || !newNotebookName.trim()}><Plus size={13} />Add</button>
                  </form>
                  {notebook && (
                    <>
                      <form className="menu-form" onSubmit={renameNotebook}>
                        <input value={renameNotebookName} onChange={(event) => setRenameNotebookName(event.target.value)} aria-label="Rename notebook" />
                        <button type="submit" disabled={busy || !renameNotebookName.trim()}>Rename</button>
                      </form>
                      <button type="button" className="menu-delete" disabled={busy || notebooks.length <= 1} onClick={() => void deleteNotebook()}>
                        <Trash2 size={13} />Delete notebook
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <nav className="header-navigation" aria-label="Workspace navigation">
          <button type="button" title="Refresh books" aria-label="Refresh books" disabled={busy || mcp.state !== 'ready'} onClick={() => void loadBooks(bookId)}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
          </button>
          {screenNavigation.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} type="button" className={screen === item.id ? 'active' : ''} title={item.label} aria-label={`Open ${item.label}`} onClick={() => navigate(item.id)}>
                <Icon size={17} />
              </button>
            )
          })}
        </nav>
      </header>

      {!activeBook ? emptyWorkspace : (
        <>
          {screen === 'notebook' && (
            <>
              <section className="canvas">
                {!notebook ? (
                  <div className="canvas-empty-state">
                    <strong>No notebook selected</strong>
                    <button type="button" onClick={() => setNotebookMenuOpen(true)}>Choose a notebook</button>
                  </div>
                ) : (
                  <ReactFlow<CanvasNode, Edge>
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    onInit={(instance) => { flowRef.current = instance }}
                    onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
                    onEdgesChange={(changes) => {
                      setEdges((current) => applyEdgeChanges(changes, current))
                      const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
                      if (removed.length > 0) void removeEdges(removed)
                    }}
                    onNodeClick={(_event, node) => setSelectedCellId(node.id)}
                    onPaneClick={() => setSelectedCellId(null)}
                    onNodeDragStop={(_event, node) => {
                      const nextNodes = nodes.map((entry) => entry.id === node.id ? { ...entry, position: node.position } : entry)
                      setNodes(nextNodes)
                      void persistPositions(nextNodes)
                    }}
                    onConnect={(connection) => void connectCells(connection)}
                    onDrop={(event) => {
                      event.preventDefault()
                      const raw = event.dataTransfer.getData('application/x-videobook-cell')
                      if (!['prompt', 'character', 'scene', 'asset', 'image', 'video'].includes(raw)) return
                      const point = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
                      void createCell(raw as NotebookCellType, point)
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    fitView
                    deleteKeyCode={null}
                  >
                    <Background gap={36} size={1} color="rgba(96, 196, 141, 0.14)" />
                    <Controls className="flow-controls" showInteractive={false} />
                    <MiniMap className="minimap" pannable zoomable />
                    <Panel position="top-left" className="palette-panel">
                      <aside className="palette">
                        <span className="section-label">ADD CELLS</span>
                        {cellPalette.map((item) => {
                          const Icon = item.icon
                          return (
                            <button
                              key={item.type}
                              type="button"
                              draggable
                              disabled={busy}
                              onDragStart={(event) => event.dataTransfer.setData('application/x-videobook-cell', item.type)}
                              onClick={() => void createCell(item.type)}
                            >
                              <Icon size={15} /><span>Add {item.label}</span>
                            </button>
                          )
                        })}
                        <button type="button" disabled={busy} onClick={() => void runNotebook()}><Sparkles size={15} /><span>Run notebook</span></button>
                      </aside>
                    </Panel>
                  </ReactFlow>
                )}
              </section>
              <aside className="inspector">
                <header><span>INSPECTOR</span><button type="button" onClick={() => setSelectedCellId(null)}>×</button></header>
                {!selectedCell ? (
                  <div className="empty-inspector"><CircleDot size={20} /><strong>Select a notebook cell</strong><p>Edit its prompt and model, then run it directly from the canvas.</p></div>
                ) : (
                  <div className="inspector-body">
                    <h2 className="inspector-slug">{selectedCell.data.title}</h2>
                    <span className="workspace-notice">{selectedCell.data.kind.toUpperCase()} · {selectedCell.data.status}</span>
                    <label>
                      Title
                      <input defaultValue={selectedCell.data.title} onBlur={(event) => {
                        const title = event.target.value.trim()
                        if (title && title !== selectedCell.data.title) void updateCell({ title })
                      }} />
                    </label>
                    {(selectedCell.data.kind === 'prompt' || selectedCell.data.kind === 'image' || selectedCell.data.kind === 'video') && (
                      <label>
                        Prompt
                        <textarea defaultValue={selectedCell.data.prompt ?? ''} rows={8} onBlur={(event) => {
                          if (event.target.value !== (selectedCell.data.prompt ?? '')) void updateCell({ prompt: event.target.value })
                        }} />
                      </label>
                    )}
                    {(selectedCell.data.kind === 'image' || selectedCell.data.kind === 'video') && (
                      <label>
                        Tool model
                        <input defaultValue={selectedCell.data.model ?? ''} placeholder="Generation tool name" onBlur={(event) => {
                          if (event.target.value !== (selectedCell.data.model ?? '')) void updateCell({ model: event.target.value })
                        }} />
                      </label>
                    )}
                    {selectedCell.data.asset?.mediaUrl && (
                      <a className="inspector-media-link" href={selectedCell.data.asset.mediaUrl} target="_blank" rel="noreferrer">Open output</a>
                    )}
                    <div className="record-card-actions">
                      {(selectedCell.data.kind === 'image' || selectedCell.data.kind === 'video') && <button type="button" onClick={() => void runCell(selectedCell.id)} disabled={busy}>Run cell</button>}
                      <button type="button" className="danger-button" onClick={() => void deleteSelectedCell()} disabled={busy}><Trash2 size={13} />Delete</button>
                    </div>
                  </div>
                )}
              </aside>
            </>
          )}

          {screen === 'books' && (
            <section className="workspace-screen">
              <header>
                <div><span className="section-label">BOOK LIBRARY</span><h1>Independent books, independent v2 roots.</h1><p>Each book has its own UUID-backed engine root and starts with a Main notebook.</p></div>
                <button type="button" onClick={() => void loadBooks(bookId)} disabled={busy}><RefreshCw size={15} />Refresh</button>
              </header>
              <form className="project-create" onSubmit={createBook}>
                <label>New book slug<input value={createSlug} onChange={(event) => setCreateSlug(event.target.value)} placeholder="new-story" /></label>
                <button type="submit" disabled={busy || !createSlug.trim()}><Plus size={15} />Create book</button>
              </form>
              <div className="record-grid">
                {books.map((book) => (
                  <article className="record-card project-record-card" key={book.bookId}>
                    <span>BOOK</span><div className="project-record-meta"><strong>{book.slug}</strong><small>{book.notebookCount} notebooks · {book.artifactCount} artifacts</small></div>
                    <div className="record-card-actions"><button type="button" onClick={() => void chooseBook(book.bookId)} disabled={busy}>{book.bookId === bookId ? 'Open' : 'Switch'}</button></div>
                  </article>
                ))}
              </div>
              <span className="workspace-notice">{notice}</span>
            </section>
          )}

          {screen === 'library' && (
            <section className="workspace-screen">
              <header>
                <div><span className="section-label">ARTIFACT LIBRARY</span><h1>{activeBook.slug} assets</h1><p>Uploads and generated artifacts are stored through the selected book’s engine.</p></div>
                <label className="upload-button">{uploading ? 'Uploading…' : 'Upload file'}<input type="file" disabled={uploading} onChange={upload} /></label>
              </header>
              <div className="record-grid">
                {assets.map((asset) => (
                  <article className="record-card asset-card" key={asset.artifactId}>
                    <span>{asset.type.toUpperCase()} · {asset.status}</span>
                    {asset.mediaUrl ? asset.type === 'video' ? <video src={asset.mediaUrl} controls playsInline preload="metadata" /> : <img src={asset.thumbnailUrl ?? asset.mediaUrl} alt={asset.id} /> : <div className="asset-placeholder"><Library size={28} /></div>}
                    <strong>{asset.id}</strong><small>{asset.prompt ?? asset.createdAt}</small>
                  </article>
                ))}
                {assets.length === 0 && <div className="empty-record"><Library size={25} /><strong>No assets yet</strong><p>Upload media or generate an image/video from the notebook.</p></div>}
              </div>
            </section>
          )}

          {screen === 'timeline' && (
            <section className="workspace-screen">
              <header>
                <div><span className="section-label">TYPED TIMELINE</span><h1>{timeline.slots.length} timeline slots</h1><p>The timeline holds stable artifact UUID references inside the selected book.</p></div>
                <button type="button" disabled={busy} onClick={() => void saveTimeline(timeline)}><Check size={15} />Save timeline</button>
              </header>
              <form className="project-create entity-create" onSubmit={(event) => {
                event.preventDefault()
                if (!timelineAssetId) return
                void saveTimeline({ ...timeline, slots: [...timeline.slots, { id: '', artifactId: timelineAssetId }] })
              }}>
                <label>Render orientation<select value={timeline.render} onChange={(event) => setTimeline({ ...timeline, render: event.target.value as TimelineRecord['render'] })}><option value="landscape">Landscape</option><option value="portrait">Portrait</option><option value="square">Square</option></select></label>
                <label>Add artifact<select value={timelineAssetId} onChange={(event) => setTimelineAssetId(event.target.value)}><option value="">Select artifact</option>{assets.filter((asset) => asset.type === 'video' || asset.type === 'image').map((asset) => <option key={asset.artifactId} value={asset.artifactId}>{asset.id}</option>)}</select></label>
                <button type="submit" disabled={busy || !timelineAssetId}><Plus size={15} />Add slot</button>
              </form>
              <div className="record-grid">
                {timeline.slots.map((slot, index) => {
                  const asset = assetById.get(slot.artifactId)
                  return <article className="record-card" key={slot.id}><span>SLOT {String(index + 1).padStart(2, '0')}</span><strong>{asset?.id ?? slot.artifactId}</strong><small>{asset?.type ?? 'missing artifact'}</small><button type="button" disabled={busy} onClick={() => void saveTimeline({ ...timeline, slots: timeline.slots.filter((entry) => entry.id !== slot.id) })}>Remove</button></article>
                })}
                {timeline.slots.length === 0 && <div className="empty-record"><Film size={25} /><strong>No timeline slots</strong><p>Add an image or video artifact to begin a typed render timeline.</p></div>}
              </div>
            </section>
          )}

          {screen === 'jobs' && (
            <section className="workspace-screen">
              <header><div><span className="section-label">PERSISTENT JOBS</span><h1>Book job queue</h1><p>Generation, processing, and notebook runs are recorded in the selected book’s durable queue.</p></div><button type="button" disabled={busy} onClick={() => bookId && void refreshBookData(bookId, notebook?.id)}><RefreshCw size={15} />Refresh</button></header>
              <div className="record-grid">
                {jobs.map((job) => <article className="record-card" key={job.id}><span>{job.state.toUpperCase()}</span><strong>{job.type}</strong><small>{job.artifactId ?? 'book-level job'}</small><pre>{job.error?.message ?? new Date(job.enqueuedAt).toLocaleString()}</pre></article>)}
                {jobs.length === 0 && <div className="empty-record"><Activity size={25} /><strong>No jobs recorded</strong><p>Run a cell or a notebook to queue work.</p></div>}
              </div>
            </section>
          )}

          {screen === 'settings' && (
            <section className="workspace-screen">
              <header><div><span className="section-label">APPLICATION SETTINGS</span><h1>Provider and storage state</h1><p>Provider keys and X OAuth are application-level; object publication state is scoped to the selected book.</p></div><button type="button" disabled={busy} onClick={() => void refreshSettings()}><RefreshCw size={15} />Refresh</button></header>
              <form className="project-create" onSubmit={storeSecret}>
                <label>Provider key<select value={secretKey} onChange={(event) => setSecretKey(event.target.value)}>{['KIE_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'ELEVENLABS_API_KEY', 'FAL_API_KEY', 'GOOGLE_FLOW_API_KEY', 'X_CLIENT_ID', 'X_CLIENT_SECRET'].map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
                <label>Value<input type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} placeholder="Stored locally in .env" /></label>
                <button type="submit" disabled={busy || !secretValue}>Save key</button>
              </form>
              <div className="settings-sections"><div className="settings-grid">{providers.map((provider) => <article className="provider-card" key={provider.envKey}><span className={`provider-dot provider-${provider.keyStatus}`} /><div><strong>{provider.label}</strong><p>{provider.keyStatus}{provider.maskedKey ? ` · ${provider.maskedKey}` : ''}</p></div></article>)}</div><div className="settings-diagnostics"><div className="workspace-section-heading"><h2>Selected book storage</h2><p>Catalog and object publication status from videobook-engine 2.0.1.</p></div><div className="settings-diagnostics-grid"><article className="record-card"><pre>{storage ? JSON.stringify(storage, null, 2) : 'Refresh settings to inspect storage.'}</pre></article></div></div></div>
            </section>
          )}
        </>
      )}

      <CommandComposer
        commands={commands}
        assetSlugs={assets.map((asset) => asset.id)}
        bookId={bookId}
        callTool={mcp.callTool}
        disabled={busy || !bookId || mcp.state !== 'ready'}
        connectionLabel={mcp.state === 'ready' ? 'Load a book to begin' : 'Connecting to MCP…'}
        promptSession={null}
        onEnsureCatalog={() => loadBooks(bookId)}
        onExecute={executeCommand}
      />
    </main>
  )
}

export default App
