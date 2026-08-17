import { Activity } from 'lucide-react'

export function BusyIndicator({ size = 16 }: { size?: number }) {
  return (
    <span className="busy-indicator" aria-hidden="true">
      <Activity size={size} />
    </span>
  )
}
