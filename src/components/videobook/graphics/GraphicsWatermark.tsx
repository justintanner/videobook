import { useState } from 'react'
import { WATERMARK_PLATFORM_LABELS, type WatermarkPlatform } from '../../../../server/src/watermark-platform'
import type { GraphicsRead } from '@/videobook/graphics-model'
import type { GraphicsEditor, GraphicsTemplateOutcome } from '@/videobook/useGraphicsEditor'

const PLATFORMS: readonly WatermarkPlatform[] = ['tiktok', 'x']

function burnsLine(label: string, saved: string | null): string {
  return saved
    ? `Goal finishing and apply_watermark burn your saved ${label} watermark, “${saved}”.`
    : `Goal finishing and apply_watermark burn the ${label} profile’s watermark.`
}

export function GraphicsWatermark({ editor, read, platform, disabled }: {
  editor: GraphicsEditor
  read: GraphicsRead
  platform: WatermarkPlatform
  disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<GraphicsTemplateOutcome | null>(null)
  const saved = read.watermark?.template_name ?? null
  const locked = disabled || busy
  const run = async (action: () => Promise<GraphicsTemplateOutcome>) => {
    setBusy(true)
    setNotice(null)
    try {
      setNotice(await action())
    } finally {
      setBusy(false)
    }
  }
  const choose = (choice: WatermarkPlatform) => {
    setNotice(null)
    void editor.setPlatform(choice)
  }
  return (
    <section className="graphics-watermark" aria-label="Watermark">
      <span className="graphics-section-label">Watermark</span>
      <div className="graphics-segmented" role="group" aria-label="Watermark platform">
        {PLATFORMS.map((choice) => (
          <button key={choice} type="button" aria-pressed={choice === platform} disabled={locked} onClick={() => choose(choice)}>
            {WATERMARK_PLATFORM_LABELS[choice]}
          </button>
        ))}
      </div>
      <div className="graphics-watermark-actions">
        <button type="button" disabled={locked} onClick={() => void run(editor.saveWatermark)}>Save as default watermark</button>
        {saved && <button type="button" disabled={locked} onClick={() => void run(editor.resetWatermark)}>Use the profile’s look</button>}
      </div>
      <p className="graphics-muted">{burnsLine(WATERMARK_PLATFORM_LABELS[platform], saved)}</p>
      {notice && <p className="graphics-template-notice" role={notice.ok ? 'status' : 'alert'} data-tone={notice.ok ? 'info' : 'error'}>{notice.message}</p>}
    </section>
  )
}
