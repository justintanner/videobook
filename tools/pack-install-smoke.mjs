import { execFile, spawn } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const appSource = resolve(scriptDir, '..')
const options = parseOptions(process.argv.slice(2))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'videobook-pack-install-'))
const appRoot = join(temporaryRoot, 'videobook')
const runtimeRoot = join(temporaryRoot, 'runtime')
const children = new Set()

const ALLOW_SCRIPTS = ['ffmpeg-static', 'ytdlp-nodejs', '@dolthub/doltlite', 'usearch', 'onnxruntime-node', 'esbuild']
const MAX_PACKED_BYTES = 8 * 1024 * 1024
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024
const ALLOWED_PATH = /^(package\.json|README\.md|LICENSE|CHANGELOG\.md|bin\/videobook\.js|dist\/.+|ui\/.+)$/
const DENIED_PATHS = [
  /\.(test|e2e\.test)\.js$/,
  /\.d\.ts$/,
  /\.map$/,
  /^dist\/(test-client|test-goals|test-media-fixtures|test-fetch-guard|screenshot|cli)\.js$/,
  /^dist\/quiet-probes\//,
  /^dist\/tools\/xai-realtime-endpoint\.js$/,
  /^dist\/fixtures\//,
  /^dist\/guides\/guides\//,
  /\.mp4$/,
  /^ui\/(1080p-blank|dancing-kittens-first-frame)\.png$/,
]
const REQUIRED_PATHS = [
  'package.json', 'LICENSE', 'CHANGELOG.md', 'bin/videobook.js', 'dist/index.js', 'dist/cli/entry.js', 'dist/cli/main.js',
  'dist/test-queue-cleanup.js', 'dist/rhythm/worker.js', 'dist/remotion/public/qr-outro-impact.wav', 'ui/index.html', 'ui/favicon.svg',
]

function parseOptions(args) {
  const parsed = { worktree: false, npm12: false, artifactDir: null }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--worktree') parsed.worktree = true
    else if (arg === '--npm12') parsed.npm12 = true
    else if (arg === '--artifact-dir' && args[index + 1]) parsed.artifactDir = resolve(args[++index])
    else throw new Error('Usage: pack-install-smoke.mjs [--worktree] [--npm12] [--artifact-dir <dir>]')
  }
  return parsed
}

function log(message) {
  process.stdout.write(`pack-install: ${message}\n`)
}

function isSafeSourcePath(relativePath) {
  const parts = relativePath.split('/')
  if (parts.some((part) => part === '.git' || part === '.beads' || part === '.env' || part.startsWith('.env.'))) return false
  const blockedRoots = ['.playwright-mcp/', 'books/', 'dist/', 'node_modules/', 'runtime/', 'server/ui/', 'server/dist/', '.artifacts/']
  if (blockedRoots.some((prefix) => relativePath.startsWith(prefix))) return false
  return !relativePath.includes('/node_modules/') && !relativePath.includes('/dist/')
}

async function listFiles(command, args, cwd) {
  const { stdout } = await execFileAsync(command, args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  return stdout.toString('utf8').split('\0').filter((name) => name && isSafeSourcePath(name))
}

async function exportCommitted(destination) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: appSource })
  const revision = stdout.trim()
  const files = await listFiles('git', ['ls-tree', '-rz', '--name-only', revision], appSource)
  await mkdir(destination, { recursive: true })
  const archive = join(temporaryRoot, 'source.tar')
  for (let offset = 0; offset < files.length; offset += 250) {
    await execFileAsync('git', ['archive', '--format=tar', `--output=${archive}`, revision, '--', ...files.slice(offset, offset + 250)], { cwd: appSource })
    await execFileAsync('tar', ['-xf', archive, '-C', destination])
  }
  await rm(archive, { force: true })
  log(`committed source ${revision}`)
}

