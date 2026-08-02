import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CallToolResult, Client } from '@modelcontextprotocol/client'
import { callMcpTool, connectMcpClient } from './mcp-client'

type McpConnectionState = 'connecting' | 'ready' | 'failed'

type McpConnectionOptions = {
  url: string
  clientName: string
  autoReconnect: number
}

type McpConnection = {
  state: McpConnectionState
  error: Error | null
  callTool: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>
}

export function useMcpConnection({
  url,
  clientName,
  autoReconnect,
}: McpConnectionOptions): McpConnection {
  const clientRef = useRef<Client | null>(null)
  const [state, setState] = useState<McpConnectionState>('connecting')
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let active = true
    let reconnectTimer = 0

    const connect = async () => {
      setState('connecting')
      try {
        const client = await connectMcpClient(url, clientName)
        if (!active) {
          await client.close()
          return
        }
        clientRef.current = client
        setError(null)
        setState('ready')
      } catch (cause) {
        if (!active) return
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setState('failed')
        reconnectTimer = window.setTimeout(() => {
          void connect()
        }, autoReconnect)
      }
    }

    void connect()

    return () => {
      active = false
      window.clearTimeout(reconnectTimer)
      const client = clientRef.current
      clientRef.current = null
      void client?.close()
    }
  }, [autoReconnect, clientName, url])

  const callTool = useCallback(async (
    tool: string,
    args: Record<string, unknown>,
  ) => {
    const client = clientRef.current
    if (!client) throw new Error('MCP server is not ready')
    return callMcpTool(client, tool, args)
  }, [])

  return useMemo(() => ({ state, error, callTool }), [callTool, error, state])
}
