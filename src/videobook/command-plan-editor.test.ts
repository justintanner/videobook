import { describe, expect, it } from 'vitest'
import { scopedEngine } from '../../server/src/engine'
import { buildWorkspaceActionCatalog } from '../../server/src/workspace-action-catalog'
import { APPLICATION_COMMANDS } from '../../server/src/tools/application-commands'
import { getCanonicalCommands } from '../../server/src/tools/commands'
import { getAllToolDefs } from '../../server/src/tools/index'
import { commandPlanEditor, commandPlanEditorInput, commandPlanEditorSchema, roughCutOptions } from './command-plan-editor'

describe('editable command plans', () => {
  const { actions } = buildWorkspaceActionCatalog(getAllToolDefs(scopedEngine), getCanonicalCommands())
  const action = (command: string) => actions.find((entry) => entry.command === command)!
  const params = (command: string) => APPLICATION_COMMANDS.find((entry) => entry.command === command)!.params

  it('seeds the card from the typed arguments and rebuilds the command from edited values', () => {
    const editor = commandPlanEditor('/caption', params('/caption'), ['0', '90', 'clean', 'Opening', 'scene'])!
    expect(editor.values).toEqual({ start_frame: 0, duration_frames: 90, style: 'clean', text: 'Opening scene' })
    const edited = { ...editor, values: { ...editor.values, style: 'bold', duration_frames: 120 } }
    expect(commandPlanEditorInput(edited, action('/caption').inputSchema)).toBe('/caption 0 120 bold Opening scene')
  })

  it('edits export aspect and captions as flags', () => {
    const editor = commandPlanEditor('/export', [], ['--aspect', '9:16'])!
    expect(editor.values).toEqual({ aspect: '9:16', captions: 'burned' })
    expect(commandPlanEditorInput({ ...editor, values: { aspect: '1:1', captions: 'omit' } }, action('/export').inputSchema)).toBe('/export --aspect 1:1 --captions omit')
  })

  it('edits clip verbs with their sequence parameters', () => {
    const trim = commandPlanEditor('/trim', [], ['@clip-1', '0', '15'])!
    expect(trim.values).toEqual({ clip_id: 'clip-1', start_frame: 0, duration_frames: 15 })
    const trimSchema = commandPlanEditorSchema(trim, undefined)!
    expect(commandPlanEditorInput({ ...trim, values: { ...trim.values, duration_frames: 30 } }, trimSchema)).toBe('/trim clip-1 0 30')
    const remove = commandPlanEditor('/delete', [], ['@clip-1', '--ripple'])!
    expect(remove.values).toEqual({ clip_id: 'clip-1', ripple: true })
    expect(commandPlanEditorInput({ ...remove, values: { ...remove.values, ripple: false } }, commandPlanEditorSchema(remove, undefined)!)).toBe('/delete clip-1')
  })

  it('edits rough-cut shot limits with their defaults', () => {
    const editor = commandPlanEditor('/rough-cut', params('/rough-cut'), ['45'])!
    expect(editor.values).toEqual({ min_shot_frames: 45, max_shot_frames: 120, max_repeats_per_artifact: 1 })
    expect(roughCutOptions(editor.values)).toEqual({ min_shot_frames: 45, max_shot_frames: 120, max_repeats_per_artifact: 1 })
    expect(roughCutOptions({})).toEqual({ min_shot_frames: 30, max_shot_frames: 120, max_repeats_per_artifact: 1 })
    expect(commandPlanEditorInput({ ...editor, values: { ...editor.values, max_repeats_per_artifact: 2 } }, action('/rough-cut').inputSchema)).toBe('/rough-cut 45 120 2')
  })
})
