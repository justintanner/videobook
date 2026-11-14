import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { testBudget } from '../server/src/test-budget'

const roots: string[] = []
const broken = 'let value = 1;\nconsole.log(value);\n'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(install = true) {
  const root = await mkdtemp(join(tmpdir(), 'vb-lint-hook-'))
  roots.push(root)
  await mkdir(join(root, 'scripts'))
  await copyFile(resolve('scripts/lint-edited-file.mjs'), join(root, 'scripts/lint-edited-file.mjs'))
  await copyFile(resolve('eslint.config.js'), join(root, 'eslint.config.js'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  if (install) await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  return root
}

function run(root: string, input: string) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/lint-edited-file.mjs')], {
    input, encoding: 'utf8', cwd: tmpdir(), timeout: testBudget(30_000),
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
}

function payload(path: string, tool = 'Edit') {
  return JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: path } })
}

it('fixes only the edited file for Edit and Write, including paths with spaces and glob characters', async () => {
  const root = await fixture()
  const edited = join(root, 'edited [file].ts')
  const untouched = join(root, 'untouched.ts')
  await writeFile(untouched, broken)
  for (const tool of ['Edit', 'Write']) {
    await writeFile(edited, broken)
    run(root, payload(edited, tool))
    expect(await readFile(edited, 'utf8')).toBe(broken.replace('let', 'const'))
    expect(await readFile(untouched, 'utf8')).toBe(broken)
  }
})

it('silently skips unsupported, ignored, outside, missing and malformed inputs', async () => {
  const root = await fixture()
  const outside = await fixture()
  await mkdir(join(root, 'dist'))
  for (const path of [join(root, 'notes.md'), join(root, 'data.json'), join(root, 'dist/ignored.ts'), join(outside, 'outside.ts')]) {
    await writeFile(path, broken)
    run(root, payload(path))
    expect(await readFile(path, 'utf8')).toBe(broken)
  }
  await symlink(join(outside, 'outside.ts'), join(root, 'linked.ts'))
  run(root, payload(join(root, 'linked.ts')))
  expect(await readFile(join(outside, 'outside.ts'), 'utf8')).toBe(broken)
  for (const input of ['', '{', 'null', '{}', payload(join(root, 'missing.ts')), payload(root)]) run(root, input)
})

it('silently skips a missing local install', async () => {
  const root = await fixture(false)
  const path = join(root, 'edited.ts')
  await writeFile(path, broken)
  run(root, payload(path))
  expect(await readFile(path, 'utf8')).toBe(broken)
})
