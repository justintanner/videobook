export const X_POST_MAX_CHARACTERS = 280

const X_POST_SCHEDULE_LEAD_MS = 5_000
const X_POST_DEFAULT_DELAY_MS = 60 * 60 * 1_000
const X_POST_SCHEDULE_INTERVAL_MS = 5 * 60 * 1_000

type XPostOrientation = 'portrait' | 'landscape' | null

export type XPostDraft = {
  postText: string
  scheduledFor: string | null
  orientation: XPostOrientation
}

export type XPostDraftPatch = Partial<XPostDraft>

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

export function xPostDraftError(
  draft: XPostDraft,
  nowMs = Date.now(),
): string | null {
  if (draft.postText.length > X_POST_MAX_CHARACTERS) {
    const overage = draft.postText.length - X_POST_MAX_CHARACTERS
    return `Message is ${overage} character${overage === 1 ? '' : 's'} too long.`
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
