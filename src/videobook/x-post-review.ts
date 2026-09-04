export const X_POST_MAX_CHARACTERS = 280
export const X_POST_MAX_FOLLOWUPS = 25
export const X_POST_MAX_IMAGES_PER_FOLLOWUP = 4

const X_POST_SCHEDULE_LEAD_MS = 5_000
const X_POST_DEFAULT_DELAY_MS = 60 * 60 * 1_000
const X_POST_SCHEDULE_INTERVAL_MS = 5 * 60 * 1_000

type XPostOrientation = 'portrait' | 'landscape' | null

export type XPostFollowup = {
  text: string
  imageAssetIds: string[]
}

export type XPostDraft = {
  postText: string
  scheduledFor: string | null
  orientation: XPostOrientation
  followups: XPostFollowup[]
}

export type XPostDraftPatch = Partial<Omit<XPostDraft, 'followups'>>

function xPostFollowupsFromParams(value: unknown): XPostFollowup[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    const imageValues = item.image_asset_ids
    const hasImages = Array.isArray(imageValues)
    const imageAssetIds = hasImages
      ? imageValues.filter((id: unknown): id is string => typeof id === 'string')
      : []
    const hasText = typeof item.text === 'string'
    const text = hasText ? item.text as string : ''
    return hasText || hasImages ? [{ text, imageAssetIds }] : []
  })
}

export function xPostDraftFromParams(
  params: Record<string, unknown>,
): XPostDraft {
  const scheduledFor = Object.hasOwn(params, 'scheduled_for')
    ? typeof params.scheduled_for === 'string' ? params.scheduled_for : ''
    : null
  const orientation = params.orientation === 'portrait'
    || params.orientation === 'landscape'
    ? params.orientation
    : null
  return {
    postText: typeof params.text === 'string' ? params.text : '',
    scheduledFor,
    orientation,
    followups: xPostFollowupsFromParams(params.followups),
  }
}

export function reviseXPostParams(
  params: Record<string, unknown>,
  patch: XPostDraftPatch,
): Record<string, unknown> {
  const next = { ...params }
  if (patch.postText !== undefined) {
    if (patch.postText) next.text = patch.postText
    else delete next.text
  }
  if (patch.scheduledFor !== undefined) {
    if (patch.scheduledFor === null) delete next.scheduled_for
    else next.scheduled_for = patch.scheduledFor
  }
  if (patch.orientation !== undefined) {
    if (patch.orientation === null) delete next.orientation
    else next.orientation = patch.orientation
  }
  return next
}

export function reviseXPostFollowups(
  params: Record<string, unknown>,
  followups: readonly XPostFollowup[],
): Record<string, unknown> {
  const next = { ...params }
  if (followups.length === 0) {
    delete next.followups
    return next
  }
  next.followups = followups.map((followup) => ({
    text: followup.text,
    ...(followup.imageAssetIds.length > 0
      ? { image_asset_ids: followup.imageAssetIds }
      : {}),
  }))
  return next
}

const X_POST_TITLE_REQUIRED_MESSAGE = 'Add a title for the post.'

/**
 * Why the draft cannot post yet, or null. `maxCharacters` is the post length
 * the connected X account allows: 280, or 25,000 with an X Premium tier.
 */
export function xPostDraftError(
  draft: XPostDraft,
  nowMs = Date.now(),
  maxCharacters = X_POST_MAX_CHARACTERS,
): string | null {
  if (draft.postText.trim() === '') return X_POST_TITLE_REQUIRED_MESSAGE
  if (draft.postText.length > maxCharacters) {
    const overage = draft.postText.length - maxCharacters
    return `Title is ${overage} character${overage === 1 ? '' : 's'} too long.`
  }
  if (draft.followups.length > X_POST_MAX_FOLLOWUPS) {
    return `Thread has ${draft.followups.length} replies; X posts support at most ${X_POST_MAX_FOLLOWUPS} here.`
  }
  for (const [index, followup] of draft.followups.entries()) {
    if (!followup.text && followup.imageAssetIds.length === 0) {
      return `Follow-up ${index + 1} needs text or an image.`
    }
    if (followup.text.length > maxCharacters) {
      const overage = followup.text.length - maxCharacters
      return `Follow-up ${index + 1} is ${overage} character${overage === 1 ? '' : 's'} too long.`
    }
    if (followup.imageAssetIds.length > X_POST_MAX_IMAGES_PER_FOLLOWUP) {
      return `Follow-up ${index + 1} has more than ${X_POST_MAX_IMAGES_PER_FOLLOWUP} images.`
    }
  }
  if (draft.scheduledFor === null) return null
  const scheduledAt = Date.parse(draft.scheduledFor)
  if (!draft.scheduledFor || Number.isNaN(scheduledAt)) {
    return 'Choose a valid date and time.'
  }
  if (scheduledAt - nowMs <= X_POST_SCHEDULE_LEAD_MS) {
    return 'Scheduled time must be in the future.'
  }
  return null
}

export function xPostLocalDateTimeValue(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const twoDigits = (part: number) => part.toString().padStart(2, '0')
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`
    + `T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
}

export function xPostIsoDateTimeValue(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

export function defaultXPostScheduledFor(nowMs = Date.now()): string {
  const delayed = nowMs + X_POST_DEFAULT_DELAY_MS
  const rounded = Math.ceil(delayed / X_POST_SCHEDULE_INTERVAL_MS)
    * X_POST_SCHEDULE_INTERVAL_MS
  return new Date(rounded).toISOString()
}
