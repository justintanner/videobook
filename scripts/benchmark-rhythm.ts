import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { FFMPEG } from '../server/src/ffmpeg.js'
import { runRhythmWorker } from '../server/src/rhythm/run-worker.js'
import { scoreBeats } from '../server/src/rhythm/score.js'

const exec = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), 'videobook-rhythm-benchmark-'))
const results = []
try {
  const supplied = process.argv[2]
  const cases = supplied ? [0] : [67, 300, 1800]
  for (const duration of cases) {
    const file = supplied ?? join(directory, `pulse-${duration}.wav`)
    if (!supplied) await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=sin(2*PI*880*t)*lt(mod(t\\,0.5)\\,0.035):s=22050:d=${duration}`, '-c:a', 'pcm_s16le', file])
    const reference = supplied
      ? process.argv[3] ? (await readFile(process.argv[3], 'utf8')).split('\n').filter((line) => line.trim() && !line.startsWith('#')).map((line) => Number(line.trim().split(/\s+/u)[0])) : null
      : Array.from({ length: duration * 2 }, (_, index) => index / 2)
    let lag = 0
    let last = performance.now()
    const timer = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - last - 20); last = now }, 20)
    const start = performance.now()
    try {
      const result = await runRhythmWorker(FFMPEG, file, new AbortController().signal)
      results.push({ input: supplied ?? `${duration}s generated pulses`, seconds: (performance.now() - start) / 1000, parentMaxLagMs: lag,
        bpm: result.bpm, lowConfidence: result.lowConfidence, beats: result.beats.length, resources: result.resources,
        score: reference ? scoreBeats(reference, result.beats.map((beat) => beat.timeSeconds), 0.07) : null })
    } finally { clearInterval(timer) }
  }
  process.stdout.write(`${JSON.stringify({ platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model, node: process.version, results }, null, 2)}\n`)
} finally { await rm(directory, { recursive: true, force: true }) }
