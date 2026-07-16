import { useEffect, useState, useRef, useCallback } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import type { MediaItem } from '@/components/sidebar/types'
import type { ManifestFile } from './viewer-types'
import { categorizeManifestFiles } from './character-folder-utils'
import { uploadProjectFile } from '@/lib/upload'
import { CloseButton } from '@/components/ui/CloseButton'
import { Save, UploadCloud, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePublishGoogleFlowCharacter } from '@/hooks/usePublishGoogleFlowCharacter'
import { toast } from '@/hooks/useToast'
import {
  parseCharacterMetadataObject,
  resolveDisplayName,
  extractManagedFields,
  mergeManagedFields,
} from '@/lib/character-name'

type CharacterMetadataForm = {
  displayName: string
  personalityNotes: string
  metadata: string
}

function parseCharacterMetadataForm(text: string, itemId: string): CharacterMetadataForm {
  const { displayName, personalityNotes } = extractManagedFields(text)
  const advanced = parseCharacterMetadataObject(text)
  delete advanced.display_name
  delete advanced.personality_notes
  delete advanced.personalityNotes
  delete advanced.notes
  return {
    displayName: displayName || resolveDisplayName(undefined, itemId),
    personalityNotes: personalityNotes || '',
    metadata: Object.keys(advanced).length ? JSON.stringify(advanced, null, 2) : '{}',
  }
}

