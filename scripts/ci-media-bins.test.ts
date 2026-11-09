import { createHash } from 'node:crypto'
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureFfmpegBin, installWorkspace, resolvePackage } from './ci-install.mjs'
import {
  FFMPEG_RELEASE,
  YTDLP_VERSION,
  ffmpegReleaseUrl,
  releasesBlocked,
  resolveBinary,
  sha256,
  ytdlpAssetName,
  ytdlpReleaseUrl,
} from './ci-media-bins.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vb-ci-bins-'))
  roots.push(root)
  return root
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('pinned CI media binaries', () => {
  it('pins yt-dlp and ffmpeg release assets instead of latest', () => {
    expect(ytdlpAssetName('linux', 'x64', false)).toBe('yt-dlp_linux')
    expect(ytdlpReleaseUrl('yt-dlp_linux', {})).toBe(
      `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux`,
    )
    expect(ytdlpReleaseUrl('yt-dlp_linux', {})).not.toContain('/latest/')
    expect(ffmpegReleaseUrl('linux', 'x64', {})).toBe(
      `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}/ffmpeg-linux-x64.gz`,
    )
    expect(ffmpegReleaseUrl('linux', 'x64', { FFMPEG_BINARIES_URL: 'https://bogus.invalid/ffmpeg' })).toBe(
      'https://bogus.invalid/ffmpeg/b6.1.1/ffmpeg-linux-x64.gz',
    )
    expect(ytdlpReleaseUrl('yt-dlp_linux', { VIDEOBOOK_CI_YTDLP_RELEASE_BASE: 'https://bogus.invalid/yt-dlp' })).toBe(
      `https://bogus.invalid/yt-dlp/${YTDLP_VERSION}/yt-dlp_linux`,
    )
    expect(releasesBlocked({})).toBe(false)
    expect(releasesBlocked({ VIDEOBOOK_CI_BLOCK_RELEASES: '1' })).toBe(true)
  })

  it('uses a cached binary when release downloads are blocked', async () => {
    const root = await tempRoot()
    const body = Buffer.from('cached-yt-dlp')
    const cachePath = join(root, 'cache', 'yt-dlp_linux')
    await mkdir(join(root, 'cache'), { recursive: true })
    await writeFile(cachePath, body)
    let fetched = false
    const resolved = await resolveBinary({
      cachePath,
      fallbackPath: join(root, 'fallback', 'yt-dlp_linux'),
      url: 'https://bogus.invalid/yt-dlp/2026.10.26/yt-dlp_linux',
      sha256: hash(body),
      blocked: true,
      fetchImpl: async () => {
        fetched = true
        throw new Error('release download attempted')
      },
      fallback: async () => {
        throw new Error('fallback attempted')
      },
    })
    expect(fetched).toBe(false)
    expect(resolved).toEqual({ path: cachePath, source: 'cache' })
  })

  it('downloads the pinned gzip asset and checks the unpacked bytes', async () => {
    const root = await tempRoot()
    const raw = Buffer.from('ffmpeg-bytes')
    const urls: string[] = []
    const resolved = await resolveBinary({
      cachePath: join(root, 'cache', 'ffmpeg'),
      fallbackPath: join(root, 'fallback', 'ffmpeg'),
      url: ffmpegReleaseUrl('linux', 'x64', {}),
      gzip: true,
      sha256: hash(raw),
      blocked: false,
      retries: 1,
      delayMs: 0,
      fetchImpl: async (url: string) => {
        urls.push(url)
        return { ok: true, status: 200, arrayBuffer: async () => gzipSync(raw) }
      },
      fallback: async () => {
        throw new Error('fallback attempted')
      },
    })
    expect(urls).toEqual([
      'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz',
    ])
    expect(resolved.source).toBe('download')
    expect(await readFile(resolved.path)).toEqual(raw)
  })

  it('falls back without calling the release host when the download is blocked or corrupt', async () => {
    const root = await tempRoot()
    const cachePath = join(root, 'cache', 'yt-dlp_linux')
    await mkdir(join(root, 'cache'), { recursive: true })
    await writeFile(cachePath, 'not-the-pinned-binary')
    const urls: string[] = []
    const resolved = await resolveBinary({
      cachePath,
      fallbackPath: join(root, 'fallback', 'yt-dlp_linux'),
      url: 'https://bogus.invalid/yt-dlp/2026.10.26/yt-dlp_linux',
      sha256: hash(Buffer.from('pinned')),
      blocked: true,
      fetchImpl: async (url: string) => {
        urls.push(url)
        return { ok: false, status: 504, arrayBuffer: async () => new ArrayBuffer(0) }
      },
      fallback: async (dest: string) => {
        await writeFile(dest, 'provided')
      },
    })
    expect(urls).toEqual([])
    expect(resolved.source).toBe('fallback')
    expect(await readFile(resolved.path, 'utf8')).toBe('provided')
    await expect(access(cachePath, constants.F_OK)).rejects.toThrow()

    const failed = await resolveBinary({
      cachePath: join(root, 'cache', 'again'),
      fallbackPath: join(root, 'fallback', 'again'),
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux',
      sha256: hash(Buffer.from('pinned')),
      blocked: false,
      retries: 2,
      delayMs: 0,
      fetchImpl: async (url: string) => {
        urls.push(url)
        return { ok: false, status: 504, arrayBuffer: async () => new ArrayBuffer(0) }
      },
      fallback: async (dest: string) => {
        await writeFile(dest, 'after-504')
      },
    })
    expect(urls).toEqual([
      'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux',
      'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux',
    ])
    expect(failed.source).toBe('fallback')
    expect(sha256(await readFile(failed.path))).toBe(hash(Buffer.from('after-504')))
  })
})

