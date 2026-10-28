import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testBudget } from '../../server/src/test-budget'

const hook = path.resolve('.githooks/pre-push')
const knip = path.resolve('node_modules/knip/bin/knip.js')
const directories: string[] = []
const zero = '0'.repeat(40)

function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'videobook-push-hook-'))
  directories.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: testBudget(10_000),
  }).trim()
  git('init', '--quiet')
  git('config', 'user.email', 'hook@example.test')
  git('config', 'user.name', 'Hook test')
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'hook-fixture',
    private: true,
    scripts: { 'check:dead-code': `node ${JSON.stringify(knip)} --include exports` },
  }))
  writeFileSync(path.join(cwd, 'knip.json'), JSON.stringify({ entry: ['index.ts'], project: ['*.ts'] }))
  writeFileSync(path.join(cwd, 'index.ts'), "import { used } from './value'\nconsole.log(used)\n")
  writeFileSync(path.join(cwd, 'value.ts'), 'export const used = 1\n')
  const commit = () => {
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const base = commit()
  const run = (head: string, remote = base) => spawnSync('sh', [hook], {
    cwd,
    input: `refs/heads/main ${head} refs/heads/main ${remote}\n`,
    encoding: 'utf8',
    timeout: testBudget(30_000),
  })
  return { cwd, commit, base, run }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('pre-push dead-code check', () => {
  it('blocks TypeScript changes with unused exports using real Knip', () => {
    const { cwd, commit, run } = fixture()
    writeFileSync(path.join(cwd, 'value.ts'), 'export const used = 1\nexport const unused = 2\n')
    const result = run(commit())
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('unused')
  })

  it('accepts clean TypeScript changes', () => {
    const { cwd, commit, run } = fixture()
    writeFileSync(path.join(cwd, 'value.ts'), 'export const used = 2\n')
    const result = run(commit())
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).toContain('check:dead-code')
  })

  it('skips documentation changes and deletions without invoking npm', () => {
    const { cwd, commit, run } = fixture()
    writeFileSync(path.join(cwd, 'README.md'), 'Documentation\n')
    const head = commit()
    rmSync(path.join(cwd, 'package.json'))
    expect(run(head).status).toBe(0)
    expect(run(zero).status).toBe(0)
  })

  it('checks TypeScript files on a new ref', () => {
    const { base, run } = fixture()
    const result = run(base, zero)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).toContain('check:dead-code')
  })
})
