import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { estimateDubCost } from '../../server/src/dub-video'
import { DUB_VIDEO_MODELS } from '../../server/src/dub-video-contract'
import { resolveModel } from '../../server/src/media/descriptor'
import { modelListing } from '../../server/src/media/listing'
import { MediaDockActions } from '../../src/components/videobook/MediaDockActions'
import type { MediaDockKind } from '../../src/videobook/media-dock'
import { dubCatalogLanguages, dubEstimateUsd } from '../../src/videobook/useDubVideo'

describe('video cell dub picker', () => {
  it('offers the action only on video cells and disables it while disconnected', () => {
    function dock(kind: MediaDockKind) {
      return renderToStaticMarkup(createElement(MediaDockActions, {
        kind, bookId: 'book', artifactId: 'clip', call: undefined, busy: false,
        dub: { notebookId: 'notebook', cellId: 'cell', onRefresh: async () => undefined },
      }))
    }
    expect(dock('video')).toMatch(/<button[^>]*disabled=""[^>]*aria-haspopup="dialog"/)
    expect(dock('image')).not.toContain('aria-haspopup="dialog"')
    expect(dock('audio')).not.toContain('aria-haspopup="dialog"')
  })

  it('reads both published language lists and the two-language speed quote', () => {
    const models = Object.values(DUB_VIDEO_MODELS).map(id => modelListing(resolveModel(id)))
    const languages = dubCatalogLanguages({ models })
    for (const options of Object.values(languages)) {
      expect(options).toEqual(expect.arrayContaining(['Japanese', 'Thai (Thailand)']))
    }
    expect(dubEstimateUsd({ estimate: estimateDubCost({ durationSeconds: 2.3, quality: 'speed', languageCount: 2 }) })).toBe(0.3)
  })

  it('refuses confirmation when the server returns a zero-price warning for an unavailable estimate', () => {
    expect(() => dubEstimateUsd({ estimate: { source: 'free', usd: 0, warnings: ['Use trim_video first.'] } })).toThrow('Use trim_video first.')
  })
})
