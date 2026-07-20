import { useCallback, useEffect, useRef, useState } from 'react'
import { Crop, Settings } from 'lucide-react'
import { CloseButton } from '@/components/ui/CloseButton'
import { cn } from '@/lib/utils'
import type { MediaItem } from '@/components/sidebar/types'
import { useMountKey } from '@/contexts/MountKeyContext'
import { isFailedPending } from '@/components/commands/inbox-utils'
import type { UseMcpResult } from 'use-mcp/react'
import type { ViewerSize, BackTab } from './viewer-types'
import { CropOverlay, type CropRatio } from './CropOverlay'
import {
  CropImage,
  RatioToggle,
  ViewerToolbar,
  BackFaceTabBar,
  FilesBackPane,
  HistoryBackPane,
  useViewerBackFace,
} from './viewer-shared'

// ── Image content renderer ──

function ImageContent({
  item,
  size,
  imgRef,
  cropMode,
  cropRatio,
  onCropApply,
  onCropCancel,
}: {
  item: MediaItem
  size: ViewerSize
  imgRef: React.RefObject<HTMLImageElement | null>
  cropMode: boolean
  cropRatio: CropRatio
  onCropApply: (ratio: CropRatio, rect: { x: number; y: number; w: number; h: number }) => void
  onCropCancel: () => void
}) {
  if (!item.filePath) return null

  // Interactive crop always targets the true original source (object-contain).
  if (cropMode || size === 'original') {
    return (
 <div className="relative size-full ">
        <img
          ref={imgRef}
          src={item.filePath}
          alt={item.title}
 className="size-full object-contain"
          draggable={false}
        />
        {cropMode && (
          <CropOverlay
            mediaRef={imgRef}
            initialRatio={cropRatio}
            onApply={onCropApply}
            onCancel={onCropCancel}
          />
        )}
      </div>
    )
  }

  const cropFile = size === 'landscape' ? 'landscape.jpg'
    : size === 'portrait' ? 'portrait.jpg'
    : 'square.jpg'
  const cropSrc = item.filePath.replace(/\/[^/]+$/, `/${cropFile}`)
  return (
    <CropImage key={cropSrc} cropSrc={cropSrc} fallbackSrc={item.filePath} alt={item.title} />
  )
}

// ── ImageViewer ──

const IMAGE_BACK_TABS: BackTab[] = ['files', 'history']