async function exportWorktree(destination) {
  const files = await listFiles('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], appSource)
  for (const relativePath of files) {
    if (!existsSync(join(appSource, relativePath))) continue
    await mkdir(dirname(join(destination, relativePath)), { recursive: true })
    await cp(join(appSource, relativePath), join(destination, relativePath), { preserveTimestamps: true })
  }
  log(`worktree source (${files.length} files)`)
}

function isolatedEnvironment(extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('VIDEOBOOK_') || key.startsWith('npm_') || /(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY|CLIENT_ID)/i.test(key)) delete env[key]
  }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  return {
    ...env,
    CI: '1',
    VIDEOBOOK_HOME: join(runtimeRoot, 'home'),
    VIDEOBOOK_MODEL_DOWNLOAD: 'disabled',
    VIDEOBOOK_MODEL_CACHE_DIR: join(runtimeRoot, 'models'),
    VIDEOBOOK_REMOTION_CACHE_DIR: join(runtimeRoot, 'remotion'),
    VIDEOBOOK_DOWNLOADS_DIR: join(runtimeRoot, 'downloads'),
    VIDEOBOOK_LOG_LEVEL: 'info',
    npm_config_userconfig: join(runtimeRoot, 'npmrc'),
    ...extra,
  }
}

function run(command, args, cwd, env = isolatedEnvironment()) {
  log(`${command === process.execPath ? 'node' : command} ${args.join(' ')}`)
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} ${args[0] ?? ''} exited with ${code ?? signal}`)))
  })
}

function capture(command, args, cwd, env = isolatedEnvironment()) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectCapture)
    child.once('exit', (code) => resolveCapture({ code, stdout, stderr }))
  })
}

function start(command, args, env) {
  const child = spawn(command, args, { cwd: runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.output = ''
  child.stdout.on('data', (chunk) => { child.output += chunk })
  child.stderr.on('data', (chunk) => { child.output += chunk })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.kill('SIGTERM')
  let timer
  const code = await Promise.race([exited, new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout('timeout'), 20_000) })])
  clearTimeout(timer)
  if (code !== 'timeout') return code
  child.kill('SIGKILL')
  await exited
  throw new Error('videobook did not stop within 20 s of SIGTERM')
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  await new Promise((resolveClose) => server.close(resolveClose))
  return address.port
}

async function waitFor(url, child) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`videobook exited before ${url} answered:\n${child.output}`)
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200))
    }
  }
  throw new Error(`${url} did not answer:\n${child.output}`)
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

async function verifyWorkspaceLock() {
  const lock = JSON.parse(await readFile(join(appRoot, 'package-lock.json'), 'utf8'))
  const server = JSON.parse(await readFile(join(appRoot, 'server', 'package.json'), 'utf8'))
  const version = server.dependencies['videobook-engine']
  const entry = lock.packages['node_modules/videobook-engine']
  expect(entry?.resolved === `https://registry.npmjs.org/videobook-engine/-/videobook-engine-${version}.tgz`, `lockfile engine is not the npm release ${version}`)
  expect(entry?.integrity?.startsWith('sha512-'), 'lockfile engine has no sha512 integrity')
  log(`workspace lock pins videobook-engine ${version} from npm`)
}

async function packPackage() {
  await run('npm', ['run', 'build:package'], appRoot)
  const packDir = join(temporaryRoot, 'pack')
  await mkdir(packDir, { recursive: true })
  const { code, stdout, stderr } = await capture('npm', ['pack', '-w', 'server', '--ignore-scripts', '--json', '--pack-destination', packDir], appRoot)
  expect(code === 0, `npm pack failed:\n${stderr}`)
  const [pack] = JSON.parse(stdout)
  return { pack, tarball: join(packDir, pack.filename) }
}

function verifyTarball(pack) {
  const paths = pack.files.map((file) => file.path)
  expect(pack.size <= MAX_PACKED_BYTES, `packed size ${pack.size} exceeds ${MAX_PACKED_BYTES}`)
  expect(pack.unpackedSize <= MAX_UNPACKED_BYTES, `unpacked size ${pack.unpackedSize} exceeds ${MAX_UNPACKED_BYTES}`)
  const outside = paths.filter((path) => !ALLOWED_PATH.test(path))
  expect(outside.length === 0, `unexpected files in the package: ${outside.join(', ')}`)
  const denied = paths.filter((path) => DENIED_PATHS.some((pattern) => pattern.test(path)))
  expect(denied.length === 0, `test or sample files in the package: ${denied.join(', ')}`)
  const missing = REQUIRED_PATHS.filter((path) => !paths.includes(path))
  expect(missing.length === 0, `package is missing: ${missing.join(', ')}`)
  expect(paths.some((path) => /^ui\/assets\/.+\.js$/.test(path)), 'package has no UI JavaScript assets')
  expect((pack.files.find((file) => file.path === 'bin/videobook.js')?.mode & 0o111) !== 0, 'bin/videobook.js is not executable')
  log(`${pack.filename}: ${(pack.size / 1048576).toFixed(2)} MiB packed, ${(pack.unpackedSize / 1048576).toFixed(2)} MiB unpacked, ${pack.entryCount} files`)
}

