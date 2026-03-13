import { FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ProjectButtonProps {
  projectSlug: string | undefined
}

export function ProjectButton({ projectSlug }: ProjectButtonProps) {
  return (
    <button
      className={cn(
        'group flex items-center gap-0 rounded overflow-hidden relative',
        'h-8 border border-primary/25 bg-cyan-500/10',
        'transition-all duration-300 cursor-pointer',
        'hover:border-primary/40',
        'focus-visible:ring-2 focus-visible:ring-cyan-400/80 focus-visible:ring-offset-1 focus-visible:ring-offset-black focus-visible:outline-none'
      )}
    >
      {/* Chevron zone */}
      <div className={cn(
        'flex items-center justify-center h-full px-2 transition-colors',
        'text-primary/40 group-hover:text-primary/60'
      )}>
        <span className={cn(
          'font-mono select-none transition-all text-sm',
          '-translate-y-1 group-hover:animate-pulse'
        )}>
          {'\u2304'}
        </span>
      </div>

      {/* Path zone */}
      <div className={cn(
        'flex-1 flex items-center h-full px-2.5 gap-0',
        'bg-black/40 shadow-[inset_0_0_10px_rgba(0,255,255,0.05)]',
        'group-hover:bg-black/60 group-hover:shadow-[inset_0_0_10px_rgba(0,255,255,0.12)]',
        'transition-all'
      )}>
        <span className="font-mono font-bold text-xs tracking-widest text-primary/40">
          projects/
        </span>
        <span className="font-mono font-bold text-xs tracking-widest text-primary/70 group-hover:text-primary/90 transition-colors">
          {projectSlug}
        </span>
      </div>

      {/* Icon zone */}
      <div className="flex items-center justify-center h-full px-2 text-primary/80 group-hover:text-primary transition-colors">
        <FolderOpen className="w-3.5 h-3.5" />
      </div>
    </button>
  )
}
