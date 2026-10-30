import type { PostView } from '../../server/src/posts/post-contract'

export type PostProgressStep = { key: 'clip' | 'caption' | 'deliver' | 'link' | 'results'; label: string; done: boolean }

export function postProgressSteps(post: PostView): PostProgressStep[] {
  const { definition, runtime } = post
  const delivered = Boolean(runtime.icloud?.completedAt || runtime.download?.completedAt || runtime.url)
  return [
    { key: 'clip', label: 'Clip', done: Boolean(definition.source) },
    { key: 'caption', label: 'Caption', done: definition.caption.trim().length > 0 },
    { key: 'deliver', label: 'Deliver', done: delivered },
    { key: 'link', label: 'Link live post', done: Boolean(runtime.url) },
    { key: 'results', label: 'Results', done: runtime.metrics.length > 0 },
  ]
}

export function postProgressCurrent(steps: readonly PostProgressStep[]): PostProgressStep['key'] | null {
  return steps.find(step => !step.done)?.key ?? null
}

export function postPreviewAspect(width: number | null | undefined, height: number | null | undefined): string {
  return width && height ? `${width} / ${height}` : '9 / 16'
}
