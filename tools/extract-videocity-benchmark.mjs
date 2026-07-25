import { createHash } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const mediaPattern = /^original\.(?:mp4|mov|mkv|webm|mp3|wav|m4a|weba|aac|flac|ogg|png|jpe?g|webp|gif|svg)$/i
const imagePattern = /^original\.(?:png|jpe?g|webp|gif)$/i
const jsonPattern = /\.json$/i
const sensitiveKeyPattern = /(?:api.?key|token|secret|authorization|cookie|password|credential)/i
const lineageKeys = [
  'source_asset',
  'source_asset_id',
  'source_assets',
  'source_audio',
  'source_audios',
  'source_image',
  'source_images',
  'source_video',
  'source_videos',
]

function argument(name) {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  if (index < 0 || !value || value.startsWith('--')) {
    throw new Error(`${name} is required`)
  }
  return value
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  return index >= 0 && value && !value.startsWith('--') ? value : null
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function sanitizeString(value) {
  return value
    .replace(/\b[A-Z]{2,12}-[A-Z0-9]{24,}\b/g, '[redacted-token]')
    .replace(/\b(?:sk|pk|key|token)[-_][A-Za-z0-9_-]{20,}\b/gi, '[redacted-token]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
}

function sanitize(value, key = '') {
  if (sensitiveKeyPattern.test(key)) return '[redacted]'
  if (typeof value === 'string') {
    if (value.startsWith('data:') || value.length > 200_000) {
      return {
        omitted: true,
        sha256: hash(value),
        originalLength: value.length,
      }
    }
    return sanitizeString(
      /^https?:\/\//i.test(value) ? sanitizeUrl(value) : value,
    )
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitize(childValue, childKey),
    ]),
  )
}

function metadataCategory(metadata) {
  const origin = typeof metadata.origin === 'string' ? metadata.origin : null
  if (typeof metadata.model === 'string') return 'generated'
  if (origin === 'upload') return 'uploaded'
  if (origin === 'download' || origin === 'external') return 'downloaded-external'
  if (origin) return 'derived'
  return 'unknown'
}

function stringValues(value) {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    typeof item === 'string' && item.trim() ? [item.trim()] : [])
}

function lineageReferences(metadata) {
  return lineageKeys.flatMap((key) =>
    stringValues(metadata[key]).map((reference) => ({ key, reference })))
}

function resolveReference(project, reference, projectAssetIds, globalAssetIds) {
  const normalized = reference.replace(/^@/, '')
  if (normalized.includes('/')) return normalized
  if (projectAssetIds.get(project)?.has(normalized)) {
    return `${project}/${normalized}`
  }
  const globalMatches = globalAssetIds.get(normalized) ?? []
  return globalMatches.length === 1 ? globalMatches[0] : null
}

function secondsRange(start, end, duration) {
  const boundedStart = Math.max(0, Number.isFinite(start) ? start : 0)
  const fallbackEnd = Number.isFinite(duration)
    ? Math.min(duration, boundedStart + 5)
    : boundedStart + 5
  const boundedEnd = Math.max(
    boundedStart + 0.001,
    Number.isFinite(end) ? end : fallbackEnd,
  )
  return { startSeconds: boundedStart, endSeconds: boundedEnd }
}

function candidateCase(caseId, className, query, judgment, evidence) {
  return {
    caseId,
    class: className,
    query,
    judgments: [judgment],
    evidence,
    reviewStatus: 'candidate',
  }
}

function sceneCases(sourceId, analysis, duration) {
  const scenes = Array.isArray(analysis.scenes) ? analysis.scenes : []
  return scenes.flatMap((scene, index) => {
    if (!scene || typeof scene !== 'object') return []
    const query = typeof scene.description === 'string'
      ? scene.description.trim()
      : ''
    const start = Number(scene.timestamp)
    if (!query || !Number.isFinite(start)) return []
    const next = scenes[index + 1]
    const nextStart = next && typeof next === 'object'
      ? Number(next.timestamp)
      : Number.NaN
    return [candidateCase(
      `visual-scene:${sourceId}:${index}`,
      'natural-language-visual',
      { text: query },
      {
        sourceId,
        range: secondsRange(start, nextStart, duration),
      },
      {
        source: 'original.analysis.scenes',
        tags: stringValues(scene.tags),
      },
    )]
  })
}

