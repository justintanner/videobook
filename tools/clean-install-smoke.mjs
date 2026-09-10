import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const appSource = resolve(scriptDir, '..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'videobook-clean-install-'))
const appRoot = join(temporaryRoot, 'videobook')
const runtimeRoot = join(temporaryRoot, 'runtime')
const children = new Set()
const worktree = process.argv.includes('--worktree')
if (process.argv.slice(2).some((arg) => arg !== '--worktree')) throw new Error('Usage: clean-install-smoke.mjs [--worktree]')

function isSafeSourcePath(relativePath) {
  if (relativePath.split('/').some((part) =>
    part === '.git' || part === '.beads' || part === '.env' || part.startsWith('.env.'))) return false
  if (
    relativePath === '.env'
    || relativePath.startsWith('.env.')
    || relativePath.startsWith('.git/')
    || relativePath.startsWith('.playwright-mcp/')
    || relativePath.startsWith('books/')
    || relativePath.startsWith('dist/')
    || relativePath.startsWith('node_modules/')
    || relativePath.startsWith('runtime/')
    || relativePath === 'vancat.mp4'
    || relativePath === 'vancat_profile.jpg'
  ) return false
  return !relativePath.includes('/node_modules/')
    && !relativePath.includes('/dist/')
}

async function trackedAndUntrackedFiles(repoRoot) {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  )
  return stdout.toString('utf8').split('\0').filter((relativePath) =>
    relativePath.length > 0 && isSafeSourcePath(relativePath))
}

async function copyRepository(source, destination) {
  if (!worktree) {
    const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source })
    const revision = head.trim()
    const { stdout } = await execFileAsync('git', ['ls-tree', '-rz', '--name-only', revision], {
      cwd: source, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
    })
    const files = stdout.toString('utf8').split('\0').filter((name) => name && isSafeSourcePath(name))
    await mkdir(destination, { recursive: true })
    const archive = join(temporaryRoot, 'source.tar')
    for (let offset = 0; offset < files.length; offset += 250) {
      await execFileAsync('git', ['archive', '--format=tar', `--output=${archive}`, revision, '--', ...files.slice(offset, offset + 250)], { cwd: source })
      await execFileAsync('tar', ['-xf', archive, '-C', destination])
    }
    await rm(archive, { force: true })
    process.stdout.write(`clean-install: committed source ${revision}\n`)
    return files.length
  }
  const files = await trackedAndUntrackedFiles(source)
  for (const relativePath of files) {
    const target = join(destination, relativePath)
    await mkdir(dirname(target), { recursive: true })
    try {
      await cp(join(source, relativePath), target, {
        dereference: false,
        preserveTimestamps: true,
      })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return files.length
}

function isolatedEnvironment() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('VIDEOBOOK_') || /(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY|CLIENT_ID)/i.test(key)) delete env[key]
  }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  delete env.npm_config_allow_scripts
  delete env.NPM_CONFIG_ALLOW_SCRIPTS
  return {
    ...env,
    VIDEOBOOK_LIBRARY_DIR: join(runtimeRoot, 'books'),
    VIDEOBOOK_APP_STATE_PATH: join(runtimeRoot, 'app-state.json'),
    VIDEOBOOK_MODEL_DOWNLOAD: 'disabled',
    VIDEOBOOK_MODEL_CACHE_DIR: join(runtimeRoot, 'models'),
    VIDEOBOOK_OBJECT_PREFIX: 'clean-install-smoke',
    npm_config_userconfig: join(runtimeRoot, 'npmrc'),
  }
}

async function run(command, args, cwd) {
  process.stdout.write(`clean-install: ${command} ${args.join(' ')}\n`)
  const env = {
    ...isolatedEnvironment(),
    CI: '1',
  }
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(
        `${command} exited with ${code ?? `signal ${signal}`}`,
      ))
    })
  })
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not allocate a local port')
  }
  await new Promise((resolveClose) => server.close(resolveClose))
  return address.port
}

function runtimeEnvironment(port, serverUrl) {
  return {
    ...isolatedEnvironment(),
    PORT: String(port),
    VIDEOBOOK_SERVER_URL: serverUrl,
  }
}

