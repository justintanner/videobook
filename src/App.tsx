import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Boxes,
  ChevronDown,
  Check,
  CircleDot,
  Clock3,
  Film,
  FolderKanban,
  Image,
  Library,
  Menu,
  MessageSquareText,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  UserRound,
  Video,
  X,
} from 'lucide-react'
import { useMcp } from 'use-mcp/react'
import type {
  ProjectBook,
} from 'videobook-engine'
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
  type PromptSession,
} from '@/components/videobook/CommandComposer'
import { NotebookStageBoard } from '@/components/videobook/NotebookStageBoard'
import {
  nextNotebookGridSlot,
  notebookGridSlot,
  resolveNotebookGridMove,
  snapNotebookGridMove,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'
import {
  parseBookAssets,
  parseProjectBook,
  projectBookEdges,
  projectBookNodes,
  type BookAsset,
  type BookCellData,
  type BookCellKind,
} from '@/videobook/project-book'

type Screen =
  | 'notebook'
  | 'projects'
  | 'library'
  | 'jobs'
  | 'settings'
  | 'diagnostics'

type EntityKind = 'prompt' | 'character' | 'scene'

interface ToolResponse {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

interface ProjectRecord {
  slug: string
  asset_count?: number
}

const mcpUrl = new URL('/mcp', window.location.origin).toString()
const nodeTypes = { cell: CellNode }

const navigation: Array<{
  id: Exclude<Screen, 'settings'>
  label: string
  icon: typeof BookOpen
}> = [
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'library', label: 'Entities', icon: Library },
  { id: 'jobs', label: 'Jobs', icon: Activity },
  { id: 'diagnostics', label: 'Diagnostics', icon: CircleDot },
]

const palette = [
  { kind: 'prompt' as const, label: 'Prompt', icon: MessageSquareText },
  { kind: 'image' as const, label: 'Image', icon: Image },
  { kind: 'video' as const, label: 'Video', icon: Video },
  { kind: 'character' as const, label: 'Character', icon: UserRound },
  { kind: 'scene' as const, label: 'Scene', icon: Film },
]

const cellDragType = 'application/x-videobook-cell'

function cellKindFromDrag(value: string): BookCellKind | null {
  return palette.some((item) => item.kind === value)
    ? value as BookCellKind
    : null
}

function CellNode({ data, selected }: NodeProps<Node<BookCellData>>) {
  const Icon =
    data.kind === 'video'
      ? Video
      : data.kind === 'prompt'
        ? MessageSquareText
        : data.kind === 'character'
          ? UserRound
          : data.kind === 'scene'
            ? Film
            : Image

  return (
    <article className={`cell-node ${selected ? 'cell-node-selected' : ''}`}>
      <Handle type="target" position={Position.Top} id="reference" />
      <Handle type="target" position={Position.Top} id="subject" />
      <Handle type="target" position={Position.Top} id="scene" />
      <Handle type="target" position={Position.Top} id="first-frame" />
      <header className="cell-node-header">
        <span>
          <Icon size={13} />
          {data.subtitle}
        </span>
        <span>{data.stage.toString().padStart(2, '0')}</span>
      </header>
      {data.mediaUrl || data.thumbnailUrl ? (
        <div className="cell-media">
          {data.kind === 'video' && !data.thumbnailUrl ? (
            <video
              src={data.mediaUrl}
              muted
              playsInline
              preload="metadata"
            />
          ) : (
            <img
              src={data.thumbnailUrl ?? data.mediaUrl}
              alt={data.slug}
            />
          )}
          {data.width && data.height && (
            <span className="cell-ratio">
              {data.width > data.height
                ? '16:9'
                : data.width < data.height
                  ? '9:16'
                  : '1:1'}
            </span>
          )}
        </div>
      ) : (
        <div className="cell-copy">
          <Sparkles size={26} />
          <span>{data.prompt || data.operation}</span>
        </div>
      )}
      {data.historyExpanded && (
        <div className="cell-trail">
          {data.trail.map((item) => (
            <span key={item.id}>
              <Clock3 size={10} />
              {item.title} · {item.phase} · {item.revision.slice(0, 7)}
            </span>
          ))}
        </div>
      )}
      <footer className="cell-node-footer">
        <span>
          <strong>{data.slug}</strong>
          <small>{data.title}</small>
        </span>
        <strong>{data.status}</strong>
      </footer>
      <Handle type="source" position={Position.Bottom} />
    </article>
  )
}

function textFromToolResult(result: unknown): string | null {
  const response = result as ToolResponse
  return response.content?.find((item) => item.type === 'text')?.text ?? null
}

function parseToolResult(result: unknown): unknown {
  const response = result as ToolResponse
  const text = textFromToolResult(result)
  if (response.isError) throw new Error(text ?? 'MCP tool failed')
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asProjects(value: unknown): ProjectRecord[] {
  return asArray(value).filter((item): item is ProjectRecord => (
    typeof item === 'object'
    && item !== null
    && 'slug' in item
    && typeof item.slug === 'string'
  ))
}

function asCommands(value: unknown): ServerCommand[] {
  return asArray(value).filter((item): item is ServerCommand => (
    typeof item === 'object'
    && item !== null
    && 'command' in item
    && typeof item.command === 'string'
  ))
}

function asAssetSlugs(assets: BookAsset[]): string[] {
  return assets.map((asset) => asset.id.replace(/^@/, ''))
}

function summarize(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return `${value.length} ${value.length === 1 ? 'result' : 'results'}`
  }
  if (typeof value === 'object' && value !== null) {
    for (const key of ['message', 'name', 'id', 'asset_id', 'notebookId', 'hash']) {
      if (key in value && typeof value[key as keyof typeof value] === 'string') {
        return `${fallback}: ${String(value[key as keyof typeof value])}`
      }
    }
    if ('status' in value && typeof value.status === 'string') {
      return `${fallback}: ${value.status}`
    }
  }
  return fallback
}

function errorOutcome(error: unknown): ComposerOutcome {
  return {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }
}

function recordedActionId(value: unknown): string | null {
  if (
    typeof value !== 'object'
    || value === null
    || !('action' in value)
    || typeof value.action !== 'object'
    || value.action === null
    || !('id' in value.action)
    || typeof value.action.id !== 'string'
  ) {
    return null
  }
  return value.action.id
}

function artifactIdForNode(node: Node<BookCellData>): string {
  return node.data.slug.replace(/^@/, '')
}

function ProjectMenu({
  open,
  activeSlug,
  projects,
  busy,
  onHome,
  onToggle,
  onSwitch,
  onManage,
}: {
  open: boolean
  activeSlug: string
  projects: ProjectRecord[]
  busy: boolean
  onHome: () => void
  onToggle: () => void
  onSwitch: (slug: string) => Promise<ComposerOutcome>
  onManage: () => void
}) {
  return (
    <div className="brand-project">
      <div className="brand-project-trigger">
        <button
          type="button"
          className="brand-project-home"
          onClick={onHome}
          aria-label={activeSlug ? `Open ${activeSlug} project book` : 'Open projects'}
        >
          <BookOpen size={18} />
          <span>/videobook</span>
          <strong>{activeSlug || 'select-project'}</strong>
        </button>
        <button
          type="button"
          className="brand-project-menu-toggle"
          onClick={onToggle}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Choose project"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open && (
        <div
          className="project-menu"
          role="menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') onToggle()
          }}
        >
          <span>PROJECTS</span>
          {projects.length === 0 ? (
            <p>No projects found</p>
          ) : (
            projects.map((project) => (
              <button
                type="button"
                role="menuitem"
                key={project.slug}
                disabled={busy}
                className={project.slug === activeSlug ? 'active' : ''}
                onClick={() => void onSwitch(project.slug)}
              >
                <span>{project.slug}</span>
                <small>{project.asset_count ?? 0} assets</small>
                {project.slug === activeSlug && <Check size={13} />}
              </button>
            ))
          )}
          <button type="button" role="menuitem" onClick={onManage}>
            <Settings size={13} />
            <span>Manage projects…</span>
          </button>
        </div>
      )}
    </div>
  )
}

