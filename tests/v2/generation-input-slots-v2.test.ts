import { describe, expect, it } from 'vitest'
import { resolveModel } from '../../server/src/media/descriptor.js'
import { modelListing } from '../../server/src/media/listing.js'
import { notebookGenerationInputContract } from '../../server/src/notebook-generation-contract.js'
import { controlsForModel } from '../../server/src/notebook-generation-controls.js'

function inputsOf(model: string, mode: string) {
  const contract = notebookGenerationInputContract(resolveModel(model))
  const found = contract.modes.find((candidate) => candidate.id === mode)
  if (!found) throw new Error(`${model} has no ${mode} mode`)
  return found
}

describe('generation input slots v2', () => {
  it('labels Grok 1.5 Preview frames, references and timed keyframes per mode', () => {
    const frames = inputsOf('kie:grok-imagine-video-1-5-preview', 'i2v')
    expect(frames.label).toBe('Frames')
    expect(frames.inputs.map((input) => [input.target, input.label, input.fields.map((field) => field.path), input.token, input.sent])).toEqual([
      ['image', 'Reference images', ['image_urls'], 'image', true],
      ['first_frame', 'First frame', ['first_frame_url'], 'firstframe', true],
      ['last_frame', 'Last frame', ['last_frame_url'], 'lastframe', true],
      ['keyframe', 'Keyframes', ['keyframe_urls'], 'keyframe', true],
      ['replace_audio', 'Replacement audio', [], null, false],
    ])
    expect(frames.inputs.find((input) => input.target === 'keyframe')?.itemParams).toEqual([{
      name: 'timestamp_s',
      label: 'Time',
      valueType: 'number',
      minimum: 0,
      exclusiveMinimum: true,
      unit: 's',
      computedDefault: 'even_seconds',
      legacyOptions: ['keyframe_1_seconds', 'keyframe_2_seconds', 'keyframe_3_seconds', 'keyframe_4_seconds'],
    }])
    expect(frames.limits).toEqual([{ kind: 'max', roles: [{ role: 'image' }], max: 1, when: { option: 'resolution', equals: '1080p' }, message: '1080p takes one reference image' }])
    const loop = inputsOf('kie:grok-imagine-video-1-5-preview', 'loop')
    expect(loop.label).toBe('Loop')
    expect(loop.inputs.map((input) => input.target)).toEqual(['image', 'loop', 'keyframe', 'replace_audio'])
  })

  it('keeps Seedance 2.5 frame limits out of its reference mode', () => {
    expect(inputsOf('kie:bytedance/seedance-2-5', 'i2v').limits).toEqual([
      { kind: 'requires', role: 'last_frame', requires: 'first_frame', message: 'A last frame needs a first frame' },
    ])
    const references = inputsOf('kie:bytedance/seedance-2-5', 'r2v')
    expect(references.limits).toEqual([])
    expect(references.inputs.map((input) => [input.target, input.label, input.max])).toEqual([
      ['image', 'Reference images', 30],
      ['video', 'Reference videos', 10],
      ['audio', 'Reference audio', 10],
      ['replace_audio', 'Replacement audio', 1],
    ])
  })

  it('labels each field of a composite slot in fill order', () => {
    const [image] = inputsOf('fal:bria/fibo-edit-1.5/product-holding', 'default').inputs
    expect(image?.label).toBe('Person image + Product images')
    expect(image?.fields).toEqual([
      { path: 'person_image_url', label: 'Person image', max: 1 },
      { path: 'product_image_urls', label: 'Product images', max: 3 },
    ])
  })

  it('derives item params from item schemas, catalog defaults and aliases', () => {
    const video = inputsOf('kie:gemini-omni-video', 'v2v').inputs.find((input) => input.target === 'video')
    expect(video?.itemParams.map((param) => [param.name, param.valueType, param.defaultValue, param.legacyOptions])).toEqual([
      ['start', 'number', 0, ['clip_start']],
      ['ends', 'number', 8, ['clip_end']],
    ])
    const keyframes = inputsOf('fal:blackforestlabs/flux-3/keyframes-to-video', 'default').inputs.find((input) => input.target === 'image')
    expect(keyframes?.label).toBe('Keyframes')
    expect(keyframes?.itemParams.map((param) => [param.name, param.valueType])).toEqual([['frame_index', 'integer']])
  })

  it('marks per-item legacy options as hidden controls without dropping them', () => {
    const controls = controlsForModel(resolveModel('kie:grok-imagine-video-1-5-preview'))
    expect(controls.filter((control) => control.hidden).map((control) => control.name)).toEqual([
      'keyframe_1_seconds', 'keyframe_2_seconds', 'keyframe_3_seconds', 'keyframe_4_seconds',
    ])
    expect(controls.filter((control) => !control.hidden).map((control) => control.name)).toEqual(expect.arrayContaining(['aspect_ratio', 'resolution', 'duration']))
    expect(controlsForModel(resolveModel('kie:bytedance/seedance-2-5')).some((control) => control.hidden)).toBe(false)
  })

  it('lists inputs and limits next to the role refs agents already read', () => {
    const listing = modelListing(resolveModel('kie:grok-imagine-video-1-5-preview'))
    expect(listing.refs.map((ref) => ref.role)).toEqual(listing.inputs.map((input) => input.role))
    expect(listing.inputs.find((input) => input.role === 'keyframe')).toMatchObject({ kind: 'image', label: 'Keyframes', max: 4 })
    expect(listing.limits).toHaveLength(1)
  })
})
