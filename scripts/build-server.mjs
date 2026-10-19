import { spawnSync } from 'node:child_process'
import { copyFile, cp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = join(root, 'server')
const dist = join(server, 'dist')
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc')

async function replaceDirectory(from, to) {
  await rm(to, { recursive: true, force: true })
  await cp(from, to, { recursive: true })
}

await rm(dist, { recursive: true, force: true })
const compiled = spawnSync(process.execPath, [tsc, '-p', join(server, 'tsconfig.build.json')], { stdio: 'inherit' })
if (compiled.status !== 0) process.exit(compiled.status ?? 1)
await replaceDirectory(join(server, 'src', 'guides'), join(dist, 'guides'))
await replaceDirectory(join(server, 'src', 'remotion', 'public'), join(dist, 'remotion', 'public'))
await copyFile(join(root, 'LICENSE'), join(server, 'LICENSE'))
