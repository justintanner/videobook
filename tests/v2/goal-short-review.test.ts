import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GoalShortReview } from '../../src/components/videobook/GoalShortReview'
import { GoalComposerStatus } from '../../src/components/videobook/GoalComposerStatus'
import { GoalPanel } from '../../src/components/videobook/GoalPanel'
import type { AssetRecord } from '../../src/videobook/workspace-responses'
import type { NodeProps } from '@xyflow/react'
import { GoalCellNode } from '../../src/components/videobook/GoalCellNode'
import { GoalTileContext } from '../../src/components/videobook/notebook-canvas-context'
import type { CanvasNode } from '../../src/videobook/notebook-canvas'
import { defaultShortTab, LEGACY_GOAL_NOTE, type GoalSnapshot, type ShortGoalSnapshot, type ShortTab } from '../../src/videobook/goals'
import { SHORT_RULES } from '../../server/src/goal-short-rules'
import { goalShortPlanSchema, withShortFinishTitle, type ShortFinishTitle } from '../../server/src/goal-short-plan'
import { legacyGoalFixture, legacyShortPlanFixture, shortGoalFixture, shortPlanFixture, shortStage, storyboardPlanFixture, withStoryboardFailures } from './goal-short-fixtures'

const noop = async () => shortGoalFixture()

function asset(artifactId: string): AssetRecord | null {
  if (artifactId.startsWith('photo')) return { mediaUrl: `/media/${artifactId}.jpg`, thumbnailUrl: `/thumbs/${artifactId}.jpg` } as unknown as AssetRecord
  if (!artifactId.startsWith('clip') && !artifactId.startsWith('final') && !artifactId.startsWith('video')) return null
  return { mediaUrl: `/media/${artifactId}.mp4`, thumbnailUrl: null, duration: 20, fps: 24, objectHash: `${artifactId}-hash` } as unknown as AssetRecord
}

function render(goal: ShortGoalSnapshot, view: ShortTab = defaultShortTab(goal, goal.shortPlan!), titleOptions: readonly ShortFinishTitle[] = []): string {
  return renderToStaticMarkup(createElement(GoalShortReview, {
    goal, plan: goal.shortPlan!, view, disabled: false,
    resolveAsset: asset, onView: () => undefined, onPreviewCell: () => undefined, onRun: () => undefined, onAction: noop,
    titleOptions, onWriteTitle: async () => undefined,
  }))
}