export function ImageViewer({ item, projectSlug, size, onSizeChange, flipped, onFlippedChange, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, callTool, onClose, cropTarget, onCropConsumed }: {
  item: MediaItem
  projectSlug: string
  size: ViewerSize
  onSizeChange: (s: ViewerSize) => void
  flipped: boolean
  onFlippedChange: (f: boolean) => void
  pendingFilePosition?: number | null
  onClearPendingFilePosition?: () => void
  pendingBackTab?: BackTab | null
  onClearPendingBackTab?: () => void
  callTool: UseMcpResult['callTool']
  onClose: () => void
  cropTarget?: { assetId: string; ratio?: string } | null
  onCropConsumed?: () => void
}) {
  useMountKey('viewer')

  // Auto-flip to back face when the asset is failed and has no image to show —
  // the back face exposes the generation-error file and commit history.
  const lastAutoFlippedId = useRef<string | null>(null)
  useEffect(() => {
    if (lastAutoFlippedId.current === item.id) return
    if (isFailedPending(item) && !item.filePath) {
      lastAutoFlippedId.current = item.id
      if (!flipped) onFlippedChange(true)
    }
  }, [item, flipped, onFlippedChange])

  const bf = useViewerBackFace({
    projectSlug,
    itemId: item.id,
    callTool,
    flipped,
    onFlippedChange,
    pendingFilePosition,
    onClearPendingFilePosition,
    pendingBackTab,
    onClearPendingBackTab,
    defaultBackTab: 'files',
  })

  const imgRef = useRef<HTMLImageElement>(null)
  const [cropMode, setCropMode] = useState(false)
  const defaultCropRatio: CropRatio =
    size === 'portrait' ? '9:16' : size === 'square' ? '1:1' : '16:9'
  const [cropRatio, setCropRatio] = useState<CropRatio>(defaultCropRatio)

  useEffect(() => {
    if (!cropTarget || cropTarget.assetId !== item.id) return
    const r = cropTarget.ratio
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (r === '16:9' || r === '9:16' || r === '1:1') setCropRatio(r)
    else setCropRatio(defaultCropRatio)
    setCropMode(true)
    onCropConsumed?.()
  }, [cropTarget, item.id, defaultCropRatio, onCropConsumed])

  const handleCropApply = useCallback(async (ratio: CropRatio, rect: { x: number; y: number; w: number; h: number }) => {
    setCropMode(false)
    await callTool('crop_image', {
      asset_id: item.id,
      project_slug: projectSlug,
      ratio,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    })
  }, [callTool, item.id, projectSlug])

  const handleCropCancel = useCallback(() => setCropMode(false), [])

  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div
        className={cn(
          'flip-card-perspective',
 size === 'original' ? 'size-full '
 : size === 'landscape' ? 'aspect-video size-full '
 : size === 'square' ? 'aspect-square size-full '
 : 'size-full ',
        )}
      >
        <div className={cn(
 'flip-card-inner size-full relative',
          flipped && 'flipped',
        )}>
          {/* FRONT FACE */}
          <div className={cn(
            'flip-card-face absolute inset-0 flex flex-col overflow-hidden',
            'border border-zinc-600/50',
          )}>
            <ViewerToolbar
              left={<RatioToggle active={size} onSelect={onSizeChange} item={item} />}
              slug={item.slug}
              right={
                <div className="flex items-center gap-1">
                  <button
                    tabIndex={-1}
                    onClick={() => setCropMode((v) => !v)}
                    title="/crop"
                    className={cn(
 'size-6 flex items-center justify-center rounded transition-colors duration-150',
                      cropMode
                        ? 'text-violet-300 bg-violet-500/15'
                        : 'text-muted-foreground hover:text-violet-300 hover:bg-violet-500/10',
                    )}
                  >
 <Crop className="size-4 stroke-[2.5]" />
                  </button>
                  <button
                    tabIndex={-1}
                    onClick={bf.handleFlipToBack}
                    title="/files"
 className="size-6 flex items-center justify-center text-muted-foreground hover:text-cyan-300 transition-colors duration-150 rounded hover:bg-cyan-500/10"
                  >
 <Settings className="size-4 stroke-[2.5]" />
                  </button>
                  <CloseButton tabIndex={-1} onClick={onClose} tone="cyan" />
                </div>
              }
            />

            <div className={cn(
              'flex-1 bg-black flex min-h-0 items-center justify-center',
              (size === 'portrait' || size === 'square') && 'py-2',
            )}>
              {size === 'portrait' && !cropMode ? (
                <div className="aspect-[9/16] h-full max-w-full">
                  <ImageContent
                    item={item}
                    size={size}
                    imgRef={imgRef}
                    cropMode={cropMode}
                    cropRatio={cropRatio}
                    onCropApply={handleCropApply}
                    onCropCancel={handleCropCancel}
                  />
                </div>
              ) : size === 'square' && !cropMode ? (
                <div className="aspect-square h-full max-w-full">
                  <ImageContent
                    item={item}
                    size={size}
                    imgRef={imgRef}
                    cropMode={cropMode}
                    cropRatio={cropRatio}
                    onCropApply={handleCropApply}
                    onCropCancel={handleCropCancel}
                  />
                </div>
              ) : (
                <ImageContent
                  item={item}
                  size={size}
                  imgRef={imgRef}
                  cropMode={cropMode}
                  cropRatio={cropRatio}
                  onCropApply={handleCropApply}
                  onCropCancel={handleCropCancel}
                />
              )}
            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            <BackFaceTabBar
              tabs={IMAGE_BACK_TABS}
              active={bf.backTab}
              onSelect={bf.setBackTab}
              slug={item.slug}
              onClose={() => onFlippedChange(false)}
              onCloseViewer={onClose}
            />

            {bf.backTab === 'files' ? (
              <FilesBackPane
                manifest={bf.manifest}
                manifestLoading={bf.manifestLoading}
                selectedFile={bf.selectedFile}
                fileContent={bf.fileContent}
                fileLoading={bf.fileLoading}
                fileUrl={bf.fileUrl}
                handleSelectFile={bf.handleSelectFile}
                handleFileKeyDown={bf.handleFileKeyDown}
                fetchManifest={bf.fetchManifest}
                fetchFileContent={bf.fetchFileContent}
              />
            ) : (
              <HistoryBackPane
                commits={bf.commits}
                historyLoading={bf.historyLoading}
                selectedCommitHash={bf.selectedCommitHash}
                setSelectedCommitHash={bf.setSelectedCommitHash}
                handleRestore={bf.handleRestore}
                fetchHistory={bf.fetchHistory}
                itemId={item.id}
                projectSlug={projectSlug}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
