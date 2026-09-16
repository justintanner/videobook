import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { McpCallRows } from '../../src/components/videobook/McpCallRows'
import {
  MCP_CALL_HISTORY,
  beginMcpCall,
  emptyMcpCallLog,
  formatMcpElapsed,
  mcpCallArgs,
  mcpCallState,
  mcpCallsRunning,
  mcpResultSummary,
  settleMcpCall,
  shouldNotifyMcpActivity,
  toggleMcpCall,
  type McpCallLog,
} from '../../src/videobook/mcp-activity'

function started(log: McpCallLog, id: number, tool: string, args: Record<string, unknown> = {}) {
  return beginMcpCall(log, { id, tool, args: mcpCallArgs(args) })
}

function render(log: McpCallLog): string {
  return renderToStaticMarkup(createElement(McpCallRows, { log, onToggle: () => {} }))
}

describe('mcp call log', () => {
  it('keeps every call as its own row instead of replacing the newest', () => {
    const log = started(started(emptyMcpCallLog, 1, 'plan_chat_command'), 2, 'chain')
    expect(log.calls.map((call) => call.tool)).toEqual(['plan_chat_command', 'chain'])
    expect(mcpCallsRunning(log)).toBe(2)
    expect(log.calls.every((call) => call.phase === 'running' && !call.expanded)).toBe(true)
  })

  it('settles one call without disturbing the other in flight', () => {
    const log = settleMcpCall(
      started(started(emptyMcpCallLog, 1, 'plan_chat_command'), 2, 'chain'),
      1,
      { phase: 'done', elapsedMs: 842, detail: '' },
    )
    expect(log.calls[0]).toMatchObject({ phase: 'done', elapsedMs: 842 })
    expect(log.calls[1]?.phase).toBe('running')
    expect(mcpCallsRunning(log)).toBe(1)
  })

  it('records the error on a failure and leaves an unknown id alone', () => {
    const running = started(emptyMcpCallLog, 1, 'estimate_cost')
    const failed = settleMcpCall(running, 1, {
      phase: 'failed',
      elapsedMs: 120,
      detail: 'No cost adapter for generate_veo31_video',
    })
    expect(failed.calls[0]).toMatchObject({
      phase: 'failed',
      detail: 'No cost adapter for generate_veo31_video',
    })
    expect(settleMcpCall(running, 99, { phase: 'done', elapsedMs: 1, detail: '' })).toBe(running)
    expect(toggleMcpCall(running, 99)).toBe(running)
  })

  it('expands one row at a time without touching its neighbours', () => {
    const log = toggleMcpCall(started(started(emptyMcpCallLog, 1, 'chat'), 2, 'chain'), 2)
    expect(log.calls.map((call) => call.expanded)).toEqual([false, true])
    expect(toggleMcpCall(log, 2).calls.map((call) => call.expanded)).toEqual([false, false])
  })

  it('ages the oldest rows out and keeps the newest', () => {
    let log = emptyMcpCallLog
    for (let id = 1; id <= MCP_CALL_HISTORY + 4; id += 1) log = started(log, id, `tool_${id}`)
    expect(log.calls).toHaveLength(MCP_CALL_HISTORY)
    expect(log.calls[0]?.id).toBe(5)
    expect(log.calls.at(-1)?.id).toBe(MCP_CALL_HISTORY + 4)
  })
})

describe('mcp call arguments', () => {
  it('flattens values and drops the ones with nothing to show', () => {
    expect(mcpCallArgs({
      book_id: 'yosemite-reel',
      seconds: 4,
      loop: false,
      slot: { row: 0, column: 2 },
      label: '',
      media_context: null,
      actor: undefined,
    })).toEqual([
      { name: 'book_id', value: 'yosemite-reel' },
      { name: 'seconds', value: '4' },
      { name: 'loop', value: 'false' },
      { name: 'slot', value: '{"row":0,"column":2}' },
    ])
  })

  it('truncates a payload so an upload never reaches the panel', () => {
    const [arg] = mcpCallArgs({ data: 'A'.repeat(4000) })
    expect(arg?.value).toHaveLength(140 + ' (4000 chars)'.length + 1)
    expect(arg?.value.endsWith('… (4000 chars)')).toBe(true)
  })

  it('collapses whitespace so a multi-line prompt stays one row', () => {
    expect(mcpCallArgs({ prompt: 'make @a3\n  a slow pan' })[0]?.value)
      .toBe('make @a3 a slow pan')
  })
})

