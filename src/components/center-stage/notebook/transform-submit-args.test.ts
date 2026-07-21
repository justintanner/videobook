import { describe, it, expect } from 'vitest'
import { transformNotebookSubmitArgs } from './transform-submit-args'
import type { ModelOption } from '@/components/gen/types'

function optionWith(characterRefs: boolean): ModelOption {
  return {
    key: 'test',
    label: 'test',
    providers: [{ key: 'google', label: 'Google Flow' }],
    schema: {
      properties: characterRefs ? { character_refs: { type: 'array' } } : {},
      required: [],
    },
  } as unknown as ModelOption
}

describe('transformNotebookSubmitArgs', () => {
  it('rewrites @<handle> character mentions to @character_N when character_refs is in the schema', () => {
    const out = transformNotebookSubmitArgs({
      option: optionWith(true),
      values: {
        prompt: '@jane waves at @bob',
        character_refs: ['character:jane', 'character:bob'],
        image_slugs: [],
        voice_refs: [],
      },
      charMentions: [
        { handle: 'jane', n: 1 },
        { handle: 'bob', n: 2 },
      ],
    })
    expect(out.prompt).toBe('@character_1 waves at @character_2')
  })

  it('strips orphaned @character_N markers that exceed the actual ref count', () => {
    const out = transformNotebookSubmitArgs({
      option: optionWith(true),
      values: {
        prompt: '@character_1 and @character_3 meet',
        character_refs: ['character:a'],
        image_slugs: [],
        voice_refs: [],
      },
      charMentions: [{ handle: 'a', n: 1 }],
    })
    // character_1 stays (valid), character_3 is orphaned
    expect(out.prompt).toBe('@character_1 and  meet')
  })

  it('leaves the prompt untouched when character_refs is not in the schema', () => {
    const out = transformNotebookSubmitArgs({
      option: optionWith(false),
      values: { prompt: '@jane waves' },
      charMentions: [{ handle: 'jane', n: 1 }],
    })
    expect(out.prompt).toBe('@jane waves')
  })

  it('leaves the prompt untouched when charMentions is missing', () => {
    const out = transformNotebookSubmitArgs({
      option: optionWith(true),
      values: { prompt: '@jane waves' },
    })
    expect(out.prompt).toBe('@jane waves')
  })

  it('preserves other values (character_refs, image_slugs) alongside the rewritten prompt', () => {
    const out = transformNotebookSubmitArgs({
      option: optionWith(true),
      values: {
        prompt: '@jane',
        character_refs: ['character:jane'],
        image_slugs: ['img-x'],
        voice_refs: [],
      },
      charMentions: [{ handle: 'jane', n: 1 }],
    })
    expect(out.prompt).toBe('@character_1')
    expect(out.character_refs).toEqual(['character:jane'])
    expect(out.image_slugs).toEqual(['img-x'])
  })

  it('returns a shallow copy so callers can safely mutate', () => {
    const input = { prompt: '@jane', character_refs: ['character:jane'] }
    const out = transformNotebookSubmitArgs({
      option: optionWith(true),
      values: input,
      charMentions: [{ handle: 'jane', n: 1 }],
    })
    expect(out).not.toBe(input)
    expect(input.prompt).toBe('@jane')  // input unchanged
  })
})
