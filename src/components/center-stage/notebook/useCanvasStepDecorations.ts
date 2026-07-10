import { useEffect } from 'react'
import type { RefObject } from 'react'
import { latestAssetId, stepRunStatus } from './model'
import type { NotebookPlanDefinition } from './types'
import type { MediaItem } from '@/components/sidebar/types'

export function useCanvasStepDecorations(
  rootRef: RefObject<HTMLDivElement | null>,
  definition: NotebookPlanDefinition | null,
  mediaItems: MediaItem[],
) {
  useEffect(() => {
    if (!rootRef.current || !definition) return
    const steps = new Map(definition.sequence.map((step) => [step.id, step]))
    for (const group of rootRef.current.querySelectorAll<SVGGElement>('g[data-step-id]')) {
      const step = steps.get(group.dataset.stepId ?? '')
      if (!step || step.type === 'prompt') continue
      const status = stepRunStatus(step, mediaItems)
      group.classList.toggle('vc-step-running', status.state === 'pending' && latestAssetId(step) !== null)
      group.classList.toggle('vc-step-error', status.state === 'error')
      const asset = status.assetId ? mediaItems.find((item) => item.id === status.assetId) : null
      if (status.state !== 'ready' || !asset?.thumbnailSrc) continue
      const image = group.querySelector<SVGImageElement>('image')
      image?.setAttribute('href', asset.thumbnailSrc)
    }
  }, [definition, mediaItems, rootRef])
}