async function globalInstall(npmCommand, tarball, prefix, extraArgs) {
  await mkdir(join(prefix, 'lib', 'node_modules'), { recursive: true })
  await run(npmCommand[0], [...npmCommand.slice(1), 'install', '-g', tarball, '--prefix', prefix, '--no-audit', '--no-fund', ...extraArgs], runtimeRoot)
  const packageDir = join(prefix, 'lib', 'node_modules', 'videobook')
  expect(existsSync(join(packageDir, 'package.json')), `global install did not create ${packageDir}`)
  return packageDir
}

async function packagesWithInstallScripts(directory, found = new Map()) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(directory, entry.name)
    if (entry.name.startsWith('@')) {
      await packagesWithInstallScripts(path, found)
      continue
    }
    await recordInstallScripts(path, found)
    await packagesWithInstallScripts(join(path, 'node_modules'), found)
  }
  return found
}

async function recordInstallScripts(packageDir, found) {
  try {
    const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    const scripts = manifest.scripts ?? {}
    const gyp = existsSync(join(packageDir, 'binding.gyp')) && manifest.gypfile !== false
    if (scripts.preinstall || scripts.install || scripts.postinstall || gyp) found.set(manifest.name, packageDir)
  } catch {
    return
  }
}

async function verifyInstalledTree(packageDir) {
  const scripted = [...(await packagesWithInstallScripts(join(packageDir, 'node_modules'))).keys()].sort()
  const undocumented = scripted.filter((name) => !ALLOW_SCRIPTS.includes(name))
  expect(undocumented.length === 0, `packages with install scripts missing from the documented --allow-scripts list: ${undocumented.join(', ')}`)
  log(`install scripts in the tree: ${scripted.join(', ')}`)
  const fromPackage = createRequire(join(packageDir, 'package.json'))
  const fromEngine = createRequire(fromPackage.resolve('videobook-engine/package.json'))
  expect(fromPackage.resolve('sharp') === fromEngine.resolve('sharp'), 'videobook and videobook-engine resolve different Sharp copies')
  const ffmpeg = fromPackage('ffmpeg-static')
  return { ffmpegBundled: typeof ffmpeg === 'string' && existsSync(ffmpeg) }
}

