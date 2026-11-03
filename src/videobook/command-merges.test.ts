import { describe, expect, it } from 'vitest'
import { getCanonicalCommands } from '../../server/src/tools/commands'
import { canonicalCommandToken } from '../lib/command-registry'
import { rewriteRetiredCommand, routeMergedCommand, transcribeRequestsFreshRun } from './command-merges'

const commands = getCanonicalCommands()
const route = (input: string) => {
  const [token = '', ...parts] = rewriteRetiredCommand(input).split(/\s+/u)
  return { command: canonicalCommandToken(commands, token), route: routeMergedCommand(canonicalCommandToken(commands, token), parts) }
}

describe('merged slash commands', () => {
  it('rewrites retired names onto their canonical verb', () => {
    expect(rewriteRetiredCommand('/recover @a1')).toBe('/doctor @a1 fix')
    expect(rewriteRetiredCommand('/clear-failed')).toBe('/doctor clean')
    expect(rewriteRetiredCommand('/scene-concat @a1 @a2 0.5')).toBe('/splice @a1 @a2 smooth 0.5')
    expect(rewriteRetiredCommand('/export-to @a1 other launch cut')).toBe('/duplicate @a1 --project other launch cut')
    expect(rewriteRetiredCommand('/tldr @a1 tiktok')).toBe('/rewrite @a1 tldr tiktok')
    expect(rewriteRetiredCommand('/bg blur')).toBe('/settings bg blur')
    expect(rewriteRetiredCommand('/trim @a1 0 5')).toBe('/trim @a1 0 5')
  })

  it('routes each merged verb to the tool its arguments ask for', () => {
    expect(route('/sound-effects').route).toEqual({ kind: 'sound-effects' })
    expect(route('/sfx @a1').route).toBeNull()
    expect(route('/apply-sfx @a1 2.5 whoosh fast transition').route).toEqual({
      kind: 'tool', tool: 'apply_sfx', preview: true,
      args: { asset_id: 'a1', sfx: [{ timestamp: 2.5, type: 'whoosh', description: 'fast transition' }] },
    })
    expect(route('/scene-concat @a1 @a2 0.5').route).toEqual({
      kind: 'tool', tool: 'smooth_scene_concat', preview: true,
      args: { first_asset_id: 'a1', second_asset_id: 'a2', transition_seconds: 0.5 },
    })
    expect(route('/splice @a1 @a2 0').route).toBeNull()
    expect(route('/export-to @a1 other').route).toEqual({
      kind: 'tool', tool: 'export_asset_to_project', preview: false, args: { asset_id: 'a1', target_project: 'other' },
    })
    expect(route('/tldr @a1').route).toMatchObject({ kind: 'tool', tool: 'rewrite_script', args: { asset_id: 'a1', variant: 'tldr' } })
    expect(route('/rewrite make it cinematic').route).toBeNull()
    expect(route('/character @a1 @a2').route).toEqual({ kind: 'tool', tool: 'create_character', preview: false, args: { args: ['a1', 'a2'] } })
    expect(route('/character-new luna calm').route).toBeNull()
    expect(route('/settings-portrait').route).toEqual({ kind: 'settings', uiAction: 'settings_portrait', values: {} })
    expect(route('/audio-settings volume 80').route).toEqual({ kind: 'settings', uiAction: 'settings_audio', values: { field: 'volume', value: '80' } })
    expect(route('/bg black @a1').route).toEqual({ kind: 'settings', uiAction: 'settings_bg', values: { asset_id: 'a1', mode: 'black' } })
  })

  it('resolves every retired name through a canonical alias', () => {
    for (const name of ['/recover', '/clear-failed', '/sound-effects', '/scene-concat', '/export-to', '/transcript', '/tldr', '/bg', '/character-new']) {
      expect(canonicalCommandToken(commands, name), name).not.toBe(name)
    }
    expect(transcribeRequestsFreshRun(['@a1', 'again'])).toBe(true)
    expect(transcribeRequestsFreshRun(['@a1'])).toBe(false)
  })
})
