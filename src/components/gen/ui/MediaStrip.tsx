import { useState, useCallback, useMemo } from 'react'
import { ImageIcon, Video, Music, X, Pin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AssetDropSlot } from '@/components/ui/AssetDropSlot'
import type { ModelOption, ModeSpec, ResolvedAsset } from '@/components/gen/types'
import { sectionTheme, type Domain } from '@/theme/domains'
import { findByAssetSlug, stripSlugPrefix } from '@/lib/slugs'
import {
  deriveStripSlots,
  combinedRefBudget,
  imageRefMax,
  routeDrop,
  appendSlug,
  toggleFirstFramePin,
  type StripSlot,
  type CharacterEntity,
} from '@/components/gen/ui/media-strip'

const BUDGET_OVER = 'text-red-400'
const BUDGET_WARN = 'text-amber-400/70'

function videoThumbFallback(asset: ResolvedAsset): string {
  if (asset.thumbnailSrc) return asset.thumbnailSrc
  if (asset.type === 'video' && asset.src) {
    return asset.src.replace(/\/[^/]+$/, '/original.jpg')
  }
  return asset.src || ''
}

function findThumbnail(
  slug: string,
  resolvedAssets: ResolvedAsset[],
  droppedAssets: Map<string, ResolvedAsset>,
  projectImages?: { slug: string; filePath: string; thumbnailSrc: string | null }[],
): string {
  if (!slug) return ''
  // Prefer live project image paths so renames refresh thumbs even when
  // droppedAssets still holds a stale URL under the same logical slot.
  if (projectImages?.length) {
    const live = findByAssetSlug(slug, projectImages)
    if (live) return live.thumbnailSrc || live.filePath || ''
  }
  const dropped = droppedAssets.get(slug) ?? findByAssetSlug(slug, [...droppedAssets.values()])
  if (dropped) return videoThumbFallback(dropped)
  const clean = stripSlugPrefix(slug)
  const asset = resolvedAssets.find((a) => {
    const aClean = a.slug ? stripSlugPrefix(a.slug) : a.slug
    return a.slug === slug || a.slug === clean || aClean === clean
  })
  return asset ? videoThumbFallback(asset) : ''
}

function slotIcon(kind: StripSlot['kind']): React.ReactNode {
  if (kind === 'video') return <Video className="w-3 h-3" />
  if (kind === 'audio') return <Music className="w-3 h-3" />
  return <ImageIcon className="w-3 h-3" />
}

