import { useState } from 'react'
import { SplicePreview, type SplicePreviewClip } from '../../SplicePreview'
import { useSplicePreview } from '@/videobook/use-splice-preview'

type ToolCall = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

type SpliceReviewClip = SplicePreviewClip & { artifactId: string }

export function SpliceReviewPreview({
  bookId,
  call,
  first,
  second,
  overlap,
  busy,
  onOverlapChange,
}: {
  bookId: string
  call: ToolCall | null
  first: SpliceReviewClip
  second: SpliceReviewClip
  overlap: number
  busy: boolean
  onOverlapChange: (value: string) => void
}) {
  const [draft, setDraft] = useState(String(overlap))
  const preview = useSplicePreview({
    call,
    target: { bookId, firstAssetId: first.artifactId, secondAssetId: second.artifactId },
  })
  return (
    <SplicePreview
      first={first}
      second={second}
      overlap={draft}
      busy={busy}
      match={preview.match}
      loading={preview.loading}
      error={preview.error}
      onRetry={preview.retry}
      onOverlapChange={(value) => {
        setDraft(value)
        onOverlapChange(value)
      }}
    />
  )
}
