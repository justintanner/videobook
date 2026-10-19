import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SECRET_REFERENCE = process.env.VIDEOBOOK_NPM_TOKEN_REFERENCE?.trim() || 'op://apicity/NPM_TOKEN/password'
const REGISTRY = 'https://registry.npmjs.org/'
const PACKAGE = 'videobook'
const ALLOW_SCRIPTS = 'ffmpeg-static,ytdlp-nodejs,@dolthub/doltlite,usearch,onnxruntime-node,esbuild'

function usage() {
  return [
    'Usage: npm run release -- <version> [--dry-run] [--push]',
    '',
    '  <version>   must equal server/package.json and have a ## [<version>] changelog section',
    '  --dry-run   run every gate and npm publish --dry-run, then stop',
    '  --push      also push main and the tag and create the GitHub release',
    '',
    `The npm token is read from ${SECRET_REFERENCE} with the 1Password CLI into a`,
    'temporary npmrc that is deleted afterwards. It is never written to .env.',
    '',
  ].join('\n')
}

function parseOptions(args) {
  const options = { version: null, dryRun: false, push: false }
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--push') options.push = true
    else if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(arg) && !options.version) options.version = arg
    else throw new Error(`Unexpected argument "${arg}".\n\n${usage()}`)
  }
  if (!options.version) throw new Error(usage())
  if (options.dryRun && options.push) throw new Error('--dry-run and --push cannot be combined.')
  return options
}

function log(message) {
  process.stdout.write(`release: ${message}\n`)
}

function fail(message) {
  throw new Error(message)
}

function run(command, args, extraEnv = {}) {
  log(`${command} ${args.join(' ')}`)
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}`)))
  })
}

async function output(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, { cwd: root, maxBuffer: 16 * 1024 * 1024, ...options })
  return stdout.trim()
}

async function outputOrNull(command, args, options = {}) {
  try {
    return await output(command, args, options)
  } catch {
    return null
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'))
}

async function verifyRepository(version) {
  const branch = await output('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'main') fail(`Releases are cut from main; this checkout is on ${branch}.`)
  if (await output('git', ['status', '--porcelain'])) fail('The working tree has uncommitted changes; commit them first.')
  const manifest = await readJson('server/package.json')
  if (manifest.name !== PACKAGE) fail(`server/package.json is named ${manifest.name}, expected ${PACKAGE}.`)
  if (manifest.version !== version) fail(`server/package.json is version ${manifest.version}, not ${version}. Run: npm version -w server ${version} --no-git-tag-version`)
  await output(process.execPath, ['scripts/changelog-section.mjs', version])
  return await output('git', ['rev-parse', 'HEAD'])
}

async function publishedIntegrity(version) {
  return await outputOrNull('npm', ['view', `${PACKAGE}@${version}`, 'dist.integrity', '--registry', REGISTRY])
}

async function localTag(version) {
  return await outputOrNull('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}^{commit}`])
}

async function runGates(artifactDir) {
  await run('npm', ['run', 'lint'])
  await run('npm', ['run', 'check:dead-code'])
  await run('npm', ['run', 'typecheck:test'])
  await run('npm', ['run', 'test'])
  await rm(artifactDir, { recursive: true, force: true })
  await run('npm', ['run', 'test:pack-install', '--', '--artifact-dir', artifactDir])
}

async function testedTarball(artifactDir, version) {
  const name = `${PACKAGE}-${version}.tgz`
  const files = existsSync(artifactDir) ? await readdir(artifactDir) : []
  if (!files.includes(name)) fail(`The pack-and-install gate did not leave ${name} in ${artifactDir}.`)
  return join(artifactDir, name)
}

async function tarballIntegrity(path) {
  return `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`
}

async function readNpmToken() {
  const token = await outputOrNull('op', ['read', SECRET_REFERENCE])
  if (!token) fail(`Could not read ${SECRET_REFERENCE}. Sign in to the 1Password CLI (op whoami) and retry.`)
  if (!token.startsWith('npm_')) fail(`${SECRET_REFERENCE} does not hold a granular npm token (expected the npm_ prefix).`)
  return token
}

