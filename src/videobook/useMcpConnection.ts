import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { callMcpTool, connectMcpClient } from './mcp-client'
import {
  createMcpConnectionLifecycle,
  type McpConnectionLifecycle,
  type McpConnectionLifecycleState,
} from './mcp-connection-lifecycle'

type McpConnectionOptions = {
  url: string
  clientName: string
  reconnectDelayMs: number
}

type McpConnection = {
  state: McpConnectionLifecycleState
  error: Error | null
  callTool: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>
}

export function useMcpConnection({
  url,
  clientName,
  reconnectDelayMs,
}: McpConnectionOptions): McpConnection {
  const lifecycleRef = useRef<McpConnectionLifecycle<CallToolResult> | null>(null)
  const [state, setState] = useState<McpConnectionLifecycleState>('connecting')
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const lifecycle = createMcpConnectionLifecycle({
      connect: () => connectMcpClient(url, clientName),
      callTool: callMcpTool,
      reconnectDelayMs,
      scheduleTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancelTimer: (timer) => window.clearTimeout(timer),
      onStateChange: (snapshot) => {
        setState(snapshot.state)
        setError(snapshot.error)
      },
    })
    lifecycleRef.current = lifecycle
    lifecycle.start()

    return () => {
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null
      lifecycle.stop()
    }
  }, [clientName, reconnectDelayMs, url])

  const callTool = useCallback(async (
    tool: string,
    args: Record<string, unknown>,
  ) => {
    const lifecycle = lifecycleRef.current
    if (!lifecycle) throw new Error('MCP server is not ready')
    return lifecycle.callTool(tool, args)
  }, [])

  return useMemo(() => ({ state, error, callTool }), [callTool, error, state])
}
