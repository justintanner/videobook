import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GoalShortReview } from '../../src/components/videobook/GoalShortReview'
import { GoalPanel } from '../../src/components/videobook/GoalPanel'
import type { AssetRecord } from '../../src/videobook/workspace-responses'
import type { GoalSnapshot, MainCharacterView } from '../../src/videobook/goals'
import { SHORT_RULES } from '../../server/src/goal-short-rules'
import { shortGoalFixture, shortPlanFixture, shortStage } from './goal-short-fixtures'

const noop = async () => shortGoalFixture()
const noCharacter = async (): Promise<MainCharacterView> => ({ character: { name: 'Main character', description: 'a man in a green shirt', silent: true }, references: [], sheet: { estimate: { usd: null, warnings: [] }, pending: null, lastError: null } })

function asset(artifactId: string): AssetRecord | null {
  if (!artifactId.startsWith('clip') && !artifactId.startsWith('final')) return null
  return { mediaUrl: `/media/${artifactId}.mp4`, thumbnailUrl: null, duration: 20, fps: 24, objectHash: `${artifactId}-hash` } as unknown as AssetRecord
}

function render(goal: GoalSnapshot): string {
  return renderToStaticMarkup(createElement(GoalShortReview, {
    goal, plan: goal.shortPlan!, disabled: false, resolveAsset: asset, onPreviewCell: () => undefined, onRun: () => undefined, onAction: noop, onCharacter: noCharacter,
  }))
}

function button(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*>(?:(?!</button>).)*${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:(?!</button>).)*</button>`, 'u').exec(html)
  return match?.[0] ?? ''
}

const withFrame = { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a', versions: 2 }]) }

describe('GoalShortReview', () => {
  it('opens on the frame with the four tabs, its estimate and the read-only rule lines', () => {
    const html = render(shortGoalFixture())
    for (const tab of ['Character', 'Frame', 'Video', 'Finish']) expect(html).toContain(`>${tab}</button>`)
    expect(button(html, 'Generate frame')).toContain('Generate frame · $0.21')
    expect(button(html, 'Generate frame')).not.toContain('disabled')
    expect(html).toContain('aria-label="Always added"')
    expect(html).toContain(`<p>${SHORT_RULES.frame}</p>`)
    expect(html).not.toMatch(new RegExp(`<textarea[^>]*>[^<]*${SHORT_RULES.frame.slice(0, 20)}`, 'u'))
    expect(html).toContain('/ 40 words')
  })

  it('disables the frame with a reason while the character has no reference image', () => {
    const html = render(shortGoalFixture({}, shortPlanFixture([12], [])))
    expect(button(html, 'Generate frame')).toContain('disabled=""')
    expect(html).toContain('Give the main character a reference image first')
    const ready = render(shortGoalFixture({ mainCharacterReferences: 1 }, shortPlanFixture([12], [])))
    expect(button(ready, 'Generate frame')).not.toContain('disabled')
    expect(ready).not.toContain('Give the main character a reference image first')
  })

  it('shows each clip with its state and estimate, continues the next one and offers another beat', () => {
    const goal = shortGoalFixture({ stage: 'videos', stages: { ...withFrame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }]) } })
    const html = render(goal)
    expect(html).toContain('aria-label="Current clip"')
    expect(html).toMatch(/Clip 1<\/strong><span>10s<\/span><span>Ready<\/span><span>at least \$0\.60<\/span>/u)
    expect(html).toMatch(/Clip 2<\/strong><span>10s<\/span><span>Not generated<\/span><span>at least \$0\.60<\/span>/u)
    expect(button(html, 'Continue · clip 2')).toContain('Continue · clip 2 · at least $0.60')
    expect(html).toContain('<legend>Add a beat</legend>')
    expect(html).toContain(`<p>${SHORT_RULES.video}</p><p>${SHORT_RULES.silence}</p>`)
  })

  it('marks a stale clip and generates it again first', () => {
    const goal = shortGoalFixture({ stage: 'videos', stages: { ...withFrame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a', stale: 'The frame or an earlier clip changed after this clip was made.' }]) } })
    const html = render(goal)
    expect(html).toContain('<span>Out of date</span>')
    expect(html).toContain('The frame or an earlier clip changed after this clip was made.')
    expect(button(html, 'Generate clip')).toContain('Generate clip · at least $0.60')
  })

  it('hides Add a beat at four clips', () => {
    const html = render(shortGoalFixture({ stage: 'videos', stages: withFrame }, shortPlanFixture([5, 5, 5, 5])))
    expect(html).not.toContain('Add a beat')
  })

  it('opens on the next clip, not the earlier finish, after a beat is added to a finished short', () => {
    const goal = shortGoalFixture({
      stage: 'videos', finalArtifactId: 'final-a',
      stages: { ...withFrame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }, { index: 1, artifactId: 'clip-b' }]) },
      finish: { status: 'completed', sourceArtifactId: 'clip-b', finalArtifactId: 'final-a', error: null },
    }, shortPlanFixture([10, 10, 5]))
    const html = render(goal)
    expect(button(html, 'Continue · clip 3')).toContain('Continue · clip 3 · at least $0.60')
    expect(html).toMatch(/Clip 3<\/strong><span>5s<\/span><span>Not generated<\/span>/u)
    expect(html).not.toContain('aria-label="Finished short"')
  })

  it('reviews the cold open and plays the finished short', () => {
    const goal = shortGoalFixture({
      status: 'completed', stage: 'videos', finalArtifactId: 'final-a',
      stages: { ...withFrame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }, { index: 1, artifactId: 'clip-b' }]) },
      finish: { status: 'completed', sourceArtifactId: 'clip-b', finalArtifactId: 'final-a', error: null, startSeconds: 0, endSeconds: 2.3 },
      coldOpen: { startSeconds: 0, endSeconds: 2.3, durationSeconds: 20, sourceObjectHash: 'clip-b-hash', analysisUsd: 0 },
    })
    const html = render(goal)
    expect(html).toContain('aria-label="Finished short"')
    expect(html).toContain('src="/media/final-a.mp4"')
    expect(button(html, 'Finish')).toContain('>Finish<')
  })
})

describe('GoalPanel with a short', () => {
  it('opens the short review for a version-4 goal and the older reviews for others', () => {
    const props = { connected: true, onAction: noop, onCharacter: noCharacter, onPreview: async () => undefined, onSelectCell: () => undefined, onPreviewCell: () => undefined, resolveAsset: asset }
    expect(renderToStaticMarkup(createElement(GoalPanel, { ...props, goal: shortGoalFixture() }))).toContain('aria-label="Short stages"')
    expect(renderToStaticMarkup(createElement(GoalPanel, { ...props, goal: shortGoalFixture({ status: 'planning', shortPlan: undefined }) }))).toContain('Planning the frame and the beats of your short')
    const failed = renderToStaticMarkup(createElement(GoalPanel, { ...props, goal: shortGoalFixture({ status: 'failed', shortPlan: undefined, error: 'OpenAI API error 500' }) }))
    expect(failed).toContain('>Short<')
    expect(failed).toContain('OpenAI API error 500')
    expect(button(failed, 'Retry planning')).toMatch(/>Retry planning<\/button>$/u)
    expect(failed).not.toContain('ready ·')
  })
})
