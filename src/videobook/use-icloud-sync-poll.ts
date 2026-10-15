import { useEffect, useRef } from 'react'
import { icloudSyncFromTool, icloudSyncShouldPoll, type ICloudSyncView } from '@/videobook/post-delivery-review'

type SyncCall = (tool: string, args: Record<string, unknown>, options?: { background?: boolean }) => Promise<unknown>

const POLL_INTERVAL_MS = 3_000
const POLL_DEADLINE_MS = 120_000

export function useIcloudSyncPoll(
  enabled: boolean,
  call: SyncCall | undefined,
  bookId: string,
  postId: string,
  onSync: (sync: ICloudSyncView) => void,
): void {
  const onSyncRef = useRef(onSync)
  useEffect(() => {
    onSyncRef.current = onSync
  }, [onSync])
  useEffect(() => {
    if (!enabled || !call || !bookId || !postId) return undefined
    let stopped = false
    const deadline = Date.now() + POLL_DEADLINE_MS
    const tick = async () => {
      if (stopped || Date.now() > deadline) return
      try {
        const sync = icloudSyncFromTool(await call('post_icloud_sync_status', { book_id: bookId, post_cell_id: postId }, { background: true }))
        if (stopped) return
        onSyncRef.current(sync)
        if (!icloudSyncShouldPoll(sync.phase)) stopped = true
      } catch (error) {
        if (stopped) return
        stopped = true
        onSyncRef.current({ phase: 'error', error: error instanceof Error ? error.message : 'iCloud upload failed' })
      }
    }
    void tick()
    const timer = window.setInterval(() => {
      if (stopped || Date.now() > deadline) {
        window.clearInterval(timer)
        return
      }
      void tick()
    }, POLL_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [enabled, call, bookId, postId])
}
