import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApplicationStateStore } from '../../server/src/app-state.js'
import { getOAuthFlowStatus } from '../../server/src/x/oauth-flow.js'
import { XConnectionCard } from '../../src/components/videobook/XConnectionCard'
import {
  fetchXConnectionStatus,
  initialXConnectionState,
  parseXConnectionStatus,
  startXConnection,
  waitForXConnection,
  X_CONNECTION_POLL_MS,
  xConnectionAccountDetail,
  xConnectionOutcome,
  xConnectionPresentation,
  xPostMaxCharacters,
  xSubscriptionLabel,
  type XConnectionStatus,
} from '../../src/videobook/x-connection'

function memoryStore(values: Record<string, unknown> = {}): ApplicationStateStore {
  const state = new Map(Object.entries(values))
  return {
    async get<T>(key: string): Promise<T | null> {
      return state.has(key) ? state.get(key) as T : null
    },
    async set<T>(key: string, value: T): Promise<void> {
      state.set(key, value)
    },
  }
}

const connectedStatus: XConnectionStatus = {
  connected: true,
  pending: false,
  hasCredentials: true,
  error: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  account: null,
  postMaxCharacters: 280,
}

const premiumStatus: XConnectionStatus = {
  ...connectedStatus,
  account: { username: 'longposter', subscriptionType: 'Premium' },
  postMaxCharacters: 25_000,
}

const disconnectedStatus: XConnectionStatus = {
  connected: false,
  pending: false,
  hasCredentials: true,
  error: null,
  expiresAt: null,
  account: null,
  postMaxCharacters: 280,
}

/** A stand-in for X's /2/users/me that reports the given subscription tier. */
function usersMeFetch(subscriptionType: string): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const stub: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    urls.push(url)
    if (!url.includes('/2/users/me')) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify({
      data: { id: '1', name: 'Long Poster', username: 'longposter', subscription_type: subscriptionType },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetch: stub, urls }
}

function scriptedCallTool(statuses: Array<Record<string, unknown>>) {
  const calls: Array<{ tool: string; background: boolean }> = []
  let index = 0
  const callTool = async (
    tool: string,
    _args: Record<string, unknown>,
    options?: { background?: boolean },
  ): Promise<unknown> => {
    calls.push({ tool, background: options?.background === true })
    if (tool === 'connect_service') {
      return { authorize_url: 'https://x.com/i/oauth2/authorize?state=abc' }
    }
    if (tool === 'service_status') {
      const status = statuses[Math.min(index, statuses.length - 1)]
      index += 1
      return status
    }
    throw new Error(`unexpected tool ${tool}`)
  }
  return { callTool, calls }
}

function renderCard(connection: Partial<typeof initialXConnectionState>): string {
  return renderToStaticMarkup(createElement(XConnectionCard, {
    busy: false,
    connection: { ...initialXConnectionState, ...connection },
    onConnect: () => undefined,
  }))
}

