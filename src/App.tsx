import { useCallback, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
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

interface CellData extends Record<string, unknown> {
  kind: CellKind
  title: string
  subtitle: string
  stage: number
  status?: string
  preview?: string
}

interface ToolResponse {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

const mcpUrl = new URL('/mcp', window.location.origin).toString()

const initialNodes: Array<Node<CellData>> = [
  {
    id: 'img-look',
    type: 'cell',
    position: { x: 120, y: 110 },
    data: {
      kind: 'image',
      title: '@img-nbp-eyes-look-like',
      subtitle: 'ASSET · IMA',
      stage: 1,
      status: 'ready',
      preview: 'aurora',
    },
  },
  {
    id: 'img-profile',
    type: 'cell',
    position: { x: 500, y: 110 },
    data: {
      kind: 'image',
      title: '@img-vancatprofile',
      subtitle: 'ASSET · IMA',
      stage: 1,
      status: 'ready',
      preview: 'profile',
    },
  },
  {
    id: 'img-generation',
    type: 'cell',
    position: { x: 180, y: 570 },
    data: {
      kind: 'image',
      title: 'Celestial portrait',
      subtitle: 'GEN IMAGE · IMG',
      stage: 2,
      status: '$0.134',
      preview: 'result',
    },
  },
  {
    id: 'scene',
    type: 'cell',
    position: { x: 570, y: 610 },
    data: {
      kind: 'scene',
      title: 'Moon garden',
      subtitle: 'SCENE · SCN',
      stage: 2,
      status: 'configured',
    },
  },
  {
    id: 'video',
    type: 'cell',
    position: { x: 330, y: 1040 },
    data: {
      kind: 'video',
      title: 'Arrival sequence',
      subtitle: 'GEN VIDEO · VID',
      stage: 3,
      status: 'draft',
      preview: 'video',
    },
  },
]

const initialEdges = [
  { id: 'edge-1', source: 'img-look', target: 'img-generation', targetHandle: 'reference' },
  { id: 'edge-2', source: 'img-profile', target: 'img-generation', targetHandle: 'subject' },
  { id: 'edge-3', source: 'img-generation', target: 'video', targetHandle: 'first-frame' },
  { id: 'edge-4', source: 'scene', target: 'video', targetHandle: 'scene' },
]

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
  const [screen, setScreen] = useState<Screen>('notebook')
  const [nodes, setNodes] = useState(initialNodes)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [projectSlug, setProjectSlug] = useState('notebook-scratch')
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
      const tool =
        screen === 'projects'
          ? 'list_projects'
          : screen === 'library'
            ? 'list_characters'
            : screen === 'history'
              ? 'revision_history'
              : screen === 'jobs'
                ? 'sync'
                : screen === 'diagnostics'
                  ? 'storage_status'
                  : 'list_notebooks'
      const args =
        tool === 'storage_status'
          ? {}
          : tool === 'sync'
            ? { project_slug: projectSlug }
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
          ...(node.data.kind === 'image' ? { outputAssetId: node.id } : {}),
        })),
        edges: initialEdges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          targetInput: edge.targetHandle,
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
  }, [call, nodes, notebookName, projectSlug])

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
          <button type="button">
            {projectSlug}
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
              <button type="button" onClick={saveNotebook} disabled={busy}>
                <Save size={15} />
                Save
              </button>
              <button
                className="primary-action"
                type="button"
                onClick={runNotebook}
                disabled={busy}
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
                onClick={() => {
                  setScreen(item.id)
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
              edges={initialEdges}
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
                  <select defaultValue="auto">
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
                    placeholder="Describe the desired result or reference a reusable prompt…"
                  />
                </label>
                <div className="input-ports">
                  <span>INPUT PORTS</span>
                  <button type="button">+ reference</button>
                  <button type="button">+ subject</button>
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
          onProjectSlug={setProjectSlug}
          notebookName={notebookName}
          onNotebookName={setNotebookName}
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
  onProjectSlug: (value: string) => void
  notebookName: string
  onNotebookName: (value: string) => void
}

function WorkspaceScreen({
  screen,
  records,
  busy,
  onRefresh,
  projectSlug,
  onProjectSlug,
  notebookName,
  onNotebookName,
}: WorkspaceScreenProps) {
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
        <button type="button" onClick={onRefresh} disabled={busy}>
          <RefreshCw size={16} className={busy ? 'spin' : ''} />
          Refresh
        </button>
      </header>

      {screen === 'settings' ? (
        <div className="settings-grid">
          <label>
            Project slug
            <input value={projectSlug} onChange={(event) => onProjectSlug(event.target.value)} />
          </label>
          <label>
            Default notebook
            <input value={notebookName} onChange={(event) => onNotebookName(event.target.value)} />
          </label>
          {['OpenAI', 'KIE', 'FAL', 'Google Flow', 'ElevenLabs', 'Backblaze B2'].map(
            (provider) => (
              <article key={provider} className="provider-card">
                <span className="provider-dot" />
                <div>
                  <strong>{provider}</strong>
                  <p>Environment-managed credential</p>
                </div>
                <button type="button">Configure</button>
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
            records.map((record, index) => (
              <article className="record-card" key={`${screen}-${index}`}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <pre>{JSON.stringify(record, null, 2)}</pre>
              </article>
            ))
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
