import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderGenerationInputGoldens } from './fixtures/generation-input-goldens'

const directory = resolve(import.meta.dirname, 'fixtures/generation-input-goldens')

function changedRecords(expected: string, actual: string): string[] {
  const before = expected.split('\n')
  const after = actual.split('\n')
  const changed: string[] = []
  for (let index = 0; index < Math.max(before.length, after.length) && changed.length < 5; index += 1) {
    if (before[index] === after[index]) continue
    changed.push(`line ${index + 1}\n- ${(before[index] ?? '').slice(0, 400)}\n+ ${(after[index] ?? '').slice(0, 400)}`)
  }
  return changed
}

describe('generation input goldens', () => {
  const shards = renderGenerationInputGoldens()

  it('has exactly one committed shard per provider group', () => {
    const files = readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
    expect(files).toEqual([...shards.keys()].map((name) => `${name}.json`).sort())
  })

  it.each([...shards.keys()])('keeps every %s payload, token, prompt and fingerprint unchanged', (name) => {
    const committed = readFileSync(join(directory, `${name}.json`), 'utf8')
    const rendered = shards.get(name)!
    expect(changedRecords(committed, rendered), 'run npm run test:goldens:update only when a payload change is intended').toEqual([])
  })
})
