import { useState, useEffect, useRef, useCallback } from 'react'
import { Pencil, Check, X, Plus, Trash2, Loader2 } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { ProjectButton } from './ProjectButton'
import { useListProjects } from '@/hooks/useListProjects'
import { useRenameProject } from '@/hooks/useRenameProject'
import { useCreateProject } from '@/hooks/useCreateProject'
import { useDeleteProject } from '@/hooks/useDeleteProject'
import { cn } from '@/lib/utils'
import type { UseMcpResult } from 'use-mcp/react'

interface ProjectDropdownProps {
  bookId: string | undefined
  assetCount: number | undefined
  callTool: UseMcpResult['callTool']
  onProjectChange: (slug: string) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function formatAssetCount(count: number): string {
  return count === 1 ? '1 asset' : `${count} assets`
}

export function ProjectDropdown({ bookId, assetCount, callTool, onProjectChange, open: controlledOpen, onOpenChange }: ProjectDropdownProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [creatingNew, setCreatingNew] = useState(false)
  const [newSlugValue, setNewSlugValue] = useState('')
  const [snapshotSlug, setSnapshotSlug] = useState(bookId)
  const [confirmingDeleteSlug, setConfirmingDeleteSlug] = useState<string | null>(null)
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const editInputRef = useRef<HTMLInputElement>(null)
  const newInputRef = useRef<HTMLInputElement>(null)

  const { projects, loading, refresh } = useListProjects(callTool)
  const { renameProject } = useRenameProject(callTool)
  const { createProject } = useCreateProject(callTool)
  const { deleteProject } = useDeleteProject(callTool)

  const activeProject = projects.find((project) => project.slug === bookId)
  const displayedAssetCount = assetCount ?? activeProject?.asset_count

  // Snapshot the active project whenever the popover opens, including
  // externally-controlled opens (e.g. the /projects command).
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setSnapshotSlug(bookId)
  }

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setEditingSlug(null)
      setEditValue('')
      setCreatingNew(false)
      setNewSlugValue('')
      setConfirmingDeleteSlug(null)
      setDeleteError(null)
    }
  }, [setOpen])

  // Refresh the project list on every open edge, including external opens.
  const prevOpenRef = useRef(open)
  useEffect(() => {
    if (open && !prevOpenRef.current) refresh()
    prevOpenRef.current = open
  }, [open, refresh])

  useEffect(() => {
    if (editingSlug) editInputRef.current?.focus()
  }, [editingSlug])

  useEffect(() => {
    if (creatingNew) newInputRef.current?.focus()
  }, [creatingNew])

  function cancelEdit() {
    setEditingSlug(null)
    setEditValue('')
  }

  function cancelCreate() {
    setCreatingNew(false)
    setNewSlugValue('')
  }

  function cancelDelete() {
    setConfirmingDeleteSlug(null)
    setDeleteError(null)
  }

  function handleSwitch(slug: string) {
    if (deletingSlug) return
    onProjectChange(slug)
    setOpen(false)
  }

  async function handleRenameConfirm() {
    if (!editingSlug || !editValue.trim() || editValue === editingSlug) {
      cancelEdit()
      return
    }
    const ok = await renameProject(editingSlug, editValue.trim())
    if (ok) {
      if (editingSlug === bookId) onProjectChange(editValue.trim())
      cancelEdit()
      refresh()
    }
  }

  async function handleCreateConfirm() {
    const slug = newSlugValue.trim()
    if (!slug) {
      cancelCreate()
      return
    }
    const created = await createProject(slug)
    if (created) {
      onProjectChange(slug)
      cancelCreate()
      setOpen(false)
    }
  }

  async function handleDeleteConfirm(slug: string) {
    setDeletingSlug(slug)
    setDeleteError(null)
    const result = await deleteProject(slug)
    setDeletingSlug(null)
    if (!result.ok) {
      setDeleteError(result.error)
      return
    }

    const nextSlug = result.value.default_book_id ?? projects.find((project) => project.slug !== slug)?.slug
    cancelDelete()
    refresh()
    if (slug === bookId && nextSlug) {
      onProjectChange(nextSlug)
      setOpen(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <ProjectButton bookId={bookId} assetCount={displayedAssetCount} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-0 bg-card border-zinc-500/25"
        onEscapeKeyDown={(e) => {
          if (editingSlug || creatingNew || confirmingDeleteSlug) {
            e.preventDefault()
            if (editingSlug) cancelEdit()
            if (creatingNew) cancelCreate()
            if (confirmingDeleteSlug) cancelDelete()
          }
        }}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-500/20">
          <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
            Projects
          </span>
          <span className="font-mono text-[10px] text-zinc-500">
            {projects.length} total
          </span>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {loading && projects.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-zinc-500">
 <Loader2 className="size-3.5 animate-spin" />
              <span className="font-mono text-xs">Loading projects</span>
            </div>
          ) : null}
          {projects.map((project) => {
            const isActive = project.slug === snapshotSlug
            const isEditing = editingSlug === project.slug
            const isConfirmingDelete = confirmingDeleteSlug === project.slug
            const isDeleting = deletingSlug === project.slug
            const canDelete = projects.length > 1
            const countLabel = formatAssetCount(project.asset_count)

            if (isEditing) {
              return (
                <div key={project.slug} className="flex items-center gap-1 px-2 py-1">
                  <Input
                    ref={editInputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameConfirm()
                      if (e.key === 'Escape') { e.stopPropagation(); cancelEdit() }
                    }}
                    className="h-7 text-xs font-mono flex-1"
                  />
                  <button
                    type="button"
                    onClick={handleRenameConfirm}
                    className="p-1 text-green-400 hover:text-green-300 transition-colors"
                    aria-label="Save project name"
                  >
 <Check className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="p-1 text-red-400 hover:text-red-300 transition-colors"
                    aria-label="Cancel rename"
                  >
 <X className="size-3.5" />
                  </button>
                </div>
              )
            }

            if (isConfirmingDelete) {
              return (
                <div
                  key={project.slug}
                  className="px-3 py-2 bg-red-950/20 border-y border-red-500/15"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-2">
 <Trash2 className="size-3.5 text-red-300 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs text-red-100 min-w-0 truncate">
                        Delete {project.slug}?
                      </div>
                      <div className="font-mono text-[10px] text-red-200/60">
                        {countLabel} will be removed
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteConfirm(project.slug)}
                      disabled={isDeleting}
                      className="p-1 text-red-300 hover:text-red-100 disabled:opacity-50 transition-colors"
                      aria-label="Confirm delete project"
                    >
 {isDeleting ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={cancelDelete}
                      disabled={isDeleting}
                      className="p-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-50 transition-colors"
                      aria-label="Cancel delete project"
                    >
 <X className="size-3.5" />
                    </button>
                  </div>
                  {deleteError ? (
                    <div className="mt-1 font-mono text-[10px] text-red-200/80 min-w-0 truncate">
                      {deleteError}
                    </div>
                  ) : null}
                </div>
              )
            }

            return (
              <div
                key={project.slug}
                className={cn(
                  'group/row flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors',
                  'hover:bg-zinc-500/10',
                  isActive && 'bg-zinc-500/5',
                  isDeleting && 'pointer-events-none opacity-60'
                )}
                onClick={() => handleSwitch(project.slug)}
              >
                <div
                  className={cn(
 'size-1.5 rounded-full shrink-0',
                    isActive ? 'bg-zinc-400' : 'bg-transparent'
                  )}
                />
                <span className="font-mono text-xs tracking-wide text-zinc-400/80 flex-1 min-w-0 truncate">
                  {project.slug}
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none',
                    project.asset_count === 0
                      ? 'border-amber-400/20 bg-amber-400/10 text-amber-200/80'
                      : 'border-zinc-500/20 bg-zinc-500/10 text-zinc-400/80'
                  )}
                  title={countLabel}
                >
                  {project.asset_count}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    cancelDelete()
                    setEditingSlug(project.slug)
                    setEditValue(project.slug)
                  }}
                  className="p-1 opacity-0 group-hover/row:opacity-100 text-muted-foreground hover:text-foreground transition-all"
                  aria-label={`Rename ${project.slug}`}
                >
 <Pencil className="size-3" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!canDelete) return
                    cancelEdit()
                    cancelCreate()
                    setConfirmingDeleteSlug(project.slug)
                  }}
                  disabled={!canDelete}
                  className={cn(
                    'p-1 opacity-0 group-hover/row:opacity-100 transition-all',
                    canDelete
                      ? 'text-muted-foreground hover:text-red-300'
                      : 'text-muted-foreground/30 cursor-not-allowed'
                  )}
                  title={canDelete ? `Delete ${project.slug}` : 'Create another project before deleting this one'}
                  aria-label={`Delete ${project.slug}`}
                >
 <Trash2 className="size-3" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="border-t border-zinc-500/20" />

        <div className="py-1">
          {creatingNew ? (
            <div className="flex items-center gap-1 px-2 py-1">
              <Input
                ref={newInputRef}
                value={newSlugValue}
                onChange={(e) => setNewSlugValue(e.target.value)}
                placeholder="project-slug"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateConfirm()
                  if (e.key === 'Escape') { e.stopPropagation(); cancelCreate() }
                }}
                className="h-7 text-xs font-mono flex-1"
              />
              <button
                type="button"
                onClick={handleCreateConfirm}
                className="p-1 text-green-400 hover:text-green-300 transition-colors"
                aria-label="Create project"
              >
 <Check className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={cancelCreate}
                className="p-1 text-red-400 hover:text-red-300 transition-colors"
                aria-label="Cancel new project"
              >
 <X className="size-3.5" />
              </button>
            </div>
          ) : (
            <div
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-zinc-500/10 transition-colors"
              onClick={() => {
                cancelDelete()
                setCreatingNew(true)
              }}
            >
 <Plus className="size-3.5 text-zinc-400/60" />
              <span className="font-mono text-xs tracking-wide text-zinc-400/60">
                New Project
              </span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
