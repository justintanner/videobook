import { asSceneData, type SceneData } from '../../server/src/scene-cuts'
import { recordValue } from './value-decoders'

type SceneToolCall = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

const POLL_INTERVAL_MS = 1000
const DETECTION_TIMEOUT_MS = 10 * 60_000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function scenesFrom(value: unknown): SceneData | null {
  const record = recordValue(value)
  if (record?.status !== 'cached') return null
  return asSceneData(record.scenes)
}

export async function loadSceneData(input: {
  artifactId: string
  bookId: string
  callTool: SceneToolCall
  isCurrent?: () => boolean
}): Promise<SceneData> {
  const args = { book_id: input.bookId, source_asset_id: input.artifactId, detail: 'full' }
  const deadline = Date.now() + DETECTION_TIMEOUT_MS
  let scenes = scenesFrom(await input.callTool('detect_scenes', args))
  while (!scenes) {
    if (input.isCurrent?.() === false) throw new Error('Workspace changed. Repeat the command in the current workspace.')
    if (Date.now() > deadline) throw new Error('Scene detection is taking too long; try again shortly')
    await wait(POLL_INTERVAL_MS)
    scenes = scenesFrom(await input.callTool('detect_scenes', args, { background: true }))
  }
  return scenes
}