function start(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  child.stdout.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  child.once('exit', () => children.delete(child))
  return child
}

async function waitFor(url, child, label) {
  const deadline = Date.now() + 30_000
  let lastError = ''
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before becoming ready`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = `${response.status} ${response.statusText}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  throw new Error(`${label} did not become ready: ${lastError}`)
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  child.kill('SIGTERM')
  let timer
  try {
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveTimeout) => { timer = setTimeout(resolveTimeout, 5_000) }),
    ])
  } finally { clearTimeout(timer) }
  if (child.exitCode !== null || child.signalCode !== null) return true
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGKILL')
  await exited
  return false
}

async function verifyMcp(serverUrl) {
  const requireFromServer = createRequire(join(appRoot, 'server/package.json'))
  const clientEntry = requireFromServer.resolve(
    '@modelcontextprotocol/client',
  )
  const { Client, StreamableHTTPClientTransport } = await import(
    pathToFileURL(clientEntry).href
  )
  const client = new Client(
    {
      name: 'videobook-clean-install',
      version: '1.0.0',
    },
    {
      capabilities: {},
      supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  )
  const transport = new StreamableHTTPClientTransport(
    new URL(`${serverUrl}/mcp`),
  )
  await client.connect(transport)
  try {
    const created = await client.callTool({
      name: 'create_book',
      arguments: { name: 'clean-install-smoke' },
    })
    const createdText = created.content.find((item) => item.type === 'text')?.text
    const book = JSON.parse(createdText ?? '{}')
    if (created.isError || typeof book.bookId !== 'string' || book.name !== 'clean-install-smoke') {
      throw new Error('MCP create_book did not return a book ID')
    }
    const listed = await client.callTool({
      name: 'list_books',
      arguments: {},
    })
    const listedText = listed.content.find((item) => item.type === 'text')?.text
    const books = JSON.parse(listedText ?? '[]')
    if (
      listed.isError || !Array.isArray(books)
      || !books.some((candidate) =>
        candidate.bookId === book.bookId
        && candidate.name === 'clean-install-smoke')
    ) {
      throw new Error('MCP list_books did not return the created book')
    }
    return book.bookId
  } finally {
    await client.close()
  }
}

async function verifyNativeRuntime() {
  const locations = ['package.json', 'server/package.json', 'node_modules/videobook-engine/package.json']
  const imports = locations.map((name) => createRequire(join(appRoot, name)))
  const paths = await Promise.all(imports.map((load) => realpath(load.resolve('sharp'))))
  const dependencyRoot = await realpath(join(appRoot, 'node_modules'))
  const nativePaths = await Promise.all(imports.map((load) => realpath(load.resolve('@dolthub/doltlite'))))
  if (new Set(nativePaths).size !== 1 || !nativePaths[0].startsWith(`${dependencyRoot}${sep}`)) {
    throw new Error(`DoltLite must resolve once inside the isolated application: ${JSON.stringify(nativePaths)}`)
  }
  const nativeVersion = imports[0]('@dolthub/doltlite/package.json').version
  const expectedNativeVersion = imports[2]('./package.json').dependencies['@dolthub/doltlite']
  if (nativeVersion !== expectedNativeVersion
    || imports[0]('./package.json').devDependencies['@dolthub/doltlite'] !== expectedNativeVersion) {
    throw new Error('Installed DoltLite must match the application and engine pins')
  }
  const { DatabaseSync } = imports[0]('@dolthub/doltlite')
  const native = new DatabaseSync(':memory:')
  try {
    process.stdout.write(`clean-install: one DoltLite ${nativeVersion} runtime (${native.doltVersion()})\n`)
  } finally { native.close() }
  if (new Set(paths).size !== 1 || !paths[0].startsWith(`${dependencyRoot}${sep}`)) {
    throw new Error(`Sharp must resolve once inside the isolated application: ${JSON.stringify(paths)}`)
  }
  const sharp = imports[0]('sharp')
  if (!imports.every((load) => load('sharp') === sharp)) throw new Error('Multiple Sharp module instances loaded')
  const encoded = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#2468ac' } }).png().toBuffer()
  for (const load of imports) {
    const metadata = await load('sharp')(encoded).metadata()
    if (metadata.width !== 8 || metadata.height !== 8) throw new Error('Native image round-trip failed')
  }
  const binaries = process.report.getReport().sharedObjects.filter((name) => /sharp[^/]*\.node$/.test(name))
  const libraries = process.report.getReport().sharedObjects.filter((name) => /libvips[^/]*\.(?:dylib|so(?:\.\d+)*)$/.test(name))
  if (binaries.length !== 1 || libraries.length > 1) throw new Error(`Duplicate native image runtimes: ${JSON.stringify({ binaries, libraries })}`)
  process.stdout.write(`clean-install: one Sharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips} runtime; image round-trip passed\n`)
}

try {
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(join(runtimeRoot, 'npmrc'), '', 'utf8')
  const appFiles = await copyRepository(appSource, appRoot)
  process.stdout.write(
    `clean-install: copied ${appFiles} app files with no sibling videobook-engine\n`,
  )
  await run('npm', ['ci', '--no-audit', '--no-fund'], appRoot)
  await verifyNativeRuntime()
  await run('npm', ['run', 'build'], appRoot)
  await run('npm', ['run', 'build:server'], appRoot)
  const requireFromEngine = createRequire(join(appRoot, 'package.json'))
  const enginePackageJson = requireFromEngine('videobook-engine/package.json')
  const expectedEngineVersion = enginePackageJson.version
  const lock = JSON.parse(await readFile(join(appRoot, 'package-lock.json'), 'utf8'))
  const lockedEngine = lock.packages['node_modules/videobook-engine']
  if (expectedEngineVersion !== lockedEngine.version || !lockedEngine.resolved.startsWith('file:vendor/')) {
    throw new Error('Installed engine does not match the pinned vendored lockfile')
  }
  const builtEngine = await import(
    pathToFileURL(join(appRoot, 'node_modules/videobook-engine/dist/index.js')).href
  )
  const expectedSchemaVersion = builtEngine.SCHEMA_VERSION

  const serverPort = await freePort()
  const clientPort = await freePort()
  const serverUrl = `http://127.0.0.1:${serverPort}`
  const env = runtimeEnvironment(serverPort, serverUrl)
  const server = start(
    process.execPath,
    ['server/dist/index.js'],
    appRoot,
    env,
  )
  try {
    const healthResponse = await waitFor(
      `${serverUrl}/healthz`,
      server,
      'Videobook server',
    )
    const health = await healthResponse.json()
    if (
      health.ok !== true
      || health.engineVersion !== expectedEngineVersion
      || health.schemaVersion !== expectedSchemaVersion
    ) {
      throw new Error(`Unexpected health response: ${JSON.stringify(health)}`)
    }
    const bookId = await verifyMcp(serverUrl)
    const client = start(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(clientPort),
      ],
      appRoot,
      env,
    )
    try {
      const shellResponse = await waitFor(
        `http://127.0.0.1:${clientPort}/`,
        client,
        'Videobook client',
      )
      const shell = await shellResponse.text()
      if (!shell.includes('<div id="root"></div>')) {
        throw new Error('Built client did not serve the Videobook shell')
      }
      const proxiedHealth = await fetch(
        `http://127.0.0.1:${clientPort}/healthz`,
      )
      if (!proxiedHealth.ok) {
        throw new Error('Built client did not proxy local server requests')
      }
      if (!bookId) throw new Error('MCP did not return the isolated book ID')
    } finally {
      await stop(client)
    }
  } finally {
    const graceful = await stop(server)
    if (!graceful || server.exitCode !== 0) throw new Error('Built server did not shut down gracefully with exit code zero')
  }
  process.stdout.write(
    `clean-install: PASS (${temporaryRoot} removed after verification)\n`,
  )
} finally {
  for (const child of children) await stop(child)
  if (process.env.KEEP_CLEAN_INSTALL !== '1') {
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  } else {
    process.stdout.write(`clean-install: retained ${temporaryRoot}\n`)
  }
}
