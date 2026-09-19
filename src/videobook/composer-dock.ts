export const COMPOSER_DOCK_HIDE_LABEL = 'Collapse chat'

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
  return Boolean(relatedTarget.closest('[data-composer-dock-hide]'))
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

export function composerDockCloseInPanel(owner: ComposerDockCloseOwner): boolean {
  return owner.dockOpen && owner.panelHasHeader && !owner.reviewPriority
}

export interface ComposerDockNoticeOwner {
  dockOpen: boolean
  closeInPanel: boolean
}

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
