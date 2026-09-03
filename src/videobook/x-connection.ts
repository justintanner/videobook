import { nonEmptyStringValue, recordValue } from './value-decoders'

export type XConnectionStatus = {
  connected: boolean
  pending: boolean
  hasCredentials: boolean
  error: string | null
  expiresAt: string | null
}

export type XConnectionState = {
  status: XConnectionStatus | null
  connecting: boolean
  authorizeUrl: string | null
  error: string | null
}

export type XConnectionTone =
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'missing-credentials'
  | 'pending'
  | 'unknown'

export type XConnectionPresentation = {
  actionLabel: string | null
  detail: string
  label: string
  tone: XConnectionTone
}

export type XConnectionCallTool = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

export type XConnectionOutcome = { ok: boolean; message: string }

export const X_CONNECTION_POLL_MS = 2_000
// The server abandons an unanswered authorization after five minutes; wait a
// little longer so its own timeout message reaches the card.
export const X_CONNECTION_TIMEOUT_MS = 6 * 60_000

export const initialXConnectionState: XConnectionState = {
  status: null,
  connecting: false,
  authorizeUrl: null,
  error: null,
}

export function parseXConnectionStatus(value: unknown): XConnectionStatus {
  const payload = recordValue(value)
  return {
    connected: payload?.connected === true,
    pending: payload?.pending === true,
    hasCredentials: payload?.has_credentials === true,
    error: nonEmptyStringValue(payload?.error),
    expiresAt: nonEmptyStringValue(payload?.expires_at),
  }
}

export async function fetchXConnectionStatus(
  callTool: XConnectionCallTool,
): Promise<XConnectionStatus> {
  return parseXConnectionStatus(
    await callTool('x_connect_status', {}, { background: true }),
  )
}

export async function startXConnection(
  callTool: XConnectionCallTool,
): Promise<string> {
  const payload = recordValue(await callTool('x_connect_start', {}))
  const authorizeUrl = nonEmptyStringValue(payload?.authorize_url)
  if (!authorizeUrl) throw new Error('X did not return an authorization URL.')
  return authorizeUrl
}

export async function waitForXConnection(
  callTool: XConnectionCallTool,
  options: {
    sleep: (ms: number) => Promise<void>
    now?: () => number
    pollMs?: number
    timeoutMs?: number
  },
): Promise<XConnectionStatus> {
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? X_CONNECTION_POLL_MS
  const timeoutMs = options.timeoutMs ?? X_CONNECTION_TIMEOUT_MS
  const startedAt = now()
  let status = await fetchXConnectionStatus(callTool)
  while (status.pending) {
    if (now() - startedAt >= timeoutMs) {
      return {
        ...status,
        pending: false,
        error: 'Timed out waiting for X authorization.',
      }
    }
    await options.sleep(pollMs)
    status = await fetchXConnectionStatus(callTool)
  }
  return status
}

export function xConnectionOutcome(status: XConnectionStatus): XConnectionOutcome {
  if (status.error) return { ok: false, message: status.error }
  if (status.connected) return { ok: true, message: 'X account connected' }
  return { ok: false, message: 'X authorization did not complete.' }
}

function formatExpiry(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  })
}

function connectedDetail(expiresAt: string | null, now: number): string {
  const expires = expiresAt ? Date.parse(expiresAt) : Number.NaN
  if (!Number.isFinite(expires)) return 'Tokens renew automatically.'
  if (expires <= now) {
    return 'Access token expired; it renews automatically on next use.'
  }
  return `Access token renews automatically; the current one expires ${formatExpiry(expires)}.`
}

export function xConnectionPresentation(
  status: XConnectionStatus | null,
  options: { connecting?: boolean; now?: number } = {},
): XConnectionPresentation {
  if (options.connecting) {
    return {
      tone: 'pending',
      label: 'Waiting for X authorization',
      detail: 'Approve the request in the browser tab that opened.',
      actionLabel: null,
    }
  }
  if (!status) {
    return {
      tone: 'unknown',
      label: 'Not checked',
      detail: 'Refresh to check the X connection.',
      actionLabel: 'Connect X',
    }
  }
  if (!status.hasCredentials) {
    return {
      tone: 'missing-credentials',
      label: 'App credentials missing',
      detail: 'Save X_CLIENT_ID and X_CLIENT_SECRET as provider keys first. '
        + 'They come from console.x.com → your app → OAuth 2.0.',
      actionLabel: null,
    }
  }
  if (status.pending) {
    return {
      tone: 'pending',
      label: 'Waiting for X authorization',
      detail: 'An authorization started elsewhere is still open in a browser tab.',
      actionLabel: null,
    }
  }
  if (status.error) {
    return {
      tone: 'error',
      label: 'Connection failed',
      detail: status.error,
      actionLabel: status.connected ? 'Reconnect X' : 'Connect X',
    }
  }
  if (status.connected) {
    return {
      tone: 'connected',
      label: 'Connected',
      detail: connectedDetail(status.expiresAt, options.now ?? Date.now()),
      actionLabel: 'Reconnect X',
    }
  }
  return {
    tone: 'disconnected',
    label: 'Not connected',
    detail: 'Posting needs a one-time browser authorization; tokens renew on their own afterwards.',
    actionLabel: 'Connect X',
  }
}
