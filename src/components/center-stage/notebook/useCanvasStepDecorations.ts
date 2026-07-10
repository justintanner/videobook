import { useEffect } from 'react'
import type { RefObject } from 'react'
import { stepRunStatus } from './model'
import type { NotebookPlanDefinition } from './types'
import type { MediaItem } from '@/components/sidebar/types'

export function useCanvasStepDecorations(
  rootRef: RefObject<HTMLDivElement | null>,
  definition: NotebookPlanDefinition | null,
  mediaItems: MediaItem[],
) {
  useEffect(() => {
    const root = rootRef.current
    if (!root || !definition) return
    const steps = new Map(definition.sequence.map((step) => [step.id, step]))
    const apply = () => {
      for (const group of root.querySelectorAll<SVGGElement>('g[data-step-id]')) {
        const step = steps.get(group.dataset.stepId ?? '')
        if (!step || step.type === 'prompt') continue
        const status = stepRunStatus(step, mediaItems)
        group.classList.toggle('vc-step-running', status.state === 'pending')
        group.classList.toggle('vc-step-error', status.state === 'error')
        group.classList.toggle('vc-step-ready', status.state === 'ready')
        const asset = status.assetId ? mediaItems.find((item) => item.id === status.assetId) : null
        const thumb = group.querySelector<SVGImageElement>('image.vc-node-thumb')
        const href = status.state === 'ready' && asset?.thumbnailSrc ? asset.thumbnailSrc : null
        if (thumb && href) thumb.setAttribute('href', href)
        // Flip the icon ↔ thumbnail layers via CSS.
        group.classList.toggle('vc-has-thumb', Boolean(thumb && href))
      }
    }
    apply()
    // SWD re-renders the workspace on a setTimeout(0) after definition changes,
    // and the initial render after Designer.create is async — re-apply whenever
    // step nodes (re)appear. Class/attr writes above are not childList
    // mutations, so this observer cannot re-trigger itself into a loop.
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.addedNodes.length > 0)) apply()
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [definition, mediaItems, rootRef])
}
