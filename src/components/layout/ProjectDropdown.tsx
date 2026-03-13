import { useState, useEffect, useRef } from 'react'
import { Pencil, Check, X, Plus } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { ProjectButton } from './ProjectButton'
import { useListProjects } from '@/hooks/useListProjects'
import { useSwitchProject } from '@/hooks/useSwitchProject'
import { useRenameProject } from '@/hooks/useRenameProject'
import { useCreateProject } from '@/hooks/useCreateProject'
import { cn } from '@/lib/utils'
import type { UseMcpResult } from 'use-mcp/react'
interface ProjectDropdownProps {
  projectSlug: string | undefined
  callTool: UseMcpResult['callTool']
  onProjectChange: (slug: string) => void
}

export function ProjectDropdown({ projectSlug, callTool, onProjectChange }: ProjectDropdownProps) {
  const [open, setOpen] = useState(false)
  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [creatingNew, setCreatingNew] = useState(false)
  const [newSlugValue, setNewSlugValue] = useState('')

  const editInputRef = useRef<HTMLInputElement>(null)
  const newInputRef = useRef<HTMLInputElement>(null)

  const { projects, refresh } = useListProjects(callTool)
  const { switchProject } = useSwitchProject(callTool)
  const { renameProject } = useRenameProject(callTool)
  const { createProject } = useCreateProject(callTool)

  useEffect(() => {
    if (open) refresh()
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

  function handleSwitch(slug: string) {
    onProjectChange(slug)
    setOpen(false)
    switchProject(slug)
  }

  async function handleRenameConfirm() {
    if (!editingSlug || !editValue.trim() || editValue === editingSlug) {
      cancelEdit()
      return
    }
    const ok = await renameProject(editingSlug, editValue.trim())
    if (ok) {
      if (editingSlug === projectSlug) onProjectChange(editValue.trim())
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
      switchProject(slug)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ProjectButton projectSlug={projectSlug} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0 bg-card border-emerald-500/25"
      >
        {/* Project list */}
        <div className="max-h-60 overflow-y-auto py-1">
          {projects.map((project) => {
            const isActive = project.slug === projectSlug
            const isEditing = editingSlug === project.slug

            if (isEditing) {
              return (
                <div key={project.slug} className="flex items-center gap-1 px-2 py-1">
                  <Input
                    ref={editInputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameConfirm()
                      if (e.key === 'Escape') cancelEdit()
                    }}
                    className="h-7 text-xs font-mono flex-1"
                  />
                  <button
                    onClick={handleRenameConfirm}
                    className="p-1 text-green-400 hover:text-green-300 transition-colors"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={cancelEdit}
                    className="p-1 text-red-400 hover:text-red-300 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            }

            return (
              <div
                key={project.slug}
                className={cn(
                  'group/row flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors',
                  'hover:bg-emerald-500/10',
                  isActive && 'bg-emerald-500/5'
                )}
                onClick={() => handleSwitch(project.slug)}
              >
                <div
                  className={cn(
                    'w-1.5 h-1.5 rounded-full shrink-0',
                    isActive ? 'bg-emerald-400' : 'bg-transparent'
                  )}
                />
                <span className="font-mono text-xs tracking-wide text-emerald-400/80 flex-1 truncate">
                  {project.slug}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditingSlug(project.slug)
                    setEditValue(project.slug)
                  }}
                  className="p-1 opacity-0 group-hover/row:opacity-100 text-muted-foreground hover:text-foreground transition-all"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </div>
            )
          })}
        </div>

        {/* Separator */}
        <div className="border-t border-emerald-500/20" />

        {/* New project */}
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
                  if (e.key === 'Escape') cancelCreate()
                }}
                className="h-7 text-xs font-mono flex-1"
              />
              <button
                onClick={handleCreateConfirm}
                className="p-1 text-green-400 hover:text-green-300 transition-colors"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={cancelCreate}
                className="p-1 text-red-400 hover:text-red-300 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-emerald-500/10 transition-colors"
              onClick={() => setCreatingNew(true)}
            >
              <Plus className="w-3.5 h-3.5 text-emerald-400/60" />
              <span className="font-mono text-xs tracking-wide text-emerald-400/60">
                New Project
              </span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