function button(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*>(?:(?!</button>).)*${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:(?!</button>).)*</button>`, 'u').exec(html)
  return match?.[0] ?? ''
}

const withFrame = { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a', versions: 2 }]) }

describe('GoalShortReview', () => {
  it('lists adaptation notes above the plan', () => {
    const note = '@a1 is a video, so its frame at 1.5 s (@c5) is the reference.'
    const html = render(shortGoalFixture({ notes: [note, '@h8 is empty and was skipped.'] }), 'frame')
    expect(html.indexOf('aria-label="Notes"')).toBeGreaterThan(-1)
    expect(html.indexOf('aria-label="Notes"')).toBeLessThan(html.indexOf('aria-label="Short title"'))
    expect(html).toContain(note)
    expect(html).toContain('@h8 is empty and was skipped.')
    expect(render(shortGoalFixture({ notes: [note] }))).toContain(note)
    expect(render(shortGoalFixture())).not.toContain('aria-label="Notes"')
  })

  it('opens a new short on Frame, the first of Frame, Video and Finish', () => {
    const html = render(shortGoalFixture())
    expect([...html.matchAll(/aria-pressed="(true|false)">(\w+)<\/button>/gu)].map(match => [match[2], match[1]]).slice(0, 3))
      .toEqual([['Frame', 'true'], ['Video', 'false'], ['Finish', 'false']])
    expect(html).not.toContain('>Character</button>')
    expect(html).toContain('aria-label="Short title"')
    expect(html).toContain('aria-label="Source images"')
    expect(button(html, 'Generate frame')).toContain('Generate frame · $0.21')
  })

  it('shows a saved version 4 character read-only', () => {
    const html = render(shortGoalFixture({}, legacyShortPlanFixture([12], [])), 'character')
    expect([...html.matchAll(/aria-pressed="(true|false)">(\w+)<\/button>/gu)].map(match => [match[2], match[1]]).slice(0, 4))
      .toEqual([['Character', 'true'], ['Frame', 'false'], ['Video', 'false'], ['Finish', 'false']])
    expect(html).toContain('This short was saved with a character. The name, description and pictures stay as they were.')
    expect(html).toContain('No reference image was saved with this short.')
    expect(html).toContain('aria-label="Character name">Main character</p>')
    expect(html).toContain('aria-label="Character description">a man in a green shirt</p>')
    expect(html).not.toContain('Save character')
    expect(html).not.toContain('Generate character sheet')
    expect(html).not.toContain('Upload a character image')
    expect(html).not.toContain('<input')
  })

  it('shows the frame tab with its estimate and the read-only rule lines', () => {
    const html = render(shortGoalFixture(), 'frame')
    for (const tab of ['Frame', 'Video', 'Finish']) expect(html).toContain(`>${tab}</button>`)
    expect(html).not.toContain('>Character</button>')
    expect(button(html, 'Generate frame')).toContain('Generate frame · $0.21')
    expect(button(html, 'Generate frame')).not.toContain('disabled')
    expect(html).toContain('aria-label="Always added"')
    expect(html).toContain(`<p>${SHORT_RULES.frame}</p>`)
    expect(html).not.toMatch(new RegExp(`<textarea[^>]*>[^<]*${SHORT_RULES.frame.slice(0, 20)}`, 'u'))
    expect(html).toContain('/ 40 words')
  })

  it('approves a frame from the brief when the short has no source image', () => {
    const html = render(shortGoalFixture({}, shortPlanFixture([12], [])), 'frame')
    expect(button(html, 'Generate frame')).not.toContain('disabled')
    expect(html).toContain('aria-label="Source images"')
    expect(html).not.toContain('No reference image')
    expect(html).not.toContain('Main character')
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

  it('offers feedback and a priced revise action only for generated clips', () => {
    const goal = shortGoalFixture({ stage: 'videos', stages: { ...withFrame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }, { index: 1, artifactId: 'clip-b' }]) } }, shortPlanFixture([10, 10, 5]))
    const html = render(goal)
    for (const index of [1, 2]) {
      expect(html).toContain(`aria-label="Clip ${index} feedback"`)
      expect(button(html, `Revise clip ${index}`)).toContain('at least $0.60')
      expect(button(html, `Revise clip ${index}`)).toContain('disabled=""')
    }
    expect(html).toContain('maxLength="2000"')
    expect(html).not.toContain('Clip 3 feedback')
    expect(button(html, 'Revise clip 3')).toBe('')
    const running = render({ ...goal, status: 'running' })
    expect(running).toMatch(/<textarea aria-label="Clip 1 feedback"[^>]*disabled=""/u)
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

  it('checks the frame and each clip for AI tells on request and lists warnings first', () => {
    const findings = [{ severity: 'note' as const, text: 'Rain streaks repeat.' }, { severity: 'warn' as const, text: 'Six fingers on the right hand.' }]
    const checked = { status: 'completed' as const, checkedAt: '2026-11-12T00:00:00Z', findings, error: null }
    const frameHtml = render(shortGoalFixture({ stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a', realism: checked }]) } }))
    expect(frameHtml).toMatch(/aria-label="AI tells in the frame"><li data-severity="warn"><strong>Warn<\/strong> <span>Six fingers on the right hand\.<\/span><\/li><li data-severity="note">/u)
    expect(button(frameHtml, 'Check again for AI tells')).not.toContain('disabled')
    expect(frameHtml).toContain('billed like planning and never blocks a step')
    expect(button(frameHtml, 'Regenerate frame')).not.toContain('disabled')
    const unchecked = render(shortGoalFixture({ stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]) } }))
    expect(button(unchecked, 'Check for AI tells')).toContain('>Check for AI tells<')
    expect(render(shortGoalFixture({ stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a', realism: { ...checked, findings: [] } }]) } }))).toContain('No AI tells found in the frame.')
    const running = render(shortGoalFixture({ stage: 'videos', stages: { ...withFrame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a', realism: { status: 'running', checkedAt: null, findings: [], error: null } }]) } }))
    expect(button(running, 'Checking for AI tells')).toContain('disabled=""')
    expect(running).toContain('Looking at the clip 1 for AI tells')
    expect(running.match(/for AI tells…?<\/button>/gu) ?? []).toHaveLength(1)
  })

  it('offers Finish on the reviewed take without a range', () => {
    const goal = shortGoalFixture({
      stage: 'videos',
      stages: { ...withFrame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }, { index: 1, artifactId: 'clip-b' }]) },
      finish: { status: 'review', sourceArtifactId: 'clip-b', finalArtifactId: null, error: null },
    })
    const html = render(goal)
    expect(html).toContain('aria-label="Reviewed take"')
    expect(html).toContain('class="goal-panel-primary">Finish</button>')
    expect(html).toContain('burns the saved watermark')
    expect(html).not.toContain('Cold-open')
    expect(html).not.toContain('type="number"')
    const running = render({ ...goal, finish: { ...goal.finish!, status: 'running' } })
    expect(running).toContain('Burning the saved watermark onto the reviewed take.')
    expect(running).not.toContain('class="goal-panel-primary">Finish</button>')
  })

  const finishable = (extra: Partial<ShortGoalSnapshot> = {}, plan = shortPlanFixture()) => shortGoalFixture({
    stage: 'videos',
    stages: { ...withFrame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }, { index: 1, artifactId: 'clip-b' }]) },
    finish: { status: 'review', sourceArtifactId: 'clip-b', finalArtifactId: null, error: null },
    ...extra,
  }, plan)

  it('offers a typed or written burned title on Finish, with the Write title estimate shown first', () => {
    const estimate = { ...shortGoalFixture().estimate, title: { usd: 0.42, warnings: [] } }
    const html = render(finishable({ estimate }), 'finish')
    expect(html).toContain('<fieldset class="goal-finish-title">')
    expect(html.indexOf('aria-label="Burned title"')).toBeGreaterThan(-1)
    expect(html.indexOf('aria-label="Burned title"')).toBeLessThan(html.indexOf('aria-label="English line"'))
    expect(html).not.toContain('aria-label="Short title"')
    expect(button(html, 'Write title')).toContain('Write title · $0.42')
    expect(button(html, 'Write title')).not.toContain('disabled')
    expect(html).toContain('Typing a title costs nothing.')
    expect(html).not.toContain('aria-label="Title options"')
    expect(html).toContain('class="goal-panel-primary">Finish</button>')
    expect(button(render(finishable(), 'finish'), 'Write title')).toContain('Write title · estimate unavailable')
  })

  it('fills the fields from the saved title and marks the option they match', () => {
    const plan = goalShortPlanSchema.parse(JSON.parse(JSON.stringify(withShortFinishTitle(shortPlanFixture(), { headline: 'รอรถเมล์กลางฝน', secondary: 'Waiting for the bus in the rain' }))))
    const html = render(finishable({}, plan), 'finish', [
      { headline: 'รอรถเมล์กลางฝน', secondary: 'Waiting for the bus in the rain' },
      { headline: 'ฝนตกแต่รถเมล์ไม่มา', secondary: 'The rain came, the bus did not' },
    ])
    expect(html).toContain('>รอรถเมล์กลางฝน</textarea>')
    expect(html).toContain('>Waiting for the bus in the rain</textarea>')
    expect(html).toContain('aria-label="Title options"')
    expect(html).toContain('aria-pressed="true"><strong>รอรถเมล์กลางฝน</strong><span>Waiting for the bus in the rain</span></button>')
    expect(html).toContain('aria-pressed="false"><strong>ฝนตกแต่รถเมล์ไม่มา</strong><span>The rain came, the bus did not</span></button>')
    expect(html).toContain('class="goal-panel-primary">Finish</button>')
    expect(button(html, 'Save')).toBe('')
    expect(html).toContain('Each paid step needs its own approval.')
  })

  it('disables the title with one line when the TikTok watermark template has no headline, and the English line when it has no line under it', () => {
    const blocked = render(finishable({ titleSlots: { headline: false, secondary: false } }), 'finish')
    expect(blocked).toContain('<fieldset class="goal-finish-title" disabled="">')
    expect(blocked).toContain('The saved TikTok watermark template has no headline, so Finish burns the handle alone.')
    expect(blocked).not.toContain('Typing a title costs nothing.')
    expect(blocked).toContain('class="goal-panel-primary">Finish</button>')
    const headlineOnly = render(finishable({ titleSlots: { headline: true, secondary: false } }), 'finish')
    expect(headlineOnly).toContain('<fieldset class="goal-finish-title">')
    expect(headlineOnly).toMatch(/<textarea aria-label="English line"[^>]*disabled=""/u)
    expect(headlineOnly).toContain('has no line under its headline, so only the burned title is drawn.')
    const goal = finishable()
    expect(render({ ...goal, finish: { ...goal.finish!, status: 'running' } }, 'finish')).toContain('<fieldset class="goal-finish-title" disabled="">')
  })

  it('plays an already finished short without a cold-open review', () => {
    const goal = shortGoalFixture({
      status: 'completed', stage: 'videos', finalArtifactId: 'final-a',
      stages: { ...withFrame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }, { index: 1, artifactId: 'clip-b' }]) },
      finish: { status: 'completed', sourceArtifactId: 'clip-b', finalArtifactId: 'final-a', error: null, startSeconds: 0, endSeconds: 2.3 },
    })
    const html = render(goal)
    expect(html).toContain('aria-label="Finished short"')
    expect(html).toContain('src="/media/final-a.mp4"')
    expect(button(html, 'Finish')).toContain('>Finish<')
    expect(html).not.toContain('Cold-open')
    expect(html).not.toContain('type="number"')
  })
})

const tabsOf = (html: string) => [...html.matchAll(/aria-pressed="(true|false)">(\w+)<\/button>/gu)].map(match => [match[2], match[1]])
const boardGoal = (extra: Partial<ShortGoalSnapshot> = {}) => shortGoalFixture({ stage: 'storyboards', ...extra }, storyboardPlanFixture())
const cleaned = (versions = 1) => ({
  storyboards: shortStage('storyboards', [0, 1, 2, 3].map(index => ({ index, artifactId: `clean-${index + 1}`, versions: index === 2 ? versions : 1 }))),
})

describe('GoalShortReview with a storyboard', () => {
  it('opens a short made from a video on Storyboard, the first of Storyboard, Frame, Video and Finish', () => {
    const html = render(boardGoal())
    expect(tabsOf(html).slice(0, 4)).toEqual([['Storyboard', 'true'], ['Frame', 'false'], ['Video', 'false'], ['Finish', 'false']])
    expect(html).toContain('Seedream 5.5 storyboard clean-up · GPT Image 2.6 frame · H3 Max video')
    expect(render(shortGoalFixture({ stage: 'storyboards' }, storyboardPlanFixture(undefined, undefined, undefined, 'fal:google/nano-banana-2.1/edit'))))
      .toContain('Nano Banana 2.1 storyboard clean-up · GPT Image 2.6 frame · H3 Max video')
    expect(html).toContain('4 frames of Umbrella walk (@d1), in order.')
    expect(html).toContain('aria-label="Storyboard frames"')
    for (const index of [1, 2, 3, 4]) expect(html).toContain(`aria-label="Open Storyboard ${index} before · @a${index + 2}"`)
    expect(html).toMatch(/Storyboard 1<\/strong><span>0\.8 s<\/span><span>Not cleaned<\/span><span>\$0\.21<\/span>/u)
    expect(html).toMatch(/Storyboard 4<\/strong><span>5\.3 s<\/span><span>Not cleaned<\/span>/u)
    expect(html.match(/Not cleaned yet/gu)).toHaveLength(4)
    expect(button(html, 'Remove on-screen graphics')).toContain('Remove on-screen graphics · $0.84')
    expect(button(html, 'Remove on-screen graphics')).not.toContain('disabled')
    expect(button(html, 'Regenerate storyboard')).toBe('')
    expect(html).not.toContain('Storyboard 1 feedback')
    const partly = render(boardGoal({ stages: { storyboards: shortStage('storyboards', [{ index: 0, artifactId: 'clean-1' }]) } }))
    expect(button(partly, 'Remove on-screen graphics')).toContain('Remove on-screen graphics · $0.63')
    expect(render(boardGoal({ status: 'running' }))).toContain('Removing the on-screen graphics from the storyboard.')
  })

  it('keeps Generate frame disabled, saying why, until the storyboard is clean', () => {
    const html = render(boardGoal(), 'frame')
    expect(button(html, 'Generate frame')).toContain('disabled=""')
    expect(html).toContain('Remove the on-screen graphics from the storyboard first: the frame is made from clean storyboard frame 1.')
    const clean = render(boardGoal({ stage: 'frame', stages: cleaned() }), 'frame')
    expect(button(clean, 'Generate frame')).toContain('Generate frame · $0.21')
    expect(button(clean, 'Generate frame')).not.toContain('disabled')
    expect(clean).not.toContain('Remove the on-screen graphics from the storyboard first')
    expect(clean).toMatch(/aria-label="Frame references">.*aria-label="Open @image1 · @a1".*aria-label="Open @image2 · storyboard 1"/su)
  })

  it('shows each clean frame before and after its clean-up, with its versions, a regenerate and a revise', () => {
    const html = render(boardGoal({ stage: 'frame', stages: cleaned(2) }), 'storyboard')
    expect(html).not.toContain('Not cleaned yet')
    expect(html).toContain('aria-label="Open Storyboard 3 before · @a5"')
    expect(html).toContain('aria-label="Open Storyboard 3 after · @c3"')
    expect(html).toMatch(/Storyboard 3<\/strong><span>3\.8 s<\/span><span>Clean<\/span><span>\$0\.21<\/span>/u)
    expect(html).toContain('aria-label="Storyboard 3 versions"')
    expect(html).toMatch(/aria-label="Storyboard 3 v2" aria-pressed="true"/u)
    expect(html).toMatch(/aria-label="Storyboard 3 v1" aria-pressed="false"/u)
    expect(button(html, 'Regenerate storyboard 3')).toContain('Regenerate storyboard 3 · $0.21')
    expect(button(html, 'Regenerate storyboard 3')).not.toContain('disabled')
    expect(html).toContain('aria-label="Storyboard 3 feedback"')
    expect(button(html, 'Revise storyboard 3')).toContain('disabled=""')
    expect(button(html, 'Remove on-screen graphics')).toBe('')
  })

  it('shows a refused frame with its error, a regenerate and a revise, and a frame another failure stopped as not run', () => {
    const goal = withStoryboardFailures(boardGoal({ stages: { storyboards: shortStage('storyboards', [1, 2].map(index => ({ index, artifactId: `clean-${index + 1}` }))) } }), {
      0: { kind: 'failed', message: 'Nano Banana 2.1 Edit refused this request.' },
      3: { kind: 'not-run', message: 'Not run: storyboard 1 failed first.' },
    })
    const html = render(goal, 'storyboard')
    expect(html).toMatch(/Storyboard 1<\/strong><span>0\.8 s<\/span><span>Failed<\/span><span>\$0\.21<\/span>/u)
    expect(html).toContain('data-state="failed"')
    expect(html).toContain('<span class="goal-media goal-media-pending">Clean-up failed</span>')
    expect(html).toContain('<p role="alert" class="goal-panel-warning">Nano Banana 2.1 Edit refused this request.</p>')
    expect(button(html, 'Regenerate storyboard 1')).toContain('Regenerate storyboard 1 · $0.21')
    expect(button(html, 'Regenerate storyboard 1')).not.toContain('disabled')
    expect(html).toContain('aria-label="Storyboard 1 feedback"')
    expect(button(html, 'Revise storyboard 1')).toContain('Revise storyboard 1 · $0.21')
    expect(html).not.toContain('aria-label="Storyboard 1 versions"')
    expect(html).toMatch(/Storyboard 4<\/strong><span>5\.3 s<\/span><span>Not run<\/span>/u)
    expect(html).toContain('<span class="goal-media goal-media-pending">Not run</span>')
    expect(html).toContain('<p class="goal-panel-muted">Not run: storyboard 1 failed first.</p>')
    expect(button(html, 'Regenerate storyboard 4')).toBe('')
    expect(html).not.toContain('Storyboard 4 feedback')
    expect(html).not.toContain('Not cleaned yet')
    expect(button(html, 'Remove on-screen graphics')).toContain('Remove on-screen graphics · $0.42')
    const cleaning = render({ ...goal, status: 'running', storyboard: { ...goal.storyboard!, frames: goal.storyboard!.frames.map(frame => frame.index === 0 ? { ...frame, failure: null } : frame) } }, 'storyboard')
    expect(cleaning).toMatch(/Storyboard 1<\/strong><span>0\.8 s<\/span><span>Cleaning<\/span>/u)
    expect(cleaning).toMatch(/Storyboard 4<\/strong><span>5\.3 s<\/span><span>Not run<\/span>/u)
  })

  it('marks a frame made from an earlier clean storyboard frame 1 out of date', () => {
    const stale = 'Storyboard frame 1 changed after this frame was made.'
    const html = render(boardGoal({ stage: 'videos', stages: { ...cleaned(), frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a', stale }]) } }), 'frame')
    expect(html).toContain(stale)
    expect(button(html, 'Regenerate frame')).not.toContain('disabled')
  })
})

const panelProps = { connected: true, onAction: noop, onWriteTitle: async () => [], onSelectCell: () => undefined, onPreviewCell: () => undefined, resolveAsset: asset }

describe('GoalPanel with a short', () => {
  it('opens a new short on Frame and a saved version 4 short on Character', () => {
    const fresh = renderToStaticMarkup(createElement(GoalPanel, { ...panelProps, goal: shortGoalFixture() }))
    expect(fresh).toContain('aria-pressed="true">Frame</button>')
    expect(fresh).not.toContain('>Character</button>')
    const saved = renderToStaticMarkup(createElement(GoalPanel, { ...panelProps, goal: shortGoalFixture({}, legacyShortPlanFixture()) }))
    expect(saved).toContain('aria-pressed="true">Character</button>')
    expect(saved).toContain('This short was saved with a character.')
    const framed = renderToStaticMarkup(createElement(GoalPanel, { ...panelProps, goal: shortGoalFixture({ stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]) } }) }))
    expect(framed).toContain('aria-pressed="true">Frame</button>')
    const boarded = renderToStaticMarkup(createElement(GoalPanel, { ...panelProps, goal: boardGoal() }))
    expect(boarded).toContain('aria-pressed="true">Storyboard</button>')
    expect(button(boarded, 'Remove on-screen graphics')).toContain('Remove on-screen graphics · $0.84')
  })

  it('opens the short review for a current short and the older reviews for earlier goals', () => {
    const props = panelProps
    expect(renderToStaticMarkup(createElement(GoalPanel, { ...props, goal: shortGoalFixture() }))).toContain('aria-label="Short stages"')
    expect(renderToStaticMarkup(createElement(GoalPanel, { ...props, goal: shortGoalFixture({ status: 'planning', shortPlan: undefined }) }))).toContain('Planning the frame and the beats of your short')
    const failed = renderToStaticMarkup(createElement(GoalPanel, { ...props, goal: shortGoalFixture({ status: 'failed', shortPlan: undefined, error: 'OpenAI API error 500' }) }))
    expect(failed).toContain('>Short<')
    expect(failed).toContain('OpenAI API error 500')
    expect(button(failed, 'Retry planning')).toMatch(/>Retry planning<\/button>$/u)
    expect(failed).not.toContain('ready ·')
  })
})

describe('GoalPanel with an earlier goal', () => {
  const props = panelProps

  it('summarises a version-2 goal read-only with its outputs as cell addresses', () => {
    const html = renderToStaticMarkup(createElement(GoalPanel, { ...props, goal: legacyGoalFixture() }))
    expect(html).toContain('>The skateboard champion<')
    expect(html).toContain('make a funny video of a dog on a skateboard')
    expect(html).toContain('Made by an earlier /goal.')
    expect(html).toMatch(/<span>Frame<\/span><button type="button" class="goal-progress-address">@c1<\/button>/u)
    expect(html).toMatch(/<span>Storyboard<\/span><button type="button" class="goal-progress-address">@c2<\/button>/u)
    expect(html).toMatch(/<span>Video<\/span><span class="goal-panel-muted">Removed from the notebook<\/span>/u)
    expect(button(html, 'Dismiss')).not.toContain('disabled')
    for (const label of ['Generate', 'Retry', 'Finish', 'Approve', 'Discard goal']) expect(html).not.toContain(`>${label}`)
    expect(html).not.toContain('aria-label="Short stages"')
  })

  it('plays the finished video of a version-3 goal and keeps an already dismissed goal from dismissing again', () => {
    const goal = legacyGoalFixture({ planVersion: 3, title: 'Morning market', outputs: [{ stage: 'frame', artifactId: 'scene-old', cellId: 'scene-cell', address: '@c1' }, { stage: 'videos', artifactId: 'video-old', cellId: 'video-cell', address: '@d1' }], finalArtifactId: 'final-old' })
    const html = renderToStaticMarkup(createElement(GoalPanel, { ...props, goal }))
    expect(html).toContain('aria-label="Finished video"')
    expect(html).toContain('src="/media/final-old.mp4"')
    expect(html).toMatch(/<span>Video<\/span><button type="button" class="goal-progress-address">@d1<\/button>/u)
    expect(button(renderToStaticMarkup(createElement(GoalPanel, { ...props, goal: { ...goal, dismissedAt: '2026-11-12T00:00:00Z' } })), 'Dismiss')).toContain('disabled=""')
  })
})

describe('GoalCellNode with an earlier goal', () => {
  const props = { id: 'legacy-tile', data: { slot: { row: 3, column: 0 }, label: 'The skateboard champion' }, selected: false } as unknown as NodeProps<CanvasNode>
  const tile = (goals: ReadonlyMap<string, GoalSnapshot>) =>
    renderToStaticMarkup(createElement(GoalTileContext.Provider, { value: goals }, createElement(GoalCellNode, props)))

  it('shows the earlier-goal note, its outputs and its state once the goal list has loaded', () => {
    const html = tile(new Map([['legacy-tile', legacyGoalFixture()]]))
    expect(html).toContain(`<p class="goal-tile-note" data-tone="quiet">${LEGACY_GOAL_NOTE}</p>`)
    expect(html).toContain('>4 outputs<')
    expect(html).toContain('>Complete<')
  })

  it('shows a plain goal tile without the note until the goal list arrives', () => {
    const html = tile(new Map())
    expect(html).toContain('>The skateboard champion<')
    expect(html).toContain('>Goal<')
    expect(html).not.toContain(LEGACY_GOAL_NOTE)
  })
})

describe('GoalComposerStatus refusal details', () => {
  it('shows the same refusal in the chip, tooltip and accessible label', () => {
    const error = 'Nano Banana 2.1 Edit refused this request: its content checker flagged it (model_moderated). Sending the same request again will most likely be refused again. Change the prompt or the input, or use another model.'
    const goal = shortGoalFixture({ status: 'failed', error })
    const html = renderToStaticMarkup(createElement(GoalComposerStatus, { goal, onOpen: () => undefined }))
    expect(html).toContain(`title="${error}"`)
    expect(html).toContain(`<span class="goal-status-long">${error}</span>`)
    expect(html).toContain(`${error} Open the goal panel`)
  })
})
