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

export interface ComposerDockCloseOwner {
  dockOpen: boolean
  panelHasHeader: boolean
  reviewPriority: boolean
}

/* The dock's own strip exists only to hold the hide control, so a contextual
   panel that already draws a header row takes the control and the strip goes
   away. Only while that panel is really on screen, though: a pending review
   covers it, and a closed dock still needs somewhere to reopen from. */
export function composerDockCloseInPanel(owner: ComposerDockCloseOwner): boolean {
  return owner.dockOpen && owner.panelHasHeader && !owner.reviewPriority
}

export interface ComposerDockNoticeOwner {
  dockOpen: boolean
  closeInPanel: boolean
}

/* Where the status line reads. The dock's own header row names the panel and
   carries the close, so the notice belongs beside them — one row, and the row
   still stands when the notice clears. A panel that took the close draws no
   such row, and a closed dock shows nothing but the way back in, so in both
   cases the notice stays in the body above the command line. */
export function composerDockNoticeInHeader(owner: ComposerDockNoticeOwner): boolean {
  return owner.dockOpen && !owner.closeInPanel
}

export interface ComposerPanelHeaders {
  musicSession: boolean
  imageEditorDocked: boolean
  cellInspector: boolean
}

/* Which contextual panel is on screen decides whether one of them draws the
   dock's close control in a header row of its own. The music editor keeps its
   own chrome and does not, so the composer's strip stays for it. */
export function composerPanelDrawsClose(panels: ComposerPanelHeaders): boolean {
  if (panels.musicSession) return false
  if (panels.imageEditorDocked) return true
  return panels.cellInspector
}
