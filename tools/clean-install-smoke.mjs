import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const appSource = resolve(scriptDir, '..')
const engineSource = resolve(appSource, '../videobook-engine')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'videobook-clean-install-'))
const appRoot = join(temporaryRoot, 'videobook')
const engineRoot = join(temporaryRoot, 'videobook-engine')
const runtimeRoot = join(temporaryRoot, 'runtime')
const children = new Set()

function isSafeSourcePath(relativePath) {
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

async function run(command, args, cwd) {
  process.stdout.write(`clean-install: ${command} ${args.join(' ')}\n`)
  const env = {
    ...process.env,
    CI: '1',
    npm_config_userconfig: join(runtimeRoot, 'npmrc'),
  }
  delete env.npm_config_allow_scripts
  delete env.NPM_CONFIG_ALLOW_SCRIPTS
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
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      key.endsWith('_API_KEY')
      || key.endsWith('_ACCESS_KEY_ID')
      || key.endsWith('_SECRET_ACCESS_KEY')
      || key === 'X_CLIENT_ID'
      || key === 'X_CLIENT_SECRET'
    ) {
      delete env[key]
    }
  }
  return {
    ...env,
    PORT: String(port),
    VIDEOBOOK_SERVER_URL: serverUrl,
    VIDEOBOOK_LIBRARY_DIR: join(runtimeRoot, 'books'),
    VIDEOBOOK_APP_STATE_PATH: join(runtimeRoot, 'app-state.json'),
    VIDEOBOOK_OBJECT_PREFIX: 'clean-install-smoke',
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
    if (child.exitCode !== null) {
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
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function verifyMcp(serverUrl) {
  const requireFromServer = createRequire(join(appRoot, 'server/package.json'))
  const clientEntry = requireFromServer.resolve(
    '@modelcontextprotocol/sdk/client/index.js',
  )
  const transportEntry = requireFromServer.resolve(
    '@modelcontextprotocol/sdk/client/streamableHttp.js',
  )
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import(pathToFileURL(clientEntry).href),
    import(pathToFileURL(transportEntry).href),
  ])
  const client = new Client({
    name: 'videobook-clean-install',
    version: '1.0.0',
  })
  const transport = new StreamableHTTPClientTransport(
    new URL(`${serverUrl}/mcp`),
  )
  await client.connect(transport)
  try {
    const created = await client.callTool({
      name: 'create_book',
      arguments: { slug: 'clean-install-smoke' },
    })
    const createdText = created.content.find((item) => item.type === 'text')?.text
    const book = JSON.parse(createdText ?? '{}')
    if (typeof book.bookId !== 'string') {
      throw new Error('MCP create_book did not return a book ID')
    }
    const listed = await client.callTool({
      name: 'list_books',
      arguments: {},
    })
    const listedText = listed.content.find((item) => item.type === 'text')?.text
    const books = JSON.parse(listedText ?? '[]')
    if (
      !Array.isArray(books)
      || !books.some((candidate) =>
        candidate.bookId === book.bookId
        && candidate.slug === 'clean-install-smoke')
    ) {
      throw new Error('MCP list_books did not return the created book')
    }
    return book.bookId
  } finally {
    await client.close()
  }
}

try {
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(join(runtimeRoot, 'npmrc'), '', 'utf8')
  const engineFiles = await copyRepository(engineSource, engineRoot)
  const appFiles = await copyRepository(appSource, appRoot)
  process.stdout.write(
    `clean-install: copied ${engineFiles} engine files and ${appFiles} app files\n`,
  )
  await run('npm', ['ci', '--no-audit', '--no-fund'], engineRoot)
  await run('npm', ['run', 'build'], engineRoot)
  await run('npm', ['ci', '--no-audit', '--no-fund'], appRoot)
  await run('npm', ['ci', '--no-audit', '--no-fund'], join(appRoot, 'server'))
  await run('npm', ['run', 'build'], appRoot)
  await run('npm', ['run', 'build:server'], appRoot)
  const requireFromEngine = createRequire(join(engineRoot, 'package.json'))
  const expectedEngineVersion = requireFromEngine('./package.json').version
  const builtEngine = await import(pathToFileURL(join(engineRoot, 'dist/index.js')).href)
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
    await stop(server)
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