function stillVisualCases(sourceId, metadata, analysis, type) {
  if (type !== 'image') return []
  const query = [
    analysis.summary,
    metadata.prompt,
    analysis.text,
  ].find((value) => typeof value === 'string' && value.trim())
  if (typeof query !== 'string') return []
  return [candidateCase(
    `visual-still:${sourceId}`,
    'natural-language-visual',
    { text: query.trim() },
    { sourceId },
    { source: 'analysis-or-prompt' },
  )]
}

function ocrCases(sourceId, analysis, duration) {
  const values = stringValues(analysis.textOnScreen)
  return values.map((text, index) => candidateCase(
    `ocr:${sourceId}:${index}`,
    'quoted-speech-ocr',
    { text: `"${text}"`, modalities: ['ocr'] },
    {
      sourceId,
      range: secondsRange(0, duration, duration),
    },
    { source: 'original.analysis.textOnScreen' },
  ))
}

function transcriptCases(sourceId, transcript, filename) {
  const words = Array.isArray(transcript.words)
    ? transcript.words.filter((word) =>
        word
        && typeof word === 'object'
        && typeof word.text === 'string'
        && Number.isFinite(Number(word.start))
        && Number.isFinite(Number(word.end)))
    : []
  const cases = []
  for (let offset = 0; offset < words.length; offset += 12) {
    const group = words.slice(offset, offset + 12)
    const text = group.map((word) => word.text).join('').trim()
    if (text.split(/\s+/).length < 3) continue
    cases.push(candidateCase(
      `speech:${sourceId}:${basename(filename)}:${offset}`,
      'quoted-speech-ocr',
      { text: `"${text}"`, modalities: ['speech'] },
      {
        sourceId,
        range: secondsRange(
          Number(group[0].start),
          Number(group.at(-1).end),
          Number(transcript.audio_duration_secs),
        ),
      },
      {
        source: filename,
        language: transcript.language_code,
        speakerIds: [...new Set(group.flatMap((word) =>
          typeof word.speaker_id === 'string' ? [word.speaker_id] : []))],
      },
    ))
  }
  const segments = Array.isArray(transcript.segments) ? transcript.segments : []
  for (const [index, segment] of segments.entries()) {
    if (
      !segment
      || typeof segment !== 'object'
      || typeof segment.text !== 'string'
      || !Number.isFinite(Number(segment.start))
      || !Number.isFinite(Number(segment.end))
    ) continue
    cases.push(candidateCase(
      `speech-segment:${sourceId}:${basename(filename)}:${index}`,
      'quoted-speech-ocr',
      { text: `"${segment.text.trim()}"`, modalities: ['speech'] },
      {
        sourceId,
        range: secondsRange(Number(segment.start), Number(segment.end)),
      },
      {
        source: filename,
        language: transcript.targetLanguage ?? transcript.sourceLanguageCode,
      },
    ))
  }
  return cases
}

function lineageCases(sourceId, type, metadata, references) {
  const cases = []
  for (const [index, item] of references.entries()) {
    const range = Number.isFinite(Number(metadata.chunk_start))
      ? secondsRange(
          Number(metadata.chunk_start),
          Number(metadata.chunk_end),
          Number(metadata.duration),
        )
      : undefined
    if (type === 'video') {
      cases.push(candidateCase(
        `reverse-video-lineage:${sourceId}:${index}`,
        'reverse-video',
        { reference: { kind: 'video', sourceId } },
        {
          sourceId: item.resolvedSourceId ?? item.reference,
          ...(range ? { range } : {}),
        },
        {
          source: item.key,
          origin: metadata.origin,
          referenceResolved: item.resolvedSourceId !== null,
        },
      ))
    }
    if (type === 'audio') {
      cases.push(candidateCase(
        `audio-lineage:${sourceId}:${index}`,
        'audio',
        { reference: { kind: 'audio', sourceId } },
        {
          sourceId: item.resolvedSourceId ?? item.reference,
          ...(range ? { range } : {}),
        },
        {
          source: item.key,
          origin: metadata.origin,
          referenceResolved: item.resolvedSourceId !== null,
        },
      ))
    }
    if (type === 'image' || item.key.includes('image')) {
      cases.push(candidateCase(
        `reverse-image-lineage:${sourceId}:${index}`,
        'reverse-image-semantic',
        { reference: { kind: 'image', sourceId } },
        { sourceId: item.resolvedSourceId ?? item.reference },
        {
          source: item.key,
          origin: metadata.origin,
          referenceResolved: item.resolvedSourceId !== null,
        },
      ))
    }
  }
  return cases
}

