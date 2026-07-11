import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { genThemes } from '@/components/gen/ui/gen-themes'
import { cardTone } from '@/theme/domains'

const root = join(import.meta.dirname)

describe('notebook generation editor order and domain themes', () => {
  it('renders Options and Characters before Prompt in GenerationSidebar', () => {
    const sidebar = readFileSync(join(root, 'NotebookSidebar.tsx'), 'utf8')
    const optionsIdx = sidebar.indexOf('<label>Options</label>')
    const charactersIdx = sidebar.indexOf('variant="inline"')
    const promptIdx = sidebar.indexOf('<label>Prompt</label>', sidebar.indexOf('function GenerationSidebar'))
    expect(optionsIdx).toBeGreaterThan(-1)
    expect(charactersIdx).toBeGreaterThan(-1)
    expect(promptIdx).toBeGreaterThan(-1)
    expect(optionsIdx).toBeLessThan(promptIdx)
    expect(charactersIdx).toBeLessThan(promptIdx)
  })

  it('binds image/video genThemes and domain accents, not notebook, on gen surfaces', () => {
    const sidebar = readFileSync(join(root, 'NotebookSidebar.tsx'), 'utf8')
    expect(sidebar).toContain('const domainTheme = genThemes[category]')
    expect(sidebar).toContain('theme={domainTheme}')
    expect(sidebar).toContain('domain={category}')
    expect(sidebar).toContain("category === 'image' ? 'vc-notebook-run-image' : 'vc-notebook-run-video'")
    expect(sidebar).not.toMatch(/theme=\{genThemes\.notebook\}/)
    expect(sidebar).not.toContain('domain="notebook"')

    expect(genThemes.image).toBeDefined()
    expect(genThemes.video).toBeDefined()
    expect(cardTone('image').color).toBe('#22d3ee')
    expect(cardTone('video').color).toBe('#a78bfa')
    expect(cardTone('notebook').color).toBe('#34d399')
  })

  it('uses one emerald HUD shell with image and video limited to compact accents', () => {
    const css = readFileSync(join(root, 'notebook.css'), 'utf8')
    const unifiedRun = css.lastIndexOf('.vc-notebook-run,')
    const oldVideoSurface = css.indexOf('.vc-notebook-run-video {')
    expect(css).toContain('--vc-line-strong: rgb(110 231 183')
    expect(css).toContain('--vc-image: rgb(34 211 238)')
    expect(css).toContain('--vc-video: rgb(167 139 250)')
    expect(css).toContain('.vc-node-image {\n  --vc-node-accent: var(--vc-image)')
    expect(css).toContain('.vc-node-video {\n  --vc-node-accent: var(--vc-video)')
    expect(css).toContain('.vc-notebook-sidebar-video .vc-notebook-editor label')
    expect(css).toContain('.vc-notebook-action-deck')
    expect(unifiedRun).toBeGreaterThan(oldVideoSurface)
    expect(css.slice(unifiedRun)).toContain('border-color: rgb(110 231 183 / 0.52)')
    expect(css.slice(unifiedRun)).toContain('background:')
  })

  it('renders stage rows, drop preview, and locked snap controls', () => {
    const notebook = readFileSync(join(root, 'PlanNotebook.tsx'), 'utf8')
    const stageBoard = readFileSync(join(root, 'NotebookStageBoard.tsx'), 'utf8')
    const toolbox = readFileSync(join(root, 'NotebookToolbox.tsx'), 'utf8')
    const flow = readFileSync(join(root, 'useNotebookFlow.ts'), 'utf8')
    expect(notebook).toContain('<NotebookStageBoard')
    expect(notebook).toContain('notebookDropTarget')
    expect(notebook).toContain('reorderStepsOnTracks')
    expect(notebook).toContain('Auto-arrange')
    expect(notebook).toContain('/notebook')
    expect(stageBoard).toContain('<ViewportPortal>')
    expect(stageBoard).toContain('vc-notebook-stage-row')
    expect(stageBoard).toContain('vc-notebook-drop-link')
    expect(toolbox).toContain('Snap locked')
    expect(toolbox).not.toContain('Deploy')
    expect(flow).toContain('function activeRoute')
    expect(flow).toContain('vc-notebook-edge-active')
    expect(flow).toContain('vc-notebook-edge-muted')
  })

  it('disables Generate only while submit is in flight, not while asset is pending', () => {
    const sidebar = readFileSync(join(root, 'NotebookSidebar.tsx'), 'utf8')
    expect(sidebar).toContain('disabled={requiredMissing.length > 0 || !readiness.ready || running}')
    expect(sidebar).not.toContain("runStatus.state === 'pending'")
    expect(sidebar).toContain("running ? 'Generating' : 'Generate'")
    expect(sidebar).toContain('<RunStatus status={runStatus.state} />')
  })

  it('wires GenNode media input strip from graph-ordered connectedMediaInputs', () => {
    const genNode = readFileSync(join(root, 'nodes/GenNode.tsx'), 'utf8')
    const flow = readFileSync(join(root, 'useNotebookFlow.ts'), 'utf8')
    const sizes = readFileSync(join(root, 'model.ts'), 'utf8')
    expect(flow).toContain('connectedMediaInputs(definition, step, mediaItems)')
    expect(flow).toContain('mediaInputs:')
    expect(genNode).toContain('vc-node-input-strip')
    expect(genNode).toContain('vc-node-input-thumb')
    expect(genNode).toContain('mediaInputs')
    expect(genNode).toContain('thumbnailSrc')
    expect(genNode).toMatch(/item\.kind === 'video' \? Video : ImageIcon/)
    expect(sizes).toContain('image: { width: 220, height: 248 }')
    expect(sizes).toContain('video: { width: 220, height: 248 }')
  })
})
