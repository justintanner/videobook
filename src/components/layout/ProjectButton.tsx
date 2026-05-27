import React from 'react'
import { FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ProjectButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  projectSlug: string | undefined
  assetCount?: number
}

export const ProjectButton = React.forwardRef<HTMLButtonElement, ProjectButtonProps>(
  ({ projectSlug, assetCount, className, ...props }, ref) => {
    const assetCountLabel = assetCount === 1 ? '1 asset' : `${assetCount ?? 0} assets`

    return (
      <button
        ref={ref}
        tabIndex={-1}
        className={cn(
          'group flex items-center gap-0 rounded overflow-hidden relative max-w-[48vw]',
          'h-8 border border-zinc-500/25 bg-zinc-500/10',
          'transition-all duration-300 cursor-pointer',
          'hover:border-zinc-500/40',
          'focus-visible:ring-2 focus-visible:ring-zinc-400/80 focus-visible:ring-offset-1 focus-visible:ring-offset-black focus-visible:outline-none',
          className
        )}
        {...props}
      >
        {/* Chevron zone */}
        <div className={cn(
          'flex items-center justify-center h-full px-2 transition-colors',
          'text-zinc-400/40 group-hover:text-zinc-400/60'
        )}>
          <span className={cn(
            'font-mono select-none transition-all text-sm',
            '-translate-y-1 group-hover:animate-pulse'
          )}>
            {'⌄'}
          </span>
        </div>

        {/* Path zone */}
        <div className={cn(
          'min-w-0 flex-1 flex items-center h-full px-2.5 gap-0',
          'bg-black/40 shadow-[inset_0_0_10px_rgba(161,161,170,0.05)]',
          'group-hover:bg-black/60 group-hover:shadow-[inset_0_0_10px_rgba(161,161,170,0.12)]',
          'transition-all'
        )}>
          <span className="font-mono font-bold text-xs tracking-widest text-zinc-400/40">
            projects
          </span>
          <span className="min-w-0 truncate font-mono font-bold text-xs tracking-widest text-zinc-400/70 group-hover:text-zinc-400/90 transition-colors">
            /{projectSlug}
          </span>
        </div>

        {assetCount !== undefined ? (
          <div
            className="hidden sm:flex items-center justify-center h-full border-l border-zinc-500/20 px-2 bg-zinc-950/35"
            title={assetCountLabel}
          >
            <span
              className={cn(
                'font-mono text-[10px] leading-none',
                assetCount === 0 ? 'text-amber-200/80' : 'text-zinc-400/70'
              )}
            >
              {assetCountLabel}
            </span>
          </div>
        ) : null}

        {/* Icon zone */}
        <div className="flex items-center justify-center h-full px-2 text-zinc-400/80 group-hover:text-zinc-400 transition-colors">
          <FolderOpen className="w-3.5 h-3.5" />
        </div>
      </button>
    )
  }
)

ProjectButton.displayName = 'ProjectButton'
