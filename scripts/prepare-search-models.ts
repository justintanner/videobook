import { parseArgs } from 'node:util'
import { LOCAL_CLAP_MANIFEST, LOCAL_CLIP_MANIFEST, LocalClapTemporalProvider, LocalClipTemporalProvider } from 'videobook-engine'
import { localModelConfiguration } from '../server/src/local-search-models.js'

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  download: { type: 'boolean', default: false },
  models: { type: 'string', default: 'all' },
  help: { type: 'boolean', default: false },
} })

if (values.help) {
  console.log('Usage: npm run prepare:search-models -- [--models visual|audio|all] [--download]')
  console.log('Checks cached models by default. --download explicitly permits downloading the pinned models from Hugging Face.')
} else {
  if (!['visual', 'audio', 'all'].includes(values.models)) throw new Error('Choose --models visual, audio, or all')
  const configuration = { ...localModelConfiguration(), allowModelDownload: values.download }
  console.log(`Search model cache: ${configuration.modelCacheDir}`)
  for (const model of ['visual', 'audio'] as const) {
    if (values.models !== 'all' && values.models !== model) continue
    const manifest = model === 'visual' ? LOCAL_CLIP_MANIFEST : LOCAL_CLAP_MANIFEST
    console.log(`${values.download ? 'Preparing' : 'Checking cached'} ${model}: ${manifest.modelId}@${manifest.modelRevision}`)
    const provider = model === 'visual' ? new LocalClipTemporalProvider(configuration) : new LocalClapTemporalProvider(configuration)
    try {
      await provider.prepare()
      console.log(`${model}: ready. Retry search or reindex affected media to populate semantic coverage.`)
    } catch (cause) {
      console.error(`${model}: not ready. ${cause instanceof Error ? cause.message : String(cause)}`)
      if (!values.download) console.error(`To download this model explicitly: npm run prepare:search-models -- --download --models ${model}`)
      process.exitCode = 1
    }
  }
}
