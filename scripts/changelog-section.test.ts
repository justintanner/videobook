import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function changelog(text: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vb-changelog-'))
  roots.push(root)
  const path = join(root, 'CHANGELOG.md')
  await writeFile(path, text, 'utf8')
  return path
}

async function section(version: string, path?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/changelog-section.mjs', version, ...(path ? [path] : [])])
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string }
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr }
  }
}

describe('changelog-section', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('prints only the requested release section', async () => {
    const path = await changelog('# Changelog\n\n## [Unreleased]\n\n- next\n\n## [1.2.0] - 2026-10-19\n\n### Added\n\n- the CLI\n\n## [1.1.0] - 2026-09-01\n\n- older\n')
    expect(await section('1.2.0', path)).toEqual({ code: 0, stdout: '### Added\n\n- the CLI\n', stderr: '' })
    expect((await section('1.1.0', path)).stdout).toBe('- older\n')
  })

  it('fails when the release has no section or an empty one', async () => {
    const path = await changelog('## [1.3.0]\n\n## [1.2.0]\n\n- shipped\n')
    expect(await section('9.9.9', path)).toMatchObject({ code: 1, stderr: expect.stringContaining('has no "## [9.9.9]" section') })
    expect(await section('1.3.0', path)).toMatchObject({ code: 1, stderr: expect.stringContaining('is empty') })
    expect(await section('1.2', path)).toMatchObject({ code: 1 })
  })

  it('needs a version argument', async () => {
    expect(await section('')).toMatchObject({ code: 2 })
  })
})
