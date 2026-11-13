import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GoalShortReview } from '../../src/components/videobook/GoalShortReview'
import { GoalPanel } from '../../src/components/videobook/GoalPanel'
import type { AssetRecord } from '../../src/videobook/workspace-responses'
import { defaultShortTab, type GoalCharacterImage, type MainCharacterView, type ShortGoalSnapshot, type ShortTab } from '../../src/videobook/goals'
import { buildGoalShortPlan } from '../../server/src/goal-short-plan'
import { SHORT_RULES } from '../../server/src/goal-short-rules'
import { legacyGoalFixture, shortGoalFixture, shortPlanFixture, shortStage } from './goal-short-fixtures'

const noop = async () => shortGoalFixture()
const mainCharacter: MainCharacterView = { character: { name: 'Main character', description: 'a man in a green shirt', silent: true }, references: [], sheet: { estimate: { usd: 0.12, warnings: [] }, pending: null, lastError: null } }
const noCharacter = async (): Promise<MainCharacterView> => mainCharacter
const uploaded = async () => 'uploaded-photo'

function asset(artifactId: string): AssetRecord | null {
  if (artifactId.startsWith('photo')) return { mediaUrl: `/media/${artifactId}.jpg`, thumbnailUrl: `/thumbs/${artifactId}.jpg` } as unknown as AssetRecord
  if (!artifactId.startsWith('clip') && !artifactId.startsWith('final') && !artifactId.startsWith('video')) return null
  return { mediaUrl: `/media/${artifactId}.mp4`, thumbnailUrl: null, duration: 20, fps: 24, objectHash: `${artifactId}-hash` } as unknown as AssetRecord
}

type ReviewExtras = { character?: MainCharacterView | null, characterError?: string | null, images?: readonly GoalCharacterImage[] }

