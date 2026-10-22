import type { ConfirmValidation } from './confirm-validation'
import { mediaCellHasSpokenAudio } from './media-insights'

const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu

export interface TranscribeAssetRef {
  artifactId: string
  type: string
  label: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  duration: number | null
}

export interface TranscribeCellRef {
  outputArtifactId?: string | null
  type: string
}

export interface TranscribePreviewRef {
  assetId: string
  type: string
}

export interface TranscribeClipChoice {
  artifactId: string
  label: string
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  duration: number | null
}

export type TranscribeResolveResult =
  | { ok: true; assetId: string | null }
  | { ok: false; message: string }

export function isTranscribeLanguageCode(value: string): boolean {
  return LANGUAGE_CODE.test(value.trim())
}

export function transcribeLanguageOverride(value: string):
  | { ok: true; languageCode: string }
  | { ok: false; message: string } {
  const languageCode = value.trim()
  if (!isTranscribeLanguageCode(languageCode)) {
    return {
      ok: false,
      message: 'A quick prompt can only set a language code on a pending transcription, for example /apply en.',
    }
  }
  return { ok: true, languageCode }
}

export function transcribeValidation(input: {
  assetId: string | null
  languageCode: string
}): ConfirmValidation {
  if (!input.assetId) {
    return { blocking: 'Choose a video or audio clip.', notice: null }
  }
  if (input.languageCode.trim() && !isTranscribeLanguageCode(input.languageCode)) {
    return {
      blocking: 'Language must be a code such as en or pt-br, or left blank to auto-detect.',
      notice: null,
    }
  }
  return { blocking: null, notice: null }
}

export function transcribeToolArgs(input: {
  bookId: string
  assetId: string
  languageCode: string
  diarize: boolean
  tagAudioEvents: boolean
}): Record<string, unknown> {
  const languageCode = input.languageCode.trim()
  return {
    book_id: input.bookId,
    asset_id: input.assetId,
    diarize: input.diarize,
    tag_audio_events: input.tagAudioEvents,
    wait: false,
    ...(languageCode ? { language_code: languageCode } : {}),
  }
}

export function transcribeEstimateView(estimate: Record<string, unknown> | null): {
  usd: number | null
  unavailable: boolean
} {
  const warnings = Array.isArray(estimate?.warnings)
    ? estimate.warnings.filter((warning): warning is string => typeof warning === 'string')
    : []
  const usd = typeof estimate?.usd === 'number' ? estimate.usd : null
  const historical = warnings.length > 0 && warnings.every((warning) =>
    warning.includes('historical average per call'))
  const unavailable = usd === null || (warnings.length > 0 && !historical)
  return { usd: unavailable ? null : usd, unavailable }
}

function transcribeLabel(
  asset: TranscribeAssetRef,
  addressByArtifactId: ReadonlyMap<string, string>,
): string {
  const address = addressByArtifactId.get(asset.artifactId)
  return address ? `@${address}` : asset.label || asset.artifactId
}

function findTranscribeAsset(
  reference: string,
  assets: readonly TranscribeAssetRef[],
  addressByArtifactId: ReadonlyMap<string, string>,
): TranscribeAssetRef | undefined {
  const direct = assets.find((asset) => asset.artifactId === reference)
  if (direct) return direct
  const lowered = reference.toLowerCase()
  for (const [artifactId, address] of addressByArtifactId) {
    if (address.toLowerCase() !== lowered) continue
    return assets.find((asset) => asset.artifactId === artifactId)
  }
  return assets.find((asset) => asset.label.toLowerCase() === lowered)
}

export function resolveTranscribeTarget(input: {
  assetRef?: string | null
  selectedCell: TranscribeCellRef | null
  preview: TranscribePreviewRef | null
  assets: readonly TranscribeAssetRef[]
  addressByArtifactId: ReadonlyMap<string, string>
}): TranscribeResolveResult {
  const raw = input.assetRef?.trim() ?? ''
  const explicit = raw.replace(/^@/, '')
  if (explicit) {
    const asset = findTranscribeAsset(explicit, input.assets, input.addressByArtifactId)
    if (!asset) return { ok: false, message: `No asset found for ${raw}` }
    if (!mediaCellHasSpokenAudio(asset.type)) {
      return {
        ok: false,
        message: `Transcribe applies to video or audio; ${transcribeLabel(asset, input.addressByArtifactId)} is ${asset.type}`,
      }
    }
    return { ok: true, assetId: asset.artifactId }
  }
  const selectedId = input.selectedCell?.outputArtifactId ?? null
  if (selectedId && mediaCellHasSpokenAudio(input.selectedCell?.type ?? '')) {
    const selected = input.assets.find((asset) => asset.artifactId === selectedId)
    if (selected && mediaCellHasSpokenAudio(selected.type)) {
      return { ok: true, assetId: selected.artifactId }
    }
  }
  if (input.preview && mediaCellHasSpokenAudio(input.preview.type)) {
    const preview = input.assets.find((asset) => asset.artifactId === input.preview?.assetId)
    if (preview && mediaCellHasSpokenAudio(preview.type)) {
      return { ok: true, assetId: preview.artifactId }
    }
  }
  return { ok: true, assetId: null }
}

export function transcribeClipChoices(
  assets: readonly TranscribeAssetRef[],
  addressByArtifactId: ReadonlyMap<string, string>,
): TranscribeClipChoice[] {
  return assets
    .filter((asset) => mediaCellHasSpokenAudio(asset.type))
    .map((asset) => ({
      artifactId: asset.artifactId,
      label: transcribeLabel(asset, addressByArtifactId),
      type: asset.type,
      mediaUrl: asset.mediaUrl,
      thumbnailUrl: asset.thumbnailUrl,
      duration: asset.duration,
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
}
