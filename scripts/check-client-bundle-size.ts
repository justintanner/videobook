import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const chunkLimitBytes = 500_000
const assetsDir = join(process.cwd(), 'dist', 'assets')
const chunkNames = (await readdir(assetsDir))
  .filter((name) => name.endsWith('.js'))
  .sort()

if (chunkNames.length === 0) {
  throw new Error(`No client JavaScript chunks found in ${assetsDir}`)
}

const chunks = await Promise.all(chunkNames.map(async (name) => ({
  name,
  size: (await stat(join(assetsDir, name))).size,
})))
const oversized = chunks.filter((chunk) => chunk.size > chunkLimitBytes)

if (oversized.length > 0) {
  const details = oversized
    .map((chunk) => `${chunk.name} (${chunk.size} bytes)`)
    .join(', ')
  throw new Error(
    `Client JavaScript chunks must not exceed ${chunkLimitBytes} bytes: ${details}`,
  )
}

const largest = chunks.reduce((current, chunk) =>
  chunk.size > current.size ? chunk : current)

console.log(
  `Client bundle OK: ${chunks.length} chunks, largest ${largest.name} (${largest.size} bytes)`,
)
