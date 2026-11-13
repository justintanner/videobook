import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { graphicsDocumentFromLayers, type GraphicsLayerInput } from '../../../../server/src/graphics/model'
import { GraphicsTimingSection } from './GraphicsTiming'

function render(input: GraphicsLayerInput): string {
  const layer = graphicsDocumentFromLayers([input]).layers[0]
  return renderToStaticMarkup(<GraphicsTimingSection layer={layer} durationSeconds={8} playhead={() => 2} disabled={false} onEdit={() => true} />)
}

describe('graphics motion choices', () => {
  it('offers Words on text and shows the selected enter and exit motions', () => {
    const html = render({ kind: 'text', timing: { enter: 'words', exit: 'pop' } })
    expect(html).toContain('aria-label="Enter"')
    expect(html).toContain('aria-label="Exit"')
    expect(html).toContain('aria-pressed="true">Words</button>')
    expect(html).toContain('aria-pressed="true">Pop</button>')
    expect(html).toContain('aria-label="Transition"')
  })

  it.each<GraphicsLayerInput>([{ kind: 'scrim' }, { kind: 'qr', url: 'https://example.com' }, { kind: 'image', artifactId: 'logo' }])('offers only Fade, Slide and Pop on $kind layers', (input) => {
    const html = render(input)
    expect(html).not.toContain('>Words</button>')
    expect(html).toContain('>Slide</button>')
    expect(html).toContain('>Pop</button>')
    expect(html).toContain('aria-pressed="true">Fade</button>')
  })
})