describe('X connection status', () => {
  const originalClientId = process.env.X_CLIENT_ID
  const originalClientSecret = process.env.X_CLIENT_SECRET

  beforeEach(() => {
    process.env.X_CLIENT_ID = 'client-id'
    process.env.X_CLIENT_SECRET = 'client-secret'
  })

  afterEach(() => {
    if (originalClientId === undefined) delete process.env.X_CLIENT_ID
    else process.env.X_CLIENT_ID = originalClientId
    if (originalClientSecret === undefined) delete process.env.X_CLIENT_SECRET
    else process.env.X_CLIENT_SECRET = originalClientSecret
  })

  it('reads the real X service_status shape before and after tokens exist', async () => {
    const { fetch: fetchImpl, urls } = usersMeFetch('Premium')
    expect(parseXConnectionStatus(await getOAuthFlowStatus(memoryStore(), { fetchImpl }))).toEqual({
      ...disconnectedStatus,
    })
    expect(urls).toEqual([])

    const withTokens = memoryStore({
      'x.oauth.tokens': {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    })
    // Connecting looks the account up once; later checks reuse the cached tier.
    expect(parseXConnectionStatus(await getOAuthFlowStatus(withTokens, { fetchImpl })))
      .toEqual(premiumStatus)
    expect(parseXConnectionStatus(await getOAuthFlowStatus(withTokens, { fetchImpl })))
      .toEqual(premiumStatus)
    expect(urls).toHaveLength(1)
    expect(decodeURIComponent(urls[0]!)).toContain('user.fields=username,subscription_type')

    delete process.env.X_CLIENT_SECRET
    expect(parseXConnectionStatus(await getOAuthFlowStatus(memoryStore(), { fetchImpl })).hasCredentials)
      .toBe(false)
  })

  it('falls back to the standard post length when the server reports no account', () => {
    expect(parseXConnectionStatus({ connected: true, pending: false, has_credentials: true }))
      .toMatchObject({ account: null, postMaxCharacters: 280 })
    expect(parseXConnectionStatus({ connected: true, post_max_characters: -1 }).postMaxCharacters)
      .toBe(280)
    expect(parseXConnectionStatus({ connected: true, account: { username: 'x' } }).account)
      .toBeNull()
    expect(xPostMaxCharacters(null)).toBe(280)
    expect(xPostMaxCharacters(premiumStatus)).toBe(25_000)
  })

  it('asks the server to re-read the account only when refreshing', async () => {
    const calls: Array<Record<string, unknown>> = []
    const callTool = async (_tool: string, args: Record<string, unknown>) => {
      calls.push(args)
      return { connected: true, pending: false, has_credentials: true }
    }
    await fetchXConnectionStatus(callTool)
    await fetchXConnectionStatus(callTool, { refreshAccount: true })
    expect(calls).toEqual([{ service: 'x' }, { service: 'x', refresh_account: true }])
  })

  it('starts the flow and polls in the background until X reports the connection', async () => {
    const pending = { connected: false, pending: true, has_credentials: true }
    const connected = {
      connected: true,
      pending: false,
      has_credentials: true,
      expires_at: '2099-01-01T00:00:00.000Z',
    }
    const { callTool, calls } = scriptedCallTool([pending, pending, connected])
    const sleeps: number[] = []

    expect(await startXConnection(callTool)).toBe('https://x.com/i/oauth2/authorize?state=abc')
    const status = await waitForXConnection(callTool, {
      sleep: async (ms) => { sleeps.push(ms) },
    })

    expect(status).toEqual(connectedStatus)
    expect(xConnectionOutcome(status)).toEqual({ ok: true, message: 'X account connected' })
    expect(sleeps).toEqual([X_CONNECTION_POLL_MS, X_CONNECTION_POLL_MS])
    expect(calls[0]).toEqual({ tool: 'connect_service', background: false })
    expect(calls.slice(1).every((call) =>
      call.tool === 'service_status' && call.background)).toBe(true)
  })

  it('surfaces the server-side failure and stops polling', async () => {
    const { callTool } = scriptedCallTool([
      { connected: false, pending: true, has_credentials: true },
      {
        connected: false,
        pending: false,
        has_credentials: true,
        error: 'OAuth flow timed out after 5 minutes',
      },
    ])
    const status = await waitForXConnection(callTool, { sleep: async () => undefined })
    expect(status.error).toBe('OAuth flow timed out after 5 minutes')
    expect(xConnectionOutcome(status)).toEqual({
      ok: false,
      message: 'OAuth flow timed out after 5 minutes',
    })
  })

  it('gives up after its own timeout while X stays pending', async () => {
    const { callTool } = scriptedCallTool([
      { connected: false, pending: true, has_credentials: true },
    ])
    let clock = 0
    const sleeps: number[] = []
    const status = await waitForXConnection(callTool, {
      sleep: async (ms) => { sleeps.push(ms) },
      now: () => {
        clock += 4 * 60_000
        return clock
      },
    })
    expect(sleeps).toHaveLength(1)
    expect(status.pending).toBe(false)
    expect(status.error).toMatch(/Timed out waiting for X authorization/)
    expect(xConnectionOutcome({ ...disconnectedStatus }))
      .toEqual({ ok: false, message: 'X authorization did not complete.' })
  })

  it('describes every connection state for the card', () => {
    expect(xConnectionPresentation(disconnectedStatus, { connecting: true })).toMatchObject({
      tone: 'pending',
      actionLabel: null,
    })
    expect(xConnectionPresentation(null)).toMatchObject({
      tone: 'unknown',
      actionLabel: 'Connect X',
    })
    expect(xConnectionPresentation({ ...disconnectedStatus, hasCredentials: false }))
      .toMatchObject({ tone: 'missing-credentials', actionLabel: null })
    expect(xConnectionPresentation({ ...disconnectedStatus, pending: true }))
      .toMatchObject({ tone: 'pending', actionLabel: null })
    expect(xConnectionPresentation({ ...disconnectedStatus, error: 'nope' })).toMatchObject({
      tone: 'error',
      label: 'Connection failed',
      detail: 'nope',
      actionLabel: 'Connect X',
    })
    expect(xConnectionPresentation({ ...connectedStatus, error: 'nope' }).actionLabel)
      .toBe('Reconnect X')

    const connected = xConnectionPresentation(connectedStatus, {
      now: Date.parse('2098-12-31T00:00:00.000Z'),
    })
    expect(connected).toMatchObject({ tone: 'connected', label: 'Connected', actionLabel: 'Reconnect X' })
    expect(connected.detail).toMatch(/^Access token renews automatically; the current one expires/)

    const premium = xConnectionPresentation(premiumStatus, {
      now: Date.parse('2098-12-31T00:00:00.000Z'),
    })
    expect(premium.label).toBe('Connected as @longposter')
    expect(premium.detail).toMatch(/^X Premium: posts up to 25,000 characters\. Access token renews/)
    expect(xConnectionAccountDetail(premiumStatus)).toBe('X Premium: posts up to 25,000 characters.')
    expect(xConnectionAccountDetail({
      ...premiumStatus,
      account: { username: 'reader', subscriptionType: 'None' },
      postMaxCharacters: 280,
    })).toBe('No X Premium: posts up to 280 characters.')
    expect(xConnectionAccountDetail(connectedStatus)).toBeNull()
    expect(['None', 'Basic', 'Premium', 'PremiumPlus', 'Other'].map(xSubscriptionLabel)).toEqual([
      'No X Premium',
      'X Premium Basic',
      'X Premium',
      'X Premium+',
      'Other',
    ])
    expect(xConnectionPresentation(connectedStatus, {
      now: Date.parse('2099-06-01T00:00:00.000Z'),
    }).detail).toMatch(/expired; it renews automatically/)

    expect(xConnectionPresentation(disconnectedStatus)).toMatchObject({
      tone: 'disconnected',
      label: 'Not connected',
      actionLabel: 'Connect X',
    })
  })

  it('renders the settings card for the main states', () => {
    const disconnected = renderCard({ status: disconnectedStatus })
    expect(disconnected).toContain('aria-label="X account"')
    expect(disconnected).toContain('x-connection-disconnected')
    expect(disconnected).toContain('Not connected')
    expect(disconnected).toContain('Connect X</button>')
    expect(disconnected).not.toContain('disabled=""')

    const connecting = renderCard({
      status: disconnectedStatus,
      connecting: true,
      authorizeUrl: 'https://x.com/i/oauth2/authorize?state=abc',
    })
    expect(connecting).toContain('Waiting…</button>')
    expect(connecting).toContain('disabled=""')
    expect(connecting).toContain('href="https://x.com/i/oauth2/authorize?state=abc"')

    const missing = renderCard({ status: { ...disconnectedStatus, hasCredentials: false } })
    expect(missing).toContain('App credentials missing')
    expect(missing).toContain('disabled=""')

    const failed = renderCard({ status: disconnectedStatus, error: 'Could not start local listener' })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Could not start local listener')

    const connected = renderCard({ status: connectedStatus })
    expect(connected).toContain('x-connection-connected')
    expect(connected).toContain('Reconnect X</button>')

    const premium = renderCard({ status: premiumStatus })
    expect(premium).toContain('Connected as @longposter')
    expect(premium).toContain('X Premium: posts up to 25,000 characters.')
  })
})
