export const COMPOSER_DOCK_HIDE_LABEL = 'Hide chat'
export const COMPOSER_DOCK_SHOW_LABEL = 'Show chat'

type ComposerDockOpenReason =
  | 'selection'
  | 'action'
  | 'expand'
  | 'reopen'
  | 'completion'
  | 'poll'

export function composerDockShouldOpen(reason: ComposerDockOpenReason): boolean {
  return reason === 'selection'
    || reason === 'action'
    || reason === 'expand'
    || reason === 'reopen'
}

export function composerDockDraftKey(
  bookId: string,
  target: string | null | undefined,
): string {
  return `${bookId}:${target ?? 'chat'}`
}

export function composerDockReviewPriority(hasPendingReview: boolean): boolean {
  return hasPendingReview
}

export function hideComposerDock(options: {
  setOpen: (open: boolean) => void
  stopVoice?: () => void
  pauseMedia?: () => void
  dismissPending?: () => void
  apply?: () => void
  save?: () => void
  cancel?: () => void
}): void {
  options.stopVoice?.()
  options.pauseMedia?.()
  options.setOpen(false)
}

export function pauseComposerDockMedia(root: ParentNode | null): void {
  if (!root) return
  for (const media of root.querySelectorAll('video, audio')) {
    if (media instanceof HTMLMediaElement) media.pause()
  }
}

export function composerDockHideSkipsBlurCommit(
  relatedTarget: EventTarget | null,
): boolean {
  if (!(relatedTarget instanceof Element)) return false
  return Boolean(relatedTarget.closest('[data-composer-dock-hide], [data-composer-dock-show]'))
}

export function initialMusicDockView(
  setupStatus: string,
): 'sources' | 'soundtrack' {
  return setupStatus === 'applied' ? 'sources' : 'soundtrack'
}