describe('mcp result summaries', () => {
  it('reports only what a result can say for itself', () => {
    expect(mcpResultSummary('sequence revised')).toBe('sequence revised')
    expect(mcpResultSummary([1, 2, 3])).toBe('3 items')
    expect(mcpResultSummary([1])).toBe('1 item')
    expect(mcpResultSummary({ message: 'Applied 3 of 3' })).toBe('Applied 3 of 3')
    expect(mcpResultSummary({ artifact_id: 'abc', cells: [] })).toBe('')
    expect(mcpResultSummary(null)).toBe('')
  })
})

describe('mcp elapsed time', () => {
  it('reads in the unit that fits', () => {
    expect(formatMcpElapsed(842)).toBe('842ms')
    expect(formatMcpElapsed(999.6)).toBe('1000ms')
    expect(formatMcpElapsed(1000)).toBe('1.0s')
    expect(formatMcpElapsed(6420)).toBe('6.4s')
    expect(formatMcpElapsed(61_000)).toBe('1m 1s')
    expect(formatMcpElapsed(-5)).toBe('0ms')
  })

  it('gives the trailing slot the elapsed time only once the call has landed', () => {
    const running = started(emptyMcpCallLog, 1, 'chat').calls[0]!
    expect(mcpCallState(running)).toBe('working')
    expect(mcpCallState({ ...running, phase: 'done', elapsedMs: 842 })).toBe('842ms')
    expect(mcpCallState({ ...running, phase: 'failed', elapsedMs: 120 })).toBe('failed')
  })
})

describe('mcp call rows', () => {
  it('renders nothing until a call is made', () => {
    expect(render(emptyMcpCallLog)).toBe('')
  })

  it('shows a collapsed call as one line carrying the raw tool name', () => {
    const html = render(started(emptyMcpCallLog, 1, 'plan_chat_command', { prompt: 'pan @a3' }))
    expect(html).toContain('class="mcp-call mcp-call-running"')
    expect(html).toContain('>plan_chat_command<')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('>working<')
    // Collapsed means collapsed: the arguments are not in the document at all.
    expect(html).not.toContain('mcp-call-body')
    expect(html).not.toContain('pan @a3')
  })

  it('opens onto the arguments, the humanized name and the result', () => {
    const log = toggleMcpCall(
      settleMcpCall(started(emptyMcpCallLog, 1, 'chain', { book_id: 'yosemite-reel' }), 1, {
        phase: 'done',
        elapsedMs: 6420,
        detail: '3 items',
      }),
      1,
    )
    const html = render(log)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('>6.4s<')
    expect(html).toContain('Running chained actions')
    expect(html).toContain('<dt>book_id</dt><dd>yosemite-reel</dd>')
    expect(html).toContain('3 items')
    // Read-only detail: opening a row offers nothing to submit or edit.
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<textarea')
  })

  it('carries a failure on the row and the reason inside it', () => {
    const html = render(toggleMcpCall(
      settleMcpCall(started(emptyMcpCallLog, 1, 'estimate_cost'), 1, {
        phase: 'failed',
        elapsedMs: 120,
        detail: 'No cost adapter for generate_veo31_video',
      }),
      1,
    ))
    expect(html).toContain('class="mcp-call mcp-call-failed"')
    expect(html).toContain('>failed<')
    expect(html).toContain('No cost adapter for generate_veo31_video')
  })

  it('reads ACTION as the channel, not the transport it arrived on', () => {
    const html = renderToStaticMarkup(createElement(McpCallRows, {
      log: started(emptyMcpCallLog, 1, 'chat'),
      onToggle: () => undefined,
    }))
    expect(html).toContain('<span class="mcp-call-channel">ACTION</span>')
    expect(html).not.toContain('>MCP<')
  })

  it('keeps catalogs and pollers out of the history so a reload starts clean', () => {
    for (const quiet of [
      'get_notebook',
      'list_chat_models',
      'list_jobs',
      'list_prompt_history',
      'list_workspace_actions',
      'slash_commands',
    ]) {
      expect(shouldNotifyMcpActivity(quiet)).toBe(false)
    }
    // Work the user actually asked for still earns a row.
    for (const loud of ['chat', 'chain', 'run_notebook_cell', 'create_notebook_cell']) {
      expect(shouldNotifyMcpActivity(loud)).toBe(true)
    }
  })
})