function audioSelfCases(sourceId, type, metadata) {
  const duration = Number(metadata.duration)
  const hasAudio = type === 'audio' || metadata.hasAudio === true
  if (!hasAudio || !Number.isFinite(duration) || duration <= 0) return []
  const cases = []
  for (let start = 0; start < duration; start += 30) {
    const range = secondsRange(start, Math.min(duration, start + 10), duration)
    cases.push(candidateCase(
      `audio-self:${sourceId}:${start}`,
      'audio',
      { reference: { kind: 'audio', sourceId, range } },
      { sourceId, range },
      { source: 'exact-source-audio-window' },
    ))
  }
  return cases
}

async function parseJsonSidecars(vfs, project, asset, files, errors) {
  const sidecars = {}
  const transcripts = []
  for (const file of files) {
    if (!jsonPattern.test(file.name)) continue
    const read = await vfs.readFile(asset.id, file.name, project)
    if (!read.ok) {
      errors.push({
        sourceId: `${project}/${asset.id}`,
        file: file.name,
        error: read.error.message,
      })
      continue
    }
    try {
      const parsed = JSON.parse(read.value.toString('utf8'))
      const sanitized = sanitize(parsed)
      sidecars[file.name] = sanitized
      if (/^elevenlabs(?:\.[a-z-]+)?\.json$/i.test(file.name)) {
        transcripts.push({ filename: file.name, value: sanitized })
      }
    } catch (error) {
      errors.push({
        sourceId: `${project}/${asset.id}`,
        file: file.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { sidecars, transcripts }
}

async function imageHash(vfs, project, asset, files, errors) {
  const image = files.find((file) => imagePattern.test(file.name))
  if (!image) return null
  const read = await vfs.readFile(asset.id, image.name, project)
  if (!read.ok) {
    errors.push({
      sourceId: `${project}/${asset.id}`,
      file: image.name,
      error: read.error.message,
    })
    return null
  }
  return hash(read.value)
}

function caseCounts(cases) {
  const counts = {}
  for (const item of cases) counts[item.class] = (counts[item.class] ?? 0) + 1
  return counts
}

async function main() {
  const sourceRoot = argument('--source-root')
  const outputDir = argument('--output')
  const projectFilter = optionalArgument('--project')
  const projectsDir = join(sourceRoot, 'projects')
  const engineModule = pathToFileURL(join(
    sourceRoot,
    'node_modules',
    'videocity-engine',
    'dist',
    'index.js',
  )).href
  const { createFs } = await import(engineModule)
  await mkdir(outputDir, { recursive: false })
  const assetsFile = await open(join(outputDir, 'assets.jsonl'), 'wx')
  const casesFile = await open(join(outputDir, 'candidate-cases.jsonl'), 'wx')
  const lineageFile = await open(join(outputDir, 'lineage.jsonl'), 'wx')
  const errorsFile = await open(join(outputDir, 'errors.jsonl'), 'wx')
  const projectsFile = await open(join(outputDir, 'projects.jsonl'), 'wx')
  const historyFile = await open(join(outputDir, 'history.jsonl'), 'wx')
  const actionsFile = await open(join(outputDir, 'actions.jsonl'), 'wx')
  const promptsFile = await open(join(outputDir, 'prompts.jsonl'), 'wx')
  const chatFile = await open(join(outputDir, 'chat.jsonl'), 'wx')
  const jobsFile = await open(join(outputDir, 'jobs.jsonl'), 'wx')
  const vfs = createFs({ projectsDir })
  const availableProjects = await vfs.listProjects()
  const projects = projectFilter
    ? availableProjects.filter((project) => project.slug === projectFilter)
    : availableProjects
  if (projectFilter && projects.length === 0) {
    throw new Error(`Project not found: ${projectFilter}`)
  }
  const errors = []
  const cases = []
  const imageGroups = new Map()
  const inventoryParts = []
  const workflowParts = []
  const summary = {
    projectCount: projects.length,
    assetCount: 0,
    assetKinds: {},
    provenanceCategories: {},
    durationSeconds: 0,
    timedAssetCount: 0,
    mediaFileCount: 0,
    jsonSidecarCount: 0,
    transcriptDocumentCount: 0,
    transcriptWordCount: 0,
    visualAnalysisDocumentCount: 0,
    timedVisualSceneCount: 0,
    lineageEdgeCount: 0,
    resolvedLineageEdgeCount: 0,
    unresolvedLineageEdgeCount: 0,
    exactImageGroupCount: 0,
    historyCommitCount: 0,
    actionCount: 0,
    promptCount: 0,
    retainedPromptCount: 0,
    chatEntryCount: 0,
    jobCount: 0,
    generationErrorCount: 0,
    pendingTaskCount: 0,
  }
  try {
    const projectAssets = new Map()
    const projectAssetIds = new Map()
    const globalAssetIds = new Map()
    for (const project of projects) {
      const assets = await vfs.listAssets(project.slug)
      projectAssets.set(project.slug, assets)
      projectAssetIds.set(
        project.slug,
        new Set(assets.map((asset) => asset.id)),
      )
      for (const asset of assets) {
        const matches = globalAssetIds.get(asset.id) ?? []
        matches.push(`${project.slug}/${asset.id}`)
        globalAssetIds.set(asset.id, matches)
      }
    }
    for (const project of projects) {
      const assets = projectAssets.get(project.slug) ?? []
      const timelineResult = await vfs.readProjectMeta('timeline', project.slug)
      const history = await vfs.getHistory(project.slug, 100_000)
      const actions = await vfs.getActionLog({ limit: 100_000 }, project.slug)
      const chat = await vfs.readLog('chat', project.slug, { limit: 100_000 })
      const jobs = await vfs.queue.list(project.slug)
      const generationErrorsResult = await vfs.generationErrors.findAll(project.slug)
      const pendingTasksResult = await vfs.pendingTasks.findAll(project.slug)
      const assetWorkResult = await vfs.assetWork.list(project.slug)
      const surfaces = [
        'chat',
        'image_rewrite',
        'video_rewrite',
        'script_rewrite',
        'post',
        'image_generate',
        'video_generate',
      ]
      const prompts = []
      const promptCounts = {}
      for (const surface of surfaces) {
        const count = await vfs.countPromptHistory(surface, project.slug)
        if (count === 0) continue
        promptCounts[surface] = count
        prompts.push(...await vfs.listPromptHistory({
          surface,
          limit: Math.min(count, 1_000),
        }, project.slug))
      }
      const generationErrors = generationErrorsResult.ok
        ? generationErrorsResult.value
        : []
      const pendingTasks = pendingTasksResult.ok
        ? pendingTasksResult.value
        : []
      const assetWork = assetWorkResult.ok ? assetWorkResult.value : []
      for (const [kind, result] of [
        ['generation-errors', generationErrorsResult],
        ['pending-tasks', pendingTasksResult],
        ['asset-work', assetWorkResult],
      ]) {
        if (!result.ok) {
          errors.push({
            project: project.slug,
            workflow: kind,
            error: result.error.message,
          })
        }
      }
      const actionCounts = {}
      for (const action of actions) {
        actionCounts[action.action] = (actionCounts[action.action] ?? 0) + 1
      }
      const jobCounts = {}
      for (const job of jobs) {
        const key = `${job.type}:${job.state}`
        jobCounts[key] = (jobCounts[key] ?? 0) + 1
      }
      const projectRecord = sanitize({
        project: project.slug,
        createdAt: project.created,
        lastActivityAt: project.last_activity,
        timeline: timelineResult.ok ? timelineResult.value : null,
        assetCount: assets.length,
        historyCommitCount: history.length,
        historyRange: {
          newest: history[0]?.date ?? null,
          oldest: history.at(-1)?.date ?? null,
        },
        actionCounts,
        promptCounts,
        retainedPromptCount: prompts.length,
        chatEntryCount: chat.length,
        jobCounts,
        generationErrorCount: generationErrors.length,
        pendingTaskCount: pendingTasks.length,
        assetWork,
        generationErrors,
        pendingTasks,
      })
      const projectLine = JSON.stringify(projectRecord)
      await projectsFile.write(`${projectLine}\n`)
      workflowParts.push(projectLine)
      for (const [file, values, kind] of [
        [historyFile, history, 'history'],
        [actionsFile, actions, 'action'],
        [promptsFile, prompts, 'prompt'],
        [chatFile, chat, 'chat'],
        [jobsFile, jobs, 'job'],
      ]) {
        for (const value of values) {
          const line = JSON.stringify(sanitize({
            project: project.slug,
            kind,
            value,
          }))
          await file.write(`${line}\n`)
          workflowParts.push(line)
        }
      }
      summary.historyCommitCount += history.length
      summary.actionCount += actions.length
      summary.promptCount += Object.values(promptCounts)
        .reduce((total, count) => total + count, 0)
      summary.retainedPromptCount += prompts.length
      summary.chatEntryCount += chat.length
      summary.jobCount += jobs.length
      summary.generationErrorCount += generationErrors.length
      summary.pendingTaskCount += pendingTasks.length
      for (const asset of assets) {
        const sourceId = `${project.slug}/${asset.id}`
        const manifest = await vfs.getManifest(asset.id, project.slug, {
          includeDotfiles: true,
        })
        if (!manifest.ok) {
          errors.push({ sourceId, error: manifest.error.message })
          continue
        }
        const metadataResult = await vfs.readMetadata(
          asset.id,
          'original',
          project.slug,
        )
        const metadata = metadataResult.ok && metadataResult.value
          && typeof metadataResult.value === 'object'
          ? sanitize(metadataResult.value)
          : {}
        const files = manifest.value.files.map((file) => ({
          name: file.name,
          sizeBytes: file.size_bytes,
          mtimeMs: file.mtimeMs,
          extension: file.extension,
        }))
        const mediaFiles = files.filter((file) => mediaPattern.test(file.name))
        const parsed = await parseJsonSidecars(
          vfs,
          project.slug,
          asset,
          files,
          errors,
        )
        const visualAnalysis = parsed.sidecars['.original.analysis.json']
          ?? {}
        const simpleAnalysis = parsed.sidecars['.analysis.gpt4otrans.json']
          ?? {}
        const analysis = {
          ...(simpleAnalysis && typeof simpleAnalysis === 'object'
            ? simpleAnalysis
            : {}),
          ...(visualAnalysis && typeof visualAnalysis === 'object'
            ? visualAnalysis
            : {}),
        }
        const duration = Number(metadata.duration)
        const category = metadataCategory(metadata)
        const references = lineageReferences(metadata).map((reference) => ({
          ...reference,
          resolvedSourceId: resolveReference(
            project.slug,
            reference.reference,
            projectAssetIds,
            globalAssetIds,
          ),
        }))
        const originalImageHash = await imageHash(
          vfs,
          project.slug,
          asset,
          files,
          errors,
        )
        if (originalImageHash) {
          const group = imageGroups.get(originalImageHash) ?? []
          group.push(sourceId)
          imageGroups.set(originalImageHash, group)
        }
        const record = {
          sourceId,
          project: project.slug,
          assetId: asset.id,
          type: asset.type,
          createdAt: asset.created_at,
          sourcePath: asset.path,
          provenanceCategory: category,
          rightsStatus: 'unverified',
          metadata,
          files,
          mediaFiles,
          originalImageSha256: originalImageHash,
          lineage: references,
          sidecars: parsed.sidecars,
        }
        await assetsFile.write(`${JSON.stringify(record)}\n`)
        summary.assetCount += 1
        summary.assetKinds[asset.type] =
          (summary.assetKinds[asset.type] ?? 0) + 1
        summary.provenanceCategories[category] =
          (summary.provenanceCategories[category] ?? 0) + 1
        summary.mediaFileCount += mediaFiles.length
        summary.jsonSidecarCount += Object.keys(parsed.sidecars).length
        summary.lineageEdgeCount += references.length
        summary.resolvedLineageEdgeCount += references.filter(
          (reference) => reference.resolvedSourceId,
        ).length
        summary.unresolvedLineageEdgeCount += references.filter(
          (reference) => !reference.resolvedSourceId,
        ).length
        if (Number.isFinite(duration)) {
          summary.durationSeconds += duration
          summary.timedAssetCount += 1
        }
        if (
          visualAnalysis
          && typeof visualAnalysis === 'object'
          && Object.keys(visualAnalysis).length > 0
        ) {
          summary.visualAnalysisDocumentCount += 1
          summary.timedVisualSceneCount += Array.isArray(visualAnalysis.scenes)
            ? visualAnalysis.scenes.filter((scene) =>
                scene
                && typeof scene === 'object'
                && Number.isFinite(Number(scene.timestamp))).length
            : 0
        }
        for (const transcript of parsed.transcripts) {
          summary.transcriptDocumentCount += 1
          summary.transcriptWordCount += Array.isArray(transcript.value.words)
            ? transcript.value.words.length
            : 0
          cases.push(...transcriptCases(
            sourceId,
            transcript.value,
            transcript.filename,
          ))
        }
        cases.push(...sceneCases(sourceId, analysis, duration))
        cases.push(...stillVisualCases(
          sourceId,
          metadata,
          analysis,
          asset.type,
        ))
        cases.push(...ocrCases(sourceId, analysis, duration))
        cases.push(...lineageCases(
          sourceId,
          asset.type,
          metadata,
          references,
        ))
        cases.push(...audioSelfCases(sourceId, asset.type, metadata))
        for (const reference of references) {
          await lineageFile.write(`${JSON.stringify({
            from: sourceId,
            to: reference.resolvedSourceId,
            rawReference: reference.reference,
            relation: reference.key,
            origin: metadata.origin,
            resolved: reference.resolvedSourceId !== null,
          })}\n`)
        }
        inventoryParts.push(JSON.stringify({
          sourceId,
          type: asset.type,
          createdAt: asset.created_at,
          files,
        }))
      }
    }
    for (const [imageSha256, sourceIds] of imageGroups) {
      if (sourceIds.length < 2) continue
      summary.exactImageGroupCount += 1
      const querySourceId = sourceIds[0]
      for (const [index, sourceId] of sourceIds.slice(1).entries()) {
        cases.push(candidateCase(
          `reverse-image-exact:${imageSha256}:${index}`,
          'reverse-image-exact',
          { reference: { kind: 'image', sourceId: querySourceId } },
          { sourceId },
          { source: 'sha256-identical-original-image', imageSha256 },
        ))
      }
    }
    for (const item of cases) {
      await casesFile.write(`${JSON.stringify(item)}\n`)
    }
    for (const error of errors) {
      await errorsFile.write(`${JSON.stringify(error)}\n`)
    }
  } finally {
    await Promise.all([
      assetsFile.close(),
      casesFile.close(),
      lineageFile.close(),
      errorsFile.close(),
      projectsFile.close(),
      historyFile.close(),
      actionsFile.close(),
      promptsFile.close(),
      chatFile.close(),
      jobsFile.close(),
    ])
  }
  const counts = caseCounts(cases)
  const manifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    sourceRoot,
    projectsDir,
    projectFilter,
    outputDir,
    mediaCopied: false,
    sourceInventoryDigest: `sha256:${hash(inventoryParts.sort().join('\n'))}`,
    judgmentsDigest: `sha256:${hash(cases
      .map((item) => JSON.stringify(item))
      .sort()
      .join('\n'))}`,
    workflowDigest: `sha256:${hash(workflowParts.sort().join('\n'))}`,
    rights: {
      status: 'unverified',
      excludedFromReleaseGate: true,
    },
    summary: {
      ...summary,
      durationHours: summary.durationSeconds / 3_600,
      candidateCaseCount: cases.length,
      candidateCaseCounts: counts,
      extractionErrorCount: errors.length,
    },
    formalGate: {
      passed: false,
      reasons: [
        'Human relevance judgments have not been reviewed',
        'Rights attestation is missing',
        'The source inventory is below 50 hours',
        'The source inventory is below 1000 artifacts',
        'Candidate source IDs have not been mapped into a v5 benchmark book',
      ],
    },
    files: {
      assets: 'assets.jsonl',
      candidateCases: 'candidate-cases.jsonl',
      lineage: 'lineage.jsonl',
      errors: 'errors.jsonl',
      projects: 'projects.jsonl',
      history: 'history.jsonl',
      actions: 'actions.jsonl',
      prompts: 'prompts.jsonl',
      chat: 'chat.jsonl',
      jobs: 'jobs.jsonl',
    },
  }
  await writeFile(
    join(outputDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx' },
  )
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}

await main()