function App() {
  const mcp = useMcp({
    url: mcpUrl,
    clientName: 'videobook',
    transportType: 'http',
    autoReconnect: 3000,
  })
  const [screen, setScreen] = useState<Screen>('projects')
  const [nodes, setNodes] = useState<Array<Node<BookCellData>>>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [projectSlug, setProjectSlug] = useState('')
  const [projectBook, setProjectBook] = useState<ProjectBook | null>(null)
  const [bookAssets, setBookAssets] = useState<BookAsset[]>([])
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 720)
  const [promptOpen, setPromptOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [paletteDragKind, setPaletteDragKind] = useState<BookCellKind | null>(null)
  const [previewSlot, setPreviewSlot] = useState<NotebookGridSlot | null>(null)
  const [busy, setBusy] = useState(false)
  const [records, setRecords] = useState<unknown[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [commands, setCommands] = useState<ServerCommand[]>([])
  const [assetSlugs, setAssetSlugs] = useState<string[]>([])
  const [workspaceNotice, setWorkspaceNotice] = useState('Ready')

  const nodesRef = useRef<Array<Node<BookCellData>>>([])
  const edgesRef = useRef<Edge[]>([])
  const projectSlugRef = useRef('')
  const projectBookRef = useRef<ProjectBook | null>(null)
  const bookAssetsRef = useRef<BookAsset[]>([])
  const flowRef = useRef<ReactFlowInstance<Node<BookCellData>, Edge> | null>(null)
  const dragSlotsRef = useRef(new Map<string, NotebookGridSlot>())

  const selected = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  )

  const visibleCommands = useMemo(
    () => commands.filter((command) => {
      if (!command.onMount || command.onMount.length === 0) return true
      return screen === 'notebook' && command.onMount.includes('notebook')
    }),
    [commands, screen],
  )

  useEffect(() => {
    const closeNarrowInspector = () => {
      if (window.innerWidth <= 720) setPanelOpen(false)
    }
    closeNarrowInspector()
    window.addEventListener('resize', closeNarrowInspector)
    return () => window.removeEventListener('resize', closeNarrowInspector)
  }, [])

  const call = useCallback(
    async (tool: string, args: Record<string, unknown>) => {
      if (mcp.state !== 'ready') throw new Error('MCP server is not ready')
      return parseToolResult(await mcp.callTool(tool, args))
    },
    [mcp],
  )

  const setCurrentProject = useCallback((slug: string) => {
    projectSlugRef.current = slug
    setProjectSlug(slug)
  }, [])

  const replaceNodes = useCallback((next: Array<Node<BookCellData>>) => {
    nodesRef.current = next
    setNodes(next)
  }, [])

  const replaceEdges = useCallback((next: Edge[]) => {
    edgesRef.current = next
    setEdges(next)
  }, [])

  const loadProjects = useCallback(async () => {
    const value = await call('list_projects', {})
    const next = asProjects(value)
    setProjects(next)
    return next
  }, [call])

  const loadCommands = useCallback(async () => {
    const value = await call('slash_commands', {})
    const next = asCommands(value)
    setCommands(next)
    return next
  }, [call])

  const applyProjectBook = useCallback((
    book: ProjectBook,
    assets: BookAsset[],
  ) => {
    projectBookRef.current = book
    bookAssetsRef.current = assets
    setProjectBook(book)
    setBookAssets(assets)
    setAssetSlugs(asAssetSlugs(assets))
    replaceNodes(projectBookNodes(book, assets, historyExpanded))
    replaceEdges(projectBookEdges(book))
  }, [historyExpanded, replaceEdges, replaceNodes])

  const readProjectBook = useCallback(async (slug: string) => {
    const [bookValue, assetsValue] = await Promise.all([
      call('get_project_book', { project_slug: slug, limit: 10_000 }),
      call('list_assets', { project_slug: slug }),
    ])
    const book = parseProjectBook(bookValue)
    if (!book) throw new Error(`Invalid project book for ${slug}`)
    return { book, assets: parseBookAssets(assetsValue) }
  }, [call])

  const reloadProjectBook = useCallback(async (
    selectActionId?: string | null,
  ) => {
    const slug = projectSlugRef.current
    if (!slug) return
    const { book, assets } = await readProjectBook(slug)
    applyProjectBook(book, assets)
    if (selectActionId !== undefined) setSelectedId(selectActionId)
  }, [applyProjectBook, readProjectBook])

  const openProject = useCallback(async (
    slug: string,
  ): Promise<ComposerOutcome> => {
    setBusy(true)
    try {
      const [{ book, assets }] = await Promise.all([
        readProjectBook(slug),
        loadCommands(),
        loadProjects(),
      ])
      setCurrentProject(slug)
      applyProjectBook(book, assets)
      setSelectedId(null)
      setPromptOpen(false)
      setPaletteDragKind(null)
      setPreviewSlot(null)
      dragSlotsRef.current.clear()
      setPanelOpen(window.innerWidth > 720)
      setScreen('notebook')
      setRecords([])
      setProjectMenuOpen(false)
      setWorkspaceNotice(`Opened ${slug}`)
      return { ok: true, message: `Opened ${slug}` }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [
    applyProjectBook,
    loadCommands,
    loadProjects,
    readProjectBook,
    setCurrentProject,
  ])

  const openCurrentBook = useCallback(async (): Promise<ComposerOutcome> => {
    const slug = projectSlugRef.current
    return slug
      ? openProject(slug)
      : { ok: false, message: 'Select a project first' }
  }, [openProject])

  const createProject = useCallback(async (
    slug: string,
  ): Promise<ComposerOutcome> => {
    setBusy(true)
    try {
      const value = await call('create_project', { project_slug: slug })
      await Promise.all([loadProjects(), loadCommands()])
      const opened = await openProject(slug)
      return opened.ok
        ? { ok: true, message: summarize(value, `Created ${slug}`) }
        : opened
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, loadCommands, loadProjects, openProject])

  const renameProject = useCallback(async (
    oldSlug: string,
    newSlug: string,
  ): Promise<ComposerOutcome> => {
    setBusy(true)
    try {
      const value = await call('rename_project', {
        old_slug: oldSlug,
        new_slug: newSlug,
      })
      if (oldSlug === projectSlugRef.current) setCurrentProject(newSlug)
      await Promise.all([loadProjects(), loadCommands()])
      setRecords((current) => current.map((record) => (
        typeof record === 'object'
        && record !== null
        && 'slug' in record
        && record.slug === oldSlug
          ? { ...record, slug: newSlug }
          : record
      )))
      return { ok: true, message: summarize(value, `Renamed to ${newSlug}`) }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [
    call,
    loadCommands,
    loadProjects,
    setCurrentProject,
  ])

  const deleteProject = useCallback(async (
    slug: string,
  ): Promise<ComposerOutcome> => {
    setBusy(true)
    try {
      const value = await call('delete_project', { project_slug: slug })
      if (slug === projectSlugRef.current) {
        setCurrentProject('')
        projectBookRef.current = null
        bookAssetsRef.current = []
        setProjectBook(null)
        setBookAssets([])
        replaceNodes([])
        replaceEdges([])
        setSelectedId(null)
        setPromptOpen(false)
        setAssetSlugs([])
      }
      await Promise.all([loadProjects(), loadCommands()])
      setRecords((current) => current.filter((record) => !(
        typeof record === 'object'
        && record !== null
        && 'slug' in record
        && record.slug === slug
      )))
      return { ok: true, message: summarize(value, `Deleted ${slug}`) }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [
    call,
    loadCommands,
    loadProjects,
    replaceEdges,
    replaceNodes,
    setCurrentProject,
  ])

  const navigateScreen = useCallback(async (next: Screen) => {
    if (next !== 'notebook') setPromptOpen(false)
    setScreen(next)
    setRecords([])
    setNavOpen(false)
    setProjectMenuOpen(false)
  }, [])

  const refreshScreen = useCallback(async () => {
    setBusy(true)
    try {
      let value: unknown
      if (screen === 'notebook') {
        await reloadProjectBook()
      } else if (screen === 'projects') {
        value = await call('list_projects', {})
        const next = asProjects(value)
        setProjects(next)
        setRecords(next)
      } else {
        const slug = projectSlugRef.current
        if (!slug) throw new Error('Select a project first')
        if (screen === 'library') {
          const values = await Promise.all([
            call('list_prompts', { project_slug: slug }),
            call('list_characters', { project_slug: slug }),
            call('list_scenes', { project_slug: slug }),
          ])
          setRecords(values.flatMap(asArray))
        } else if (screen === 'jobs') {
          value = await call('list_jobs', { project_slug: slug })
          setRecords(asArray(value))
        } else if (screen === 'diagnostics') {
          value = await call('storage_status', {})
          setRecords([value])
        }
      }
      setWorkspaceNotice(`Updated ${new Date().toLocaleTimeString()}`)
    } catch (error) {
      setWorkspaceNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [call, reloadProjectBook, screen])

  const createEntity = useCallback(async (
    type: EntityKind,
    name: string,
    prompt: string,
  ): Promise<ComposerOutcome> => {
    const slug = projectSlugRef.current
    if (!slug) return { ok: false, message: 'Select a project first' }
    setBusy(true)
    try {
      const tool = type === 'character' ? 'create_character_entity' : `create_${type}`
      const value = await call(tool, {
        project_slug: slug,
        name,
        ...(prompt ? { prompt } : {}),
      })
      setRecords((current) => [value, ...current])
      await reloadProjectBook()
      return { ok: true, message: summarize(value, `Created ${type}`) }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, reloadProjectBook])

  const deleteEntity = useCallback(async (
    type: EntityKind,
    id: string,
  ): Promise<ComposerOutcome> => {
    const slug = projectSlugRef.current
    if (!slug) return { ok: false, message: 'Select a project first' }
    setBusy(true)
    try {
      const value = await call(`delete_${type}`, {
        project_slug: slug,
        entity_id: id,
      })
      setRecords((current) => current.filter((record) => !(
        typeof record === 'object'
        && record !== null
        && 'id' in record
        && record.id === id
      )))
      await reloadProjectBook()
      return { ok: true, message: summarize(value, `Deleted ${type}`) }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, reloadProjectBook])

  const addCell = useCallback(async (
    kind: BookCellKind,
    requestedSlot?: NotebookGridSlot,
  ): Promise<ComposerOutcome> => {
    const slug = projectSlugRef.current
    const book = projectBookRef.current
    if (!slug || !book) return { ok: false, message: 'Select a project first' }
    const prefix: Record<BookCellKind, string> = {
      prompt: 'prm',
      image: 'img-draft',
      video: 'vid-draft',
      character: 'char',
      scene: 'scn',
    }
    const artifactId = `${prefix[kind]}-${crypto.randomUUID().slice(0, 8)}`
    const slot = requestedSlot ?? nextNotebookGridSlot(nodesRef.current)
    setBusy(true)
    try {
      const value = await call('record_book_action', {
        project_slug: slug,
        operation: `create_${kind}_entry`,
        phase: 'completed',
        scope: 'artifact',
        actor: 'human',
        lane: 'human',
        base_revision: book.headRevision,
        output_artifact_ids: [artifactId],
        stage: slot.stage,
        column: slot.column,
        write_set: [`artifact:${artifactId}`],
        details: {
          entry: {
            id: artifactId,
            kind,
            title: `New ${kind}`,
            prompt: '',
            model: 'auto',
          },
        },
      })
      const actionId = recordedActionId(value)
      await reloadProjectBook(actionId)
      setPanelOpen(true)
      setPromptOpen(true)
      return { ok: true, message: `Added @${artifactId}` }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, reloadProjectBook])

  const updateSelectedData = useCallback((
    id: string,
    patch: Partial<BookCellData>,
  ) => {
    replaceNodes(nodesRef.current.map((node) => (
      node.id === id
        ? { ...node, data: { ...node.data, ...patch } }
        : node
    )))
  }, [replaceNodes])

  const commitEntry = useCallback(async (
    id: string,
  ): Promise<ComposerOutcome> => {
    const slug = projectSlugRef.current
    const book = projectBookRef.current
    const node = nodesRef.current.find((candidate) => candidate.id === id)
    if (!slug || !book || !node) return { ok: false, message: 'Entry is unavailable' }
    const original = projectBookNodes(
      book,
      bookAssetsRef.current,
      historyExpanded,
    ).find((candidate) => candidate.id === id)
    if (
      original
      && original.data.title === node.data.title
      && original.data.prompt === node.data.prompt
      && original.data.model === node.data.model
    ) {
      return { ok: true, message: 'Project book is current' }
    }
    const artifactId = artifactIdForNode(node)
    const slot = notebookGridSlot(node.position)
    setBusy(true)
    try {
      const value = await call('record_book_action', {
        project_slug: slug,
        operation: 'edit_entry',
        phase: 'completed',
        scope: 'artifact',
        actor: 'human',
        lane: 'human',
        base_revision: book.headRevision,
        parent_action_ids: [node.data.actionId],
        output_artifact_ids: [artifactId],
        target_artifact_id: artifactId,
        target_action_id: node.data.actionId,
        stage: slot.stage,
        column: slot.column,
        write_set: [`artifact:${artifactId}`],
        details: {
          entry: {
            id: artifactId,
            kind: node.data.kind,
            title: node.data.title,
            prompt: node.data.prompt ?? '',
            model: node.data.model ?? 'auto',
          },
        },
      })
      const actionId = recordedActionId(value)
      await reloadProjectBook(actionId)
      return { ok: true, message: `Updated @${artifactId}` }
    } catch (error) {
      await reloadProjectBook(id).catch(() => undefined)
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, historyExpanded, reloadProjectBook])

  const commitLayouts = useCallback(async (): Promise<ComposerOutcome> => {
    const slug = projectSlugRef.current
    const book = projectBookRef.current
    if (!slug || !book) return { ok: false, message: 'Select a project first' }
    const canonical = new Map(projectBookNodes(
      book,
      bookAssetsRef.current,
      historyExpanded,
    ).map((node) => [node.id, notebookGridSlot(node.position)]))
    const changed = nodesRef.current.filter((node) => {
      const before = canonical.get(node.id)
      const after = notebookGridSlot(node.position)
      return before && (before.stage !== after.stage || before.column !== after.column)
    })
    if (changed.length === 0) return { ok: true, message: 'Layout is current' }
    setBusy(true)
    try {
      for (const node of changed) {
        const slot = notebookGridSlot(node.position)
        await call('record_book_layout', {
          project_slug: slug,
          target_action_id: node.data.actionId,
          stage: slot.stage,
          column: slot.column,
          base_revision: book.headRevision,
        })
      }
      await reloadProjectBook()
      return {
        ok: true,
        message: `Recorded ${changed.length} layout ${changed.length === 1 ? 'change' : 'changes'}`,
      }
    } catch (error) {
      await reloadProjectBook().catch(() => undefined)
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, historyExpanded, reloadProjectBook])

  const connectEntries = useCallback(async (
    connection: Connection,
  ): Promise<ComposerOutcome> => {
    const slug = projectSlugRef.current
    const book = projectBookRef.current
    const source = nodesRef.current.find((node) => node.id === connection.source)
    const target = nodesRef.current.find((node) => node.id === connection.target)
    if (!slug || !book || !source || !target) {
      return { ok: false, message: 'Both entries must be available' }
    }
    const sourceArtifactId = artifactIdForNode(source)
    const targetArtifactId = artifactIdForNode(target)
    const slot = notebookGridSlot(target.position)
    setBusy(true)
    try {
      const value = await call('record_book_action', {
        project_slug: slug,
        operation: 'link_entries',
        phase: 'completed',
        scope: 'artifact',
        actor: 'human',
        lane: 'human',
        base_revision: book.headRevision,
        parent_action_ids: [source.data.actionId, target.data.actionId],
        input_artifact_ids: [sourceArtifactId],
        output_artifact_ids: [targetArtifactId],
        target_artifact_id: targetArtifactId,
        target_action_id: target.data.actionId,
        stage: slot.stage,
        column: slot.column,
        write_set: [`artifact:${targetArtifactId}`],
        details: {
          target_handle: connection.targetHandle ?? 'input',
          entry: {
            id: targetArtifactId,
            kind: target.data.kind,
            title: target.data.title,
            prompt: target.data.prompt ?? '',
            model: target.data.model ?? 'auto',
          },
        },
      })
      const actionId = recordedActionId(value)
      await reloadProjectBook(actionId)
      return { ok: true, message: `Linked @${sourceArtifactId} to @${targetArtifactId}` }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, reloadProjectBook])

  const toggleHistory = useCallback(async (): Promise<ComposerOutcome> => {
    const next = !historyExpanded
    setHistoryExpanded(next)
    const book = projectBookRef.current
    if (book) {
      replaceNodes(projectBookNodes(book, bookAssetsRef.current, next))
      if (screen !== 'notebook') await navigateScreen('notebook')
    }
    return {
      ok: true,
      message: next ? 'Expanded project-book trails' : 'Collapsed project-book trails',
    }
  }, [historyExpanded, navigateScreen, replaceNodes, screen])

  const ensureCommandCatalog = useCallback(async () => {
    if (commands.length > 0 || mcp.state !== 'ready') return
    try {
      await Promise.all([
        loadCommands(),
        projectSlugRef.current
          ? reloadProjectBook()
          : Promise.resolve([]),
      ])
    } catch {
      return
    }
  }, [commands.length, loadCommands, mcp.state, reloadProjectBook])

  const executeUiAction = useCallback(async (
    action: string,
    args: Record<string, string>,
    raw: string,
  ): Promise<ComposerOutcome> => {
    if (action === 'save_notebook') {
      return { ok: true, message: 'Every project-book action is already saved' }
    }
    if (action === 'run_notebook') {
      return {
        ok: false,
        message: 'Run generation commands directly; each result becomes a project-book action',
      }
    }
    if (action === 'open_notebook') return openCurrentBook()
    if (action === 'switch_project') return openProject(raw)
    if (action === 'create_project') return createProject(args.project_slug || raw)
    if (action === 'rename_project') {
      const slug = projectSlugRef.current
      return slug
        ? renameProject(slug, args.new_slug || raw)
        : { ok: false, message: 'Select a project first' }
    }
    if (action === 'delete_project') {
      return {
        ok: false,
        message: 'Open Manage projects to confirm project deletion',
      }
    }
    if (action === 'open_revisions' || action === 'show_history') {
      return toggleHistory()
    }
    const screens: Record<string, Screen> = {
      open_projects: 'projects',
      open_entities: 'library',
      open_jobs: 'jobs',
      open_status: 'jobs',
      open_provider_keys: 'settings',
      open_diagnostics: 'diagnostics',
    }
    const next = screens[action]
    if (next) {
      await navigateScreen(next)
      return { ok: true, message: `Opened ${next}` }
    }
    return {
      ok: false,
      message: `/${action.replaceAll('_', '-')} is not available on this screen`,
    }
  }, [
    createProject,
    navigateScreen,
    openCurrentBook,
    openProject,
    renameProject,
    toggleHistory,
  ])

  const executeCommand = useCallback(async (
    input: string,
  ): Promise<ComposerOutcome> => {
    try {
      if (input.startsWith('/')) {
        const space = input.indexOf(' ')
        const commandName = space === -1 ? input : input.slice(0, space)
        const rest = space === -1 ? '' : input.slice(space + 1).trim()
        const command = selectCommandForInput(commands, commandName, rest)
        if (!command) return { ok: false, message: `Unknown command: ${commandName}` }
        const parsed = parseCommandArgs(rest, command.params)
        if (command.uiAction) {
          const stringArgs = Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(' ') : String(value),
            ]),
          )
          const raw = command.uiAction === 'switch_project'
            ? commandName.slice(1)
            : rest
          return executeUiAction(command.uiAction, stringArgs, raw)
        }
        if (command.mcpTool) {
          let toolArgs: CommandToolArgs = { ...parsed }
          if (command.mcpTool.autoInject?.includes('project_slug')) {
            const slug = projectSlugRef.current
            if (!slug) return { ok: false, message: 'Select a project first' }
            toolArgs.project_slug = slug
          }
          if (command.mcpTool.injectParams) {
            Object.assign(toolArgs, command.mcpTool.injectParams)
          }
          toolArgs = adaptCommandArgs(
            command.mcpTool.adapter,
            command.mcpTool.tool,
            toolArgs,
          )
          const value = await call(
            command.mcpTool.tool,
            toolArgs as Record<string, unknown>,
          )
          if (projectSlugRef.current) await reloadProjectBook()
          return {
            ok: true,
            message: summarize(value, command.description),
          }
        }
        return { ok: false, message: `Command has no action: ${commandName}` }
      }
      const slug = projectSlugRef.current
      if (!slug) return { ok: false, message: 'Select a project first' }
      const value = await call('chat', { project_slug: slug, prompt: input })
      await reloadProjectBook()
      return { ok: true, message: summarize(value, 'Done') }
    } catch (error) {
      return errorOutcome(error)
    }
  }, [call, commands, executeUiAction, reloadProjectBook])

  const promptSession = useMemo<PromptSession | null>(() => {
    if (screen !== 'notebook' || !selected || !promptOpen) return null
    return {
      id: selected.id,
      kind: selected.data.kind,
      title: selected.data.title,
      value: selected.data.prompt ?? '',
      assetSlugs,
      onChange: (value) => updateSelectedData(selected.id, { prompt: value }),
      onCommit: () => commitEntry(selected.id),
      onCollapse: async () => {
        const outcome = await commitEntry(selected.id)
        if (outcome.ok) setPromptOpen(false)
        return outcome
      },
    }
  }, [
    assetSlugs,
    commitEntry,
    promptOpen,
    screen,
    selected,
    updateSelectedData,
  ])

  return (
    <main className={`app-shell app-screen-${screen}`}>
      <header className="topbar">
        <button
          className="mobile-menu"
          type="button"
          onClick={() => setNavOpen((value) => !value)}
          aria-label="Toggle navigation"
        >
          <Menu size={18} />
        </button>
        <ProjectMenu
          open={projectMenuOpen}
          activeSlug={projectSlug}
          projects={projects}
          busy={busy}
          onHome={() => {
            if (!projectSlug) {
              void navigateScreen('projects')
              return
            }
            void openCurrentBook().then((outcome) => {
              setWorkspaceNotice(outcome.message)
            })
          }}
          onToggle={() => {
            const next = !projectMenuOpen
            setProjectMenuOpen(next)
            if (next && mcp.state === 'ready') void loadProjects()
          }}
          onSwitch={openProject}
          onManage={() => void navigateScreen('projects')}
        />
        <div className="topbar-center" aria-hidden="true" />
        <button
          type="button"
          className={`settings-trigger ${screen === 'settings' ? 'active' : ''}`}
          onClick={() => void navigateScreen('settings')}
          aria-label="Open provider settings"
          title="Provider settings"
        >
          <Settings size={18} />
        </button>
      </header>

      <aside className={`navigation ${navOpen ? 'navigation-open' : ''}`}>
        <nav>
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                type="button"
                key={item.id}
                className={screen === item.id ? 'active' : ''}
                onClick={() => void navigateScreen(item.id)}
                title={item.label}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            )
          })}
          <button
            type="button"
            className={screen === 'notebook' && historyExpanded ? 'active' : ''}
            disabled={!projectSlug}
            onClick={() => void toggleHistory().then((outcome) => {
              setWorkspaceNotice(outcome.message)
            })}
            title="Toggle project-book history trails"
          >
            <Clock3 size={19} />
            <span>History trails</span>
          </button>
        </nav>
        <div className="navigation-version">v0.1</div>
      </aside>

      {screen === 'notebook' ? (
        <>
          <section
            className="canvas"
            onDragOver={(event) => {
              const kind = paletteDragKind ?? cellKindFromDrag(
                event.dataTransfer.getData(cellDragType),
              )
              if (!kind || !flowRef.current) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              const position = flowRef.current.screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
              })
              setPreviewSlot(notebookGridSlot(position))
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node)) {
                setPreviewSlot(null)
              }
            }}
            onDrop={(event) => {
              const kind = cellKindFromDrag(event.dataTransfer.getData(cellDragType))
                ?? paletteDragKind
              if (!kind || !flowRef.current) return
              event.preventDefault()
              const position = flowRef.current.screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
              })
              void addCell(kind, notebookGridSlot(position)).then((outcome) => {
                setWorkspaceNotice(outcome.message)
              })
              setPaletteDragKind(null)
              setPreviewSlot(null)
            }}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={(changes) => {
                let next = nodesRef.current
                for (const change of changes.filter((item) => item.type !== 'remove')) {
                  next = applyNodeChanges([change], next)
                  if (change.type === 'position' && change.position) {
                    const slot = notebookGridSlot(change.position)
                    dragSlotsRef.current.set(change.id, slot)
                    next = snapNotebookGridMove(
                      next,
                      change.id,
                      slot,
                    )
                  }
                }
                replaceNodes(next)
              }}
              onEdgesChange={(changes) => {
                replaceEdges(applyEdgeChanges(
                  changes.filter((change) => change.type !== 'remove'),
                  edgesRef.current,
                ))
              }}
              onNodeDragStop={(_, node) => {
                const slot = dragSlotsRef.current.get(node.id)
                  ?? notebookGridSlot(node.position)
                dragSlotsRef.current.delete(node.id)
                replaceNodes(resolveNotebookGridMove(nodesRef.current, node.id, slot))
                setPreviewSlot(null)
                void commitLayouts().then((outcome) => {
                  setWorkspaceNotice(outcome.message)
                })
              }}
              onNodeClick={(_, node) => {
                const selectNode = () => {
                  setSelectedId(node.id)
                  setPanelOpen(true)
                  setPromptOpen(true)
                }
                if (selectedId && node.id !== selectedId) {
                  void commitEntry(selectedId).then((outcome) => {
                    setWorkspaceNotice(outcome.message)
                    if (outcome.ok) selectNode()
                  })
                  return
                }
                selectNode()
              }}
              onConnect={(connection: Connection) => {
                void connectEntries(connection).then((outcome) => {
                  setWorkspaceNotice(outcome.message)
                })
              }}
              onPaneClick={() => {
                const id = selectedId
                if (!id) return
                void commitEntry(id).then((outcome) => {
                  setWorkspaceNotice(outcome.message)
                  if (!outcome.ok) return
                  setSelectedId(null)
                  setPromptOpen(false)
                })
              }}
              onInit={(instance) => {
                flowRef.current = instance
              }}
              fitView
              minZoom={0.35}
              maxZoom={1.7}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <NotebookStageBoard nodes={nodes} previewSlot={previewSlot} />
              <Background color="rgba(93, 220, 164, .09)" gap={36} size={1} />
              <Panel position="top-right" className="palette-panel">
                <aside className="palette">
                  <span className="section-label">CELLS</span>
                  {palette.map((item) => {
                    const Icon = item.icon
                    return (
                      <button
                        type="button"
                        key={item.kind}
                        draggable
                        onClick={() => void addCell(item.kind).then((outcome) => {
                          setWorkspaceNotice(outcome.message)
                        })}
                        onDragStart={(event) => {
                          event.dataTransfer.setData(cellDragType, item.kind)
                          event.dataTransfer.effectAllowed = 'copy'
                          setPaletteDragKind(item.kind)
                        }}
                        onDragEnd={() => {
                          setPaletteDragKind(null)
                          setPreviewSlot(null)
                        }}
                        title={`Add ${item.label}`}
                      >
                        <Icon size={18} />
                        <span>{item.label}</span>
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    className="palette-add"
                    draggable
                    onClick={() => void addCell('prompt').then((outcome) => {
                      setWorkspaceNotice(outcome.message)
                    })}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(cellDragType, 'prompt')
                      event.dataTransfer.effectAllowed = 'copy'
                      setPaletteDragKind('prompt')
                    }}
                    onDragEnd={() => {
                      setPaletteDragKind(null)
                      setPreviewSlot(null)
                    }}
                    title="Add prompt cell"
                  >
                    <Plus size={20} />
                    <span>Prompt</span>
                  </button>
                </aside>
              </Panel>
              <MiniMap
                className="minimap"
                nodeColor="rgba(111, 234, 177, .65)"
                maskColor="rgba(2, 10, 7, .74)"
              />
              <Controls position="top-left" className="flow-controls" />
            </ReactFlow>
          </section>

          <aside className={`inspector ${panelOpen ? '' : 'inspector-closed'}`}>
            <header>
              <span>INSPECTOR</span>
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                aria-label="Close inspector"
              >
                <X size={16} />
              </button>
            </header>
            {selected ? (
              <div className="inspector-body">
                <span className="inspector-kicker">
                  {selected.data.kind} cell
                </span>
                <h2>{selected.data.title}</h2>
                <label>
                  Label
                  <input
                    value={selected.data.title}
                    onChange={(event) => updateSelectedData(selected.id, {
                      title: event.target.value,
                    })}
                    onBlur={() => void commitEntry(selected.id).then((outcome) => {
                      setWorkspaceNotice(outcome.message)
                    })}
                  />
                </label>
                <label>
                  Model
                  <select
                    value={selected.data.model ?? 'auto'}
                    onChange={(event) => updateSelectedData(selected.id, {
                      model: event.target.value,
                    })}
                    onBlur={() => void commitEntry(selected.id).then((outcome) => {
                      setWorkspaceNotice(outcome.message)
                    })}
                  >
                    <option value="auto">Auto route</option>
                    <option value="nano-banana-pro-google">Nano Banana Pro · Google Flow</option>
                    <option value="google-omni">Google Omni · Google Flow</option>
                    <option value="seedance">Seedance 2</option>
                    <option value="grok">Grok Imagine</option>
                  </select>
                </label>
                <div className="input-ports">
                  <span>INPUT PORTS</span>
                  <p>Drag a source handle into this cell to add an input.</p>
                </div>
              </div>
            ) : (
              <div className="empty-inspector">
                <div className="target-mark">
                  <CircleDot size={42} />
                </div>
                <strong>NO CELL SELECTED</strong>
                <p>Select a cell on the canvas to configure its model, inputs, and settings.</p>
              </div>
            )}
          </aside>
        </>
      ) : (
        <WorkspaceScreen
          screen={screen}
          records={records}
          busy={busy}
          notice={workspaceNotice}
          onRefresh={refreshScreen}
          projectSlug={projectSlug}
          bookSummary={projectBook
            ? `${projectBook.actions.length} actions · ${bookAssets.length} assets · ${projectBook.headRevision.slice(0, 8)}`
            : 'No project book'}
          onCreateProject={createProject}
          onOpenProject={openProject}
          onRenameProject={renameProject}
          onDeleteProject={deleteProject}
          onCreateEntity={createEntity}
          onDeleteEntity={deleteEntity}
          onOutcome={(outcome) => setWorkspaceNotice(outcome.message)}
        />
      )}

      <CommandComposer
        commands={visibleCommands}
        assetSlugs={assetSlugs}
        projectSlug={projectSlug}
        callTool={mcp.callTool}
        disabled={mcp.state !== 'ready'}
        connectionLabel={`MCP ${mcp.state}`}
        promptSession={promptSession}
        onEnsureCatalog={ensureCommandCatalog}
        onExecute={executeCommand}
      />
    </main>
  )
}

interface WorkspaceScreenProps {
  screen: Exclude<Screen, 'notebook'>
  records: unknown[]
  busy: boolean
  notice: string
  onRefresh: () => Promise<void>
  projectSlug: string
  bookSummary: string
  onCreateProject: (slug: string) => Promise<ComposerOutcome>
  onOpenProject: (slug: string) => Promise<ComposerOutcome>
  onRenameProject: (oldSlug: string, newSlug: string) => Promise<ComposerOutcome>
  onDeleteProject: (slug: string) => Promise<ComposerOutcome>
  onCreateEntity: (
    type: EntityKind,
    name: string,
    prompt: string,
  ) => Promise<ComposerOutcome>
  onDeleteEntity: (type: EntityKind, id: string) => Promise<ComposerOutcome>
  onOutcome: (outcome: ComposerOutcome) => void
}

function WorkspaceScreen({
  screen,
  records,
  busy,
  notice,
  onRefresh,
  projectSlug,
  bookSummary,
  onCreateProject,
  onOpenProject,
  onRenameProject,
  onDeleteProject,
  onCreateEntity,
  onDeleteEntity,
  onOutcome,
}: WorkspaceScreenProps) {
  const [newProjectSlug, setNewProjectSlug] = useState('')
  const [entityType, setEntityType] = useState<EntityKind>('prompt')
  const [entityName, setEntityName] = useState('')
  const [entityPrompt, setEntityPrompt] = useState('')
  const title =
    screen === 'library'
      ? 'Entity library'
      : screen[0]!.toUpperCase() + screen.slice(1)

  return (
    <section className="workspace-screen">
      <header>
        <div>
          <span className="section-label">VIDEOBOOK / {screen.toUpperCase()}</span>
          <h1>{title}</h1>
          <p>
            {screen === 'projects' && 'Fresh local-first projects and their canonical project books.'}
            {screen === 'library' && 'Reusable prompts, characters, scenes, images, and videos.'}
            {screen === 'jobs' && 'Queued project-book actions and provider operations.'}
            {screen === 'settings' && 'Provider credentials, routing, and model defaults.'}
            {screen === 'diagnostics' && 'Catalog, CAS, MCP, and publication health.'}
          </p>
          <span className="workspace-notice">{notice}</span>
        </div>
        {screen !== 'settings' && (
          <button type="button" onClick={() => void onRefresh()} disabled={busy}>
            <RefreshCw size={16} className={busy ? 'spin' : ''} />
            Refresh
          </button>
        )}
      </header>

      {screen === 'projects' && (
        <form
          className="project-create"
          onSubmit={(event) => {
            event.preventDefault()
            const slug = newProjectSlug.trim()
            if (!slug) return
            setNewProjectSlug('')
            void onCreateProject(slug).then(onOutcome)
          }}
        >
          <label>
            New project slug
            <input
              value={newProjectSlug}
              onChange={(event) => setNewProjectSlug(event.target.value)}
              placeholder="moon-garden"
              pattern="[a-z0-9](?:[a-z0-9]|-)*"
              disabled={busy}
            />
          </label>
          <button type="submit" disabled={busy || !newProjectSlug.trim()}>
            <Plus size={16} />
            Create project
          </button>
        </form>
      )}

      {screen === 'library' && (
        <form
          className="project-create entity-create"
          onSubmit={(event) => {
            event.preventDefault()
            const name = entityName.trim()
            if (!name) return
            setEntityName('')
            setEntityPrompt('')
            void onCreateEntity(entityType, name, entityPrompt.trim()).then(onOutcome)
          }}
        >
          <label>
            Entity type
            <select
              value={entityType}
              onChange={(event) => setEntityType(event.target.value as EntityKind)}
              disabled={busy}
            >
              <option value="prompt">Prompt</option>
              <option value="character">Character</option>
              <option value="scene">Scene</option>
            </select>
          </label>
          <label>
            Name
            <input
              value={entityName}
              onChange={(event) => setEntityName(event.target.value)}
              placeholder="Moon gardener"
              disabled={busy}
            />
          </label>
          <label>
            Prompt
            <input
              value={entityPrompt}
              onChange={(event) => setEntityPrompt(event.target.value)}
              placeholder="Reusable visual description"
              disabled={busy}
            />
          </label>
          <button type="submit" disabled={busy || !entityName.trim()}>
            <Plus size={16} />
            Create entity
          </button>
        </form>
      )}

      {screen === 'settings' ? (
        <div className="settings-grid">
          <label>
            Project slug
            <input value={projectSlug || 'No project selected'} readOnly />
          </label>
          <label>
            Project book
            <input value={bookSummary} readOnly />
          </label>
          {['OpenAI', 'KIE', 'FAL', 'Google Flow', 'ElevenLabs', 'Backblaze B2'].map(
            (provider) => (
              <article key={provider} className="provider-card">
                <span className="provider-dot" />
                <div>
                  <strong>{provider}</strong>
                  <p>Environment-managed credential</p>
                </div>
                <button type="button" disabled>Environment managed</button>
              </article>
            ),
          )}
        </div>
      ) : (
        <div className="record-grid">
          {records.length === 0 ? (
            <>
              <EmptyRecord icon={Boxes} label="No records loaded" />
              <EmptyRecord icon={Sparkles} label="Use Refresh or the command bar" />
              <EmptyRecord icon={BookOpen} label="Local data stays revisioned" />
            </>
          ) : (
            records.map((record, index) => {
              const project =
                screen === 'projects'
                && typeof record === 'object'
                && record !== null
                && 'slug' in record
                  ? String(record.slug)
                  : null
              const entity =
                screen === 'library'
                && typeof record === 'object'
                && record !== null
                && 'id' in record
                && 'type' in record
                && (record.type === 'prompt'
                  || record.type === 'character'
                  || record.type === 'scene')
                  ? {
                      id: String(record.id),
                      type: record.type as EntityKind,
                    }
                  : null
              if (project) {
                return (
                  <ProjectRecordCard
                    key={project}
                    record={record}
                    slug={project}
                    busy={busy}
                    onOpen={() => void onOpenProject(project).then(onOutcome)}
                    onRename={(next) => onRenameProject(project, next)}
                    onDelete={() => onDeleteProject(project)}
                    onOutcome={onOutcome}
                  />
                )
              }
              return (
                <article className="record-card" key={`${screen}-${index}`}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <pre>{JSON.stringify(record, null, 2)}</pre>
                  {entity && (
                    <button
                      type="button"
                      onClick={() => void onDeleteEntity(entity.type, entity.id).then(onOutcome)}
                    >
                      Delete entity
                    </button>
                  )}
                </article>
              )
            })
          )}
        </div>
      )}
    </section>
  )
}

function ProjectRecordCard({
  record,
  slug,
  busy,
  onOpen,
  onRename,
  onDelete,
  onOutcome,
}: {
  record: unknown
  slug: string
  busy: boolean
  onOpen: () => void
  onRename: (slug: string) => Promise<ComposerOutcome>
  onDelete: () => Promise<ComposerOutcome>
  onOutcome: (outcome: ComposerOutcome) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(slug)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const project = typeof record === 'object' && record !== null
    ? record as Record<string, unknown>
    : {}
  const assetCount = typeof project.asset_count === 'number'
    ? project.asset_count
    : 0
  const created = typeof project.created === 'number'
    ? new Date(project.created * 1000).toLocaleDateString()
    : 'Fresh project'

  return (
    <article className="record-card project-record-card">
      <span>{slug}</span>
      <div className="project-record-meta">
        <strong>{assetCount} {assetCount === 1 ? 'asset' : 'assets'}</strong>
        <small>{created}</small>
      </div>
      {renaming ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const next = renameValue.trim()
            if (!next || next === slug) return
            void onRename(next).then((outcome) => {
              onOutcome(outcome)
              if (outcome.ok) setRenaming(false)
            })
          }}
        >
          <input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            pattern="[a-z0-9](?:[a-z0-9]|-)*"
            autoFocus
          />
          <button type="submit" disabled={busy}>Rename</button>
          <button type="button" onClick={() => setRenaming(false)}>Cancel</button>
        </form>
      ) : confirmingDelete ? (
        <div className="project-delete-confirm">
          <span>Delete {slug}?</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onDelete().then((outcome) => {
              onOutcome(outcome)
              if (!outcome.ok) setConfirmingDelete(false)
            })}
          >
            <Trash2 size={14} />
            Confirm delete
          </button>
          <button type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button>
        </div>
      ) : (
        <div className="record-card-actions">
          <button type="button" onClick={onOpen}>Open project</button>
          <button type="button" onClick={() => setRenaming(true)}>Rename</button>
          <button type="button" onClick={() => setConfirmingDelete(true)}>Delete</button>
        </div>
      )}
    </article>
  )
}

function EmptyRecord({
  icon: Icon,
  label,
}: {
  icon: typeof Boxes
  label: string
}) {
  return (
    <div className="empty-record">
      <Icon size={24} />
      <strong>{label}</strong>
    </div>
  )
}

export default App
