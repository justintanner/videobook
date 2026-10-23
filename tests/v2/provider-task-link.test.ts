import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderTaskLink } from '../../src/components/videobook/ProviderTaskLink'
import { parseProviderTaskStatus, providerStatusUrl } from '../../server/src/provider-status-link'

describe('ProviderTaskLink', () => {
  it('shows a MachGen task id without inventing a status page', () => {
    const task = parseProviderTaskStatus({ provider: 'machgen', model: 'Seedance-2.5', taskId: 'machgen-task-1' })
    expect(task).toEqual({ provider: 'machgen', model: 'Seedance-2.5', taskId: 'machgen-task-1' })
    expect(providerStatusUrl('machgen', 'Seedance-2.5')).toBeNull()

    const html = renderToStaticMarkup(createElement(ProviderTaskLink, { task: task! }))
    expect(html).toContain('<span>MachGen task</span>')
    expect(html).toContain('<code title="machgen-task-1">machgen-task-1</code>')
    expect(html).not.toContain('<a ')
    expect(renderToStaticMarkup(createElement(ProviderTaskLink, { task: { ...task!, taskId: null } }))).toBe('')
  })

  it('keeps linking fal and Kie requests only when a dashboard exists', () => {
    const fal = renderToStaticMarkup(createElement(ProviderTaskLink, {
      task: { provider: 'fal', model: 'fal-ai/nano-banana-pro/edit', taskId: 'fal-1' },
    }))
    expect(fal).toContain('href="https://fal.ai/models/fal-ai/nano-banana-pro/edit/requests"')
    expect(renderToStaticMarkup(createElement(ProviderTaskLink, {
      task: { provider: 'fal', model: null, taskId: 'fal-1' },
    }))).toBe('')
    expect(renderToStaticMarkup(createElement(ProviderTaskLink, {
      task: { provider: 'kie', model: null, taskId: 'kie-1' },
    }))).toContain('href="https://kie.ai/logs"')
  })
})
