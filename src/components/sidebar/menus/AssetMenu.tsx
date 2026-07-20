import { Fragment, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { UseMcpResult } from 'use-mcp/react'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import { EmptyState } from '@/components/ui/EmptyState'
import { DISABLED_STATE } from '@/components/ui/interaction-states'
import { supportsOnScreenGraphics, type ViewerSize } from '@/components/center-stage/viewer-types'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/useToast'

type MenuItemComponent = ComponentType<{ onSelect: () => void; children: ReactNode; className?: string; disabled?: boolean; title?: string }>

interface AssetMenuProps {
  slug: string
  filePath?: string
  itemType?: string
  prompt?: string | null
  onAnimateCommand?: (text: string) => void
  onAnimateEdit?: (text: string) => void
  onExtractSkeleton?: () => void
  onMarkSeen?: () => void
  onOpenProjectExport?: () => void
  /** Current viewer orientation; gates OSG/watermark actions off on `original`. */
  viewerSize?: ViewerSize
  MenuItem: MenuItemComponent
}

interface ProjectExportPickerProps {
  assetId: string | null
  projectSlug?: string
  projects?: { slug: string }[]
  callTool?: UseMcpResult['callTool']
  onClose: () => void
  onAfterExport?: (targetProject: string) => void
}

interface CommandAction {
  command: string
  title: string
  titleClassName?: string
  accentColor?: string
  onSelect: () => void
  className?: string
  disabled?: boolean
  /** Mouseover explanation shown while the action is disabled. */
  disabledReason?: string
}

interface CommandMenuItemProps extends CommandAction {
  MenuItem: MenuItemComponent
  showCommand?: boolean
}

const defaultAccentColor = 'border-l-cyan-500/30 focus:border-l-cyan-500/60'

function commandItemClassName(accentColor?: string, className?: string) {
  return cn(
    '!flex !items-center gap-3 py-2 px-2.5 border-l-[3px] bg-white/[0.02] focus:!bg-white/[0.12] focus:!text-inherit focus:!border-l-[3px]',
    accentColor ?? defaultAccentColor,
    className,
  )
}

function CommandMenuItem({
  command,
  title,
  titleClassName,
  accentColor,
  onSelect,
  MenuItem,
  className,
  showCommand = true,
  disabled,
  disabledReason,
}: CommandMenuItemProps) {
  return (
    <MenuItem
      onSelect={disabled ? () => {} : onSelect}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      className={commandItemClassName(accentColor, cn(className, disabled && DISABLED_STATE))}
    >
      <span className={cn('min-w-0 flex-1 truncate text-sm font-semibold leading-none', titleClassName ?? 'text-foreground')}>
        {title}
      </span>
      {showCommand && (
        <span className="max-w-[8rem] min-w-0 truncate font-mono text-[11px] leading-none tracking-wide text-muted-foreground">
          {command}
        </span>
      )}
    </MenuItem>
  )
}

function CommandActionList({ actions, MenuItem }: { actions: CommandAction[]; MenuItem: MenuItemComponent }) {
  return (
    <>
      {actions.map((action, index) => (
        <Fragment key={`${action.command}-${action.title}`}>
          {index > 0 && <ContextMenuSeparator />}
          <CommandMenuItem {...action} MenuItem={MenuItem} />
        </Fragment>
      ))}
    </>
  )
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
        return
      }
      reject(new Error('Failed to convert image'))
    }, 'image/png')
  })
}

