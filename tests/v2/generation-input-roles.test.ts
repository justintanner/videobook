import { describe, expect, it } from 'vitest'
import { generationInputRoles, type GenerationRoleEntry } from '../../server/src/generation-input-roles.js'
import type { RefRole } from '../../server/src/media/types.js'

const image = (targetInput: string): GenerationRoleEntry => ({ targetInput, kind: 'image' })
const ports = (roles: Partial<Record<RefRole, GenerationRoleEntry[]>>) =>
  Object.fromEntries(Object.entries(roles).map(([role, entries]) => [role, entries!.map((entry) => entry.targetInput)]))

describe('generationInputRoles', () => {
  it('moves the first images into the frames of an image-to-video mode without reference images', () => {
    const roles = new Set<RefRole>(['first_frame', 'last_frame'])
    expect(ports(generationInputRoles([image('image_2'), image('image'), image('image_3')], roles, 'i2v')))
      .toEqual({ first_frame: ['image'], last_frame: ['image_2'] })
    expect(ports(generationInputRoles([image('image'), image('last_frame')], roles, 'i2v')))
      .toEqual({ first_frame: ['image'], last_frame: ['last_frame'] })
  })

  it('shifts in the default mode only once a frame is connected', () => {
    const roles = new Set<RefRole>(['first_frame', 'last_frame'])
    expect(ports(generationInputRoles([image('image')], roles, 'default'))).toEqual({})
    expect(ports(generationInputRoles([image('image'), image('last_frame')], roles, 'default')))
      .toEqual({ first_frame: ['image'], last_frame: ['last_frame'] })
  })

  it('sends frames as reference images under r2v and drops a loop there', () => {
    const roles = new Set<RefRole>(['image', 'loop'])
    expect(ports(generationInputRoles([image('first_frame'), image('loop'), image('image')], roles, 'r2v')))
      .toEqual({ image: ['image', 'first_frame'] })
  })

  it('orders keyframes and images by port, keeps replacement audio out and drops roles the mode lacks', () => {
    const roles = new Set<RefRole>(['image', 'keyframe', 'audio'])
    const entries: GenerationRoleEntry[] = [
      image('keyframe_2'), image('image_2'), image('keyframe'), image('image'),
      { targetInput: 'replace_audio', kind: 'audio' }, { targetInput: 'audio', kind: 'audio' }, { targetInput: 'video', kind: 'video' },
    ]
    expect(ports(generationInputRoles(entries, roles, 'i2v')))
      .toEqual({ image: ['image', 'image_2'], audio: ['audio'], keyframe: ['keyframe', 'keyframe_2'] })
  })
})
