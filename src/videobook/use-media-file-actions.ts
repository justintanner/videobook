import { useRef, useState } from 'react'
import { recordValue } from './value-decoders'

export type MediaFileToolCall = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

type MediaFileAction = 'copy' | 'download'

type ActionState =
  | { phase: 'idle' }
  | { phase: 'running'; action: MediaFileAction }
  | { phase: 'done'; message: string }
  | { phase: 'failed'; message: string }

export async function performMediaFileAction(
  call: MediaFileToolCall,
  action: MediaFileAction,
  bookId: string,
  artifactId: string,
): Promise<string> {
  const result = recordValue(await call(
    'export_asset_file',
    { book_id: bookId, asset_id: artifactId, to: action === 'copy' ? 'clipboard' : 'downloads' },
    { background: true },
  ))
  const expectedStatus = action === 'copy' ? 'copied' : 'exported'
  if (result?.status !== expectedStatus || typeof result.path !== 'string') {
    throw new Error('The server did not confirm the file action. Try again.')
  }
  return action === 'copy' ? 'File copied to clipboard' : `Saved ${result.path}`
}

export function useMediaFileActions({
  call,
  bookId,
  artifactId,
}: {
  call: MediaFileToolCall | undefined
  bookId: string
  artifactId: string
}) {
  const [state, setState] = useState<ActionState>({ phase: 'idle' })
  const inFlight = useRef(false)
  const available = Boolean(call && bookId && artifactId)

  async function run(action: MediaFileAction): Promise<void> {
    if (!call || !bookId || !artifactId || inFlight.current) return
    inFlight.current = true
    setState({ phase: 'running', action })
    try {
      const message = await performMediaFileAction(call, action, bookId, artifactId)
      setState({
        phase: 'done',
        message,
      })
    } catch (error) {
      setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    } finally {
      inFlight.current = false
    }
  }

  return { state, available, run }
}