function hiddenPackageJson(name: string): string {
  return `${JSON.stringify({
    name,
    main: './dist/index.js',
    exports: { '.': './dist/index.js' },
  })}\n`
}

describe('CI install with release downloads blocked', () => {
  async function script(path: string, body: string): Promise<void> {
    await writeFile(path, body)
    await chmod(path, 0o755)
  }

  async function installedPackage(root: string, name: string): Promise<void> {
    const dir = join(root, 'node_modules', name, 'dist')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.js'), 'module.exports = {}\n')
    await writeFile(join(root, 'node_modules', name, 'package.json'), hiddenPackageJson(name))
  }

  function blockedEnv(root: string, ytdlpBin: string, ffmpegBin: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      VIDEOBOOK_CI_PLATFORM: 'linux',
      VIDEOBOOK_CI_ARCH: 'x64',
      VIDEOBOOK_CI_MUSL: '0',
      VIDEOBOOK_CI_BLOCK_RELEASES: '1',
      FFMPEG_BINARIES_URL: 'https://bogus.invalid/ffmpeg',
      VIDEOBOOK_CI_YTDLP_RELEASE_BASE: 'https://bogus.invalid/yt-dlp',
      VIDEOBOOK_CI_CACHE_DIR: join(root, 'empty-cache'),
      VIDEOBOOK_CI_YTDLP_BIN: ytdlpBin,
      VIDEOBOOK_CI_FFMPEG_BIN: ffmpegBin,
    }
  }

  it('installs provided binaries and does not request the bogus release URLs', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n')
    const ytdlpBin = join(root, 'provided', 'yt-dlp')
    const ffmpegBin = join(root, 'provided', 'ffmpeg')
    await mkdir(join(root, 'provided'), { recursive: true })
    await script(ytdlpBin, '#!/bin/sh\necho 2026.10.26\n')
    await script(ffmpegBin, '#!/bin/sh\necho ffmpeg version test\n')
    const events: string[][] = []
    const urls: string[] = []
    const installed = await installWorkspace({
      root,
      env: blockedEnv(root, ytdlpBin, ffmpegBin),
      fetchImpl: async (url: string) => {
        urls.push(url)
        throw new Error(`release download attempted: ${url}`)
      },
      run: async (command, args) => {
        events.push([command, ...args])
        if (args[0] !== 'ci') return
        await installedPackage(root, 'ffmpeg-static')
        await installedPackage(root, 'ytdlp-nodejs')
      },
    })
    expect(urls).toEqual([])
    expect(events).toEqual([
      ['npm', 'ci', '--ignore-scripts'],
      ['npm', 'rebuild', 'esbuild', 'usearch', '@dolthub/doltlite', 'onnxruntime-node', '@ffprobe-installer/linux-x64', 'ffmpeg-static', 'ytdlp-nodejs'],
    ])
    expect(installed.ytdlp.source).toBe('fallback')
    expect(installed.ffmpeg.source).toBe('fallback')
    expect(installed.ytdlpTarget).toBe(join(root, 'node_modules', 'ytdlp-nodejs', 'bin', 'yt-dlp_linux'))
    await expect(access(installed.ffmpegTarget, constants.X_OK)).resolves.toBeUndefined()
  })

  it('fails when rebuild replaces the placed yt-dlp binary', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n')
    const ytdlpBin = join(root, 'provided', 'yt-dlp')
    const ffmpegBin = join(root, 'provided', 'ffmpeg')
    await mkdir(join(root, 'provided'), { recursive: true })
    await script(ytdlpBin, '#!/bin/sh\necho 2026.10.26\n')
    await script(ffmpegBin, '#!/bin/sh\necho ffmpeg version test\n')
    await expect(installWorkspace({
      root,
      env: blockedEnv(root, ytdlpBin, ffmpegBin),
      fetchImpl: async () => {
        throw new Error('release download attempted')
      },
      run: async (_command, args) => {
        if (args[0] === 'ci') {
          await installedPackage(root, 'ffmpeg-static')
          await installedPackage(root, 'ytdlp-nodejs')
          return
        }
        await writeFile(join(root, 'node_modules', 'ytdlp-nodejs', 'bin', 'yt-dlp_linux'), 'replaced')
      },
    })).rejects.toThrow('yt-dlp binary was replaced during rebuild')
  })

  it('resolves a package whose exports omit package.json', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n')
    await installedPackage(root, 'ytdlp-nodejs')
    const serverPkg = join(root, 'server', 'node_modules', 'ffmpeg-static')
    await mkdir(join(serverPkg, 'dist'), { recursive: true })
    await writeFile(join(serverPkg, 'dist', 'index.js'), 'module.exports = {}\n')
    await writeFile(join(serverPkg, 'package.json'), hiddenPackageJson('ffmpeg-static'))
    await writeFile(join(root, 'server', 'package.json'), '{"name":"server"}\n')
    await expect(resolvePackage(root, 'ytdlp-nodejs')).resolves.toBe(join(root, 'node_modules', 'ytdlp-nodejs'))
    await expect(resolvePackage(root, 'ffmpeg-static')).resolves.toBe(serverPkg)
  })

  it('copies a provided ffmpeg into the release-check path when GitHub releases are blocked', async () => {
    const root = await tempRoot()
    const provided = join(root, 'provided', 'ffmpeg.exe')
    const dest = join(root, 'active', 'ffmpeg.exe')
    await mkdir(join(root, 'provided'), { recursive: true })
    await writeFile(provided, 'windows-ffmpeg')
    const urls: string[] = []
    const resolved = await ensureFfmpegBin({
      root,
      dest,
      env: {
        ...process.env,
        VIDEOBOOK_CI_PLATFORM: 'win32',
        VIDEOBOOK_CI_ARCH: 'x64',
        VIDEOBOOK_CI_BLOCK_RELEASES: '1',
        FFMPEG_BINARIES_URL: 'https://bogus.invalid/ffmpeg',
        VIDEOBOOK_CI_CACHE_DIR: join(root, 'empty-cache'),
        VIDEOBOOK_CI_FFMPEG_BIN: provided,
      },
      fetchImpl: async (url: string) => {
        urls.push(url)
        throw new Error(`release download attempted: ${url}`)
      },
      run: async () => {
        throw new Error('package install attempted')
      },
    })
    expect(urls).toEqual([])
    expect(resolved).toEqual({ path: dest, source: 'fallback' })
    expect(await readFile(dest, 'utf8')).toBe('windows-ffmpeg')
  })
})