async function copyImageToClipboard(filePath: string) {
  const imgUrl = filePath.replace(/\?.*$/, '')
  let objectUrl: string | undefined

  try {
    const response = await fetch(imgUrl)
    if (!response.ok) throw new Error('Failed to fetch image')

    const blob = await response.blob()
    objectUrl = URL.createObjectURL(blob)
    const img = await loadImage(objectUrl)
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight

    const context = canvas.getContext('2d')
    if (!context) throw new Error('Failed to prepare image')

    context.drawImage(img, 0, 0)
    const pngBlob = await canvasToPngBlob(canvas)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
    toast({ title: 'Copied', description: 'Image copied to clipboard', duration: 2000 })
  } catch {
    toast({ title: 'Error', description: 'Failed to copy image', duration: 3000 })
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

function copySlugToClipboard(slug: string) {
  void navigator.clipboard.writeText(slug)
  toast({ title: 'Copied', description: slug, duration: 2000 })
}

async function copyPromptToClipboard(prompt: string) {
  try {
    await navigator.clipboard.writeText(prompt)
    toast({ title: 'Copied', description: 'Prompt copied to clipboard', duration: 2000 })
  } catch {
    toast({ title: 'Error', description: 'Failed to copy prompt', duration: 3000 })
  }
}

export function ProjectExportPicker({
  assetId,
  projectSlug,
  projects,
  callTool,
  onClose,
  onAfterExport,
}: ProjectExportPickerProps) {
  const [exportingTarget, setExportingTarget] = useState<string | null>(null)
  const targetProjects = (projects ?? []).filter((p) => p.slug !== projectSlug)

  useEffect(() => {
    if (!assetId) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !exportingTarget) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [assetId, exportingTarget, onClose])

  if (!assetId) return null

  const exportToProject = async (target: string) => {
    if (!callTool || !projectSlug) return
    setExportingTarget(target)
    try {
      const result = await callTool('export_asset_to_project', {
        asset_id: assetId,
        project_slug: projectSlug,
        target_project: target,
      })
      const isError = (result as { isError?: boolean }).isError === true
      const content = (result.content ?? []) as Array<{ type: string; text: string }>
      const text = content[0]?.text ?? ''

      if (isError) {
        toast({ title: 'Export failed', description: text || 'Unknown error', duration: 4000 })
        return
      }

      const parsed = (() => {
        try {
          return JSON.parse(text) as { new_asset_id?: string }
        } catch {
          return null
        }
      })()

      toast({
        title: 'Exported',
        description: `${assetId} → ${target}${parsed?.new_asset_id ? ` (${parsed.new_asset_id})` : ''}`,
        duration: 3000,
      })
      onAfterExport?.(target)
      onClose()
    } catch (e: unknown) {
      toast({ title: 'Export failed', description: e instanceof Error ? e.message : String(e), duration: 4000 })
    } finally {
      setExportingTarget(null)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={() => { if (!exportingTarget) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Export to project"
        className="w-[360px] max-w-[92vw] overflow-hidden rounded border border-cyan-500/30 bg-zinc-950 shadow-[0_0_24px_rgba(34,211,238,0.18)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-cyan-500/15 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-cyan-300">Export to project</span>
          <span className="max-w-[11rem] min-w-0 truncate font-mono text-[10px] text-zinc-500">@{assetId}</span>
        </div>
        <div className="max-h-72 overflow-y-auto p-1.5">
          {targetProjects.length === 0 ? (
            <EmptyState className="px-3 py-4 text-left">No other projects</EmptyState>
          ) : targetProjects.map((project) => {
            const exporting = exportingTarget === project.slug
            return (
              <button
                key={project.slug}
                type="button"
                disabled={exportingTarget !== null}
                onClick={() => { void exportToProject(project.slug) }}
                className={cn(
                  'flex w-full items-center justify-between rounded px-3 py-2 text-left transition-colors',
                  'border-l-[3px] border-l-cyan-500/30 bg-white/[0.02] hover:bg-white/[0.08] focus:outline-none focus:ring-1 focus:ring-cyan-500/40',
                  exportingTarget !== null && !exporting && 'opacity-45',
                )}
              >
                <span className="min-w-0 truncate text-sm font-semibold text-zinc-100">{project.slug}</span>
                <span className="ml-3 shrink-0 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  {exporting ? 'Exporting' : 'Select'}
                </span>
              </button>
            )
          })}
        </div>
        <div className="flex justify-end border-t border-cyan-500/15 px-3 py-2">
          <button
            type="button"
            disabled={exportingTarget !== null}
            onClick={onClose}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.06] disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function AssetMenu({
  slug,
  filePath,
  itemType,
  prompt,
  onAnimateCommand,
  onAnimateEdit,
  onExtractSkeleton,
  onMarkSeen,
  onOpenProjectExport,
  viewerSize,
  MenuItem,
}: AssetMenuProps) {
  // OSG/watermark bake into the rendered orientations only — never `original`.
  const graphicsAllowed = supportsOnScreenGraphics(viewerSize ?? 'landscape')
  const imageActions: CommandAction[] = itemType === 'image'
    ? [
        {
          command: `/image ${slug}`,
          title: 'Generate Image',
          titleClassName: 'text-primary',
          accentColor: 'border-l-primary/50 focus:border-l-primary/80',
          onSelect: () => onAnimateCommand?.(`/image ${slug}`),
        },
        {
          command: `/video ${slug}`,
          title: 'Generate Video',
          titleClassName: 'text-violet-400',
          accentColor: 'border-l-violet-500/50 focus:border-l-violet-500/80',
          onSelect: () => onAnimateCommand?.(`/video ${slug}`),
        },
        {
          command: `/describe ${slug}`,
          title: 'Describe Image',
          titleClassName: 'text-emerald-400',
          accentColor: 'border-l-emerald-500/50 focus:border-l-emerald-500/80',
          onSelect: () => onAnimateCommand?.(`/describe ${slug}`),
        },

        ...(onExtractSkeleton
          ? [{
              command: `extract pose ${slug}`,
              title: 'Extract Pose Skeleton',
              titleClassName: 'text-amber-400',
              accentColor: 'border-l-amber-500/50 focus:border-l-amber-500/80',
              onSelect: onExtractSkeleton,
            }]
          : []),
      ]
    : []

  const videoActions: CommandAction[] = itemType === 'video'
    ? [
        {
          command: `/video ${slug}`,
          title: 'Extend Video',
          titleClassName: 'text-violet-400',
          accentColor: 'border-l-violet-500/50 focus:border-l-violet-500/80',
          onSelect: () => onAnimateCommand?.(`/video ${slug}`),
        },
        {
          command: `/split ${slug}`,
          title: 'Split Video',
          titleClassName: 'text-violet-400',
          accentColor: 'border-l-violet-500/50 focus:border-l-violet-500/80',
          onSelect: () => onAnimateCommand?.(`/split ${slug}`),
        },
        {
          command: `/extract-first-frame ${slug}`,
          title: 'Extract First Frame',
          titleClassName: 'text-primary',
          accentColor: 'border-l-primary/50 focus:border-l-primary/80',
          onSelect: () => onAnimateCommand?.(`/extract-first-frame ${slug}`),
        },
        {
          command: `/extract-last-frame ${slug}`,
          title: 'Extract Last Frame',
          titleClassName: 'text-primary',
          accentColor: 'border-l-primary/50 focus:border-l-primary/80',
          onSelect: () => onAnimateCommand?.(`/extract-last-frame ${slug}`),
        },
        {
          command: `/extract-audio ${slug}`,
          title: 'Extract Audio',
          titleClassName: 'text-emerald-400',
          accentColor: 'border-l-emerald-500/50 focus:border-l-emerald-500/80',
          onSelect: () => onAnimateCommand?.(`/extract-audio ${slug}`),
        },
        {
          command: `/archive ${slug}`,
          title: 'Archive Clip',
          titleClassName: 'text-amber-400',
          accentColor: 'border-l-amber-500/50 focus:border-l-amber-500/80',
          onSelect: () => onAnimateCommand?.(`/archive ${slug}`),
        },
        {
          command: `/splice ${slug} ...`,
          title: 'Splice with...',
          titleClassName: 'text-amber-400',
          accentColor: 'border-l-amber-500/50 focus:border-l-amber-500/80',
          onSelect: () => onAnimateEdit?.(`/splice ${slug} `),
        },
        {
          command: `/watermark ${slug}`,
          title: 'Watermark…',
          onSelect: () => onAnimateCommand?.(`/watermark ${slug}`),
          disabled: !graphicsAllowed,
          disabledReason: 'Switch to landscape, portrait, or square to add a watermark',
        },
      ]
    : []

  const copyActions: CommandAction[] = [
    {
      command: '/copy',
      title: 'Copy Slug',
      onSelect: () => copySlugToClipboard(slug),
    },
    ...((itemType === 'video' || itemType === 'image') && prompt
      ? [{
          command: '/copy-prompt',
          title: 'Copy Prompt',
          onSelect: () => { void copyPromptToClipboard(prompt) },
        }]
      : []),
    ...((itemType === 'image' || itemType === 'character') && filePath
      ? [{
          command: '/copy-image',
          title: 'Copy Image',
          onSelect: () => { void copyImageToClipboard(filePath) },
        }]
      : []),
    ...(itemType === 'video'
      ? [{
          command: `/copy-video ${slug}`,
          title: 'Copy Video',
          onSelect: () => onAnimateCommand?.(`/copy-video ${slug}`),
        }]
      : []),
  ]

  const exportActions: CommandAction[] = itemType === 'video' || itemType === 'image'
    ? [
        {
          command: `/export ${slug}`,
          title: 'Export to Downloads',
          onSelect: () => onAnimateCommand?.(`/export ${slug}`),
        },
        ...(onOpenProjectExport
          ? [{
              command: `/export-to-project ${slug}`,
              title: 'Export to Project',
              onSelect: onOpenProjectExport,
            }]
          : []),
      ]
    : []

  const fileActions: CommandAction[] = [
    {
      command: '/folder',
      title: 'Show in Folder',
      onSelect: () => onAnimateCommand?.(`/folder ${slug}`),
    },
    {
      command: `/duplicate ${slug}`,
      title: 'Duplicate',
      onSelect: () => onAnimateCommand?.(`/duplicate ${slug}`),
    },
    {
      command: `/rename ${slug}`,
      title: 'Rename',
      onSelect: () => onAnimateEdit?.(`/rename ${slug} `),
    },
    {
      command: `/doctor ${slug} fix`,
      title: 'Fix (Doctor)',
      titleClassName: 'text-emerald-400',
      accentColor: 'border-l-emerald-500/50 focus:border-l-emerald-500/80',
      onSelect: () => onAnimateCommand?.(`/doctor ${slug} fix`),
    },
  ]

  const hasImageActions = imageActions.length > 0
  const hasVideoActions = videoActions.length > 0
  const hasExportActions = exportActions.length > 0

  return (
    <>
      {onMarkSeen && (
        <>
          <CommandMenuItem
            command="/mark-seen"
            title="Mark Seen"
            titleClassName="text-primary"
            accentColor="border-l-primary/50 focus:border-l-primary/80"
            onSelect={onMarkSeen}
            MenuItem={MenuItem}
          />
          <ContextMenuSeparator />
        </>
      )}
      {hasImageActions && (
        <>
          <CommandActionList actions={imageActions} MenuItem={MenuItem} />
          <ContextMenuSeparator />
        </>
      )}
      {hasVideoActions && (
        <>
          <CommandActionList actions={videoActions} MenuItem={MenuItem} />
          <ContextMenuSeparator />
        </>
      )}
      <CommandActionList actions={copyActions} MenuItem={MenuItem} />
      {hasExportActions && (
        <>
          <ContextMenuSeparator />
          <CommandActionList actions={exportActions} MenuItem={MenuItem} />
        </>
      )}
      <ContextMenuSeparator />
      <CommandActionList actions={fileActions} MenuItem={MenuItem} />
      <ContextMenuSeparator />
      <CommandMenuItem
        command={`/delete ${slug}`}
        title="Delete"
        titleClassName="text-red-400"
        accentColor="border-l-red-500/50 focus:border-l-red-500/80"
        onSelect={() => onAnimateCommand?.(`/delete ${slug}`)}
        MenuItem={MenuItem}
      />
    </>
  )
}