function slotSlugs(value: unknown): string[] {
  if (Array.isArray(value)) return (value as unknown[]).map(String).filter((s) => s.length > 0)
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

function slotAtCap(slot: StripSlot, value: unknown): boolean {
  if (slot.max == null) return false
  return slotSlugs(value).length >= slot.max
}

function emptyHintForSlots(slots: StripSlot[]): string {
  const kinds = new Set(slots.map((s) => s.kind))
  const parts: string[] = []
  if (kinds.has('image')) parts.push('img')
  if (kinds.has('video')) parts.push('vid')
  if (kinds.has('audio')) parts.push('aud')
  if (parts.length === 0) return 'drag assets here · type @ in the prompt'
  if (parts.length === 1 && parts[0] === 'img') return 'drag images here · type @ in the prompt'
  return `drag ${parts.join(' · ')} · or type @`
}

export interface CharacterPillData {
  ref: string
  name: string
  thumbnailUrl: string | null
  imageCount: number
  missing?: boolean
}

interface MediaStripProps {
  option: ModelOption
  activeMode: ModeSpec | null
  formValues: Record<string, unknown>
  resolvedAssets: ResolvedAsset[]
  droppedAssets: Map<string, ResolvedAsset>
  /** Live project images — used for thumbs after renames and to drop dead refs. */
  projectImages?: { slug: string; filePath: string; thumbnailSrc: string | null }[]
  onChange: (field: string, value: unknown, dropped?: ResolvedAsset) => void
  disabled: boolean
  domain: Domain
  characters: CharacterPillData[]
  onRemoveCharacter: (ref: string) => void
  warnings: string[]
}

export function MediaStrip({
  option,
  activeMode,
  formValues,
  resolvedAssets,
  droppedAssets,
  projectImages,
  onChange,
  disabled,
  domain,
  characters,
  onRemoveCharacter,
  warnings,
}: MediaStripProps) {
  const [dragOver, setDragOver] = useState(false)
  const theme = sectionTheme(domain)

  const slots = useMemo(() => deriveStripSlots(option, activeMode), [option, activeMode])

  // Accepted drop kinds are derived from the model's slots so the image panel
  // (image-only slots) doesn't accept video/audio, and the trailing drop square
  // matches the container guard.
  const acceptedKinds = useMemo(() => new Set<StripSlot['kind']>(slots.map((s) => s.kind)), [slots])

  const charEntityMap = useMemo(() => {
    const m: Record<string, CharacterEntity | null> = {}
    for (const c of characters) m[c.ref] = { image_count: c.imageCount }
    return m
  }, [characters])

  const characterRefs = characters.map((c) => c.ref)
  const maxImages = useMemo(() => imageRefMax(option, activeMode), [option, activeMode])
  const budget = useMemo(
    () => combinedRefBudget(formValues, characterRefs, activeMode, maxImages, charEntityMap),
    [formValues, characterRefs, activeMode, maxImages, charEntityMap],
  )

  const applyRoute = useCallback((
    route: { param: string; action: 'set' | 'append' },
    slug: string,
    resolved: ResolvedAsset,
  ) => {
    if (!route.param) return
    if (route.action === 'append') {
      const slot = slots.find((s) => s.param === route.param)
      const updated = appendSlug(formValues, route.param, slug, slot?.max)
      onChange(route.param, updated, resolved)
      return
    }
    onChange(route.param, slug, resolved)
  }, [slots, formValues, onChange])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData('application/json')
    if (!raw) return
    let parsed: { slug?: string; type?: string; filePath?: string; thumbnailSrc?: string | null }
    try {
      parsed = JSON.parse(raw) as { slug?: string; type?: string; filePath?: string; thumbnailSrc?: string | null }
    } catch {
      return
    }
    if (!parsed.slug || !parsed.type) return
    const kind = (parsed.type === 'video' ? 'video' : parsed.type === 'audio' ? 'audio' : 'image') as StripSlot['kind']
    if (!acceptedKinds.has(kind)) return
    const route = routeDrop(kind, slots)
    // Resolve a thumbnail: prefer preview.resolved_assets, then a previously
    // dropped asset, else build one from the drag payload (CardShell's DragData)
    // so a dropped asset absent from resolved_assets still chips and survives
    // the stale-slug pruning effect.
    const resolved: ResolvedAsset = (() => {
      const existing = resolvedAssets.find((a) => a.slug === parsed.slug)
      if (existing) return existing
      const dropped = droppedAssets.get(parsed.slug)
      if (dropped) return dropped
      return {
        slug: parsed.slug,
        src: parsed.filePath ?? '',
        thumbnailSrc: parsed.thumbnailSrc ?? null,
        type: kind,
      }
    })()
    applyRoute(route, parsed.slug, resolved)
  }, [acceptedKinds, slots, applyRoute, resolvedAssets, droppedAssets])

  const handleTogglePin = useCallback((slug: string) => {
    const result = toggleFirstFramePin(formValues, slug)
    for (const [k, v] of Object.entries(result)) {
      onChange(k, v)
    }
  }, [formValues, onChange])

  const pinnedSlug = typeof formValues.first_frame_slug === 'string' ? formValues.first_frame_slug : ''

  // Warn when within 1 of a finite limit AND already using refs (the old
  // `used > max - 2` painted amber on an empty strip when max <= 2). A null max
  // is never warn/blocking.
  const budgetClass = budget.blocking
    ? BUDGET_OVER
    : budget.max != null && budget.used > 0 && budget.used >= budget.max - 1
      ? BUDGET_WARN
      : theme.controlText

  // Pin only applies to models whose schema has a first_frame_slug field, so
  // image tools (no such field) never render the destructive pin.
  const hasPinnableImage =
    slots.some((s) => s.kind === 'image' && s.param !== 'first_frame_slug') &&
    'first_frame_slug' in option.schema.properties

  const hasChips = slots.some((slot) => slotSlugs(formValues[slot.param]).length > 0)
  const showEmptyHint = !hasChips && characters.length === 0

  // Empty-slot color follows the panel domain (fixes plan rendering cyan).
  const slotVariant = domain === 'video' ? 'video' : 'image'

  const routeDroppedAsset = (asset: ResolvedAsset | null, forcedKind?: StripSlot['kind']) => {
    if (!asset) return
    const kind = forcedKind
      ?? (asset.type === 'video' ? 'video' : asset.type === 'audio' ? 'audio' : 'image')
    const route = routeDrop(kind, slots)
    applyRoute(route, asset.slug, asset)
  }

  const slotChips = slots.map((slot) => {
    const slugs = slotSlugs(formValues[slot.param])
    const isArray = Array.isArray(formValues[slot.param]) || slot.param.endsWith('_slugs')
    return slugs.map((slug, i) => (
      <StripChip
        key={`${slot.param}-${i}-${slug}`}
        slug={slug}
        label={slot.label}
        resolvedAssets={resolvedAssets}
        droppedAssets={droppedAssets}
        projectImages={projectImages}
        onRemove={() => {
          if (isArray) {
            const next = slugs.filter((_, idx) => idx !== i)
            onChange(slot.param, next)
          } else {
            onChange(slot.param, '')
          }
        }}
        onPin={
          hasPinnableImage && slot.kind === 'image' && slot.param !== 'first_frame_slug'
            ? () => handleTogglePin(slug)
            : undefined
        }
        pinned={pinnedSlug === slug}
        disabled={disabled}
        icon={slotIcon(slot.kind)}
        badge={slot.param === 'image_slugs' ? String(i + 1) : undefined}
      />
    ))
  })

  // One empty drop control per unsaturated slot kind so multi-ref models
  // (Seedance refs) expose distinct img / vid / aud targets.
  const openSlots = slots.filter((s) => !slotAtCap(s, formValues[s.param]))
  const dropTargets = openSlots.length > 0 ? openSlots : slots.slice(0, 1)

  const characterChips = characters.map((c) => (
    <CharacterChip
      key={c.ref}
      name={c.name}
      thumbnailUrl={c.thumbnailUrl}
      imageCount={c.imageCount}
      onRemove={() => onRemoveCharacter(c.ref)}
      disabled={disabled}
      missing={c.missing}
    />
  ))

  const showMeter = characterRefs.length > 0 || slots.some((s) => s.kind === 'image')
  const meter = showMeter ? (
    <span className={cn('text-[10px] font-mono whitespace-nowrap', budgetClass)}>{budget.meter}</span>
  ) : null
  const modeLabelNode = activeMode ? (
    <span className={cn('text-[9px] font-mono uppercase tracking-wider whitespace-nowrap', theme.unitText)}>
      {activeMode.label}
    </span>
  ) : null

  const footer = (
    <>
      {budget.message && (
        <div className="px-3 pb-2 text-[10px] font-mono text-red-400/80">{budget.message}</div>
      )}
      {warnings.length > 0 && (
        <div className="px-3 pb-2 space-y-0.5">
          {warnings.map((w, i) => (
            <p key={i} className="text-[10px] font-mono text-amber-400/60">{w}</p>
          ))}
        </div>
      )}
    </>
  )

  const dragProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragOver(true) },
    onDragLeave: () => setDragOver(false),
    onDrop: handleDrop,
  }

  const dragOverClass = cn(theme.activeBorder, theme.controlBg)

  return (
    <div
      {...dragProps}
      className={cn(
        'rounded border transition-colors duration-150 bg-black/40',
        dragOver ? dragOverClass : 'border-primary/20',
      )}
    >
      {/* Chip row */}
      <div className="flex items-center gap-1.5 px-2 py-2 overflow-x-auto">
        {slotChips}
        {characterChips}

        {/* Empty drop zones — one per open slot when multi-kind */}
        <div className="flex items-center gap-1.5 shrink-0">
          {dropTargets.map((slot) => (
            <AssetDropSlot
              key={`drop-${slot.param}`}
              value={null}
              onChange={(asset) => routeDroppedAsset(asset, slot.kind)}
              disabled={disabled || slotAtCap(slot, formValues[slot.param])}
              acceptTypes={[slot.kind]}
              emptyIcon={slotIcon(slot.kind)}
              compact
              variant={slotVariant}
            />
          ))}
          {showEmptyHint && (
            <span className={cn('text-[10px] font-mono whitespace-nowrap select-none', theme.placeholderText)}>
              {emptyHintForSlots(slots)}
            </span>
          )}
        </div>

        {/* Budget meter + mode label (right-aligned) */}
        <div className="ml-auto flex items-center gap-3 shrink-0 pl-2">
          {meter}
          {modeLabelNode}
        </div>
      </div>
      {footer}
    </div>
  )
}

