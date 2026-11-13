import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createEngineForTest } from '../../server/src/engine.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { registerMediaProbe } from '../../server/src/notebook-media-ops.js'
import { createTestClient } from '../../server/src/test-client.js'
import { testBudget } from '../../server/src/test-budget.js'
import { buildWorkspaceActionCatalog } from '../../server/src/workspace-action-catalog.js'
import { getAllToolDefs } from '../../server/src/tools/index.js'
import { getCanonicalCommands } from '../../server/src/tools/commands.js'
import { loadWorkspaceActionResources } from '../../src/videobook/workspace-action-resources'

it('loads built-in and saved batch template choices through real MCP calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videobook-batch-choices-'))
  const client = await createTestClient(root)
  try {
    const engine = createEngineForTest(root)
    const bookId = engine.book.get().bookId
    const video = await engine.artifacts.create('video', 'Batch picker video')
    if (!video.ok) throw new Error(video.error.message)
    const assetId = video.value.artifactId
    const path = join(root, 'fixture.mp4')
    await promisify(execFile)(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=24:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', path], { timeout: testBudget(30_000) })
    const written = await engine.files.write(assetId, 'original.mp4', await readFile(path))
    if (!written.ok) throw new Error(written.error.message)
    await registerMediaProbe(engine, assetId, 'original.mp4', await probeVideo(path))
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const response = await client.callTool({ name, arguments: { book_id: bookId, ...args } })
      const text = (response.content as Array<{ text: string }>)[0].text
      if (response.isError) throw new Error(text)
      return JSON.parse(text) as unknown
    }
    await call('video_graphics', { op: 'save_template', asset_id: assetId, name: 'Saved picker look' })
    const action = buildWorkspaceActionCatalog(getAllToolDefs(engine), getCanonicalCommands()).actions.find((entry) => entry.id === 'tool.video_graphics.apply_template')!
    const resources = await loadWorkspaceActionResources(action, { asset_ids: [assetId] }, call)
    expect(resources.choices.template_id).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Saved picker look', group: 'Saved templates' }),
      expect.objectContaining({ value: 'tiktok-title', group: 'Built-in templates' }),
    ]))
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
