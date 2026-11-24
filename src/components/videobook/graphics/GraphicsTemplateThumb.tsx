import { useMemo, type CSSProperties } from 'react'
import type { GraphicsDocument } from '../../../../server/src/graphics/model'
import type { GraphicsRead } from '@/videobook/graphics-model'
import { graphicsThumbShapes, type GraphicsThumbBox, type GraphicsThumbShape } from '@/videobook/graphics-thumb'

type ShadeShape = Extract<GraphicsThumbShape, { kind: 'shade' }>

function boxStyle(box: GraphicsThumbBox): CSSProperties {
  return { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }
}

function shadeStyle(shape: ShadeShape): CSSProperties {
  const toward = shape.edge === 'top' ? 'to bottom' : 'to top'
  const strength = Math.round(shape.strength * 100)
  return {
    [shape.edge]: 0,
    height: `${shape.height}%`,
    background: `linear-gradient(${toward}, color-mix(in srgb, ${shape.color} ${strength}%, transparent), transparent)`,
  }
}

function ThumbShape({ shape, images }: { shape: GraphicsThumbShape; images: GraphicsRead['images'] }) {
  if (shape.kind === 'shade') return <span className="graphics-thumb-shade" style={shadeStyle(shape)} />
  if (shape.kind === 'plate') return <span className="graphics-thumb-plate" style={{ ...boxStyle(shape.box), background: shape.color, opacity: shape.opacity }} />
  if (shape.kind === 'bar') return <span className="graphics-thumb-bar" style={{ ...boxStyle(shape.box), background: shape.color }} />
  if (shape.kind === 'qr') return <span className="graphics-thumb-qr" style={{ ...boxStyle(shape.box), background: shape.light, color: shape.dark }} />
  const url = images[shape.artifactId]?.url
  if (!url) return <span className="graphics-thumb-image" style={boxStyle(shape.box)} />
  return <img className="graphics-thumb-image" src={url} alt="" draggable={false} style={boxStyle(shape.box)} />
}

export function GraphicsTemplateThumb({ document, images }: { document: GraphicsDocument; images: GraphicsRead['images'] }) {
  const shapes = useMemo(() => graphicsThumbShapes(document, images), [document, images])
  return (
    <span className="graphics-thumb" aria-hidden="true">
      {shapes.map((shape) => <ThumbShape key={shape.key} shape={shape} images={images} />)}
    </span>
  )
}