function StripChip({
  slug,
  label,
  resolvedAssets,
  droppedAssets,
  projectImages,
  onRemove,
  onPin,
  pinned,
  disabled,
  icon,
  badge,
}: {
  slug: string
  label: string
  resolvedAssets: ResolvedAsset[]
  droppedAssets: Map<string, ResolvedAsset>
  projectImages?: { slug: string; filePath: string; thumbnailSrc: string | null }[]
  onRemove: () => void
  onPin?: () => void
  pinned?: boolean
  disabled?: boolean
  icon?: React.ReactNode
  badge?: string
}) {
  const thumb = findThumbnail(slug, resolvedAssets, droppedAssets, projectImages)
  return (
    <div
      className={cn(
        'group relative shrink-0 rounded overflow-hidden border',
        'w-10 h-10',
        pinned ? 'border-amber-400/60 ring-1 ring-amber-400/40' : 'border-primary/30',
      )}
      title={badge ? `@referenceImage_${badge} · ${stripSlugPrefix(slug)}` : `${label} · ${stripSlugPrefix(slug)}`}
    >
      {thumb ? (
        <img src={thumb} alt={label} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-primary/20">
          {icon ?? <ImageIcon className="w-3 h-3" />}
        </div>
      )}
      {/* Positional index badge (matches @referenceImage_N order) */}
      {badge && (
        <span className="absolute left-0 top-0 z-10 rounded-br-[3px] bg-black/80 px-[2px] text-[9px] font-mono font-bold leading-none text-cyan-300">
          {badge}
        </span>
      )}
      {/* Pin button */}
      {onPin && !disabled && (
        <button
          type="button"
          onClick={onPin}
          className={cn(
            'absolute top-0 left-0 w-4 h-4 z-20 flex items-center justify-center',
            'opacity-0 group-hover:opacity-100 transition-opacity',
            pinned ? 'opacity-100 text-amber-400' : 'text-primary/40 hover:text-amber-400',
          )}
          title={pinned ? 'Unpin first frame' : 'Pin as first frame'}
        >
          <Pin className="w-2.5 h-2.5" fill={pinned ? 'currentColor' : 'none'} />
        </button>
      )}
      {/* Remove button */}
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          className={cn(
            'absolute top-0 right-0 w-4 h-4 flex items-center justify-center',
            'bg-black/70 text-red-400/80 hover:text-red-400',
            'opacity-0 group-hover:opacity-100 transition-opacity',
          )}
          title="Remove"
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  )
}

