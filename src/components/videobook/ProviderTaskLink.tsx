import { useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { providerStatusUrl, type ProviderTaskStatus } from '../../../server/src/provider-status-link'
import './ProviderTaskLink.css'

const TASK_ONLY_LABELS: Partial<Record<ProviderTaskStatus['provider'], string>> = {
  machgen: 'MachGen task',
  wavespeed: 'WaveSpeed prediction',
}

export function ProviderTaskLink({ task }: { task: ProviderTaskStatus }) {
  const [copied, setCopied] = useState<string | null>(null)
  const url = providerStatusUrl(task.provider, task.model)
  if (!url && (!TASK_ONLY_LABELS[task.provider] || !task.taskId)) return null
  const label = task.provider === 'fal' ? 'fal requests' : TASK_ONLY_LABELS[task.provider] ?? 'Kie logs'
  return (
    <div className="provider-task-link">
      {url
        ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            {label}<ExternalLink size={12} aria-hidden="true" />
          </a>
        )
        : <span>{label}</span>}
      {task.taskId && <>
        <code title={task.taskId}>{task.taskId}</code>
        <button type="button" aria-label="Copy provider request ID" title="Copy provider request ID"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(task.taskId!)
              setCopied(task.taskId)
            } catch {
              setCopied(null)
            }
          }}>
          {copied === task.taskId ? 'Copied' : <Copy size={12} aria-hidden="true" />}
        </button>
      </>}
    </div>
  )
}
