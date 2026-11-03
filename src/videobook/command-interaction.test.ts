import { describe, expect, it } from 'vitest'
import { scopedEngine } from '../../server/src/engine'
import { buildWorkspaceActionCatalog } from '../../server/src/workspace-action-catalog'
import { getCanonicalCommands } from '../../server/src/tools/commands'
import { getAllToolDefs } from '../../server/src/tools/index'
import { commandOpensPreviewForm, commandRunsAsPreview, fillDirectTarget } from './command-interaction'
import { workspaceActionLoadsOnOpen } from './workspace-actions'

describe('slash command interaction dispatch', () => {
  const { actions } = buildWorkspaceActionCatalog(getAllToolDefs(scopedEngine), getCanonicalCommands())
  const action = (command: string) => actions.find((entry) => entry.command === command)!

  it('opens a preview card for a bare preview command and never for a direct one', () => {
    expect(commandOpensPreviewForm(action('/describe'), '')).toBe(true)
    expect(commandRunsAsPreview(action('/describe'))).toBe(true)
    expect(commandOpensPreviewForm(action('/invert'), '')).toBe(false)
    expect(commandRunsAsPreview(action('/invert'))).toBe(false)
  })

  it('runs a direct command on the selected cell or returns an inline hint', () => {
    expect(fillDirectTarget(action('/invert'), {}, 'artifact-1')).toEqual({ ok: true, args: { asset_id: 'artifact-1' } })
    expect(fillDirectTarget(action('/invert'), { asset_id: 'artifact-2' }, 'artifact-1')).toEqual({ ok: true, args: { asset_id: 'artifact-2' } })
    expect(fillDirectTarget(action('/invert'), {}, undefined)).toEqual({ ok: false, message: '/invert: Select a cell or name one, such as @a1.' })
  })
})

describe('read-only actions load on open', () => {
  const { actions } = buildWorkspaceActionCatalog(getAllToolDefs(scopedEngine), getCanonicalCommands())
  const tool = (name: string) => actions.find((entry) => entry.id === `tool.${name}`)!

  it('runs diagnostics, metadata and history immediately but never a fix or a cleanup', () => {
    expect(workspaceActionLoadsOnOpen(tool('doctor'), { book_id: 'book' })).toBe(true)
    expect(workspaceActionLoadsOnOpen(tool('doctor'), { book_id: 'book', fix: true, asset_id: 'a' })).toBe(false)
    expect(workspaceActionLoadsOnOpen(tool('doctor'), { book_id: 'book', clean: true })).toBe(false)
    expect(workspaceActionLoadsOnOpen(tool('read_asset_metadata'), { book_id: 'book' })).toBe(false)
    expect(workspaceActionLoadsOnOpen(tool('delete_asset'), { book_id: 'book', asset_id: 'a' })).toBe(false)
  })
})
