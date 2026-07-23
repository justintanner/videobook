import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  addEdge,
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
  NotebookCellType,
  NotebookDocument,
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
  notebookDocument,
  notebookEdges,
  notebookNodes,
  type NotebookCellData,
} from '@/videobook/notebook-draft'
import {
  nextNotebookGridSlot,
  notebookGridSlot,
  resolveNotebookGridMove,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'

type Screen =
  | 'notebook'
  | 'projects'
  | 'library'
  | 'history'
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

interface AssetRecord {
  id?: string
  slug?: string
}

const mcpUrl = new URL('/mcp', window.location.origin).toString()
const nodeTypes = { cell: CellNode }

const navigation: Array<{
  id: Exclude<Screen, 'settings'>
  label: string
  icon: typeof BookOpen
}> = [
  { id: 'notebook', label: 'Notebook', icon: BookOpen },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'library', label: 'Entities', icon: Library },
  { id: 'history', label: 'History', icon: Clock3 },
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

function cellKindFromDrag(value: string): NotebookCellType | null {
  return palette.some((item) => item.kind === value)
    ? value as NotebookCellType
    : null
}

function CellNode({ data, selected }: NodeProps<Node<NotebookCellData>>) {
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
      {data.preview ? (
        <div className={`cell-preview preview-${data.preview}`}>
          <div className="preview-orb" />
          <div className="preview-ears" />
        </div>
      ) : (
        <div className="cell-copy">
          <Sparkles size={26} />
          <span>Reusable context</span>
        </div>
      )}
      <footer className="cell-node-footer">
        <span>{data.title}</span>
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

function asNotebooks(value: unknown): NotebookDocument[] {
  return asArray(value).filter((item): item is NotebookDocument => (
    typeof item === 'object'
    && item !== null
    && 'id' in item
    && typeof item.id === 'string'
    && 'version' in item
    && item.version === 2
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

function asAssetSlugs(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || !('assets' in value)) {
    return []
  }
  return asArray(value.assets)
    .flatMap((item) => {
      const asset = item as AssetRecord
      const slug = asset.slug ?? asset.id
      return typeof slug === 'string' ? [slug.replace(/^@/, '')] : []
    })
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

function ProjectMenu({
  open,
  activeSlug,
  projects,
  busy,
  onToggle,
  onSwitch,
  onManage,
}: {
  open: boolean
  activeSlug: string
  projects: ProjectRecord[]
  busy: boolean
  onToggle: () => void
  onSwitch: (slug: string) => Promise<ComposerOutcome>
  onManage: () => void
}) {
  return (
    <div className="brand-project">
      <button
        type="button"
        className="brand-project-trigger"
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <BookOpen size={18} />
        <span>/videobook</span>
        <strong>{activeSlug || 'select-project'}</strong>
        <ChevronDown size={14} />
      </button>
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
  const [nodes, setNodes] = useState<Array<Node<NotebookCellData>>>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [projectSlug, setProjectSlug] = useState('')
  const [activeNotebook, setActiveNotebook] = useState<NotebookDocument | null>(null)
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 720)
  const [promptOpen, setPromptOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [paletteDragKind, setPaletteDragKind] = useState<NotebookCellType | null>(null)
  const [previewSlot, setPreviewSlot] = useState<NotebookGridSlot | null>(null)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [records, setRecords] = useState<unknown[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [commands, setCommands] = useState<ServerCommand[]>([])
  const [assetSlugs, setAssetSlugs] = useState<string[]>([])
  const [workspaceNotice, setWorkspaceNotice] = useState('Ready')

  const nodesRef = useRef<Array<Node<NotebookCellData>>>([])
  const edgesRef = useRef<Edge[]>([])
  const projectSlugRef = useRef('')
  const activeNotebookRef = useRef<NotebookDocument | null>(null)
  const dirtyRef = useRef(false)
  const changeVersionRef = useRef(0)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const flowRef = useRef<ReactFlowInstance<Node<NotebookCellData>, Edge> | null>(null)

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
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])

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

  const setCurrentNotebook = useCallback((document: NotebookDocument | null) => {
    activeNotebookRef.current = document
    setActiveNotebook(document)
  }, [])

  const markDirty = useCallback(() => {
    dirtyRef.current = true
    changeVersionRef.current += 1
    setDirty(true)
  }, [])

  const replaceNodes = useCallback((
    next: Array<Node<NotebookCellData>>,
    shouldMarkDirty = true,
  ) => {
    nodesRef.current = next
    setNodes(next)
    if (shouldMarkDirty) markDirty()
  }, [markDirty])

  const replaceEdges = useCallback((next: Edge[], shouldMarkDirty = true) => {
    edgesRef.current = next
    setEdges(next)
    if (shouldMarkDirty) markDirty()
  }, [markDirty])

  const persistCore = useCallback(async (): Promise<ComposerOutcome> => {
    const base = activeNotebookRef.current
    const slug = projectSlugRef.current
    if (!base || !slug) return { ok: false, message: 'No notebook is open' }
    if (!dirtyRef.current) return { ok: true, message: 'Notebook is current' }
    const version = changeVersionRef.current
    const next = notebookDocument(
      base,
      nodesRef.current,
      edgesRef.current,
      new Date().toISOString(),
    )
    setBusy(true)
    try {
      const revision = await call('update_notebook', {
        project_slug: slug,
        notebook: next,
      })
      setCurrentNotebook(next)
      if (changeVersionRef.current === version) {
        dirtyRef.current = false
        setDirty(false)
      }
      return {
        ok: true,
        message: summarize(revision, `Saved ${next.name}`),
      }
    } catch (error) {
      dirtyRef.current = true
      setDirty(true)
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, setCurrentNotebook])

  const persistNotebook = useCallback((): Promise<ComposerOutcome> => {
    const queued = saveQueueRef.current.then(persistCore, persistCore)
    saveQueueRef.current = queued.then(() => undefined, () => undefined)
    return queued
  }, [persistCore])

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

  const loadAssets = useCallback(async (slug: string) => {
    const value = await call('list_assets', { project_slug: slug })
    const next = asAssetSlugs(value)
    setAssetSlugs(next)
    return next
  }, [call])

  const installNotebook = useCallback((
    slug: string,
    document: NotebookDocument,
  ) => {
    setCurrentProject(slug)
    setCurrentNotebook(document)
    replaceNodes(notebookNodes(document), false)
    replaceEdges(notebookEdges(document), false)
    dirtyRef.current = false
    changeVersionRef.current = 0
    setDirty(false)
    setSelectedId(null)
    setPromptOpen(false)
    setPaletteDragKind(null)
    setPreviewSlot(null)
    setPanelOpen(window.innerWidth > 720)
    setScreen('notebook')
    setRecords([])
  }, [
    replaceEdges,
    replaceNodes,
    setCurrentNotebook,
    setCurrentProject,
  ])

  const openProject = useCallback(async (
    slug: string,
  ): Promise<ComposerOutcome> => {
    if (dirtyRef.current) {
      const saved = await persistNotebook()
      if (!saved.ok) return saved
    }
    setBusy(true)
    try {
      let notebooks = asNotebooks(await call('list_notebooks', {
        project_slug: slug,
      }))
      if (notebooks.length === 0) {
        const created = await call('create_notebook', {
          project_slug: slug,
          name: 'Scratch',
        })
        notebooks = asNotebooks([created])
      }
      const document = notebooks.find((item) => item.id === 'nb-scratch')
        ?? notebooks[0]
      if (!document) throw new Error('Could not create or open a notebook')
      installNotebook(slug, document)
      await Promise.all([
        loadAssets(slug),
        loadCommands(),
        loadProjects(),
      ])
      setProjectMenuOpen(false)
      setWorkspaceNotice(`Opened ${slug}`)
      return { ok: true, message: `Opened ${slug}` }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [
    call,
    installNotebook,
    loadAssets,
    loadCommands,
    loadProjects,
    persistNotebook,
  ])

  const openNotebook = useCallback(async (
    name?: string,
  ): Promise<ComposerOutcome> => {
    const slug = projectSlugRef.current
    if (!slug) return { ok: false, message: 'Select a project first' }
    if (dirtyRef.current) {
      const saved = await persistNotebook()
      if (!saved.ok) return saved
    }
    setBusy(true)
    try {
      const notebooks = asNotebooks(await call('list_notebooks', {
        project_slug: slug,
      }))
      const requested = name?.trim().toLowerCase()
      let document = requested
        ? notebooks.find((item) => (
            item.id.toLowerCase() === requested
            || item.name.toLowerCase() === requested
          ))
        : notebooks[0]
      if (!document) {
        document = await call('create_notebook', {
          project_slug: slug,
          name: name?.trim() || 'Scratch',
        }) as NotebookDocument
      }
      installNotebook(slug, document)
      return { ok: true, message: `Opened ${document.name}` }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, installNotebook, persistNotebook])

  const runNotebook = useCallback(async (): Promise<ComposerOutcome> => {
    const saved = await persistNotebook()
    if (!saved.ok) return saved
    const document = activeNotebookRef.current
    const slug = projectSlugRef.current
    if (!document || !slug) return { ok: false, message: 'No notebook is open' }
    setBusy(true)
    try {
      const value = await call('run_notebook', {
        project_slug: slug,
        notebook_id: document.id,
      })
      setRecords([value])
      return { ok: true, message: summarize(value, `Ran ${document.name}`) }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, persistNotebook])

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
    if (oldSlug === projectSlugRef.current && dirtyRef.current) {
      const saved = await persistNotebook()
      if (!saved.ok) return saved
    }
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
    persistNotebook,
    setCurrentProject,
  ])

  const deleteProject = useCallback(async (
    slug: string,
  ): Promise<ComposerOutcome> => {
    if (slug === projectSlugRef.current && dirtyRef.current) {
      const saved = await persistNotebook()
      if (!saved.ok) return saved
    }
    setBusy(true)
    try {
      const value = await call('delete_project', { project_slug: slug })
      if (slug === projectSlugRef.current) {
        setCurrentProject('')
        setCurrentNotebook(null)
        replaceNodes([], false)
        replaceEdges([], false)
        setSelectedId(null)
        setPromptOpen(false)
        setAssetSlugs([])
        dirtyRef.current = false
        setDirty(false)
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
    persistNotebook,
    replaceEdges,
    replaceNodes,
    setCurrentNotebook,
    setCurrentProject,
  ])

  const navigateScreen = useCallback(async (next: Screen) => {
    if (screen === 'notebook' && next !== 'notebook' && dirtyRef.current) {
      const saved = await persistNotebook()
      if (!saved.ok) {
        setWorkspaceNotice(saved.message)
        return
      }
    }
    if (next !== 'notebook') setPromptOpen(false)
    setScreen(next)
    setRecords([])
    setNavOpen(false)
    setProjectMenuOpen(false)
  }, [persistNotebook, screen])

  const refreshScreen = useCallback(async () => {
    setBusy(true)
    try {
      let value: unknown
      if (screen === 'projects') {
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
        } else if (screen === 'history') {
          value = await call('revision_history', { project_slug: slug })
          setRecords(asArray(value))
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
  }, [call, screen])

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
      await loadAssets(slug)
      return { ok: true, message: summarize(value, `Created ${type}`) }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, loadAssets])

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
      await loadAssets(slug)
      return { ok: true, message: summarize(value, `Deleted ${type}`) }
    } catch (error) {
      return errorOutcome(error)
    } finally {
      setBusy(false)
    }
  }, [call, loadAssets])

  const addCell = useCallback((
    kind: NotebookCellType,
    requestedSlot?: NotebookGridSlot,
  ) => {
    const id = `${kind}-${crypto.randomUUID().slice(0, 6)}`
    const slot = requestedSlot ?? nextNotebookGridSlot(nodesRef.current)
    const next = resolveNotebookGridMove([
      ...nodesRef.current,
      {
        id,
        type: 'cell',
        position: { x: 0, y: 0 },
        data: {
          kind,
          title: `New ${kind}`,
          subtitle: `${kind.toUpperCase()} · CELL`,
          stage: slot.stage + 1,
          status: 'draft',
          prompt: '',
        },
      },
    ], id, slot)
    replaceNodes(next)
    setSelectedId(id)
    setPanelOpen(true)
    setPromptOpen(true)
    void persistNotebook()
  }, [persistNotebook, replaceNodes])

  const updateSelectedData = useCallback((
    id: string,
    patch: Partial<NotebookCellData>,
  ) => {
    replaceNodes(nodesRef.current.map((node) => (
      node.id === id
        ? { ...node, data: { ...node.data, ...patch } }
        : node
    )))
  }, [replaceNodes])

  const ensureCommandCatalog = useCallback(async () => {
    if (commands.length > 0 || mcp.state !== 'ready') return
    try {
      await Promise.all([
        loadCommands(),
        projectSlugRef.current
          ? loadAssets(projectSlugRef.current)
          : Promise.resolve([]),
      ])
    } catch {
      return
    }
  }, [commands.length, loadAssets, loadCommands, mcp.state])

  const executeUiAction = useCallback(async (
    action: string,
    args: Record<string, string>,
    raw: string,
  ): Promise<ComposerOutcome> => {
    if (action === 'save_notebook') return persistNotebook()
    if (action === 'run_notebook') return runNotebook()
    if (action === 'open_notebook') return openNotebook(args.name || raw || undefined)
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
    const screens: Record<string, Screen> = {
      open_projects: 'projects',
      open_entities: 'library',
      open_jobs: 'jobs',
      open_status: 'jobs',
      open_revisions: 'history',
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
    openNotebook,
    openProject,
    persistNotebook,
    renameProject,
    runNotebook,
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
          if (projectSlugRef.current) {
            void loadAssets(projectSlugRef.current)
          }
          return {
            ok: true,
            message: summarize(value, command.description),
          }
        }
        return { ok: false, message: `Command has no action: ${commandName}` }
      }
      if (dirtyRef.current) {
        const saved = await persistNotebook()
        if (!saved.ok) return saved
      }
      const slug = projectSlugRef.current
      if (!slug) return { ok: false, message: 'Select a project first' }
      const value = await call('chat', { project_slug: slug, prompt: input })
      void loadAssets(slug)
      return { ok: true, message: summarize(value, 'Done') }
    } catch (error) {
      return errorOutcome(error)
    }
  }, [call, commands, executeUiAction, loadAssets, persistNotebook])

  const promptSession = useMemo<PromptSession | null>(() => {
    if (screen !== 'notebook' || !selected || !promptOpen) return null
    return {
      id: selected.id,
      kind: selected.data.kind,
      title: selected.data.title,
      value: selected.data.prompt ?? '',
      assetSlugs,
      onChange: (value) => updateSelectedData(selected.id, { prompt: value }),
      onCommit: persistNotebook,
      onCollapse: async () => {
        setPromptOpen(false)
        return persistNotebook()
      },
    }
  }, [
    assetSlugs,
    persistNotebook,
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
                disabled={item.id === 'notebook' && !projectSlug}
                onClick={() => void navigateScreen(item.id)}
                title={item.label}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            )
          })}
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
              addCell(kind, notebookGridSlot(position))
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
                for (const change of changes) {
                  next = applyNodeChanges([change], next)
                  if (change.type === 'position' && change.position) {
                    next = resolveNotebookGridMove(
                      next,
                      change.id,
                      notebookGridSlot(change.position),
                    )
                  }
                }
                const changed = changes.some((change) => (
                  change.type === 'position' || change.type === 'remove'
                ))
                replaceNodes(next, changed)
                if (changes.some((change) => change.type === 'remove')) {
                  setSelectedId(null)
                  setPromptOpen(false)
                  void persistNotebook()
                }
              }}
              onEdgesChange={(changes) => {
                const next = applyEdgeChanges(changes, edgesRef.current)
                const changed = changes.some((change) => change.type === 'remove')
                replaceEdges(next, changed)
                if (changed) void persistNotebook()
              }}
              onNodeDragStop={() => {
                setPreviewSlot(null)
                void persistNotebook()
              }}
              onNodeClick={(_, node) => {
                if (node.id !== selectedId && dirtyRef.current) {
                  void persistNotebook()
                }
                setSelectedId(node.id)
                setPanelOpen(true)
                setPromptOpen(true)
              }}
              onConnect={(connection: Connection) => {
                replaceEdges(addEdge({
                  ...connection,
                  id: `edge-${crypto.randomUUID().slice(0, 8)}`,
                  targetHandle: connection.targetHandle ?? 'input',
                }, edgesRef.current))
                void persistNotebook()
              }}
              onPaneClick={() => {
                if (dirtyRef.current) void persistNotebook()
                setSelectedId(null)
                setPromptOpen(false)
              }}
              onInit={(instance) => {
                flowRef.current = instance
              }}
              fitView
              minZoom={0.35}
              maxZoom={1.7}
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
                        onClick={() => addCell(item.kind)}
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
                    onClick={() => addCell('prompt')}
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
                    onBlur={() => void persistNotebook()}
                  />
                </label>
                <label>
                  Model
                  <select
                    value={selected.data.model ?? 'auto'}
                    onChange={(event) => updateSelectedData(selected.id, {
                      model: event.target.value,
                    })}
                    onBlur={() => void persistNotebook()}
                  >
                    <option value="auto">Auto route</option>
                    <option value="nano-banana">Nano Banana</option>
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
          notebookName={activeNotebook?.name ?? 'No notebook'}
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
  notebookName: string
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
  notebookName,
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
            {screen === 'projects' && 'Fresh local-first projects and their notebook collections.'}
            {screen === 'library' && 'Reusable prompts, characters, scenes, images, and videos.'}
            {screen === 'history' && 'Forward-only DoltLite revisions with exact asset rewind.'}
            {screen === 'jobs' && 'Queued notebook runs and provider operations.'}
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
              pattern="[a-z0-9][a-z0-9-]*"
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
            Default notebook
            <input value={notebookName} readOnly />
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
            pattern="[a-z0-9][a-z0-9-]*"
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