export function CharacterFolderViewer({
  item,
  projectSlug,
  callTool,
  onClose
}: {
  item: MediaItem
  projectSlug: string | null
  callTool: UseMcpResult['callTool']
  onClose: () => void
}) {
  const [files, setFiles] = useState<ManifestFile[]>([])
  const [metadata, setMetadata] = useState<string>('{}')
  const [displayName, setDisplayName] = useState(() => resolveDisplayName(undefined, item.id))
  const [personalityNotes, setPersonalityNotes] = useState('')
  const [metadataSaving, setMetadataSaving] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [draggedImg, setDraggedImg] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { publishCharacter, publishing } = usePublishGoogleFlowCharacter(projectSlug)

  const readManifest = useCallback(async (): Promise<ManifestFile[] | null> => {
    if (!projectSlug) return null
    const res = await fetch(`/api/manifest/${encodeURIComponent(projectSlug)}/${encodeURIComponent(item.id)}`)
    if (!res.ok) return null
    const data = await res.json() as { files?: ManifestFile[] }
    return Array.isArray(data.files) ? data.files : []
  }, [projectSlug, item.id])

  const readMetadata = useCallback(async (): Promise<CharacterMetadataForm | null> => {
    if (!projectSlug) return null
    const res = await callTool('read_asset_metadata', {
      project_slug: projectSlug,
      asset_id: item.id,
      name: 'character',
    })
    if (res.isError) return parseCharacterMetadataForm('{}', item.id)
    const content = res.content as Array<{ type: string; text: string }>
    return parseCharacterMetadataForm(content[0]?.text || '{}', item.id)
  }, [projectSlug, item.id, callTool])

  const applyMetadata = useCallback((next: CharacterMetadataForm) => {
    setDisplayName(next.displayName)
    setPersonalityNotes(next.personalityNotes)
    setMetadata(next.metadata)
  }, [])

  const fetchManifest = useCallback(async () => {
    const next = await readManifest()
    if (next) setFiles(next)
  }, [readManifest])

  const loadMetadata = useCallback(async () => {
    const next = await readMetadata()
    if (next) applyMetadata(next)
  }, [applyMetadata, readMetadata])

  useEffect(() => {
    let cancelled = false
    void readManifest().then((nextFiles) => {
      if (cancelled) return
      if (nextFiles) setFiles(nextFiles)
    }).catch(() => {})
    void readMetadata().then((nextMetadata) => {
      if (cancelled) return
      if (nextMetadata) applyMetadata(nextMetadata)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [applyMetadata, readManifest, readMetadata])

  const handleSaveMetadata = async () => {
    if (!projectSlug) return
    setMetadataSaving(true)
    try {
      const name = displayName.trim()
      const notes = personalityNotes.trim()
      
      const merged = mergeManagedFields(metadata, { displayName: name, personalityNotes: notes })
      const payload = JSON.stringify(merged, null, 2)

      const res = await callTool('set_character_metadata', {
        project_slug: projectSlug,
        char_asset_id: item.id,
        metadata: payload,
      })
      if (res.isError) {
        const msg = (res.content as Array<{ type: string; text: string }>)?.[0]?.text
        toast({ title: 'Save failed', description: msg ?? 'Could not write character metadata', duration: 5000 })
        return
      }
      await loadMetadata()
      toast({ title: 'Saved', description: name ? `Name: ${name}` : 'Metadata updated', duration: 2000 })
    } finally {
      setMetadataSaving(false)
    }
  }

  const handlePublish = async () => {
    const name = displayName.trim()
    const notes = personalityNotes.trim()
    if (!name) {
      toast({
        title: 'Name required',
        description: 'Set a short name (e.g. the-guy) before publishing to Google Flow',
        duration: 4000,
      })
      return
    }

    if (notes.length > 2000) {
      toast({
        title: 'Notes too long',
        description: 'Personality notes cannot exceed 2000 characters',
        duration: 4000,
      })
      return
    }

    // Persist name and notes first so re-open keeps the values even if GF fails later.
    const mergedForPublish = mergeManagedFields(metadata, { displayName: name, personalityNotes: notes })
    const payload = JSON.stringify(mergedForPublish, null, 2)

    setMetadataSaving(true)
    try {
      const res = await callTool('set_character_metadata', {
        project_slug: projectSlug!,
        char_asset_id: item.id,
        metadata: payload,
      })
      if (res.isError) {
        const msg = (res.content as Array<{ type: string; text: string }>)?.[0]?.text
        toast({ title: 'Save failed', description: msg ?? 'Could not write character metadata', duration: 5000 })
        return
      }
    } finally {
      setMetadataSaving(false)
    }

    const result = await publishCharacter(item.id, name, {
      personalityNotes: notes || undefined,
      existingMetadata: payload,
    })
    if (result) await loadMetadata()
  }

  const handleFile = async (file: File) => {
    if (!projectSlug) return
    try {
      await uploadProjectFile(projectSlug, file, file.name, item.id)
      await fetchManifest()
    } catch (e) {
      console.error('Failed to upload file to character asset', e)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleFile(e.dataTransfer.files[0])
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const { images, audio, others } = categorizeManifestFiles(files)
  const canPublish = !publishing && images.length > 0 && displayName.trim().length > 0

  const handleDragStartImg = (e: React.DragEvent, name: string) => {
    setDraggedImg(name)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOverImg = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDropImg = async (e: React.DragEvent, targetName: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (!draggedImg || draggedImg === targetName) {
      setDraggedImg(null)
      return
    }
    const sourceIdx = images.findIndex(f => f.name === draggedImg)
    const targetIdx = images.findIndex(f => f.name === targetName)
    if (sourceIdx < 0 || targetIdx < 0) return

    const newOrder = [...images]
    const [moved] = newOrder.splice(sourceIdx, 1)
    newOrder.splice(targetIdx, 0, moved)

    setDraggedImg(null)

    if (projectSlug) {
      const orderedFilenames = newOrder.map(f => f.name)
      await callTool('reorder_character_images', {
        project_slug: projectSlug,
        asset_id: item.id,
        ordered_filenames: orderedFilenames
      })
      await fetchManifest()
    }
  }

  const handleMakeFirst = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation()
    const sourceIdx = images.findIndex(f => f.name === name)
    if (sourceIdx <= 0) return
    const newOrder = [...images]
    const [moved] = newOrder.splice(sourceIdx, 1)
    newOrder.unshift(moved)

    if (projectSlug) {
      const orderedFilenames = newOrder.map(f => f.name)
      await callTool('reorder_character_images', {
        project_slug: projectSlug,
        asset_id: item.id,
        ordered_filenames: orderedFilenames
      })
      await fetchManifest()
    }
  }

  return (
    <div className="flex w-full h-full text-zinc-100 p-6 overflow-y-auto gap-6 relative">
      <div className="absolute top-4 right-4 z-10">
        <CloseButton onClick={onClose} />
      </div>

      {/* Files Column */}
      <div className="flex-1 flex flex-col gap-6">
        <div className="flex justify-between items-start gap-4 pr-10">
          <div className="flex flex-col gap-2 min-w-0 flex-1">
            <label className="text-xs font-mono uppercase tracking-wider text-zinc-500">Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="the-guy"
              className="w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xl font-semibold text-zinc-100 focus:outline-none focus:border-emerald-500/60"
            />
            <p className="text-xs text-zinc-500">
              Short name used when publishing to Google Flow. Asset id stays <span className="font-mono">{item.id}</span>.
            </p>

            <label className="text-xs font-mono uppercase tracking-wider text-zinc-500 mt-4">Personality notes (Optional)</label>
            <textarea
              value={personalityNotes}
              onChange={(e) => setPersonalityNotes(e.target.value)}
              placeholder="Guide behavior and dialogue in Google Flow..."
              className={cn(
                "w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/60 resize-y min-h-[80px]",
                personalityNotes.length > 2000 && "border-red-500/60 focus:border-red-500/60"
              )}
            />
            <div className="flex justify-between w-full max-w-md">
              <p className="text-xs text-zinc-500">
                Guides behavior and dialogue in Google Flow.
              </p>
              <p className={cn("text-xs", personalityNotes.length > 2000 ? "text-red-400" : "text-zinc-500")}>
                {personalityNotes.length} / 2000
              </p>
            </div>
          </div>
          <button
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm transition-colors disabled:opacity-50 shrink-0 mt-6"
            onClick={() => void handlePublish()}
            disabled={!canPublish || metadataSaving}
          >
            <Globe className="w-4 h-4" />
            {publishing ? 'Publishing...' : 'Publish to Google Flow'}
          </button>
        </div>

        <div
          className={cn(
            'border-2 border-dashed rounded-lg p-8 flex flex-col items-center justify-center cursor-pointer transition-colors',
            isDragging ? 'border-emerald-500 bg-emerald-500/10' : 'border-zinc-700 hover:border-zinc-500'
          )}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void handleFile(e.target.files[0])
              }
            }}
          />
          <UploadCloud className="w-8 h-8 mb-2 text-zinc-400" />
          <p className="text-zinc-400">Drag & drop files here, or click to select</p>
        </div>

        {images.length > 0 && (
          <div>
            <h3 className="text-lg font-medium mb-3">Images</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {images.map((f, i) => {
                const isHighlight = i < 2
                return (
                  <div
                    key={f.name}
                    className={cn(
                      "aspect-square rounded-lg overflow-hidden border relative group cursor-grab active:cursor-grabbing",
                      isHighlight ? "border-emerald-500/50 ring-1 ring-emerald-500/30" : "border-zinc-800 bg-zinc-900"
                    )}
                    draggable
                    onDragStart={(e) => handleDragStartImg(e, f.name)}
                    onDragOver={handleDragOverImg}
                    onDrop={(e) => void handleDropImg(e, f.name)}
                  >
                    <img
                      src={`/files/${projectSlug}/${item.id}/${f.name}`}
                      alt={f.name}
                      className="w-full h-full object-cover pointer-events-none"
                    />

                    <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/60 text-white text-xs rounded shadow backdrop-blur-md font-medium">
                      {i + 1}
                    </div>

                    {i > 0 && (
                      <button
                        onClick={(e) => void handleMakeFirst(e, f.name)}
                        className="absolute top-2 right-2 px-2 py-1 bg-black/60 hover:bg-emerald-600 text-white text-xs rounded shadow backdrop-blur-md opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        Make first
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {audio.length > 0 && (
          <div>
            <h3 className="text-lg font-medium mb-3">Audio</h3>
            <div className="flex flex-col gap-3">
              {audio.map(f => (
                <div key={f.name} className="flex flex-col gap-1 p-3 bg-zinc-900 rounded-lg border border-zinc-800">
                  <span className="text-sm truncate">{f.name}</span>
                  <audio
                    controls
                    className="w-full h-8"
                    src={`/files/${projectSlug}/${item.id}/${f.name}`}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {others.length > 0 && (
          <div>
            <h3 className="text-lg font-medium mb-3">Other Files</h3>
            <div className="flex flex-col gap-2">
              {others.map(f => (
                <div key={f.name} className="flex justify-between items-center p-3 bg-zinc-900 rounded-lg border border-zinc-800">
                  <span className="text-sm truncate">{f.name}</span>
                  <span className="text-xs text-zinc-500">{(f.size_bytes / 1024).toFixed(1)} KB</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Metadata Column */}
      <div className="w-[400px] flex flex-col gap-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-medium">Advanced Metadata</h3>
          <button
            className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-sm transition-colors disabled:opacity-50"
            onClick={() => void handleSaveMetadata()}
            disabled={metadataSaving}
          >
            <Save className="w-4 h-4" />
            Save
          </button>
        </div>
        <textarea
          value={metadata}
          onChange={(e) => setMetadata(e.target.value)}
          className="flex-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg p-4 font-mono text-sm resize-none focus:outline-none focus:border-zinc-600"
          placeholder={'JSON object with arbitrary metadata'}
        />
      </div>
    </div>
  )
}
