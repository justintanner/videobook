import { useEffect, useState, useRef, useCallback } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import type { MediaItem } from '@/components/sidebar/types'
import type { ManifestFile } from './viewer-types'
import { categorizeManifestFiles } from './character-folder-utils'
import { uploadProjectFile } from '@/lib/upload'
import { CloseButton } from '@/components/ui/CloseButton'
import { Save, UploadCloud } from 'lucide-react'
import { cn } from '@/lib/utils'

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
  const [metadataSaving, setMetadataSaving] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchManifest = useCallback(async () => {
    if (!projectSlug) return
    const res = await fetch(`/api/manifest/${encodeURIComponent(projectSlug)}/${encodeURIComponent(item.id)}`)
    if (res.ok) {
      const data = await res.json() as { files?: ManifestFile[] }
      setFiles(Array.isArray(data.files) ? data.files : [])
    }
  }, [projectSlug, item.id])

  useEffect(() => {
    void fetchManifest()

    if (projectSlug) {
      void callTool('read_asset_metadata', { project_slug: projectSlug, asset_id: item.id, key: 'character' }).then(res => {
        if (!res.isError) {
          const content = res.content as Array<{ type: string; text: string }>
          const text = content[0]?.text || '{}'
          setMetadata(text)
        }
      })
    }
  }, [projectSlug, item.id, fetchManifest, callTool])

  const handleSaveMetadata = async () => {
    if (!projectSlug) return
    setMetadataSaving(true)
    try {
      await callTool('set_character_metadata', {
        project_slug: projectSlug,
        char_asset_id: item.id,
        metadata,
      })
    } finally {
      setMetadataSaving(false)
    }
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

  return (
    <div className="flex w-full h-full text-zinc-100 p-6 overflow-y-auto gap-6 relative">
      <div className="absolute top-4 right-4 z-10">
        <CloseButton onClick={onClose} />
      </div>

      {/* Files Column */}
      <div className="flex-1 flex flex-col gap-6">
        <h2 className="text-2xl font-semibold">{item.title || item.id}</h2>

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
              {images.map(f => (
                <div key={f.name} className="aspect-square bg-zinc-900 rounded-lg overflow-hidden border border-zinc-800">
                  <img
                    src={`/files/${projectSlug}/${item.id}/${f.name}`}
                    alt={f.name}
                    className="w-full h-full object-cover"
                  />
                </div>
              ))}
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
          <h3 className="text-lg font-medium">Character Metadata</h3>
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
          placeholder="Free-form JSON or notes..."
        />
      </div>
    </div>
  )
}
