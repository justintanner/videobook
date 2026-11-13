import { useRef, useState } from 'react'
import { saveDownload } from './browser-download'
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

type BrowserDownload = {
  hostname: string
  save: (url: string, filename: string) => void
}

function currentBrowser(): BrowserDownload {
  return { hostname: typeof window === 'undefined' ? '' : window.location.hostname, save: saveDownload }
}

function usesBrowserDownloads(hostname: string): boolean {
  return Boolean(hostname) && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase())
}

export async function performBrowserFileAction(
  call: MediaFileToolCall,
  tool: string,
  args: Record<string, unknown>,
  browser: BrowserDownload = currentBrowser(),
): Promise<string | null> {
  if (tool !== 'export_asset_file' || !['downloads', 'browser'].includes(String(args.to))) return null
  if (args.to !== 'browser' && !usesBrowserDownloads(browser.hostname)) return null
  if (typeof args.book_id !== 'string' || typeof args.asset_id !== 'string') throw new Error('Choose a media file to download.')
  return downloadInBrowser(call, args.book_id, args.asset_id, browser.save)
}

async function downloadInBrowser(
  call: MediaFileToolCall,
  bookId: string,
  artifactId: string,
  save: BrowserDownload['save'],
): Promise<string> {
  const result = recordValue(await call('export_asset_file', { book_id: bookId, asset_id: artifactId, to: 'browser' }, { background: true }))
  if (result?.status !== 'download' || typeof result.url !== 'string' || typeof result.filename !== 'string') {
    throw new Error('The server did not prepare the download. Try again.')
  }
  save(result.url, result.filename)
  return `Downloading ${result.filename}`
}

export async function performMediaFileAction(
  call: MediaFileToolCall,
  action: MediaFileAction,
  bookId: string,
  artifactId: string,
  browser: BrowserDownload = currentBrowser(),
): Promise<string> {
  if (action === 'download' && usesBrowserDownloads(browser.hostname)) return downloadInBrowser(call, bookId, artifactId, browser.save)
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
