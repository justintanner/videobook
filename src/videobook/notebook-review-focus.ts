// A pending review names an address it is about to write to and the addresses
// it reads. The canvas should already be looking at the first and marking the
// rest, so the review says what it will do somewhere you can see it happen.
import { notebookGrid, type NotebookGridSlot } from './notebook-grid'

export type NotebookReviewRole = 'target' | 'source'

export interface NotebookReviewAddresses {
  // The grid address the apply writes to, without the leading '@'. It may name
  // a slot that holds no cell yet -- that is the point of a NEW CELL review.
  target: string | null
  sources: readonly string[]
}

export const NO_NOTEBOOK_REVIEW: NotebookReviewAddresses = { target: null, sources: [] }

/* One role per address. An address that is both -- a generation that reads the
   cell it overwrites -- reads as the target, because that is what applying
   changes. */
export function notebookReviewRoles(
  review: NotebookReviewAddresses,
): Map<string, NotebookReviewRole> {
  const roles = new Map<string, NotebookReviewRole>()
  for (const source of review.sources) {
    if (source) roles.set(source, 'source')
  }
  if (review.target) roles.set(review.target, 'target')
  return roles
}

export function notebookReviewUnchanged(
  left: NotebookReviewAddresses,
  right: NotebookReviewAddresses,
): boolean {
  return left.target === right.target
    && left.sources.length === right.sources.length
    && left.sources.every((address, index) => address === right.sources[index])
}

export interface NotebookRowScrollInput {
  row: number
  zoom: number
  clientHeight: number
  scrollHeight: number
}

/* Where the canvas has to be scrolled for a row to sit in the middle of what
   you can see. The grid is pinned horizontally, so a row is the whole answer.
   Clamped to the scrollable range: a row near either end sits as close to the
   middle as the canvas allows rather than bouncing off the limit. */
export function notebookRowScrollTop(input: NotebookRowScrollInput): number {
  if (!Number.isFinite(input.row) || input.row < 0) return 0
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1
  const center = notebookGrid.originY
    + input.row * notebookGrid.rowPitch
    + notebookGrid.squareSize / 2
  const limit = Math.max(0, input.scrollHeight - input.clientHeight)
  const top = center * zoom - input.clientHeight / 2
  return Math.min(limit, Math.max(0, Math.round(top)))
}

interface NotebookScrollTarget {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
  scrollTo: (options: ScrollToOptions) => void
}

type FrameScheduler = (callback: FrameRequestCallback) => number

// Below this the canvas is already showing the row, and a scroll would be
// movement for its own sake.
const SETTLED_PX = 2

export function revealNotebookReviewRow(
  resolveTarget: () => NotebookScrollTarget | null,
  input: Omit<NotebookRowScrollInput, 'clientHeight' | 'scrollHeight'>,
  options: { reducedMotion?: boolean; scheduleFrame?: FrameScheduler } = {},
): void {
  const scheduleFrame = options.scheduleFrame
    ?? ((callback: FrameRequestCallback) => window.requestAnimationFrame(callback))
  scheduleFrame(() => {
    const target = resolveTarget()
    if (!target) return
    const top = notebookRowScrollTop({
      ...input,
      clientHeight: target.clientHeight,
      scrollHeight: target.scrollHeight,
    })
    if (Math.abs(top - target.scrollTop) <= SETTLED_PX) return
    target.scrollTo({ top, behavior: options.reducedMotion ? 'auto' : 'smooth' })
  })
}

export function notebookReviewSlotRow(slot: NotebookGridSlot | null): number | null {
  return slot ? slot.row : null
}