async function withNpmCredential(action) {
  const directory = await mkdtemp(join(tmpdir(), 'videobook-release-npm-'))
  const npmrc = join(directory, 'npmrc')
  try {
    const token = await readNpmToken()
    await writeFile(npmrc, `//registry.npmjs.org/:_authToken=${token}\nregistry=${REGISTRY}\n`, { mode: 0o600 })
    return await action(npmrc)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function npmAccount(npmrc) {
  const account = await outputOrNull('npm', ['whoami', '--userconfig', npmrc, '--registry', REGISTRY])
  if (!account) fail(`npm rejected the token from ${SECRET_REFERENCE}; see ~/apicity/RELEASE.md, "Rotating the npm publish token".`)
  return account
}

async function verifyNpmCredential() {
  const account = await withNpmCredential(npmAccount)
  log(`npm credential from ${SECRET_REFERENCE} authenticates as ${account}`)
}

async function publishTarball(tarball, dryRun) {
  await withNpmCredential(async (npmrc) => {
    log(`publishing as ${await npmAccount(npmrc)}`)
    const args = ['publish', tarball, '--access', 'public', '--tag', 'latest', '--userconfig', npmrc, '--registry', REGISTRY]
    await run('npm', dryRun ? [...args, '--dry-run'] : args)
  })
}

async function waitForRegistry(version, expected) {
  log('waiting for the registry; npm can take several minutes to process a publish')
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const integrity = await publishedIntegrity(version)
    if (integrity === expected) return
    if (integrity) fail(`The registry has ${PACKAGE}@${version} with integrity ${integrity}, not the tested ${expected}.`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
  }
  fail(`${PACKAGE}@${version} did not appear on the registry within 15 minutes. Rerun npm run release -- ${version} to finish once it does.`)
}

async function installFromRegistry(version) {
  const prefix = await mkdtemp(join(tmpdir(), 'videobook-release-install-'))
  try {
    await mkdir(join(prefix, 'lib', 'node_modules'), { recursive: true })
    await run('npm', ['install', '-g', `${PACKAGE}@${version}`, '--prefix', prefix, '--registry', REGISTRY, '--no-audit', '--no-fund', `--allow-scripts=${ALLOW_SCRIPTS}`])
    const reported = await output(join(prefix, 'bin', 'videobook'), ['--version'], { env: { ...process.env, VIDEOBOOK_HOME: join(prefix, 'home') } })
    if (!reported.startsWith(`videobook ${version} `)) fail(`The installed command reported "${reported}".`)
    log(`installed from npm: ${reported}`)
  } finally {
    await rm(prefix, { recursive: true, force: true })
  }
}

async function tagRelease(version, commit) {
  const tagged = await localTag(version)
  if (tagged === commit) return
  if (tagged) fail(`Tag v${version} already points at ${tagged}, not ${commit}.`)
  await run('git', ['tag', '-a', `v${version}`, '-m', `videobook ${version}`, commit])
}

async function pushRelease(version, tarball) {
  const notes = join(await mkdtemp(join(tmpdir(), 'videobook-release-notes-')), 'notes.md')
  await writeFile(notes, `${await output(process.execPath, ['scripts/changelog-section.mjs', version])}\n`)
  await run('git', ['push', 'origin', 'main'])
  await run('git', ['push', 'origin', `v${version}`])
  const assets = tarball && existsSync(tarball) ? [tarball] : []
  await run('gh', ['release', 'create', `v${version}`, ...assets, '--title', `videobook ${version}`, '--notes-file', notes])
}

function printNextSteps(version, pushed) {
  if (pushed) {
    log(`done: ${PACKAGE}@${version} is on npm, v${version} is pushed, and the GitHub release exists`)
    return
  }
  log(`done: ${PACKAGE}@${version} is on npm and tagged v${version} locally`)
  log(`to publish the tag and GitHub release: npm run release -- ${version} --push`)
}

async function recordedCommit(artifactDir, head) {
  const path = join(artifactDir, 'release-commit')
  if (!existsSync(path)) return head
  const recorded = (await readFile(path, 'utf8')).trim()
  if (await outputOrNull('git', ['merge-base', '--is-ancestor', recorded, head]) === null) {
    fail(`The tested tarball came from ${recorded}, which is not an ancestor of HEAD.`)
  }
  return recorded
}

async function finishPublishedRelease(options, head, artifactDir, published) {
  if (options.dryRun) fail(`${PACKAGE}@${options.version} is already published; there is nothing to dry-run.`)
  const tarball = join(artifactDir, `${PACKAGE}-${options.version}.tgz`)
  const tested = existsSync(tarball) ? await tarballIntegrity(tarball) : null
  const commit = tested === published ? await recordedCommit(artifactDir, head) : head
  const tagged = await localTag(options.version)
  if (tested !== published && !tagged) {
    fail(`${PACKAGE}@${options.version} is already on npm but matches neither a tested tarball nor a v${options.version} tag; bump the version instead.`)
  }
  log(`${PACKAGE}@${options.version} is already on npm (${published}); finishing the release`)
  await installFromRegistry(options.version)
  await tagRelease(options.version, tagged ?? commit)
  if (options.push) await pushRelease(options.version, tested === published ? tarball : null)
  printNextSteps(options.version, options.push)
}

async function release(options) {
  const commit = await verifyRepository(options.version)
  const artifactDir = join(root, '.artifacts', `release-${options.version}`)
  const published = await publishedIntegrity(options.version)
  if (published) {
    await finishPublishedRelease(options, commit, artifactDir, published)
    return
  }
  await verifyNpmCredential()
  await runGates(artifactDir)
  await writeFile(join(artifactDir, 'release-commit'), `${commit}\n`)
  const tarball = await testedTarball(artifactDir, options.version)
  const integrity = await tarballIntegrity(tarball)
  await publishTarball(tarball, options.dryRun)
  if (options.dryRun) {
    log(`dry run complete: ${tarball} (${integrity}) passed every gate and was not published`)
    return
  }
  await waitForRegistry(options.version, integrity)
  await installFromRegistry(options.version)
  await tagRelease(options.version, commit)
  if (options.push) await pushRelease(options.version, tarball)
  printNextSteps(options.version, options.push)
}

try {
  await release(parseOptions(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
