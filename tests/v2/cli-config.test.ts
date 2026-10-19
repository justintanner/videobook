import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupCli, cliEnv, runCli, tempDir } from './cli-harness.js'

interface ConfigRow {
  key: string
  source: string
  value: string | null
}

interface ConfigListing {
  envPath: string
  vault: string | null
  keys: ConfigRow[]
}

async function newHome(): Promise<string> {
  return join(await tempDir('videobook-config-'), 'home')
}

function listing(stdout: string): { vault: string | null; rows: Map<string, ConfigRow> } {
  const parsed = JSON.parse(stdout) as ConfigListing
  return { vault: parsed.vault, rows: new Map(parsed.keys.map((row) => [row.key, row])) }
}

describe('videobook config', () => {
  afterEach(cleanupCli)

  it('sets, shows and unsets keys in the data-home .env without printing secrets', async () => {
    const home = await newHome()
    const envPath = join(home, '.env')
    const set = await runCli(['config', 'set', 'OPENAI_API_KEY', 'sk-test-0123456789', '--home', home])
    expect(set.code, set.stderr).toBe(0)
    expect(set.stdout).toBe(`Set OPENAI_API_KEY=sk-tes******** in ${envPath}\n`)
    expect((await stat(envPath)).mode & 0o777).toBe(0o600)
    expect((await runCli(['config', 'set', 'FAL_API_KEY', 'op://Example/FAL_API_KEY/password', '--home', home])).code).toBe(0)
    expect((await runCli(['config', 'set', 'B2_REGION', 'us-west-004', '--home', home])).code).toBe(0)
    expect(await readFile(envPath, 'utf8')).toBe('OPENAI_API_KEY=sk-test-0123456789\nFAL_API_KEY=op://Example/FAL_API_KEY/password\nB2_REGION=us-west-004\n')

    const list = await runCli(['config', 'list', '--json', '--home', home])
    expect(list.code, list.stderr).toBe(0)
    expect(list.stdout).not.toContain('0123456789')
    const { rows, vault } = listing(list.stdout)
    expect(vault).toBeNull()
    expect(rows.get('OPENAI_API_KEY')).toEqual({ key: 'OPENAI_API_KEY', source: '.env', value: 'sk-tes********' })
    expect(rows.get('FAL_API_KEY')).toEqual({ key: 'FAL_API_KEY', source: '1password reference', value: 'op://Example/FAL_API_KEY/password' })
    expect(rows.get('B2_REGION')).toEqual({ key: 'B2_REGION', source: '.env', value: 'us-west-004' })
    expect(rows.get('KIE_API_KEY')).toEqual({ key: 'KIE_API_KEY', source: 'missing', value: null })

    const get = await runCli(['config', 'get', 'B2_REGION', '--home', home])
    expect(get.stdout).toMatch(/^B2_REGION\s+\.env\s+us-west-004\n$/u)

    const unset = await runCli(['config', 'unset', 'OPENAI_API_KEY', '--home', home])
    expect(unset.stdout).toBe(`Removed OPENAI_API_KEY from ${envPath}\n`)
    expect(await readFile(envPath, 'utf8')).toBe('FAL_API_KEY=op://Example/FAL_API_KEY/password\nB2_REGION=us-west-004\n')
    const again = await runCli(['config', 'unset', 'OPENAI_API_KEY', '--home', home])
    expect(again.stdout).toBe(`OPENAI_API_KEY was not set in ${envPath}\n`)
  }, 60_000)

  it('refuses keys the environment overrides, unknown keys and unusable values', async () => {
    const home = await newHome()
    const shadowed = await runCli(['config', 'set', 'OPENAI_API_KEY', 'sk-file', '--home', home], cliEnv({ OPENAI_API_KEY: 'sk-shell' }))
    expect(shadowed.code).toBe(1)
    expect(shadowed.stderr).toContain('OPENAI_API_KEY is set in the environment, which overrides the .env file')
    const unknown = await runCli(['config', 'set', 'NOT_A_KEY', 'x', '--home', home])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('NOT_A_KEY is not a videobook setting')
    const quotes = await runCli(['config', 'set', 'KIE_API_KEY', `a'b"c`, '--home', home])
    expect(quotes.code).toBe(1)
    expect(quotes.stderr).toContain('cannot contain both single and double quotes')
    const usage = await runCli(['config', 'set', 'KIE_API_KEY', '--home', home])
    expect(usage.code).toBe(2)
    expect(existsSync(join(home, '.env'))).toBe(false)
  }, 60_000)
})

describe('videobook setup 1password', () => {
  afterEach(cleanupCli)

  it('saves, reuses and removes the vault and token settings', async () => {
    const home = await newHome()
    const envPath = join(home, '.env')
    const withToken = cliEnv({ OP_SERVICE_ACCOUNT_TOKEN: 'ops_not_a_real_token' })
    const saved = await runCli(['setup', '1password', '--op-vault', 'Example Vault', '--no-verify', '--home', home], withToken)
    expect(saved.code, saved.stderr).toBe(0)
    expect(saved.stdout).toBe(`Saved VIDEOBOOK_OP_VAULT=Example Vault and the token setting (env:OP_SERVICE_ACCOUNT_TOKEN) to ${envPath}\n`)
    expect(saved.stdout + saved.stderr).not.toContain('ops_not_a_real_token')
    expect(await readFile(envPath, 'utf8')).toBe("VIDEOBOOK_OP_VAULT='Example Vault'\nVIDEOBOOK_OP_SERVICE_TOKEN=env:OP_SERVICE_ACCOUNT_TOKEN\n")
    expect((await stat(envPath)).mode & 0o777).toBe(0o600)

    const list = await runCli(['config', 'list', '--json', '--home', home])
    const { rows, vault } = listing(list.stdout)
    expect(vault).toBe('Example Vault')
    expect(rows.get('KIE_API_KEY')).toEqual({ key: 'KIE_API_KEY', source: '1password vault', value: 'op://Example Vault/KIE_API_KEY/password' })
    expect(rows.get('VIDEOBOOK_OP_SERVICE_TOKEN')).toEqual({ key: 'VIDEOBOOK_OP_SERVICE_TOKEN', source: '.env', value: 'env:OP_SERVICE_ACCOUNT_TOKEN' })
    const text = await runCli(['config', '--home', home])
    expect(text.stdout).toContain('Keys marked "1password vault" come from Example Vault')

    const rerun = await runCli(['setup', '1password', '--no-verify', '--home', home])
    expect(rerun.code, rerun.stderr).toBe(0)
    expect(rerun.stdout).toContain('VIDEOBOOK_OP_VAULT=Example Vault and the token setting (env:OP_SERVICE_ACCOUNT_TOKEN, which is not set in this shell)')

    const removed = await runCli(['setup', '1password', '--remove', '--home', home])
    expect(removed.code).toBe(0)
    expect(await readFile(envPath, 'utf8')).toBe('')
  }, 60_000)

  it('needs a vault', async () => {
    const result = await runCli(['setup', '1password', '--no-verify', '--home', await newHome()])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('setup 1password needs --op-vault <vault>')
  }, 60_000)
})