function CharacterChip({
  name,
  thumbnailUrl,
  imageCount,
  onRemove,
  disabled,
  missing,
}: {
  name: string
  thumbnailUrl: string | null
  imageCount: number
  onRemove: () => void
  disabled?: boolean
  missing?: boolean
}) {
  const [broken, setBroken] = useState(false)
  const showImg = !!thumbnailUrl && !broken
  return (
    <div
      className={cn(
        "group relative shrink-0 flex items-center gap-1.5 h-10 pl-1 pr-2 rounded border bg-black/60",
        missing ? "border-red-500/50" : "border-primary/30"
      )}
      title={name}
    >
      <div className={cn(
        "w-8 h-8 rounded overflow-hidden shrink-0 flex items-center justify-center",
        missing ? "bg-red-500/20" : "bg-black/60"
      )}>
        {missing ? (
          <X className="w-4 h-4 text-red-500/80" />
        ) : showImg ? (
          <img src={thumbnailUrl!} alt={name} className="w-full h-full object-cover" onError={() => setBroken(true)} />
        ) : (
          <ImageIcon className="w-3 h-3 text-primary/30" />
        )}
      </div>
      <div className="flex flex-col">
        <span className={cn(
          "text-[9px] font-mono max-w-[60px] truncate leading-tight",
          missing ? "text-red-400" : "text-primary/70"
        )}>{missing ? 'Missing' : name}</span>
        {!missing && imageCount > 1 && (
          <span className="text-[8px] font-mono text-amber-400/50 leading-tight">×{imageCount}</span>
        )}
      </div>
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          className={cn(
            'absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center rounded-full',
            'bg-black/80 text-red-400/80 hover:text-red-400 border border-red-400/30',
            'opacity-0 group-hover:opacity-100 transition-opacity',
          )}
          title={`Remove ${name}`}
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  )
}
