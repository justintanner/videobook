import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)

describe('explicit search model preparation command', () => {
  it.each([false, true])('requires its download flag even with server downloads enabled: %s', async (download) => {
    const root = await mkdtemp(join(tmpdir(), 'videobook-model-command-'))
    const source = `
      import { createServer } from 'node:http';
      const runtime = await import(new URL('./transformers-runtime.js', import.meta.resolve('videobook-engine')));
      let requests = 0;
      const server = createServer((request, response) => { requests++; response.writeHead(404).end(); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      runtime.env.remoteHost = 'http://127.0.0.1:' + server.address().port + '/';
      process.argv = [process.execPath, './scripts/prepare-search-models.ts', '--models', 'visual', ...(${download} ? ['--download'] : [])];
      try { await import('./scripts/prepare-search-models.ts'); }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      console.log(JSON.stringify({ requests }));
    `
    try {
      let stdout = '', stderr = '', code: string | number | undefined
      try {
        const result = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
          cwd: process.cwd(), env: { ...process.env, VIDEOBOOK_MODEL_CACHE_DIR: root, VIDEOBOOK_MODEL_DOWNLOAD: 'enabled' },
          timeout: 20_000,
        })
        stdout = result.stdout
        stderr = result.stderr
      } catch (cause) {
        const failure = cause as Error & { stdout: string; stderr: string; code: string | number }
        stdout = failure.stdout
        stderr = failure.stderr
        code = failure.code
      }
      expect(code, stderr).toBe(1)
      expect(stdout, stderr).not.toBe('')
      const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as { requests: number }
      if (download) expect(result.requests).toBeGreaterThan(0)
      else {
        expect(result.requests).toBe(0)
        expect(stderr).toContain('npm run prepare:search-models -- --download --models visual')
      }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
  })
})
