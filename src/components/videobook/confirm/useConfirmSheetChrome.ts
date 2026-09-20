import { useSyncExternalStore } from 'react'
import { CONFIRM_SHEET_HINTS_QUERY } from '@/videobook/confirm-sheet-chrome'

function mediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(CONFIRM_SHEET_HINTS_QUERY)
}

function subscribe(onChange: () => void): () => void {
  const query = mediaQuery()
  if (!query) return () => {}
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function snapshot(): boolean {
  return mediaQuery()?.matches ?? true
}

/* Is the sheet wide enough to put the shortcut hints beside Apply? Where there
   is no matchMedia to ask -- a test renderer, a server pass -- assume yes, so
   the header keeps the layout it has on every real viewport that reaches it. */
export function useConfirmSheetWideChrome(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true)
}