function render(goal: ShortGoalSnapshot, view: ShortTab = defaultShortTab(goal, goal.shortPlan!), extras: ReviewExtras = {}): string {
  return renderToStaticMarkup(createElement(GoalShortReview, {
    goal, plan: goal.shortPlan!, view, disabled: false, character: extras.character ?? null, characterError: extras.characterError ?? null, images: extras.images ?? [],
    resolveAsset: asset, onView: () => undefined, onPreviewCell: () => undefined, onRun: () => undefined, onAction: noop, onCharacter: noCharacter, onUploadImage: uploaded,
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

  it('opens a new short on the Character tab, first of the four, while the main character loads', () => {
    const html = render(shortGoalFixture())
    expect([...html.matchAll(/aria-pressed="(true|false)">(\w+)<\/button>/gu)].map(match => [match[2], match[1]]).slice(0, 4))
      .toEqual([['Character', 'true'], ['Frame', 'false'], ['Video', 'false'], ['Finish', 'false']])
    expect(html).toContain('Loading the main character…')
    expect(html).not.toContain('aria-label="Short title"')
    expect(button(html, 'Generate frame')).toBe('')
  })

  it('offers the notebook images as the character, the ones the brief mentioned first, and an upload', () => {
    const photo = (artifactId: string, column: number): GoalCharacterImage => ({ artifactId, cellId: `${artifactId}-cell`, address: `@a${column}`, label: artifactId })
    const steps = { kind: 'image' as const, artifactId: 'photo-man', cellId: 'photo-man-cell', address: '@a2', label: 'umbrella_water', objectHash: 'a'.repeat(64) }
    const plan = buildGoalShortPlan({
      title: 'Every day, these steps', aspectRatio: '9:16', character: { name: 'Main character', description: 'a man in a green shirt', references: [] },
      framePrompt: 'He stands at the top of wet steps.', beats: ['He slips.'], segmentSeconds: [12], extraReferences: [steps],
    })
    const html = render(shortGoalFixture({}, plan), 'character', { character: mainCharacter, images: [photo('photo-steps', 1), photo('photo-man', 2)] })
    expect(html).toContain('<legend>Use an image</legend>')
    const picks = [...html.matchAll(/aria-label="Pick (@\w+)"/gu)].map(match => match[1])
    expect(picks).toEqual(['@a2', '@a1'])
    const pick = (address: string) => new RegExp(`<button[^>]*aria-label="Pick ${address}"[^>]*>(?:(?!</button>).)*</button>`, 'u').exec(html)?.[0] ?? ''
    expect(pick('@a2')).toMatch(/aria-pressed="false".*src="\/thumbs\/photo-man\.jpg".*<span>@a2<\/span><small>In brief<\/small>/u)
    expect(pick('@a1')).toContain('<span>@a1</span>')
    expect(pick('@a1')).not.toContain('In brief')
    expect(html).toMatch(/<input type="file" accept="image\/\*" aria-label="Upload a character image"\/>/u)
    expect(html).not.toContain('Character image cells')
    expect(button(html, 'Use these images')).toContain('disabled=""')
    expect(button(html, 'Generate character sheet')).toContain('Generate character sheet · $0.12')
    expect(button(html, 'Generate character sheet')).not.toContain('disabled')
    expect(button(html, 'Save character')).not.toContain('disabled')
    expect(html).toContain('aria-label="Character name" maxLength="80" value="Main character"/>')
    expect(html).toContain('>a man in a green shirt</textarea>')
  })

  it('says why the main character did not load and offers to try again', () => {
    const html = render(shortGoalFixture(), 'character', { characterError: 'Reconnecting to the server' })
    expect(html).toContain('role="alert" class="goal-panel-warning">Reconnecting to the server</p>')
    expect(html).not.toContain('Loading the main character…')
    expect(button(html, 'Try again')).not.toContain('disabled')
    expect(button(html, 'Generate character sheet')).toBe('')
  })

  it('shows the frame tab with its estimate and the read-only rule lines', () => {
    const html = render(shortGoalFixture(), 'frame')
    for (const tab of ['Character', 'Frame', 'Video', 'Finish']) expect(html).toContain(`>${tab}</button>`)
    expect(button(html, 'Generate frame')).toContain('Generate frame · $0.21')
    expect(button(html, 'Generate frame')).not.toContain('disabled')
    expect(html).toContain('aria-label="Always added"')
    expect(html).toContain(`<p>${SHORT_RULES.frame}</p>`)
    expect(html).not.toMatch(new RegExp(`<textarea[^>]*>[^<]*${SHORT_RULES.frame.slice(0, 20)}`, 'u'))
    expect(html).toContain('/ 40 words')
  })

  it('disables the frame with a reason while the character has no reference image', () => {
    const html = render(shortGoalFixture({}, shortPlanFixture([12], [])), 'frame')
    expect(button(html, 'Generate frame')).toContain('disabled=""')
    expect(html).toContain('Give the main character a reference image first')
    const ready = render(shortGoalFixture({ mainCharacterReferences: 1 }, shortPlanFixture([12], [])), 'frame')
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

  it('offers feedback and a priced revise action only for generated clips', () => {
    const goal = shortGoalFixture({ stage: 'videos', stages: { ...withFrame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }, { index: 1, artifactId: 'clip-b' }]) } }, shortPlanFixture([10, 10, 5]))
    const html = render(goal)
    for (const index of [1, 2]) {
      expect(html).toContain(`aria-label="Clip ${index} feedback"`)
      expect(button(html, `Revise clip ${index}`)).toContain('at least $0.60')
      expect(button(html, `Revise clip ${index}`)).toContain('disabled=""')
    }
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

const panelProps = { connected: true, images: [], onAction: noop, onCharacter: noCharacter, onUploadImage: uploaded, onSelectCell: () => undefined, onPreviewCell: () => undefined, resolveAsset: asset }

describe('GoalPanel with a short', () => {
  it('opens a new short on the Character tab and a short with a frame on the Frame tab', () => {
    const fresh = renderToStaticMarkup(createElement(GoalPanel, { ...panelProps, goal: shortGoalFixture() }))
    expect(fresh).toContain('aria-pressed="true">Character</button>')
    expect(fresh).toContain('Loading the main character…')
    const framed = renderToStaticMarkup(createElement(GoalPanel, { ...panelProps, goal: shortGoalFixture({ stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]) } }) }))
    expect(framed).toContain('aria-pressed="true">Frame</button>')
    expect(framed).not.toContain('Loading the main character…')
  })

  it('opens the short review for a version-4 goal and the older reviews for others', () => {
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
