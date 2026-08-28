import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { Route } from 'playwright'

export interface StartedProcess {
  child: ChildProcess
  output: string[]
}

export interface ObservedToolCall {
  name: string
  arguments: Record<string, unknown>
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not reserve a port')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

export function startProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
): StartedProcess {
  const output: string[] = []
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (data: Buffer) => output.push(data.toString()))
  child.stderr.on('data', (data: Buffer) => output.push(data.toString()))
  return { child, output }
}

export async function waitForHttp(
  url: string,
  processState: StartedProcess,
  acceptedStatus: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (processState.child.exitCode !== null) {
      throw new Error(`Process exited during startup:\n${processState.output.join('')}`)
    }
    try {
      const response = await fetch(url)
      if (response.status === acceptedStatus) return
    } catch {
      await wait(100)
    }
  }
  throw new Error(`Process did not start:\n${processState.output.join('')}`)
}

export async function stopProcess(processState: StartedProcess | undefined): Promise<void> {
  if (!processState || processState.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => {
    processState.child.once('exit', () => resolve())
  })
  processState.child.kill('SIGINT')
  const stopped = await Promise.race([
    exited.then(() => true),
    wait(5_000).then(() => false),
  ])
  if (stopped) return
  processState.child.kill('SIGKILL')
  await exited
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function resultValue(value: unknown): unknown {
  const result = record(value)
  const content = Array.isArray(result?.content) ? result.content : []
  const textItem = content.map(record).find((item) => item?.type === 'text')
  const text = typeof textItem?.text === 'string' ? textItem.text : ''
  if (!text || result?.isError === true) {
    throw new Error(text || 'MCP tool returned no result')
  }
  return JSON.parse(text) as unknown
}

export function toolCalls(value: unknown): ObservedToolCall[] {
  const envelopes = Array.isArray(value) ? value : [value]
  return envelopes.flatMap((entry) => {
    const envelope = record(entry)
    const params = record(envelope?.params)
    const args = record(params?.arguments)
    return envelope?.method === 'tools/call'
      && typeof params?.name === 'string'
      && args
      ? [{ name: params.name, arguments: args }]
      : []
  })
}

export async function requestBody(route: Route): Promise<unknown> {
  try {
    return route.request().postDataJSON() as unknown
  } catch {
    return null
  }
}
