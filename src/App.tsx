import { useCallback, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import {
  Activity,
  BookOpen,
  Boxes,
  ChevronDown,
  CircleDot,
  Clock3,
  Film,
  FolderKanban,
  Image,
  Library,
  Menu,
  MessageSquareText,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Sparkles,
  UserRound,
  Video,
  X,
} from 'lucide-react'
import { useMcp } from 'use-mcp/react'

type Screen =
  | 'notebook'
  | 'projects'
  | 'library'
  | 'history'
  | 'jobs'
  | 'settings'
  | 'diagnostics'

type CellKind = 'image' | 'video' | 'prompt' | 'character' | 'scene'
type EntityKind = 'prompt' | 'character' | 'scene'

interface CellData extends Record<string, unknown> {
  kind: CellKind
  title: string
  subtitle: string
  stage: number
  status?: string
  preview?: string
  prompt?: string
  model?: string
  entityId?: string
  outputAssetId?: string
  inputs?: Record<string, unknown>
}

interface ToolResponse {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

const mcpUrl = new URL('/mcp', window.location.origin).toString()

const nodeTypes = { cell: CellNode }

const navigation: Array<{
  id: Screen
  label: string
  icon: typeof BookOpen
}> = [
  { id: 'notebook', label: 'Notebook', icon: BookOpen },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'library', label: 'Entities', icon: Library },
  { id: 'history', label: 'History', icon: Clock3 },
  { id: 'jobs', label: 'Jobs', icon: Activity },
  { id: 'settings', label: 'Providers', icon: Settings },
  { id: 'diagnostics', label: 'Diagnostics', icon: CircleDot },
]

const palette = [
  { kind: 'prompt' as const, label: 'Prompt', icon: MessageSquareText },
  { kind: 'image' as const, label: 'Image', icon: Image },
  { kind: 'video' as const, label: 'Video', icon: Video },
  { kind: 'character' as const, label: 'Character', icon: UserRound },
  { kind: 'scene' as const, label: 'Scene', icon: Film },
]

function CellNode({ data, selected }: NodeProps<Node<CellData>>) {
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

function parseToolResult(result: unknown): unknown {
  const response = result as ToolResponse
  const text = response.content?.find((item) => item.type === 'text')?.text
  if (response.isError) {
    throw new Error(text ?? 'MCP tool failed')
  }
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function App() {
  const mcp = useMcp({
    url: mcpUrl,
    clientName: 'videobook',
    transportType: 'http',
    autoReconnect: 3000,
  })
  const [screen, setScreen] = useState<Screen>('projects')
  const [nodes, setNodes] = useState<Array<Node<CellData>>>([])
  const [edges, setEdges] = useState<Array<Edge>>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [projectSlug, setProjectSlug] = useState('')
  const [notebookName, setNotebookName] = useState('Scratch')
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 720)
  const [navOpen, setNavOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('Local draft')
  const [records, setRecords] = useState<unknown[]>([])

  const selected = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  )

  const call = useCallback(
    async (tool: string, args: Record<string, unknown>) => {
      if (mcp.state !== 'ready') throw new Error('MCP server is not ready')
      return parseToolResult(await mcp.callTool(tool, args))
    },
    [mcp],
  )

  const refreshScreen = useCallback(async () => {
    setBusy(true)
    try {
      if (screen === 'library') {
        const values = await Promise.all([
          call('list_prompts', { project_slug: projectSlug }),
          call('list_characters', { project_slug: projectSlug }),
          call('list_scenes', { project_slug: projectSlug }),
        ])
        setRecords(values.flatMap((value) => (Array.isArray(value) ? value : [])))
        setNotice(`Updated ${new Date().toLocaleTimeString()}`)
        return
      }
      const tool =
        screen === 'projects'
          ? 'list_projects'
          : screen === 'history'
              ? 'revision_history'
              : screen === 'jobs'
                ? 'list_jobs'
                : screen === 'diagnostics'
                  ? 'storage_status'
                  : 'list_notebooks'
      const args =
        tool === 'storage_status'
          ? {}
          : { project_slug: projectSlug }
      const value = await call(tool, args)
      setRecords(Array.isArray(value) ? value : [value])
      setNotice(`Updated ${new Date().toLocaleTimeString()}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [call, projectSlug, screen])

  const createEntity = useCallback(
    async (type: EntityKind, name: string, prompt: string) => {
      setBusy(true)
      try {
        const tool =
          type === 'character'
            ? 'create_character_entity'
            : `create_${type}`
        const value = await call(tool, {
          project_slug: projectSlug,
          name,
          ...(prompt ? { prompt } : {}),
        })
        setRecords((current) => [value, ...current])
        setNotice(`Created ${type} ${name}`)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [call, projectSlug],
  )

  const deleteEntity = useCallback(
    async (type: EntityKind, id: string) => {
      setBusy(true)
      try {
        await call(`delete_${type}`, {
          project_slug: projectSlug,
          entity_id: id,
        })
        setRecords((current) =>
          current.filter(
            (record) =>
              !(
                typeof record === 'object' &&
                record !== null &&
                'id' in record &&
                record.id === id
              ),
          ),
        )
        setNotice(`Deleted ${type} ${id}`)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [call, projectSlug],
  )

  const openProject = useCallback(
    async (slug: string) => {
      setBusy(true)
      try {
        const value = await call('get_notebook', {
          project_slug: slug,
          notebook_id: 'nb-scratch',
        })
        const notebook = value as {
          name?: string
          cells?: Array<{
            id: string
            type: CellKind
            title?: string
            position?: { x: number; y: number }
            prompt?: string
            model?: string
            entityId?: string
            outputAssetId?: string
            inputs?: Record<string, unknown>
          }>
          edges?: Array<{
            id: string
            source: string
            target: string
            targetInput?: string
          }>
        }
        setProjectSlug(slug)
        setNotebookName(notebook.name ?? 'Scratch')
        setNodes(
          (notebook.cells ?? []).map((cell, index) => ({
            id: cell.id,
            type: 'cell',
            position: cell.position ?? {
              x: 120 + (index % 3) * 340,
              y: 80 + Math.floor(index / 3) * 320,
            },
            data: {
              kind: cell.type,
              title: cell.title ?? cell.id,
              subtitle: `${cell.type.toUpperCase()} · CELL`,
              stage: Math.floor(index / 3) + 1,
              status: 'ready',
              ...(cell.prompt ? { prompt: cell.prompt } : {}),
              ...(cell.model ? { model: cell.model } : {}),
              ...(cell.entityId ? { entityId: cell.entityId } : {}),
              ...(cell.outputAssetId
                ? { outputAssetId: cell.outputAssetId }
                : {}),
              ...(cell.inputs ? { inputs: cell.inputs } : {}),
            },
          })),
        )
        setEdges(
          (notebook.edges ?? []).map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            targetHandle: edge.targetInput,
          })),
        )
        setSelectedId(null)
        setScreen('notebook')
        setNotice(`Opened ${slug}`)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [call],
  )

  const createProject = useCallback(
    async (slug: string) => {
      setBusy(true)
      try {
        const value = (await call('create_project', {
          project_slug: slug,
        })) as { slug?: string }
        const createdSlug = value.slug ?? slug
        setRecords((current) => [value, ...current])
        setNotice(`Created ${createdSlug}`)
        await openProject(createdSlug)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [call, openProject],
  )

  const saveNotebook = useCallback(async () => {
    setBusy(true)
    try {
      const notebook = {
        id: 'nb-scratch',
        name: notebookName,
        version: 2,
        cells: nodes.map((node) => ({
          id: node.id,
          type: node.data.kind,
          title: node.data.title,
          position: node.position,
          ...(node.data.prompt ? { prompt: node.data.prompt } : {}),
          ...(node.data.model ? { model: node.data.model } : {}),
          ...(node.data.entityId ? { entityId: node.data.entityId } : {}),
          ...(node.data.outputAssetId
            ? { outputAssetId: node.data.outputAssetId }
            : {}),
          ...(node.data.inputs ? { inputs: node.data.inputs } : {}),
        })),
        edges: edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          targetInput: edge.targetHandle ?? 'input',
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await call('update_notebook', {
        project_slug: projectSlug,
        notebook,
      })
      setNotice('Notebook revision saved')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [call, edges, nodes, notebookName, projectSlug])

  const runNotebook = useCallback(async () => {
    setBusy(true)
    try {
      const result = await call('run_notebook', {
        project_slug: projectSlug,
        notebook_id: 'nb-scratch',
      })
      setRecords([result])
      setNotice('Notebook run completed')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [call, projectSlug])

  const addCell = useCallback((kind: CellKind) => {
    const id = `${kind}-${crypto.randomUUID().slice(0, 6)}`
    setNodes((current) => [
      ...current,
      {
        id,
        type: 'cell',
        position: { x: 420, y: 460 + current.length * 36 },
        data: {
          kind,
          title: `New ${kind}`,
          subtitle: `${kind.toUpperCase()} · CELL`,
          stage: 2,
          status: 'draft',
        },
      },
    ])
    setSelectedId(id)
    setPanelOpen(true)
  }, [])

  return (
    <main className="app-shell">
      <header className="topbar">
        <button
          className="mobile-menu"
          type="button"
          onClick={() => setNavOpen((value) => !value)}
          aria-label="Toggle navigation"
        >
          <Menu size={18} />
        </button>
        <div className="brand-lockup">
          <BookOpen size={18} />
          <span>/videobook</span>
          <strong>{screen === 'notebook' ? notebookName.toLowerCase() : screen}</strong>
        </div>
        <div className="project-switcher">
          <span>PROJECT</span>
          <button
            type="button"
            onClick={() => {
              setScreen('projects')
              setRecords([])
            }}
          >
            {projectSlug || 'Select project'}
            <ChevronDown size={14} />
          </button>
        </div>
        <div className="topbar-actions">
          <span className={`connection connection-${mcp.state}`}>
            {mcp.state}
          </span>
          <span className="notice">{notice}</span>
          {screen === 'notebook' && (
            <>
              <button
                type="button"
                onClick={saveNotebook}
                disabled={busy || !projectSlug}
              >
                <Save size={15} />
                Save
              </button>
              <button
                className="primary-action"
                type="button"
                onClick={runNotebook}
                disabled={busy || !projectSlug}
              >
                <Play size={15} />
                Run
              </button>
            </>
          )}
        </div>
      </header>

      <aside className={`navigation ${navOpen ? 'navigation-open' : ''}`}>
        <div className="navigation-mark">VB</div>
        <nav>
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                type="button"
                key={item.id}
                className={screen === item.id ? 'active' : ''}
                disabled={item.id === 'notebook' && !projectSlug}
                onClick={() => {
                  setScreen(item.id)
                  setRecords([])
                  setNavOpen(false)
                }}
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
          <aside className="palette">
            <span className="section-label">CELLS</span>
            {palette.map((item) => {
              const Icon = item.icon
              return (
                <button
                  type="button"
                  key={item.kind}
                  onClick={() => addCell(item.kind)}
                  title={`Add ${item.label}`}
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                </button>
              )
            })}
            <button type="button" className="palette-add" onClick={() => addCell('prompt')}>
              <Plus size={20} />
            </button>
          </aside>

          <section className="canvas">
            <div className="stage stage-1">
              <span>STAGE 01</span>
            </div>
            <div className="stage stage-2">
              <span>STAGE 02</span>
            </div>
            <div className="stage stage-3">
              <span>STAGE 03</span>
            </div>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={(changes) => {
                setNodes((current) =>
                  current.map((node) => {
                    const change = changes.find(
                      (item) => 'id' in item && item.id === node.id,
                    )
                    return change?.type === 'position' && change.position
                      ? { ...node, position: change.position }
                      : node
                  }),
                )
              }}
              onNodeClick={(_, node) => {
                setSelectedId(node.id)
                setPanelOpen(true)
              }}
              onConnect={(connection: Connection) => {
                setEdges((current) =>
                  addEdge(
                    {
                      ...connection,
                      id: `edge-${crypto.randomUUID().slice(0, 8)}`,
                      targetHandle: connection.targetHandle ?? 'input',
                    },
                    current,
                  ),
                )
              }}
              onPaneClick={() => setSelectedId(null)}
              fitView
              minZoom={0.35}
              maxZoom={1.7}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="rgba(93, 220, 164, .09)" gap={36} size={1} />
              <MiniMap
                className="minimap"
                nodeColor="rgba(111, 234, 177, .65)"
                maskColor="rgba(2, 10, 7, .74)"
              />
              <Controls className="flow-controls" />
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
                    onChange={(event) => {
                      const value = event.target.value
                      setNodes((current) =>
                        current.map((node) =>
                          node.id === selected.id
                            ? {
                                ...node,
                                data: { ...node.data, title: value },
                              }
                            : node,
                        ),
                      )
                    }}
                  />
                </label>
                <label>
                  Model
                  <select
                    value={selected.data.model ?? 'auto'}
                    onChange={(event) => {
                      const value = event.target.value
                      setNodes((current) =>
                        current.map((node) =>
                          node.id === selected.id
                            ? {
                                ...node,
                                data: { ...node.data, model: value },
                              }
                            : node,
                        ),
                      )
                    }}
                  >
                    <option value="auto">Auto route</option>
                    <option value="nano-banana">Nano Banana</option>
                    <option value="seedance">Seedance 2</option>
                    <option value="grok">Grok Imagine</option>
                  </select>
                </label>
                <label>
                  Prompt
                  <textarea
                    rows={7}
                    value={selected.data.prompt ?? ''}
                    onChange={(event) => {
                      const value = event.target.value
                      setNodes((current) =>
                        current.map((node) =>
                          node.id === selected.id
                            ? {
                                ...node,
                                data: { ...node.data, prompt: value },
                              }
                            : node,
                        ),
                      )
                    }}
                    placeholder="Describe the desired result or reference a reusable prompt…"
                  />
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
          onRefresh={refreshScreen}
          projectSlug={projectSlug}
          notebookName={notebookName}
          onCreateProject={createProject}
          onOpenProject={openProject}
          onCreateEntity={createEntity}
          onDeleteEntity={deleteEntity}
        />
      )}
    </main>
  )
}

interface WorkspaceScreenProps {
  screen: Exclude<Screen, 'notebook'>
  records: unknown[]
  busy: boolean
  onRefresh: () => void
  projectSlug: string
  notebookName: string
  onCreateProject: (slug: string) => void
  onOpenProject: (slug: string) => void
  onCreateEntity: (type: EntityKind, name: string, prompt: string) => void
  onDeleteEntity: (type: EntityKind, id: string) => void
}

function WorkspaceScreen({
  screen,
  records,
  busy,
  onRefresh,
  projectSlug,
  notebookName,
  onCreateProject,
  onOpenProject,
  onCreateEntity,
  onDeleteEntity,
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
        </div>
        {screen !== 'settings' && (
          <button type="button" onClick={onRefresh} disabled={busy}>
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
            onCreateProject(slug)
            setNewProjectSlug('')
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
            onCreateEntity(entityType, name, entityPrompt.trim())
            setEntityName('')
            setEntityPrompt('')
          }}
        >
          <label>
            Entity type
            <select
              value={entityType}
              onChange={(event) =>
                setEntityType(event.target.value as EntityKind)
              }
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
              <EmptyRecord icon={Sparkles} label="Use Refresh to query MCP" />
              <EmptyRecord icon={BookOpen} label="Local data stays revisioned" />
            </>
          ) : (
            records.map((record, index) => {
              const project =
                screen === 'projects' &&
                typeof record === 'object' &&
                record !== null &&
                'slug' in record
                  ? String(record.slug)
                  : null
              const entity =
                screen === 'library' &&
                typeof record === 'object' &&
                record !== null &&
                'id' in record &&
                'type' in record &&
                (record.type === 'prompt' ||
                  record.type === 'character' ||
                  record.type === 'scene')
                  ? {
                      id: String(record.id),
                      type: record.type as EntityKind,
                    }
                  : null
              return (
                <article className="record-card" key={`${screen}-${index}`}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <pre>{JSON.stringify(record, null, 2)}</pre>
                  {project && (
                    <button type="button" onClick={() => onOpenProject(project)}>
                      Open project
                    </button>
                  )}
                  {entity && (
                    <button
                      type="button"
                      onClick={() => onDeleteEntity(entity.type, entity.id)}
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

function EmptyRecord({
  icon: Icon,
  label,
}: {
  icon: typeof Boxes
  label: string
}) {
  return (
    <article className="empty-record">
      <Icon size={26} />
      <strong>{label}</strong>
    </article>
  )
}

export default App
