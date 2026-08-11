import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MIN_MODEL_BYTES = 100 * 1024 * 1024
const REPO_URL = 'https://github.com/ServeurpersoCom/acestep.cpp'
const MODEL_BASE_URL = 'https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF/resolve/main'
const WINDOWS_PREBUILT_URL = 'https://www.serveurperso.com/temp/acestep.cpp-win64/'

// Core set for cover generation. The 5Hz LM gguf is intentionally excluded:
// cover mode takes its audio codes from the source audio and lyrics are passed
// verbatim, so ace-server never invokes the LM for this workflow.
const MODEL_FILES: string[] = [
  'Qwen3-Embedding-0.6B-Q8_0.gguf',
  'acestep-v15-turbo-Q4_K_M.gguf',
  'vae-BF16.gguf',
]

const args = new Set(process.argv.slice(2))
const modelsOnly = args.has('--models-only')
const binaryOnly = args.has('--binary-only')
const force = args.has('--force')

if (modelsOnly && binaryOnly) {
  console.error('Pass at most one of --models-only and --binary-only')
  process.exit(1)
}

const rootDir = join(homedir(), '.cache', 'videobook', 'acestep')
const srcDir = join(rootDir, 'src')
const binDir = join(rootDir, 'bin')
const modelsDir = process.env.VIDEOBOOK_ACESTEP_MODELS_DIR?.trim() || join(rootDir, 'models')
const serverName = process.platform === 'win32' ? 'ace-server.exe' : 'ace-server'
const serverDest = join(binDir, serverName)

function fail(message: string): never {
  console.error(`\n${message}`)
  process.exit(1)
}

function run(command: string, commandArgs: string[], cwd?: string): SpawnSyncReturns<Buffer> {
  console.log(`$ ${command} ${commandArgs.join(' ')}`)
  return spawnSync(command, commandArgs, { cwd, stdio: 'inherit' })
}

function requireCommand(command: string, hint: string): void {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' })
  if (result.error !== undefined || result.status !== 0) {
    fail(`Required command "${command}" is not available. ${hint}`)
  }
}

function findFileNamed(dir: string, name: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true })
  const matches: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) matches.push(fullPath)
    if (entry.isDirectory() && entry.name !== '.git') {
      const nested = findFileNamed(fullPath, name)
      if (nested !== null) matches.push(nested)
    }
  }
  if (matches.length === 0) return null
  matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return matches[0]
}

function installBinary(): void {
  if (process.platform === 'win32') {
    console.log('\nWindows: prebuilt ace-server binaries are published by upstream at:')
    console.log(`  ${WINDOWS_PREBUILT_URL}`)
    console.log(`Download ace-server.exe and set VIDEOBOOK_ACESTEP_SERVER_PATH to its location.`)
    return
  }

  if (existsSync(serverDest) && !force) {
    console.log(`Binary already installed at ${serverDest} (use --force to rebuild)`)
    return
  }

  requireCommand('git', 'Install git first.')
  requireCommand('cmake', 'Install cmake first (macOS: brew install cmake).')
  if (process.platform === 'darwin') {
    const xcode = spawnSync('xcode-select', ['-p'], { stdio: 'ignore' })
    if (xcode.error !== undefined || xcode.status !== 0) {
      fail('Xcode Command Line Tools are required. Run: xcode-select --install')
    }
  }

  mkdirSync(rootDir, { recursive: true })
  if (existsSync(join(srcDir, '.git'))) {
    const pull = run('git', ['-C', srcDir, 'pull', '--ff-only'])
    if (pull.status !== 0) {
      console.warn('git pull failed; building the currently checked-out revision')
    }
  } else {
    const clone = run('git', ['clone', '--recurse-submodules', REPO_URL, srcDir])
    if (clone.status !== 0) fail(`Failed to clone ${REPO_URL}`)
  }
  const submodules = run('git', ['-C', srcDir, 'submodule', 'update', '--init', '--recursive'])
  if (submodules.status !== 0) fail('Failed to initialize acestep.cpp git submodules')

  const build = run('bash', ['./buildcpu.sh'], srcDir)
  let built = build.status === 0 ? findFileNamed(srcDir, 'ace-server') : null
  if (built === null) {
    console.warn('buildcpu.sh did not produce ace-server; trying buildall.sh')
    const buildAll = run('bash', ['./buildall.sh'], srcDir)
    if (buildAll.status !== 0) fail('acestep.cpp build failed (buildcpu.sh and buildall.sh)')
    built = findFileNamed(srcDir, 'ace-server')
  }
  if (built === null) fail('Build completed but no ace-server binary was found in the source tree')

  mkdirSync(binDir, { recursive: true })
  copyFileSync(built, serverDest)
  chmodSync(serverDest, 0o755)

  const smoke = spawnSync(serverDest, ['--help'], { stdio: 'ignore' })
  if (smoke.error !== undefined) fail(`Installed binary failed to execute: ${String(smoke.error)}`)
  console.log(`Installed ace-server -> ${serverDest}`)
}

function downloadModel(fileName: string): void {
  const dest = join(modelsDir, fileName)
  if (existsSync(dest) && statSync(dest).size > MIN_MODEL_BYTES && !force) {
    console.log(`Model already present: ${fileName}`)
    return
  }
  const partial = `${dest}.partial`
  const url = `${MODEL_BASE_URL}/${fileName}`
  const download = run('curl', ['-L', '--fail', '-C', '-', '-o', partial, url])
  if (download.status !== 0) fail(`Failed to download ${url}`)
  renameSync(partial, dest)
  console.log(`Downloaded ${fileName} (${statSync(dest).size} bytes)`)
}

function installModels(): void {
  mkdirSync(modelsDir, { recursive: true })
  for (const fileName of MODEL_FILES) downloadModel(fileName)

  const missing = MODEL_FILES.filter((fileName) => {
    const dest = join(modelsDir, fileName)
    return !existsSync(dest) || statSync(dest).size <= MIN_MODEL_BYTES
  })
  if (missing.length > 0) fail(`Models missing or truncated in ${modelsDir}: ${missing.join(', ')}`)
}

if (!modelsOnly) installBinary()
if (!binaryOnly) installModels()

console.log('\nACE-Step install summary')
console.log(`  binary: ${existsSync(serverDest) ? serverDest : '(not installed)'}`)
console.log(`  models: ${modelsDir}`)
if (process.env.VIDEOBOOK_ACESTEP_MODELS_DIR?.trim()) {
  console.log(`  export VIDEOBOOK_ACESTEP_MODELS_DIR=${modelsDir}`)
}
console.log('ace-server launches automatically on the first /make-cover-song.')
