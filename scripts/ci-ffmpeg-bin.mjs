import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureFfmpegBin } from './ci-install.mjs'

function run(cwd) {
  return (command, args, env) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

const root = process.env.VIDEOBOOK_CI_ROOT ?? fileURLToPath(new URL('..', import.meta.url))
const dest = process.env.VIDEOBOOK_CI_FFMPEG_DEST
if (!dest) {
  process.stderr.write('VIDEOBOOK_CI_FFMPEG_DEST is required\n')
  process.exit(1)
}

ensureFfmpegBin({ root, dest, env: process.env, run: run(root) }).then((resolved) => {
  process.stdout.write(`${resolved.path}\n`)
}).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
