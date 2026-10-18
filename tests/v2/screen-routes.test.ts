import { describe, expect, it } from 'vitest'
import {
  pathForScreen,
  screenFromPath,
  screenTitle,
  type Screen,
} from '../../src/videobook/screen-routes'

const screens: Screen[] = ['notebook', 'jobs', 'settings']

describe('screenFromPath', () => {
  it('maps the root path to the notebook screen', () => {
    expect(screenFromPath('/')).toBe('notebook')
  })

  it('maps each routed path to its screen', () => {
    expect(screenFromPath('/jobs')).toBe('jobs')
    expect(screenFromPath('/settings')).toBe('settings')
  })

  it('tolerates trailing slashes', () => {
    expect(screenFromPath('/jobs/')).toBe('jobs')
    expect(screenFromPath('/settings//')).toBe('settings')
  })

  it('falls back to the notebook screen for unknown paths', () => {
    expect(screenFromPath('/library')).toBe('notebook')
    expect(screenFromPath('/library/')).toBe('notebook')
    expect(screenFromPath('/timeline')).toBe('notebook')
    expect(screenFromPath('/timeline/')).toBe('notebook')
    expect(screenFromPath('/unknown')).toBe('notebook')
    expect(screenFromPath('/library/extra')).toBe('notebook')
    expect(screenFromPath('')).toBe('notebook')
  })
})

describe('pathForScreen', () => {
  it('round-trips every screen through screenFromPath', () => {
    for (const screen of screens) {
      expect(screenFromPath(pathForScreen(screen))).toBe(screen)
    }
  })

  it('maps the notebook screen to the root path', () => {
    expect(pathForScreen('notebook')).toBe('/')
  })
})

describe('screenTitle', () => {
  it('uses the bare app name for the notebook screen', () => {
    expect(screenTitle('notebook')).toBe('VIDEOBOOK')
  })

  it('prefixes routed screens with their name', () => {
    expect(screenTitle('jobs')).toBe('Jobs · VIDEOBOOK')
    expect(screenTitle('settings')).toBe('Settings · VIDEOBOOK')
  })
})
