export type McpConnectionLifecycleState = 'connecting' | 'ready' | 'failed'

export type McpConnectionLifecycleSnapshot = {
  state: McpConnectionLifecycleState
  error: Error | null
}

type ReconnectableClient = {
  close: () => Promise<void>
  onclose?: () => void
}

type McpConnectionLifecycleOptions<ClientType, ResultType, TimerType> = {
  callTool: (
    client: ClientType,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<ResultType>
  cancelTimer: (timer: TimerType) => void
  connect: () => Promise<ClientType>
  onStateChange: (snapshot: McpConnectionLifecycleSnapshot) => void
  reconnectDelayMs: number
  scheduleTimer: (callback: () => void, delayMs: number) => TimerType
}

export type McpConnectionLifecycle<ResultType> = {
  callTool: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<ResultType>
  start: () => void
  stop: () => void
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export function createMcpConnectionLifecycle<
  ClientType extends ReconnectableClient,
  ResultType,
  TimerType,
>({
  callTool: invokeTool,
  cancelTimer,
  connect: openConnection,
  onStateChange,
  reconnectDelayMs,
  scheduleTimer,
}: McpConnectionLifecycleOptions<
  ClientType,
  ResultType,
  TimerType
>): McpConnectionLifecycle<ResultType> {
  let active = false
  let client: ClientType | null = null
  let connectionAttempt = 0
  let reconnectTimer: TimerType | null = null

  const closeClient = (target: ClientType): void => {
    target.onclose = undefined
    void target.close().catch(() => undefined)
  }

  const clearReconnectTimer = (): void => {
    if (reconnectTimer === null) return
    cancelTimer(reconnectTimer)
    reconnectTimer = null
  }

  const connect = async (): Promise<void> => {
    if (!active) return
    const attempt = ++connectionAttempt
    onStateChange({ state: 'connecting', error: null })
    try {
      const connected = await openConnection()
      if (!active || attempt !== connectionAttempt) {
        if (connected !== client) closeClient(connected)
        return
      }
      client = connected
      connected.onclose = () => {
        if (!active || client !== connected) return
        connected.onclose = undefined
        client = null
        onStateChange({
          state: 'failed',
          error: new Error('MCP connection closed'),
        })
        scheduleReconnect()
      }
      onStateChange({ state: 'ready', error: null })
    } catch (cause) {
      if (!active || attempt !== connectionAttempt) return
      onStateChange({ state: 'failed', error: asError(cause) })
      scheduleReconnect()
    }
  }

  const scheduleReconnect = (): void => {
    if (!active || reconnectTimer !== null) return
    reconnectTimer = scheduleTimer(() => {
      reconnectTimer = null
      void connect()
    }, reconnectDelayMs)
  }

  const start = (): void => {
    if (active) return
    active = true
    void connect()
  }

  const stop = (): void => {
    if (!active) return
    active = false
    connectionAttempt += 1
    clearReconnectTimer()
    const connected = client
    client = null
    if (connected) closeClient(connected)
  }

  const callTool = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ResultType> => {
    const connected = client
    if (!active || !connected) throw new Error('MCP server is not ready')
    try {
      return await invokeTool(connected, tool, args)
    } catch (cause) {
      const failure = asError(cause)
      if (active && client === connected) {
        client = null
        closeClient(connected)
        onStateChange({ state: 'failed', error: failure })
        scheduleReconnect()
      }
      throw failure
    }
  }

  return { callTool, start, stop }
}
