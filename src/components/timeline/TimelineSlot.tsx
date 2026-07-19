import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { MoreHorizontal } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { SlotHourglass } from './SlotHourglass'
import { OsgBadge } from '@/components/sidebar/cards/badges'
import type { ClipState, OsgInfo } from '@/components/sidebar/types'

function parseTimestamp(url: string): number {
  const match = url.match(/(\d+\.\d+)\.jpg$/)
  return match ? parseFloat(match[1]) : 0
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function FrameThumb({ url, className }: { url: string; className?: string }) {
  const [hovered, setHovered] = useState(false)
  const thumbRef = useRef<HTMLDivElement>(null)
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (hovered && thumbRef.current) {
      const rect = thumbRef.current.getBoundingClientRect()
      setPopupPos({ x: rect.left + rect.width / 2, y: rect.top })
    } else {
      setPopupPos(null)
    }
  }, [hovered])

  return (
    <div
      ref={thumbRef}
      className={cn('relative min-w-0 overflow-hidden', className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <img
        src={url}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />
      {hovered && popupPos && createPortal(
        <div
          className="pointer-events-none"
          style={{
            position: 'fixed',
            left: popupPos.x,
            top: popupPos.y,
            transform: 'translate(-50%, -100%)',
            marginTop: -12,
            zIndex: 9999,
          }}
        >
          <img
            src={url}
            alt=""
            className="w-72 h-auto rounded-lg border-2 border-violet-500 shadow-[0_0_24px_rgba(0,255,255,0.5),0_0_48px_rgba(0,255,255,0.2),0_8px_32px_rgba(0,0,0,0.6)]"
          />
        </div>,
        document.body,
      )}
    </div>
  )
}

interface TimelineSlotProps {
  label: string
  isActive?: boolean
  isDragOver?: boolean
  hasContent?: boolean
  frameUrls?: string[]
  duration?: number
  assetId?: string
  renderStatus?: ClipState
  osg?: OsgInfo
  flex?: number
  onClick?: () => void
  onAnimateCommand?: (text: string) => void
}

function isRenderingStatus(status: ClipState | undefined): boolean {
  if (!status) return false
  return status.startsWith('render-queued') || status.startsWith('rendering')
}

export function TimelineSlot({
  label,
  isActive = false,
  isDragOver: isDragOverProp = false,
  hasContent = false,
  frameUrls,
  duration,
  assetId,
  renderStatus,
  osg,
  flex = 1,
  onClick,
  onAnimateCommand,
}: TimelineSlotProps) {
  const [isDragOverLocal, setIsDragOverLocal] = useState(false)
  const isDragOver = isDragOverProp || isDragOverLocal

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!onAnimateCommand) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOverLocal(true)
  }, [onAnimateCommand])

  const handleDragLeave = useCallback(() => {
    setIsDragOverLocal(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOverLocal(false)
    if (!onAnimateCommand) return
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'))
      if (!data?.id) return
      // Dropping an image onto a filled slot sets that clip's OSG overlay; any
      // other asset is assigned into the slot as before.
      const slotVideoId = assetId?.replace(/^@/, '')
      if (data.type === 'image' && hasContent && slotVideoId) {
        onAnimateCommand(`/osg @${slotVideoId} @${data.id}`)
      } else {
        onAnimateCommand(`/assign @${data.id} ${label}`)
      }
    } catch { /* ignore */ }
  }, [onAnimateCommand, label, assetId, hasContent])

  const hasMenu = !!onAnimateCommand
  const canClear = hasContent && hasMenu

  const handleMenuClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const target = e.currentTarget
    const x = e.clientX
    const y = e.clientY
    setTimeout(() => {
      target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y })
      )
    }, 0)
  }, [])

  const endFrames = useMemo(() => {
    if (!frameUrls || frameUrls.length === 0) return null
    const sorted = [...frameUrls].sort((a, b) => parseTimestamp(a) - parseTimestamp(b))
    return {
      first: sorted[0],
      last: sorted[sorted.length - 1],
    }
  }, [frameUrls])

  const isRendering = isRenderingStatus(renderStatus)
  const durationLabel = duration != null && duration > 0 ? formatDuration(duration) : null

  const slot = (
    <div
      className={cn(
        'relative h-full rounded cursor-pointer transition-all duration-150 group',
        isDragOver
          ? 'ring-2 ring-violet-500 shadow-[0_0_20px_rgba(0,255,255,0.2)]'
          : isActive
            ? 'ring-1 ring-violet-500'
            : hasContent
              ? 'border border-white/[0.08] hover:border-violet-500/30'
              : 'border border-dashed border-border/30 hover:border-border/50',
        hasContent && !isDragOver && !isRendering && 'cursor-grab active:cursor-grabbing',
        isRendering && 'clip-state-rendering',
      )}
      style={{ flex: `${flex} 1 0`, minWidth: '60px' }}
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Clipped inner content */}
      <div className="absolute inset-0 rounded overflow-hidden">
        {isRendering ? (
          <div className="absolute inset-0 bg-violet-500/5 flex items-center justify-center">
            <SlotHourglass />
          </div>
        ) : hasContent ? (
          <div className="absolute inset-0 bg-violet-500/5">
            {endFrames ? (
              endFrames.first === endFrames.last ? (
                <FrameThumb url={endFrames.first} className="absolute inset-0" />
              ) : (
                <div className="absolute inset-0 flex">
                  <FrameThumb url={endFrames.first} className="flex-1 h-full" />
                  <div className="w-px shrink-0 bg-black/40" />
                  <FrameThumb url={endFrames.last} className="flex-1 h-full" />
                </div>
              )
            ) : null}
            {/* Scrim so labels stay readable over frames */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/60 pointer-events-none" />
          </div>
        ) : (
          <div className="absolute inset-0 bg-card/10 flex items-center justify-center">
            <span className="text-[10px] font-mono text-muted-foreground/20 group-hover:text-muted-foreground/35 transition-colors select-none">
              empty
            </span>
          </div>
        )}
      </div>

      {/* Label — top-left slot tag */}
      <div className="absolute top-1 left-1.5 z-30">
        <span className={cn(
          'text-xs font-mono font-bold tracking-wide leading-none',
          hasContent || isRendering ? 'text-white/80 drop-shadow-md' : 'text-muted-foreground/35'
        )}>
          {label}
        </span>
      </div>

      {/* Duration — top-right, left of menu */}
      {durationLabel && !isRendering && (
        <div className="absolute top-1 right-6 z-30">
          <span className="text-[10px] font-mono tabular-nums text-white/55 drop-shadow-md leading-none">
            {durationLabel}
          </span>
        </div>
      )}

      {/* Menu button — top-right, hover-reveal */}
      <div className="absolute top-0.5 right-0.5 z-30">
        <button
          tabIndex={-1}
          className={cn(
            'w-5 h-5 flex items-center justify-center rounded transition-colors',
            'opacity-0 group-hover:opacity-100',
            hasContent
              ? 'text-white/50 hover:text-white hover:bg-white/10'
              : 'text-muted-foreground/40 hover:text-muted-foreground'
          )}
          onClick={handleMenuClick}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Asset ID — bottom-left */}
      {assetId && !isRendering && (
        <div className="absolute bottom-1 left-1.5 z-20 max-w-[calc(100%-12px)]">
          <span className="text-[9px] font-mono text-white/50 truncate block leading-tight drop-shadow-sm">
            {assetId}
          </span>
        </div>
      )}

      {/* OSG overlay badge — click opens the positioning overlay */}
      {osg && !isRendering && (
        <OsgBadge
          osg={osg}
          sizeClassName="w-6 h-6"
          onClick={() => {
            const slotVideoId = assetId?.replace(/^@/, '')
            if (slotVideoId && onAnimateCommand) onAnimateCommand(`/osg @${slotVideoId}`)
          }}
        />
      )}

      {/* Active indicator */}
      {isActive && (
        <div className="absolute bottom-0 inset-x-0 h-0.5 bg-violet-500 shadow-[0_0_8px_var(--clip-domain-video)]" />
      )}

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-violet-500/10 backdrop-blur-[1px] flex items-center justify-center z-40">
          <span className="text-xs font-mono text-violet-300 font-bold">drop</span>
        </div>
      )}
    </div>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{slot}</ContextMenuTrigger>
      {hasMenu && (
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => onAnimateCommand?.(`/insert-slot ${label} before`)}
            className="!flex flex-col !items-stretch gap-1.5 py-3 px-3 border-l-[3px] bg-white/[0.02] border-l-cyan-500/30 focus:!bg-white/[0.12] focus:!text-inherit focus:!border-l-[3px] focus:border-l-cyan-500/60"
          >
            <span className="text-sm font-semibold leading-none text-foreground">Insert Empty Slot Before</span>
            <span className="font-mono text-muted-foreground text-xs tracking-wider leading-none">/insert-slot {label} before</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => onAnimateCommand?.(`/insert-slot ${label} after`)}
            className="!flex flex-col !items-stretch gap-1.5 py-3 px-3 border-l-[3px] bg-white/[0.02] border-l-cyan-500/30 focus:!bg-white/[0.12] focus:!text-inherit focus:!border-l-[3px] focus:border-l-cyan-500/60"
          >
            <span className="text-sm font-semibold leading-none text-foreground">Insert Empty Slot After</span>
            <span className="font-mono text-muted-foreground text-xs tracking-wider leading-none">/insert-slot {label} after</span>
          </ContextMenuItem>
          {canClear && <ContextMenuSeparator />}
          {canClear && (
            <ContextMenuItem
              onSelect={() => onAnimateCommand?.(`/unassign ${label}`)}
              className="!flex flex-col !items-stretch gap-1.5 py-3 px-3 border-l-[3px] bg-white/[0.02] border-l-cyan-500/30 focus:!bg-white/[0.12] focus:!text-inherit focus:!border-l-[3px] focus:border-l-cyan-500/60"
            >
              <span className="text-sm font-semibold leading-none text-foreground">Clear Slot</span>
              <span className="font-mono text-muted-foreground text-xs tracking-wider leading-none">/unassign {label}</span>
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}
