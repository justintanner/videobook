import type { GoalShortPlan } from '../../../server/src/goal-short-plan'
import type { GoalRemixAnalysis } from '../../../server/src/goal-remix-model'
import type { GoalGenerationStage } from '../../../server/src/goal-store'
import { goalStillVersions, type ShortGoalSnapshot } from '@/videobook/goals'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { GoalOutputQuality } from './GoalOutputQuality'

export type GoalCheckStage = 'replacement' | 'frame' | 'videos' | 'finish'
export type GoalStageContext = {
  goal: ShortGoalSnapshot
  plan: GoalShortPlan
  analysis: GoalRemixAnalysis | undefined
  disabled: boolean
  canGenerate: boolean
  checksLocked: boolean
  resolveAsset: (artifactId: string) => AssetRecord | null
  onPreviewCell: (cellId: string) => void
  onSelect: (stage: GoalGenerationStage, index: number, artifactId: string) => void
  onCheckOutput: (stage: GoalCheckStage, index: number, semantic: boolean) => void
  onCheckRealism: (stage: 'frame' | 'videos', index: number) => void
}
type RealismView = NonNullable<NonNullable<ShortGoalSnapshot['stages']['frame']>['outputs'][number]['realism']>

export const REALISM_NOTE = 'The check for AI tells is billed like planning and never blocks a step.'

function thumbnailOf(asset: AssetRecord | null): string | null {
  if (!asset) return null
  return asset.type === 'video' ? asset.thumbnailUrl ?? null : asset.thumbnailUrl ?? asset.mediaUrl ?? null
}

function RealismCheck({ name, check, disabled, onCheck }: { name: string, check: RealismView | null, disabled: boolean, onCheck: () => void }) {
  const running = check?.status === 'running'
  const findings = [...(check?.findings ?? [])].sort((left, right) => left.severity === right.severity ? 0 : left.severity === 'warn' ? -1 : 1)
  return <div className="goal-realism">
    <button type="button" className="goal-panel-button" disabled={disabled || running} onClick={onCheck}>{running ? 'Checking for AI tells…' : check?.status === 'completed' ? 'Check again for AI tells' : 'Check for AI tells'}</button>
    {running && <p role="status" className="goal-panel-muted">Looking at the {name} for AI tells…</p>}
    {check?.status === 'failed' && <p role="alert" className="goal-panel-warning">{check.error ?? 'The check for AI tells failed. Run it again.'}</p>}
    {check?.status === 'completed' && (findings.length === 0
      ? <p className="goal-panel-muted">No AI tells found in the {name}.</p>
      : <ul className="goal-realism-findings" aria-label={`AI tells in the ${name}`}>{findings.map((finding, index) => <li key={`${finding.severity}:${index}`} data-severity={finding.severity}><strong>{finding.severity === 'warn' ? 'Warn' : 'Note'}</strong> <span>{finding.text}</span></li>)}</ul>)}
  </div>
}

export function GoalChecks({ ctx, stage, index, artifactId, name }: { ctx: GoalStageContext, stage: GoalCheckStage, index: number, artifactId: string, name: string }) {
  if (ctx.analysis?.recipe.outputAssertions) {
    const check = ctx.goal.quality?.[`${stage}:${index}`]
    return <GoalOutputQuality name={name} check={check?.artifactId === artifactId ? check : null} estimate={ctx.goal.estimate.quality}
      disabled={ctx.checksLocked} onCheck={semantic => ctx.onCheckOutput(stage, index, semantic)} />
  }
  if (stage !== 'frame' && stage !== 'videos') return null
  const output = ctx.goal.stages[stage]?.outputs.find(item => item.index === index)
  return <RealismCheck name={name} check={output?.realism ?? null} disabled={ctx.disabled} onCheck={() => ctx.onCheckRealism(stage, index)} />
}

export function GoalVersions({ ctx, stage, index, label }: { ctx: GoalStageContext, stage: GoalGenerationStage, index: number, label: string }) {
  const versions = goalStillVersions(ctx.goal, stage, index)
  if (versions.length === 0) return null
  return <div className="goal-versions" role="group" aria-label={`${label} versions`}>{versions.map((version, position, all) => {
    const url = version.artifactId ? thumbnailOf(ctx.resolveAsset(version.artifactId)) : null
    const name = `v${all.length - position}`
    return <button key={version.generationId ?? `${version.chainId}:${version.stepId}`} type="button" className="goal-version" aria-label={`${label} ${name}`}
      title={version.requiresReview ? 'Review and adopt this take under Takes' : undefined} aria-pressed={version.current}
      disabled={ctx.disabled || !version.artifactId || version.status !== 'completed' || version.requiresReview}
      onClick={() => { if (version.artifactId) ctx.onSelect(stage, index, version.artifactId) }}>
      {url ? <img src={url} alt="" /> : <i aria-hidden="true" />}<span>{name}</span>
    </button>
  })}</div>
}

export function AlwaysAdded({ lines }: { lines: readonly string[] }) {
  return <details className="goal-short-rules" aria-label="Always added">
    <summary>Always added</summary>
    {lines.map(line => <p key={line}>{line}</p>)}
  </details>
}

export function GoalNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null
  return <ul className="goal-short-notes" aria-label="Notes">{notes.map((note, index) => <li key={`${index}:${note}`}>{note}</li>)}</ul>
}
