import {
  publishedPostPresentation,
  type PublishedPostPresentation,
} from '@/videobook/notebook-published-post'

function TweetLink({
  href,
  children,
}: {
  href: string
  children: string
}) {
  return (
    <a
      className="published-post-link nodrag nopan"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  )
}

function PublishedPostSummary({
  presentation,
}: {
  presentation: PublishedPostPresentation
}) {
  return (
    <>
      <span className="published-post-badge">{presentation.badge}</span>
      <TweetLink href={presentation.tweetUrl}>{presentation.tweetUrl}</TweetLink>
      <time dateTime={presentation.postedAt}>{presentation.postedAtLabel}</time>
      <span>{presentation.replyLabel}</span>
    </>
  )
}

export function PublishedPostTileChrome({
  inputs,
}: {
  inputs: Record<string, unknown> | undefined
}) {
  const presentation = publishedPostPresentation(inputs)
  if (!presentation) return null
  return (
    <div className="cell-published-post" role="group" aria-label={presentation.badge}>
      <PublishedPostSummary presentation={presentation} />
    </div>
  )
}

export function PublishedPostInspectorDetails({
  inputs,
}: {
  inputs: Record<string, unknown> | undefined
}) {
  const presentation = publishedPostPresentation(inputs)
  if (!presentation) return null
  return (
    <section className="inspector-published-post" aria-label={presentation.badge}>
      <span className="inspector-media-field-label">{presentation.badge}</span>
      <p>
        <span>Root</span>
        <TweetLink href={presentation.tweetUrl}>{presentation.tweetUrl}</TweetLink>
      </p>
      <p>
        <span>Posted</span>
        <time dateTime={presentation.postedAt}>{presentation.postedAtLabel}</time>
      </p>
      <p>
        <span>Replies</span>
        <span>{presentation.replyLabel}</span>
      </p>
      {presentation.replies.map((reply, index) => (
        <p key={reply.tweetId}>
          <span>Reply {index + 1}</span>
          <TweetLink href={reply.tweetUrl}>{reply.tweetUrl}</TweetLink>
        </p>
      ))}
      {presentation.followupError && (
        <p className="inspector-published-post-error">
          Follow-up {presentation.followupError.replyNumber} failed: {presentation.followupError.message}
        </p>
      )}
    </section>
  )
}
