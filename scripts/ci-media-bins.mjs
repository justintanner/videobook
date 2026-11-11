import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const YTDLP_VERSION = '2026.10.26'
export const YTDLP_LINUX_X64_SHA256 = '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795'
export const FFMPEG_RELEASE = 'b6.1.1'
export const FFMPEG_LINUX_X64_SHA256 = 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99'

const ASSET_NAMES = {
  win32: { x64: 'yt-dlp.exe', ia32: 'yt-dlp_x86.exe', arm64: 'yt-dlp_arm64.exe' },
  linux: { x64: 'yt-dlp_linux', armv7l: 'yt-dlp_linux_armv7l', aarch64: 'yt-dlp_linux_aarch64', arm64: 'yt-dlp_linux_aarch64' },
  darwin: { x64: 'yt-dlp_macos', arm64: 'yt-dlp_macos' },
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function ytdlpAssetName(platform, arch, musl) {
  if (platform === 'linux' && musl) {
    if (arch === 'x64') return 'yt-dlp_musllinux'
    if (arch === 'arm64' || arch === 'aarch64') return 'yt-dlp_musllinux_aarch64'
  }
  const name = ASSET_NAMES[platform]?.[arch]
  if (!name) throw new Error(`No yt-dlp build for ${platform} ${arch}`)
  return name
}

export function releasesBlocked(env = process.env) {
  return env.VIDEOBOOK_CI_BLOCK_RELEASES === '1'
}

export function ytdlpReleaseUrl(asset, env = process.env) {
  const base = (env.VIDEOBOOK_CI_YTDLP_RELEASE_BASE ?? 'https://github.com/yt-dlp/yt-dlp/releases/download').replace(/\/$/u, '')
  return `${base}/${YTDLP_VERSION}/${asset}`
}

export function ffmpegReleaseUrl(platform, arch, env = process.env) {
  const base = (env.FFMPEG_BINARIES_URL ?? 'https://github.com/eugeneware/ffmpeg-static/releases/download').replace(/\/$/u, '')
  const release = env.FFMPEG_BINARY_RELEASE ?? FFMPEG_RELEASE
  return `${base}/${release}/ffmpeg-${platform}-${arch}.gz`
}

async function readIfValid(path, expected) {
  let body
  try {
    body = await readFile(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
  if (expected && sha256(body) !== expected) {
    await rm(path, { force: true })
    return false
  }
  return true
}

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function fetchBytes(url, fetchImpl, retries, delayMs) {
  let last = new Error(`failed to download ${url}`)
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url)
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error))
      if (attempt < retries) await delay(delayMs * attempt)
    }
  }
  throw last
}

async function downloadToCache(options) {
  const bytes = await fetchBytes(options.url, options.fetchImpl ?? globalThis.fetch, options.retries ?? 3, options.delayMs ?? 1000)
  const body = options.gzip ? gunzipSync(bytes) : Buffer.from(bytes)
  if (options.sha256 && sha256(body) !== options.sha256) {
    throw new Error(`checksum mismatch for ${options.url}`)
  }
  await mkdir(dirname(options.cachePath), { recursive: true })
  const partial = `${options.cachePath}.partial`
  await writeFile(partial, body)
  await chmod(partial, 0o755)
  await rename(partial, options.cachePath)
}

export async function resolveBinary(options) {
  if (await readIfValid(options.cachePath, options.sha256 ?? null)) {
    return { path: options.cachePath, source: 'cache' }
  }
  if (!options.blocked) {
    try {
      await downloadToCache(options)
      return { path: options.cachePath, source: 'download' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`pinned download failed for ${options.url}: ${message}\n`)
      await rm(options.cachePath, { force: true })
      await rm(`${options.cachePath}.partial`, { force: true })
    }
  }
  if (!options.fallback) throw new Error(`No binary for ${options.url}`)
  await mkdir(dirname(options.fallbackPath), { recursive: true })
  await options.fallback(options.fallbackPath)
  await chmod(options.fallbackPath, 0o755)
  return { path: options.fallbackPath, source: 'fallback' }
}
