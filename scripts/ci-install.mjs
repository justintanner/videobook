import { execFile, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  FFMPEG_LINUX_X64_SHA256,
  YTDLP_LINUX_X64_SHA256,
  YTDLP_VERSION,
  ffmpegReleaseUrl,
  releasesBlocked,
  resolveBinary,
  sha256,
  ytdlpAssetName,
  ytdlpReleaseUrl,
} from './ci-media-bins.mjs'

const execFileAsync = promisify(execFile)

function spawnRun(cwd) {
  return (command, args, env) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

async function which(command) {
  try {
    const { stdout } = await execFileAsync('which', [command])
    const found = stdout.trim()
    return found || null
  } catch {
    return null
  }
}

async function place(from, to) {
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
  await chmod(to, 0o755)
}

async function provideFile(source, dest) {
  await copyFile(source, dest)
  await chmod(dest, 0o755)
}

async function provideYtdlp(dest, env, run) {
  if (env.VIDEOBOOK_CI_YTDLP_BIN) {
    await provideFile(env.VIDEOBOOK_CI_YTDLP_BIN, dest)
    return
  }
  const venv = join(dirname(dest), 'venv')
  try {
    await run('python3', ['-m', 'venv', venv], env)
  } catch {
    await run('sudo', ['apt-get', 'update'], env)
    await run('sudo', ['apt-get', 'install', '-y', 'python3-venv'], env)
    await run('python3', ['-m', 'venv', venv], env)
  }
  await run(join(venv, 'bin', 'pip'), ['install', '--disable-pip-version-check', `yt-dlp==${YTDLP_VERSION}`], env)
  await provideFile(join(venv, 'bin', 'yt-dlp'), dest)
}

async function whereCommand(command) {
  try {
    const { stdout } = await execFileAsync('where.exe', [command])
    const found = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    return found || null
  } catch {
    return null
  }
}

async function provideFfmpeg(dest, env, run) {
  if (env.VIDEOBOOK_CI_FFMPEG_BIN) {
    await provideFile(env.VIDEOBOOK_CI_FFMPEG_BIN, dest)
    return
  }
  const platform = env.VIDEOBOOK_CI_PLATFORM ?? process.platform
  if (platform === 'win32') {
    let source = await whereCommand('ffmpeg')
    if (!source) {
      await run('choco.exe', ['install', 'ffmpeg', '-y', '--no-progress'], env)
      source = await whereCommand('ffmpeg')
    }
    if (!source) {
      const chocoBin = join(env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe')
      if (existsSync(chocoBin)) source = chocoBin
    }
    if (!source) throw new Error('ffmpeg was not found after the package install')
    await provideFile(source, dest)
    return
  }
  let source = await which('ffmpeg')
  if (!source) {
    await run('sudo', ['apt-get', 'update'], env)
    await run('sudo', ['apt-get', 'install', '-y', 'ffmpeg'], env)
    source = await which('ffmpeg')
  }
  if (!source) throw new Error('ffmpeg was not found after the package install')
  await provideFile(source, dest)
}

export async function ensureFfmpegBin({ root, dest, env = process.env, run, fetchImpl }) {
  const platform = env.VIDEOBOOK_CI_PLATFORM ?? process.platform
  const arch = env.VIDEOBOOK_CI_ARCH ?? process.arch
  const name = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const cacheDir = env.VIDEOBOOK_CI_CACHE_DIR ?? join(root, 'ci', 'media-bins')
  const resolved = await resolveBinary({
    cachePath: join(cacheDir, name),
    fallbackPath: join(root, 'ci', 'media-bins-fallback', name),
    url: ffmpegReleaseUrl(platform, arch, env),
    gzip: true,
    sha256: platform === 'linux' && arch === 'x64' ? FFMPEG_LINUX_X64_SHA256 : null,
    blocked: releasesBlocked(env),
    fetchImpl,
    fallback: (path) => provideFfmpeg(path, env, run),
  })
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(resolved.path, dest)
  await chmod(dest, 0o755)
  return { path: dest, source: resolved.source }
}

async function packageName(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    return typeof parsed.name === 'string' ? parsed.name : null
  } catch {
    return null
  }
}

async function packageDirFromEntry(entry, name) {
  let dir = dirname(entry)
  for (;;) {
    if (await packageName(dir) === name) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function resolvePackage(root, name) {
  const manifests = [join(root, 'package.json'), join(root, 'server', 'package.json')]
  for (const manifest of manifests) {
    try {
      const entry = createRequire(manifest).resolve(name)
      const dir = await packageDirFromEntry(entry, name)
      if (dir) return dir
    } catch {
      continue
    }
  }
  const direct = [join(root, 'node_modules', name), join(root, 'server', 'node_modules', name)]
  for (const dir of direct) {
    if (await packageName(dir) === name) return dir
  }
  throw new Error(`Could not resolve ${name} from ${root}`)
}

async function commandOutput(file, args) {
  const { stdout } = await execFileAsync(file, args)
  return stdout
}

export { resolvePackage }

export async function installWorkspace({ root, env = process.env, run, fetchImpl }) {
  const platform = env.VIDEOBOOK_CI_PLATFORM ?? process.platform
  const arch = env.VIDEOBOOK_CI_ARCH ?? process.arch
  const musl = env.VIDEOBOOK_CI_MUSL === '1'
  const asset = ytdlpAssetName(platform, arch, musl)
  const cacheDir = env.VIDEOBOOK_CI_CACHE_DIR ?? join(root, 'ci', 'media-bins')
  const fallbackDir = join(root, 'ci', 'media-bins-fallback')
  const blocked = releasesBlocked(env)
  const ffmpegName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ytdlpSha = asset === 'yt-dlp_linux' ? YTDLP_LINUX_X64_SHA256 : null
  const ffmpegSha = platform === 'linux' && arch === 'x64' ? FFMPEG_LINUX_X64_SHA256 : null

  await run('npm', ['ci', '--ignore-scripts'], env)

  const ytdlp = await resolveBinary({
    cachePath: join(cacheDir, asset),
    fallbackPath: join(fallbackDir, asset),
    url: ytdlpReleaseUrl(asset, env),
    sha256: ytdlpSha,
    blocked,
    fetchImpl,
    fallback: (dest) => provideYtdlp(dest, env, run),
  })
  const ffmpeg = await resolveBinary({
    cachePath: join(cacheDir, ffmpegName),
    fallbackPath: join(fallbackDir, ffmpegName),
    url: ffmpegReleaseUrl(platform, arch, env),
    gzip: true,
    sha256: ffmpegSha,
    blocked,
    fetchImpl,
    fallback: (dest) => provideFfmpeg(dest, env, run),
  })

  const ytdlpTarget = join(await resolvePackage(root, 'ytdlp-nodejs'), 'bin', asset)
  const ffmpegTarget = join(await resolvePackage(root, 'ffmpeg-static'), ffmpegName)
  await place(ytdlp.path, ytdlpTarget)
  await place(ffmpeg.path, ffmpegTarget)
  const ytdlpHash = sha256(await readFile(ytdlpTarget))
  const ffmpegHash = sha256(await readFile(ffmpegTarget))

  await run('npm', [
    'rebuild',
    'esbuild',
    'usearch',
    '@dolthub/doltlite',
    'onnxruntime-node',
    `@ffprobe-installer/${platform}-${arch}`,
    'ffmpeg-static',
    'ytdlp-nodejs',
  ], env)

  if (sha256(await readFile(ytdlpTarget)) !== ytdlpHash) {
    throw new Error('yt-dlp binary was replaced during rebuild')
  }
  if (sha256(await readFile(ffmpegTarget)) !== ffmpegHash) {
    throw new Error('ffmpeg binary was replaced during rebuild')
  }
  await commandOutput(ffmpegTarget, ['-version'])
  const version = (await commandOutput(ytdlpTarget, ['--version'])).trim()
  if (version !== YTDLP_VERSION) {
    throw new Error(`yt-dlp ${version} is not the pinned ${YTDLP_VERSION}`)
  }
  process.stdout.write(`yt-dlp ${version} (${ytdlp.source})\n`)
  process.stdout.write(`ffmpeg (${ffmpeg.source})\n`)
  return { ytdlp, ffmpeg, ytdlpTarget, ffmpegTarget }
}

function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const root = process.env.VIDEOBOOK_CI_ROOT ?? fileURLToPath(new URL('..', import.meta.url))
  installWorkspace({ root, env: process.env, run: spawnRun(root) }).catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  })
}