async function verifyVersionAndDoctor(binDir, packageDir) {
  const version = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).version
  const env = isolatedEnvironment({ PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` })
  const viaShim = await capture(join(binDir, 'videobook'), ['--version'], runtimeRoot, env)
  expect(viaShim.code === 0 && viaShim.stdout.startsWith(`videobook ${version} (engine `), `videobook --version failed:\n${viaShim.stdout}${viaShim.stderr}`)
  log(viaShim.stdout.trim())
  const doctor = await capture(process.execPath, [join(packageDir, 'bin', 'videobook.js'), 'doctor', '--json'], runtimeRoot)
  const report = JSON.parse(doctor.stdout)
  expect(doctor.code === 0 && report.ok === true, `videobook doctor failed:\n${doctor.stdout}${doctor.stderr}`)
  log(`doctor: ${report.checks.map((check) => `${check.id}=${check.status}`).join(' ')}`)
}

async function importClient(packageDir) {
  const fromPackage = createRequire(join(packageDir, 'package.json'))
  const client = await import(pathToFileURL(fromPackage.resolve('@modelcontextprotocol/client')).href)
  const stdio = await import(pathToFileURL(fromPackage.resolve('@modelcontextprotocol/client/stdio')).href)
  return { ...client, ...stdio }
}

function pinnedClient(sdk) {
  return new sdk.Client({ name: 'videobook-pack-install', version: '1' }, {
    capabilities: {},
    supportedProtocolVersions: ['2026-07-28'],
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  })
}

async function callJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  expect(!result.isError, `${name} failed: ${JSON.stringify(result.content)}`)
  return JSON.parse(result.content.find((item) => item.type === 'text')?.text ?? 'null')
}

async function verifyHeadless(packageDir, sdk) {
  const bin = join(packageDir, 'bin', 'videobook.js')
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const server = start(process.execPath, [bin, 'serve', '--headless', '--port', String(port)], isolatedEnvironment())
  const health = await (await waitFor(`${base}/healthz`, server)).json()
  const engine = JSON.parse(await readFile(join(packageDir, 'node_modules', 'videobook-engine', 'package.json'), 'utf8'))
  expect(health.ok === true && health.service === 'videobook' && health.engineVersion === engine.version, `unexpected health: ${JSON.stringify(health)}`)
  const client = pinnedClient(sdk)
  await client.connect(new sdk.StreamableHTTPClientTransport(new URL(`${base}/mcp`)))
  const book = await callJson(client, 'create_book', { name: 'pack-install' })
  const books = await callJson(client, 'list_books', {})
  await client.close()
  expect(books.some((candidate) => candidate.bookId === book.bookId), 'list_books did not return the created book')
  expect((await fetch(`${base}/`, { headers: { accept: 'text/html' } })).status === 404, '--headless still served the web UI')
  const second = await capture(process.execPath, [bin, 'serve', '--headless', '--port', String(await freePort())], runtimeRoot)
  expect(second.code === 1 && second.stderr.includes(`videobook is already running at ${base}`), `second serve was not refused:\n${second.stderr}`)
  expect(await stop(server) === 0, `headless server did not exit cleanly:\n${server.output}`)
  expect(!existsSync(join(runtimeRoot, 'home', 'books', '.videobook-server.json')), 'library lock was not released')
  log('serve --headless: health, MCP create/list, lock refusal and clean shutdown passed')
}

async function verifyUi(packageDir) {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const server = start(process.execPath, [join(packageDir, 'bin', 'videobook.js'), 'serve', '--port', String(port)], isolatedEnvironment())
  await waitFor(`${base}/healthz`, server)
  const shell = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text()
  expect(shell.includes('<div id="root"></div>'), 'web UI shell was not served at /')
  const asset = /\/assets\/[^"]+\.js/.exec(shell)?.[0]
  const assetResponse = asset ? await fetch(`${base}${asset}`) : null
  expect(assetResponse?.ok && assetResponse.headers.get('content-type')?.includes('javascript'), `UI asset ${asset} did not load`)
  const deepLink = await (await fetch(`${base}/jobs`, { headers: { accept: 'text/html' } })).text()
  expect(deepLink.includes('<div id="root"></div>'), '/jobs did not fall back to the UI shell')
  expect(await stop(server) === 0, `UI server did not exit cleanly:\n${server.output}`)
  log('serve: web UI shell, hashed asset and deep link passed')
}

async function verifyStdio(packageDir, sdk) {
  const client = pinnedClient(sdk)
  const transport = new sdk.StdioClientTransport({
    command: process.execPath,
    args: [join(packageDir, 'bin', 'videobook.js'), 'mcp', '--port', String(await freePort())],
    cwd: runtimeRoot,
    env: isolatedEnvironment(),
    stderr: 'pipe',
  })
  const errors = []
  client.onerror = (error) => errors.push(error)
  await client.connect(transport)
  const tools = await client.listTools()
  expect(tools.tools.some((tool) => tool.name === 'create_book'), 'stdio tools/list is missing create_book')
  const books = await callJson(client, 'list_books', {})
  expect(Array.isArray(books), 'stdio list_books did not return a list')
  await client.close()
  expect(errors.length === 0, `stdout carried non-protocol output: ${errors.map((error) => error.message).join('; ')}`)
  log(`mcp over stdio: ${tools.tools.length} tools, list_books passed`)
}

async function verifyBlockedScripts(npmCommand, tarball, label, blockArgs) {
  const prefix = join(temporaryRoot, `blocked-${label}`)
  const packageDir = await globalInstall(npmCommand, tarball, prefix, blockArgs)
  const env = isolatedEnvironment({ PATH: dirname(process.execPath) })
  const version = await capture(process.execPath, [join(packageDir, 'bin', 'videobook.js'), '--version'], runtimeRoot, env)
  expect(version.code === 0, `videobook --version failed with install scripts blocked:\n${version.stderr}`)
  const tree = await verifyInstalledTree(packageDir)
  if (tree.ffmpegBundled) {
    log(`${label}: ffmpeg-static binary present despite blocked scripts; skipping the remedy check`)
    return
  }
  const doctor = await capture(process.execPath, [join(packageDir, 'bin', 'videobook.js'), 'doctor'], runtimeRoot, env)
  expect(doctor.code === 1 && doctor.stdout.includes('--allow-scripts=ffmpeg-static'), `doctor did not explain the blocked ffmpeg download:\n${doctor.stdout}`)
  log(`${label}: install scripts blocked; CLI starts and doctor names the --allow-scripts remedy`)
}

function nodeRunsNpm12(version) {
  const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number)
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2)
  if (major === 24) return minor >= 15
  return major >= 26
}

async function npm12Command() {
  const prefix = join(temporaryRoot, 'npm12')
  await run('npm', ['install', '-g', 'npm@12', '--prefix', prefix, '--no-audit', '--no-fund'], runtimeRoot)
  return [process.execPath, join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
}

async function verifyNpm12(tarball) {
  const npm12 = await npm12Command()
  const strictPrefix = join(temporaryRoot, 'strict')
  await mkdir(join(strictPrefix, 'lib', 'node_modules'), { recursive: true })
  const strict = await capture(npm12[0], [...npm12.slice(1), 'install', '-g', tarball, '--prefix', strictPrefix, '--strict-allow-scripts', '--no-audit', '--no-fund'], runtimeRoot)
  const strictOutput = `${strict.stdout}${strict.stderr}`
  expect(strict.code !== 0, 'npm 12 --strict-allow-scripts accepted unapproved install scripts')
  expect(/allow-?scripts|install scripts?|lifecycle scripts?/i.test(strictOutput) && ALLOW_SCRIPTS.some((name) => strictOutput.includes(name)), `npm 12 strict install failed for another reason:\n${strictOutput}`)
  await globalInstall(npm12, tarball, join(temporaryRoot, 'approved'), ['--strict-allow-scripts', `--allow-scripts=${ALLOW_SCRIPTS.join(',')}`])
  log('npm 12: strict install fails without the list and succeeds with the documented --allow-scripts list')
  await verifyBlockedScripts(npm12, tarball, 'npm12', [])
}

try {
  expect(!options.npm12 || nodeRunsNpm12(process.version), `--npm12 needs Node ^22.22.2 || ^24.15.0 || >=26 to run npm 12; this is ${process.version}`)
  await mkdir(join(runtimeRoot, 'home'), { recursive: true })
  await writeFile(join(runtimeRoot, 'npmrc'), '', 'utf8')
  if (options.worktree) await exportWorktree(appRoot)
  else await exportCommitted(appRoot)
  await run('npm', ['ci', '--no-audit', '--no-fund'], appRoot)
  await verifyWorkspaceLock()
  const { pack, tarball } = await packPackage()
  verifyTarball(pack)
  if (options.artifactDir) {
    await mkdir(options.artifactDir, { recursive: true })
    await copyFile(tarball, join(options.artifactDir, pack.filename))
  }
  const prefix = join(temporaryRoot, 'prefix')
  const packageDir = await globalInstall(['npm'], tarball, prefix, [`--allow-scripts=${ALLOW_SCRIPTS.join(',')}`])
  const tree = await verifyInstalledTree(packageDir)
  expect(tree.ffmpegBundled, 'ffmpeg-static did not download its binary during the global install')
  await verifyVersionAndDoctor(join(prefix, 'bin'), packageDir)
  const sdk = await importClient(packageDir)
  await verifyHeadless(packageDir, sdk)
  await verifyUi(packageDir)
  await verifyStdio(packageDir, sdk)
  await verifyBlockedScripts(['npm'], tarball, 'ignore-scripts', ['--ignore-scripts'])
  if (options.npm12) await verifyNpm12(tarball)
  log('PASS')
} finally {
  for (const child of children) child.kill('SIGKILL')
  if (process.env.KEEP_PACK_INSTALL === '1') log(`kept ${temporaryRoot}`)
  else await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
