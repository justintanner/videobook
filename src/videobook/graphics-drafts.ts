import type { GraphicsFraming } from '../../server/src/graphics/frame'
import type { GraphicsDocument } from '../../server/src/graphics/model'
import { graphicsToolError, type GraphicsTarget } from './graphics-model'

type DraftCall = (tool: string, args: Record<string, unknown>, options?: { background?: boolean }) => Promise<unknown>

export interface GraphicsDraft {
  document: GraphicsDocument
  frame: GraphicsFraming
  revision: string
}

export interface KeptGraphicsDraft extends GraphicsDraft {
  save: 'error' | 'conflict'
  saveError: string
  conflictRevision: string | null
}

export function graphicsTargetArgs(bookId: string | null, target: GraphicsTarget | null): Record<string, unknown> {
  return {
    book_id: bookId,
    asset_id: target?.artifactId,
    ...(target?.notebookId ? { notebook_id: target.notebookId } : {}),
    ...(target?.watermark ? { watermark: true, platform: target.watermark.platform } : {}),
  }
}

function keptDraft(draft: GraphicsDraft, error: unknown): KeptGraphicsDraft {
  const failure = graphicsToolError(error)
  return failure.status === 'conflict'
    ? { ...draft, save: 'conflict', saveError: failure.message, conflictRevision: failure.revision }
    : { ...draft, save: 'error', saveError: failure.message, conflictRevision: null }
}

export function createGraphicsDraftKeeper() {
  const pending = new Map<string, Promise<void>>()
  const kept = new Map<string, KeptGraphicsDraft>()
  const keyOf = (args: Record<string, unknown>) => JSON.stringify(args)
  return {
    keep(call: DraftCall, args: Record<string, unknown>, outgoing: () => Promise<GraphicsDraft | KeptGraphicsDraft | null>): Promise<void> {
      const key = keyOf(args)
      const run = (pending.get(key) ?? Promise.resolve()).then(async () => {
        const draft = await outgoing()
        if (!draft) return
        if ('save' in draft) {
          kept.set(key, draft)
          return
        }
        try {
          await call('video_graphics', { ...args, op: 'update', expected_revision: draft.revision, document: draft.document, frame: draft.frame }, { background: true })
          kept.delete(key)
        } catch (error) {
          kept.set(key, keptDraft(draft, error))
        }
      }).catch(() => undefined)
      pending.set(key, run)
      void run.then(() => {
        if (pending.get(key) === run) pending.delete(key)
      })
      return run
    },
    settled(args: Record<string, unknown>): Promise<void> {
      return pending.get(keyOf(args)) ?? Promise.resolve()
    },
    take(args: Record<string, unknown>): KeptGraphicsDraft | null {
      const key = keyOf(args)
      const draft = kept.get(key) ?? null
      kept.delete(key)
      return draft
    },
  }
}
