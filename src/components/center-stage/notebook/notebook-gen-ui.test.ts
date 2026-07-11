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

  it('keeps notebook shell chrome emerald while gen cards use cyan/violet CSS', () => {
    const css = readFileSync(join(root, 'notebook.css'), 'utf8')
    expect(css).toContain('.vc-notebook-header > div:first-child > span:first-child')
    expect(css).toMatch(/color:\s*rgb\(110 231 183/)
    expect(css).toContain('.vc-node-image')
    expect(css).toContain('rgb(34 211 238')
    expect(css).toContain('.vc-node-video')
    expect(css).toContain('rgb(167 139 250')
    expect(css).toContain('.vc-notebook-run-image')
    expect(css).toContain('.vc-notebook-run-video')
    // Domain cost/hover rules must follow the base `.vc-notebook-run b` / hover so cascade wins.
    const baseB = css.indexOf('.vc-notebook-run b {')
    const imageB = css.indexOf('.vc-notebook-run-image b {')
    const videoB = css.indexOf('.vc-notebook-run-video b {')
    expect(baseB).toBeGreaterThan(-1)
    expect(imageB).toBeGreaterThan(baseB)
    expect(videoB).toBeGreaterThan(baseB)
    expect(css).toMatch(/\.vc-notebook-run-image:hover:not\(:disabled\)\s*\{[^}]*border-color:\s*rgb\(34 211 238/s)
    expect(css).toMatch(/\.vc-notebook-run-video:hover:not\(:disabled\)\s*\{[^}]*border-color:\s*rgb\(167 139 250/s)
    // Shared toolbox hover must not paint emerald borders onto domain Run buttons.
    expect(css).not.toMatch(
      /\.vc-notebook-toolbox button:hover,\s*\.vc-notebook-input-button:hover,\s*\.vc-notebook-run:hover/,
    )
  })

  it('disables Run only while submit is in flight, not while asset is pending', () => {
    const sidebar = readFileSync(join(root, 'NotebookSidebar.tsx'), 'utf8')
    expect(sidebar).toContain('disabled={requiredMissing.length > 0 || !readiness.ready || running}')
    expect(sidebar).not.toContain("runStatus.state === 'pending'")
    expect(sidebar).toContain("running ? 'Submitting' : 'Run'")
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
