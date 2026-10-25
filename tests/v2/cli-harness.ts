import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { testBudget } from '../../server/src/test-budget.js'

const CLI_ENTRY = 'server/src/cli/entry.ts'

export interface CliProcess {
  child: ChildProcess
  stdout: string[]
  stderr: string[]
  output(): string
}

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

const processes = new Set<CliProcess>()
const directories = new Set<string>()

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    B2_ACCESS_KEY_ID: '',
    B2_BUCKET: '',
    B2_ENDPOINT: '',
    B2_REGION: '',
    B2_SECRET_ACCESS_KEY: '',
    VIDEOBOOK_CATALOG_BACKUP_URL_TEMPLATE: '',
    VIDEOBOOK_DEV_FIXTURES: '0',
    VIDEOBOOK_LOG_LEVEL: 'info',
    ...extra,
  }
}

export async function tempDir(prefix = 'videobook-cli-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.add(directory)
  return directory
}

export function spawnCli(args: string[], env: NodeJS.ProcessEnv = cliEnv()): CliProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout?.on('data', (data: Buffer) => stdout.push(data.toString()))
  child.stderr?.on('data', (data: Buffer) => stderr.push(data.toString()))
  const cli: CliProcess = { child, stdout, stderr, output: () => `${stdout.join('')}${stderr.join('')}` }
  processes.add(cli)
  return cli
}

async function exitCode(cli: CliProcess, timeoutMs: number): Promise<number | null> {
  if (cli.child.exitCode !== null || cli.child.signalCode !== null) return cli.child.exitCode
  const exited = once(cli.child, 'exit').then(([code]) => code as number | null)
  const settled = await Promise.race([exited, wait(timeoutMs).then(() => undefined)])
  if (settled !== undefined) return settled
  cli.child.kill('SIGKILL')
  return await exited
}

export async function runCli(args: string[], env: NodeJS.ProcessEnv = cliEnv(), timeoutMs = testBudget(60_000)): Promise<CliResult> {
  const cli = spawnCli(args, env)
  const code = await exitCode(cli, timeoutMs)
  return { code, stdout: cli.stdout.join(''), stderr: cli.stderr.join('') }
}

export async function stopCli(cli: CliProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<number | null> {
  if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill(signal)
  return await exitCode(cli, testBudget(20_000))
}

export async function waitForHealth(baseUrl: string, cli: CliProcess): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < testBudget(300); attempt += 1) {
    if (cli.child.exitCode !== null) throw new Error(`videobook exited during startup:\n${cli.output()}`)
    try {
      const response = await fetch(`${baseUrl}/healthz`)
      if (response.ok) return await response.json() as Record<string, unknown>
    } catch {
      await wait(100)
    }
  }
  throw new Error(`videobook did not start:\n${cli.output()}`)
}

export async function connectMcp(mcpUrl: string): Promise<Client> {
  const client = new Client({ name: 'videobook-cli-test', version: '1' }, {
    capabilities: {},
    supportedProtocolVersions: ['2026-07-28'],
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)))
  return client
}

export async function cleanupCli(): Promise<void> {
  for (const cli of processes) await stopCli(cli, 'SIGKILL')
  processes.clear()
  for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  directories.clear()
}
