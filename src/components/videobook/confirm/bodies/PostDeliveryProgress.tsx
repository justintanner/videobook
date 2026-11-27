import type { PostView } from '../../../../../server/src/posts/post-contract'
import { postDeliveryStages } from '@/videobook/post-delivery-review'

export function PostDeliveryProgress({ post }: { post: PostView }) {
  return (
    <ol className="post-progress" aria-label="Post progress">
      {postDeliveryStages(post).map(stage => (
        <li
          key={stage.id}
          className={`post-progress-step post-progress-${stage.state}`}
          aria-current={stage.state === 'current' ? 'step' : undefined}
        >
          <span className="post-progress-mark" aria-hidden="true" />
          {stage.label}
          {stage.state === 'done' && <span className="sr-only">, done</span>}
        </li>
      ))}
    </ol>
  )
}
