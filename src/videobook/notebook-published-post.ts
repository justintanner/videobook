import { nonEmptyStringValue, recordValue } from './value-decoders'

export const PUBLISHED_POST_SOURCE_OPERATION = 'post_to_x'

export function isPublishedPostCell(
  cell: { inputs?: Record<string, unknown> } | null | undefined,
): boolean {
  return cell?.inputs?.sourceOperation === PUBLISHED_POST_SOURCE_OPERATION
}

export type PublishedPostReply = {
  tweetId: string
  tweetUrl: string
}

export type PublishedPostFollowupError = {
  replyNumber: number
  message: string
}

export type PublishedPostPresentation = {
  badge: 'Posted to X'
  tweetId: string
  tweetUrl: string
  postedAt: string
  postedAtLabel: string
  replyCount: number
  replyLabel: string
  replies: PublishedPostReply[]
  status: 'posted' | 'partially_posted'
  followupError: PublishedPostFollowupError | null
}

export function publishedPostSubtitle(): string {
  return 'X · POSTED'
}

export function formatPublishedPostTime(iso: string): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return iso
  return new Date(parsed).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

function publishedPostReply(value: unknown): PublishedPostReply | null {
  const record = recordValue(value)
  if (!record) return null
  const tweetId = nonEmptyStringValue(record.tweetId ?? record.tweet_id)
  const tweetUrl = nonEmptyStringValue(record.tweetUrl ?? record.tweet_url)
  if (!tweetId || !tweetUrl) return null
  return { tweetId, tweetUrl }
}

function publishedPostFollowupError(
  value: unknown,
): PublishedPostFollowupError | null {
  const record = recordValue(value)
  if (!record) return null
  const replyNumber = typeof record.replyNumber === 'number'
    ? record.replyNumber
    : typeof record.reply_number === 'number'
      ? record.reply_number
      : null
  const message = nonEmptyStringValue(record.message)
  if (replyNumber === null || !message) return null
  return { replyNumber, message }
}

export function publishedPostPresentation(
  inputs: Record<string, unknown> | undefined,
): PublishedPostPresentation | null {
  if (inputs?.sourceOperation !== PUBLISHED_POST_SOURCE_OPERATION) return null
  const tweetId = nonEmptyStringValue(inputs.tweetId ?? inputs.tweet_id)
  const tweetUrl = nonEmptyStringValue(inputs.tweetUrl ?? inputs.tweet_url)
  const postedAt = nonEmptyStringValue(inputs.postedAt ?? inputs.posted_at)
  if (!tweetId || !tweetUrl || !postedAt) return null
  const replies = Array.isArray(inputs.replies)
    ? inputs.replies.flatMap((reply) => {
      const parsed = publishedPostReply(reply)
      return parsed ? [parsed] : []
    })
    : []
  const status = inputs.status === 'partially_posted' ? 'partially_posted' : 'posted'
  return {
    badge: 'Posted to X',
    tweetId,
    tweetUrl,
    postedAt,
    postedAtLabel: formatPublishedPostTime(postedAt),
    replyCount: replies.length,
    replyLabel: replies.length === 1 ? '1 reply' : `${replies.length} replies`,
    replies,
    status,
    followupError: publishedPostFollowupError(inputs.followupError ?? inputs.followup_error),
  }
}
