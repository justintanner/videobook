import { Fragment, type ComponentType, type ReactNode } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/useToast'

type MenuItemComponent = ComponentType<{ onSelect: () => void; children: ReactNode; className?: string }>

interface AssetMenuProps {
  slug: string
  filePath?: string
  itemType?: string
  onAnimateCommand?: (text: string) => void
  onAnimateEdit?: (text: string) => void
  onExtractSkeleton?: () => void
  onMarkSeen?: () => void
  projectSlug?: string
  projects?: { slug: string }[]
  callTool?: UseMcpResult['callTool']
  onAfterExport?: (targetProject: string) => void
  MenuItem: MenuItemComponent
}

interface CommandAction {
  command: string
  title: string
  titleClassName?: string
  accentColor?: string
  onSelect: () => void
  className?: string
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
}: CommandMenuItemProps) {
  return (
    <MenuItem onSelect={onSelect} className={commandItemClassName(accentColor, className)}>
      <span className={cn('min-w-0 flex-1 truncate text-sm font-semibold leading-none', titleClassName ?? 'text-foreground')}>
        {title}
      </span>
      {showCommand && (
        <span className="max-w-[8rem] truncate font-mono text-[11px] leading-none tracking-wide text-muted-foreground">
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

export function AssetMenu({
  slug,
  filePath,
  itemType,
  onAnimateCommand,
  onAnimateEdit,
  onExtractSkeleton,
  onMarkSeen,
  projectSlug,
  projects,
  callTool,
  onAfterExport,
  MenuItem,
}: AssetMenuProps) {
  const targetProjects = (projects ?? []).filter((p) => p.slug !== projectSlug)
  const canExportToProject = !!projectSlug && !!callTool && targetProjects.length > 0

  const exportToProject = async (target: string) => {
    if (!callTool || !projectSlug) return
    const assetId = slug.replace(/^@/, '')

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
    } catch (e: unknown) {
      toast({ title: 'Export failed', description: e instanceof Error ? e.message : String(e), duration: 4000 })
    }
  }

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
        {
          command: `/character ${slug}`,
          title: 'Character',
          titleClassName: 'text-violet-300',
          accentColor: 'border-l-violet-400/50 focus:border-l-violet-400/80',
          onSelect: () => onAnimateCommand?.(`/character ${slug}`),
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
          command: `/trim ${slug}`,
          title: 'Trim Video',
          onSelect: () => onAnimateCommand?.(`/trim ${slug}`),
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
          command: `/splice ${slug} ...`,
          title: 'Splice with...',
          titleClassName: 'text-amber-400',
          accentColor: 'border-l-amber-500/50 focus:border-l-amber-500/80',
          onSelect: () => onAnimateEdit?.(`/splice ${slug} `),
        },
        {
          command: `/watermark ${slug}`,
          title: 'Watermark (last 2s)',
          onSelect: () => onAnimateCommand?.(`/watermark ${slug}`),
        },
      ]
    : []

  const copyActions: CommandAction[] = [
    {
      command: '/copy',
      title: 'Copy Slug',
      onSelect: () => copySlugToClipboard(slug),
    },
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
      ]
    : []

  const projectExportActions: CommandAction[] = canExportToProject
    ? targetProjects.map((p) => ({
        command: `/export-to-project ${slug} ${p.slug}`,
        title: `Export to ${p.slug}`,
        onSelect: () => { void exportToProject(p.slug) },
      }))
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
  ]

  const hasImageActions = imageActions.length > 0
  const hasVideoActions = videoActions.length > 0
  const combinedExportActions = [...exportActions, ...projectExportActions]
  const hasExportActions = combinedExportActions.length > 0

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
          <CommandActionList actions={combinedExportActions} MenuItem={MenuItem} />
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
