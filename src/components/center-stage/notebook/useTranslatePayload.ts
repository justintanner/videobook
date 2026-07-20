import { useEffect, useRef, useState } from 'react'
import type { UseMcpResult } from 'use-mcp/react'

export interface TranslatedPayload {
  provider_path: string
  payload: Record<string, unknown>
}

interface TranslateState {
  key: string
  result: TranslatedPayload | null
  error: string | null
}

function responseText(result: Awaited<ReturnType<UseMcpResult['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>
  return content[0]?.text ?? ''
}

/** Resolve the actual @apicity provider request body for the current tool
 *  call via the translate_payload MCP tool. Fetches only while `enabled`
 *  (payload view open and MCP ready); refetches when the tool call changes. */
export function useTranslatePayload(
  callTool: UseMcpResult['callTool'],
  toolName: string | null,
  args: Record<string, unknown> | null,
  enabled: boolean,
) {
  const [state, setState] = useState<TranslateState>({ key: '', result: null, error: null })
  const callToolRef = useRef(callTool)
  const requestIdRef = useRef(0)
  const requestKey = enabled && toolName && args ? JSON.stringify([toolName, args]) : ''

  useEffect(() => {
    callToolRef.current = callTool
  }, [callTool])

  useEffect(() => {
    if (!requestKey) return
    const requestId = ++requestIdRef.current
    const [name, payloadArgs] = JSON.parse(requestKey) as [string, Record<string, unknown>]
    void (async () => {
      try {
        const result = await callToolRef.current('translate_payload', {
          tool_name: name,
          args_json: JSON.stringify(payloadArgs),
        })
        if (requestId !== requestIdRef.current) return
        if (result.isError) {
          setState({ key: requestKey, result: null, error: responseText(result) || 'Payload preview unavailable' })
          return
        }
        setState({ key: requestKey, result: JSON.parse(responseText(result)) as TranslatedPayload, error: null })
      } catch (cause) {
        if (requestId !== requestIdRef.current) return
        setState({
          key: requestKey,
          result: null,
          error: cause instanceof Error ? cause.message : 'Payload preview unavailable',
        })
      }
    })()
  }, [requestKey])

  const current = state.key === requestKey
  return {
    result: current ? state.result : null,
    error: current ? state.error : null,
    loading: requestKey !== '' && !current,
  }
}
