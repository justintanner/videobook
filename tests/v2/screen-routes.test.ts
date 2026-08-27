import { describe, expect, it } from 'vitest'
import {
  pathForScreen,
  screenFromPath,
  screenTitle,
  type Screen,
} from '../../src/videobook/screen-routes'

const screens: Screen[] = ['notebook', 'library', 'timeline', 'jobs', 'settings']

describe('screenFromPath', () => {
  it('maps the root path to the notebook screen', () => {
    expect(screenFromPath('/')).toBe('notebook')
  })

  it('maps each routed path to its screen', () => {
    expect(screenFromPath('/library')).toBe('library')
    expect(screenFromPath('/timeline')).toBe('timeline')
    expect(screenFromPath('/jobs')).toBe('jobs')
    expect(screenFromPath('/settings')).toBe('settings')
  })

  it('tolerates trailing slashes', () => {
    expect(screenFromPath('/library/')).toBe('library')
    expect(screenFromPath('/settings//')).toBe('settings')
  })

  it('falls back to the notebook screen for unknown paths', () => {
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
    expect(pathForScreen('library')).toBe('/library')
  })
})

describe('screenTitle', () => {
  it('uses the bare app name for the notebook screen', () => {
    expect(screenTitle('notebook')).toBe('VIDEOBOOK')
  })

  it('prefixes routed screens with their name', () => {
    expect(screenTitle('library')).toBe('Library · VIDEOBOOK')
    expect(screenTitle('timeline')).toBe('Timeline · VIDEOBOOK')
    expect(screenTitle('jobs')).toBe('Jobs · VIDEOBOOK')
    expect(screenTitle('settings')).toBe('Settings · VIDEOBOOK')
  })
})
