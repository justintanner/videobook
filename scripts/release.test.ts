import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { testBudget } from '../server/src/test-budget.js'

const execFileAsync = promisify(execFile)
const VERSION = '1.2.3'
const NOTES = '- Cleaned up after the GitHub release\n'
const roots: string[] = []

const FAKE_NPM = `#!/bin/sh
case "$1" in
  view) echo sha512-published ;;
  install)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --prefix ]; then prefix="$2"; fi
      shift
    done
    mkdir -p "$prefix/bin"
    printf '#!/bin/sh\\necho "videobook ${VERSION} (registry)"\\n' > "$prefix/bin/videobook"
    chmod +x "$prefix/bin/videobook"
    ;;
  *) echo "unexpected npm $*" >&2; exit 1 ;;
esac
`

const FAKE_GH = `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --notes-file ]; then cp "$2" "$FAKE_GH_NOTES"; fi
  shift
done
exit "$FAKE_GH_STATUS"
`

type ReleaseRun = { code: number; stdout: string; stderr: string; notes: string | null; leftovers: string[] }

function gitFreeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, env: gitFreeEnv(), timeout: testBudget(10_000) })
}

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, body)
  await chmod(path, 0o755)
}

async function publishedRepository(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), 'vb-release-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await Promise.all(['repo/scripts', 'repo/server', 'bin', 'tmp'].map((dir) => mkdir(join(root, dir), { recursive: true })))
  await copyFile('scripts/release.mjs', join(repo, 'scripts', 'release.mjs'))
  await copyFile('scripts/changelog-section.mjs', join(repo, 'scripts', 'changelog-section.mjs'))
  await writeFile(join(repo, 'server', 'package.json'), `${JSON.stringify({ name: 'videobook', version: VERSION })}\n`)
  await writeFile(join(repo, 'server', 'CHANGELOG.md'), `# Changelog\n\n## [${VERSION}] - 2026-11-12\n\n${NOTES}`)
  await executable(join(root, 'bin', 'npm'), FAKE_NPM)
  await executable(join(root, 'bin', 'gh'), FAKE_GH)
  await executable(join(root, 'bin', 'op'), '#!/bin/sh\nexit 1\n')
  await git(root, 'init', '--quiet', '--bare', 'origin.git')
  await git(repo, 'init', '--quiet', '--initial-branch', 'main')
  await git(repo, 'config', 'user.email', 'release@example.test')
  await git(repo, 'config', 'user.name', 'Release test')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '--quiet', '-m', `Release ${VERSION}`)
  await git(repo, 'tag', `v${VERSION}`)
  await git(repo, 'remote', 'add', 'origin', join(root, 'origin.git'))
  await git(repo, 'push', '--quiet', 'origin', 'main', 'main:stable')
  return { root, repo }
}

async function finishPublishedRelease(ghStatus: number): Promise<ReleaseRun> {
  const { root, repo } = await publishedRepository()
  const env = {
    ...gitFreeEnv(),
    PATH: [join(root, 'bin'), process.env.PATH ?? ''].join(delimiter),
    TMPDIR: join(root, 'tmp'),
    FAKE_GH_NOTES: join(root, 'notes.md'),
    FAKE_GH_STATUS: String(ghStatus),
  }
  const result = await execFileAsync(process.execPath, ['scripts/release.mjs', VERSION, '--push'], { cwd: repo, env, timeout: testBudget(20_000) })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch((error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
  const leftovers = (await readdir(join(root, 'tmp'))).filter((name) => name.startsWith('videobook-release-'))
  const notes = await readFile(join(root, 'notes.md'), 'utf8').catch(() => null)
  return { ...result, notes, leftovers }
}

describe('release --push of an already published version', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('removes the release notes directory after creating the GitHub release', async () => {
    const run = await finishPublishedRelease(0)
    expect(run).toMatchObject({ code: 0, notes: NOTES, leftovers: [] })
    expect(run.stdout).toContain(`done: videobook@${VERSION} is on npm, v${VERSION} is pushed, and the GitHub release exists`)
  })

  it('removes the release notes directory when gh release create fails', async () => {
    const run = await finishPublishedRelease(1)
    expect(run).toMatchObject({ code: 1, notes: NOTES, leftovers: [] })
    expect(run.stderr).toContain(`gh release create v${VERSION} --title videobook ${VERSION} --notes-file`)
  })
})
