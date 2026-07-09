import { useEffect, useState } from 'react'
import { Loader2, Plus, RefreshCw, Trash2, User, X } from 'lucide-react'
import { GenField } from '@/components/ui/GenField'
import { AssetDropSlot } from '@/components/ui/AssetDropSlot'
import type { GenTheme } from './gen-themes'
import { genThemes } from './gen-themes'
import { cn } from '@/lib/utils'
import {
  useGoogleFlowEntities,
  type GoogleFlowEntityKind,
  type GoogleFlowEntityOption,
} from '@/hooks/useGoogleFlowEntities'
import type { ResolvedAsset } from '@/components/gen/types'
import type { UseMcpResult } from 'use-mcp/react'
import {
  nameFromAsset,
  resolveSlugToAsset,
  seedSlotsFromCandidates,
  type SlotAsset,
} from './google-flow-character-slots'

interface GoogleFlowRefPickerProps {
  kind: GoogleFlowEntityKind
  label: string
  value: string[]
  onChange: (refs: string[]) => void
  maxItems?: number
  required?: boolean
  disabled?: boolean
  theme?: GenTheme
  callTool?: UseMcpResult['callTool']
  mcpState?: UseMcpResult['state']
  description?: string
  projectSlug?: string
  /** Up to 2 image @slugs used to seed create slots when opening create. */
  imageSlugCandidates?: string[]
  resolvedAssets?: ResolvedAsset[]
  droppedAssets?: Map<string, ResolvedAsset>
}

function optionLabel(e: GoogleFlowEntityOption): string {
  if (e.displayName === e.ref) return e.ref
  if (e.source === 'system') return e.displayName
  const short = e.ref.length > 24 ? `${e.ref.slice(0, 24)}…` : e.ref
  return `${e.displayName} · ${short}`
}

function displayNameForRef(
  ref: string,
  entities: GoogleFlowEntityOption[],
  overrides?: Map<string, { displayName?: string; thumbnailUrl?: string | null }>,
): string {
  const override = overrides?.get(ref)
  if (override?.displayName?.trim()) return override.displayName.trim()
  const match = entities.find((e) => e.ref === ref)
  if (match?.displayName && match.displayName !== ref) return match.displayName
  // Avoid showing raw user:… ids as the primary label while still loading.
  if (ref.startsWith('user:') || ref.includes('-character:')) return 'Character'
  if (ref.length > 22) return `${ref.slice(0, 22)}…`
  return ref
}

function thumbForRef(
  ref: string,
  entities: GoogleFlowEntityOption[],
  overrides?: Map<string, { displayName?: string; thumbnailUrl?: string | null }>,
): string | null {
  const override = overrides?.get(ref)
  if (override?.thumbnailUrl) return override.thumbnailUrl
  const match = entities.find((e) => e.ref === ref)
  return match?.thumbnailUrl ?? null
}

function CharacterThumb({
  name,
  src,
  theme,
}: {
  name: string
  src: string | null
  theme: GenTheme
}) {
  const [broken, setBroken] = useState(false)
  const showImg = !!src && !broken
  return (
    <div
      className={cn(
        'w-10 h-10 shrink-0 rounded border overflow-hidden bg-black/60 flex items-center justify-center',
        theme.controlBorder,
      )}
    >
      {showImg ? (
        <img
          src={src}
          alt=""
          className="w-full h-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <User className={cn('w-4 h-4', theme.inactiveText)} aria-hidden />
      )}
      <span className="sr-only">{name}</span>
    </div>
  )
}

export function GoogleFlowRefPicker({
  kind,
  label,
  value,
  onChange,
  maxItems = kind === 'voice' ? 5 : 7,
  required,
  disabled,
  theme,
  callTool,
  mcpState,
  description,
  projectSlug,
  imageSlugCandidates = [],
  resolvedAssets,
  droppedAssets,
}: GoogleFlowRefPickerProps) {
  const {
    entities,
    systemEntities,
    userEntities,
    loading,
    loaded,
    error,
    refresh,
    ensureLoaded,
  } = useGoogleFlowEntities(kind, callTool, mcpState)

  const selected = value.filter(Boolean)
  const atCap = selected.length >= maxItems
  const selectedSet = new Set(selected)
  const available = entities.filter((e) => !selectedSet.has(e.ref))
  const availableSystem = systemEntities.filter((e) => !selectedSet.has(e.ref))
  const availableUser = userEntities.filter((e) => !selectedSet.has(e.ref))

  const [createOpen, setCreateOpen] = useState(() => kind === 'character' && selected.length === 0)
  const [createName, setCreateName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [primarySlot, setPrimarySlot] = useState<SlotAsset | null>(null)
  const [altSlot, setAltSlot] = useState<SlotAsset | null>(null)
  /** Local name/thumb overrides right after create (before list refresh). */
  const [localMeta, setLocalMeta] = useState<
    Map<string, { displayName?: string; thumbnailUrl?: string | null }>
  >(() => new Map())
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const t = theme ?? genThemes.video

  // Keep create open by default when nothing is selected.
  useEffect(() => {
    if (kind !== 'character') return
    if (selected.length === 0) setCreateOpen(true)
  }, [kind, selected.length])

  function addRef(ref: string) {
    if (!ref || selectedSet.has(ref) || atCap) return
    onChange([...selected, ref])
  }

  function removeRef(ref: string) {
    onChange(selected.filter((r) => r !== ref))
    setLocalMeta((prev) => {
      if (!prev.has(ref)) return prev
      const next = new Map(prev)
      next.delete(ref)
      return next
    })
  }

  function openCreate() {
    void ensureLoaded()
    const seeded = seedSlotsFromCandidates(
      imageSlugCandidates,
      resolvedAssets,
      droppedAssets,
      { primary: primarySlot, alt: altSlot },
    )
    setPrimarySlot(seeded.primary)
    setAltSlot(seeded.alt)
    if (!createName.trim()) {
      setCreateName(nameFromAsset(seeded.primary))
    }
    setCreateError(null)
    setCreateOpen(true)
  }

  function closeCreate() {
    if (selected.length === 0) return
    setCreateOpen(false)
    setCreateError(null)
  }

  function resetCreateSlots() {
    setPrimarySlot(null)
    setAltSlot(null)
    setCreateName('')
    setCreateError(null)
  }

  async function handleCreateCharacter() {
    if (!callTool || !projectSlug) return
    const images = [primarySlot?.slug, altSlot?.slug].filter((s): s is string => !!s && s.trim() !== '')
    if (images.length === 0) {
      setCreateError('Drop an image into Image 1')
      return
    }
    const displayName = createName.trim() || nameFromAsset(primarySlot) || 'Character'
    setCreating(true)
    setCreateError(null)
    try {
      const result = await callTool('create_google_flow_character', {
        project_slug: projectSlug,
        display_name: displayName,
        image_slugs: images,
      })
      const content = result.content as Array<{ type: string; text: string }> | undefined
      const text = content?.[0]?.text
      if (result.isError) {
        setCreateError(text ?? 'create_google_flow_character failed')
        return
      }
      if (!text) {
        setCreateError('create_google_flow_character returned no data')
        return
      }
      const parsed = JSON.parse(text) as {
        character_ref?: string
        display_name?: string
        source_images?: string[]
      }
      const ref = typeof parsed.character_ref === 'string' ? parsed.character_ref : ''
      const name = typeof parsed.display_name === 'string' && parsed.display_name.trim()
        ? parsed.display_name.trim()
        : displayName
      let localThumb: string | null = null
      const sourceId = Array.isArray(parsed.source_images) ? parsed.source_images[0] : undefined
      if (sourceId) {
        const asset = resolveSlugToAsset(sourceId, resolvedAssets, droppedAssets)
          ?? (primarySlot ? primarySlot : null)
        localThumb = asset?.thumbnailSrc || asset?.src || primarySlot?.thumbnailSrc || primarySlot?.src || null
      } else if (primarySlot) {
        localThumb = primarySlot.thumbnailSrc || primarySlot.src || null
      }
      if (ref) {
        setLocalMeta((prev) => {
          const next = new Map(prev)
          next.set(ref, { displayName: name, thumbnailUrl: localThumb })
          return next
        })
        if (!selectedSet.has(ref) && !atCap) {
          onChange([...selected, ref])
        }
      }
      await refresh()
      resetCreateSlots()
      if (selected.length > 0 || ref) setCreateOpen(false)
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(ref: string) {
    if (!callTool || !ref) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await callTool('delete_google_flow_character', { ref })
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined
        setDeleteError(content?.[0]?.text ?? 'delete_google_flow_character failed')
        return
      }
      if (selectedSet.has(ref)) onChange(selected.filter((r) => r !== ref))
      setLocalMeta((prev) => {
        if (!prev.has(ref)) return prev
        const next = new Map(prev)
        next.delete(ref)
        return next
      })
      setPendingDelete(null)
      await refresh()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }

  const canCreate =
    !disabled
    && !creating
    && !!callTool
    && !!projectSlug
    && !!primarySlot?.slug
    && !atCap

  // ── Character: selected + create + library ───────────────────────────────
  if (kind === 'character') {
    return (
      <GenField label={label} required={required} theme={theme} className="w-full min-w-[280px]">
        <div className="flex flex-col gap-3 w-full">
          {/* Selected */}
          {selected.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className={cn('text-[9px] font-mono uppercase tracking-wider', t.inactiveText)}>
                  Selected
                </div>
                <div className={cn('text-[9px] font-mono', t.inactiveText)}>
                  {selected.length}/{maxItems}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {selected.map((ref) => {
                  const name = displayNameForRef(ref, entities, localMeta)
                  const thumb = thumbForRef(ref, entities, localMeta)
                  return (
                    <div
                      key={ref}
                      title={ref}
                      className={cn(
                        'inline-flex items-center gap-2 max-w-full pl-0.5 pr-1.5 py-0.5 rounded border',
                        t.activeBg,
                        t.activeBorder,
                        'bg-black/40',
                      )}
                    >
                      {pendingDelete === ref ? (
                        <>
                          <span className={cn('truncate text-[10px] font-mono', t.activeText)}>Delete?</span>
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={() => void handleDelete(ref)}
                            className={cn('shrink-0 rounded p-0.5 hover:bg-red-500/30', 'text-red-300/90')}
                          >
                            {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                          </button>
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={() => setPendingDelete(null)}
                            className={cn('shrink-0 opacity-60 hover:opacity-100 rounded p-0.5', t.inactiveText)}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </>
                      ) : (
                        <>
                          <CharacterThumb name={name} src={thumb} theme={t} />
                          <span className={cn('truncate text-xs font-mono max-w-[9rem]', t.activeText)}>
                            {name}
                          </span>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => removeRef(ref)}
                            aria-label={`Remove ${name}`}
                            className={cn(
                              'shrink-0 opacity-60 hover:opacity-100 rounded p-0.5',
                              'hover:bg-red-500/30',
                              t.inactiveText,
                            )}
                          >
                            <X className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            disabled={disabled || deleting}
                            onClick={(e) => { e.stopPropagation(); setPendingDelete(ref) }}
                            aria-label={`Delete ${name}`}
                            title="Delete from Google Flow"
                            className={cn(
                              'shrink-0 opacity-60 hover:opacity-100 rounded p-0.5',
                              'hover:bg-red-500/30',
                              t.inactiveText,
                            )}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Create form */}
          {!atCap && (
            <div className="flex flex-col gap-1.5">
              {!createOpen ? (
                <button
                  type="button"
                  disabled={disabled || !callTool || !projectSlug}
                  onClick={openCreate}
                  className={cn(
                    'inline-flex items-center gap-1.5 self-start px-2.5 py-1.5 rounded border text-[10px] font-mono uppercase tracking-wider',
                    t.controlBorder,
                    t.inactiveText,
                    'hover:opacity-90 transition-opacity',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                  )}
                >
                  <Plus className="w-3 h-3" />
                  Add character
                </button>
              ) : (
                <div className={cn('flex flex-col gap-2 p-2.5 rounded border', t.controlBorder, 'bg-black/40')}>
                  <div className={cn('text-[10px] font-mono uppercase tracking-wider', t.activeText)}>
                    {selected.length === 0 ? 'Add character' : 'New character'}
                  </div>

                  <label className="block">
                    <div className={cn('text-[9px] font-mono uppercase tracking-wider mb-1', t.inactiveText)}>
                      Name
                    </div>
                    <input
                      type="text"
                      value={createName}
                      onChange={(e) => setCreateName(e.target.value)}
                      placeholder="Display name"
                      disabled={disabled || creating}
                      className={cn(
                        'w-full px-2 py-1.5 bg-black/60 rounded font-mono text-xs',
                        theme ? cn(theme.controlBorder, 'border', theme.valueText) : 'border border-primary/30 text-primary/90',
                        'focus:outline-none',
                        theme?.focusBorder ?? 'focus:border-primary/60',
                      )}
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="min-w-0">
                      <div className={cn('text-[9px] font-mono uppercase tracking-wider mb-1', t.inactiveText)}>
                        Image 1
                      </div>
                      <AssetDropSlot
                        value={primarySlot}
                        onChange={(asset) => {
                          setPrimarySlot(asset)
                          if (asset && !createName.trim()) {
                            setCreateName(nameFromAsset(asset))
                          }
                        }}
                        disabled={disabled || creating}
                        acceptTypes={['image', 'character']}
                        square
                        variant="video"
                      />
                    </div>
                    <div className="min-w-0">
                      <div className={cn('text-[9px] font-mono uppercase tracking-wider mb-1', t.inactiveText)}>
                        Image 2 (optional)
                      </div>
                      <AssetDropSlot
                        value={altSlot}
                        onChange={setAltSlot}
                        disabled={disabled || creating}
                        acceptTypes={['image', 'character']}
                        square
                        variant="video"
                      />
                    </div>
                  </div>

                  <div className={cn('text-[9px] font-mono', t.inactiveText)}>
                    Drop 1–2 reference images from the sidebar. Image 1 is required.
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={!canCreate}
                      onClick={() => void handleCreateCharacter()}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-[10px] font-mono uppercase tracking-wider transition-colors',
                        canCreate
                          ? cn(t.activeBg, t.activeBorder, t.activeText, 'hover:opacity-90')
                          : 'border-zinc-700 text-zinc-500 cursor-not-allowed bg-zinc-900/40',
                      )}
                    >
                      {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                      {creating ? 'Creating…' : 'Create character'}
                    </button>
                    {selected.length > 0 && (
                      <button
                        type="button"
                        disabled={creating}
                        onClick={closeCreate}
                        className={cn(
                          'px-2 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider',
                          t.inactiveText,
                          'hover:opacity-90',
                        )}
                      >
                        Cancel
                      </button>
                    )}
                  </div>

                  {createError && (
                    <div className="text-[9px] font-mono text-amber-300/80">{createError}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Your characters library */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className={cn('text-[9px] font-mono uppercase tracking-wider', t.inactiveText)}>
                Your characters
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={disabled || loading || !callTool}
                title="Refresh characters"
                className={cn(
                  'flex items-center justify-center w-6 h-6 rounded border shrink-0',
                  t.controlBorder,
                  t.inactiveText,
                  'hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              </button>
            </div>

            {loading && !loaded && (
              <div className={cn('text-[10px] font-mono', t.inactiveText)}>Loading characters…</div>
            )}

            {loaded && available.length === 0 && (
              <div className={cn('text-[10px] font-mono', t.inactiveText)}>
                {entities.length === 0
                  ? 'None yet — create one above'
                  : atCap
                    ? `Max ${maxItems} selected`
                    : 'All characters are already selected'}
              </div>
            )}

            {available.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {available.map((e) => {
                  const name = e.displayName && e.displayName !== e.ref ? e.displayName : 'Character'
                  return (
                    pendingDelete === e.ref ? (
                        <div
                          className={cn(
                            'inline-flex items-center gap-2 max-w-full pl-0.5 pr-1.5 py-0.5 rounded border',
                            t.controlBorder,
                            'bg-black/40',
                          )}
                        >
                          <span className={cn('truncate text-[10px] font-mono', t.valueText)}>Delete?</span>
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={() => void handleDelete(e.ref)}
                            className={cn('shrink-0 rounded p-0.5 hover:bg-red-500/30', 'text-red-300/90')}
                          >
                            {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                          </button>
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={() => setPendingDelete(null)}
                            className={cn('shrink-0 opacity-60 hover:opacity-100 rounded p-0.5', t.inactiveText)}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <div
                          title={e.ref}
                          onClick={() => { if (!disabled && !atCap) addRef(e.ref) }}
                          className={cn(
                            'inline-flex items-center gap-2 max-w-full pl-0.5 pr-1.5 py-0.5 rounded border text-left cursor-pointer',
                            t.controlBorder,
                            'bg-black/30 hover:opacity-90 transition-opacity',
                            (disabled || atCap) && 'opacity-40 cursor-not-allowed',
                          )}
                        >
                          <CharacterThumb name={name} src={e.thumbnailUrl ?? null} theme={t} />
                          <span className={cn('truncate text-xs font-mono max-w-[9rem]', t.valueText)}>
                            {name}
                          </span>
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={(ev) => { ev.stopPropagation(); setPendingDelete(e.ref) }}
                            aria-label={`Delete ${name}`}
                            title="Delete from Google Flow"
                            className={cn('shrink-0 opacity-60 hover:opacity-100 rounded p-0.5 hover:bg-red-500/30', t.inactiveText)}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                    )
                  )
                })}
              </div>
            )}
          </div>

          {(deleteError || error || description) && (
            <div className={cn('text-[9px] font-mono', (deleteError || error) ? 'text-amber-300/80' : 'text-muted-foreground/70')}>
              {deleteError ?? error ?? description}
            </div>
          )}
        </div>
      </GenField>
    )
  }

  // ── Voice (select + chips) ───────────────────────────────────────────────
  const placeholder =
    atCap
      ? `Max ${maxItems}`
      : loading
        ? 'Loading…'
        : loaded
          ? `Add ${kind}…`
          : `Load ${kind}s…`

  return (
    <GenField label={label} required={required} theme={theme} className="w-full min-w-[220px]">
      <div className="flex flex-col gap-1.5 w-full">
        <div className="flex items-center gap-1.5">
          <select
            value=""
            disabled={disabled || atCap || !callTool}
            onFocus={() => void ensureLoaded()}
            onPointerDown={() => void ensureLoaded()}
            onChange={(e) => {
              const v = e.target.value
              if (v) addRef(v)
              e.target.value = ''
            }}
            className={cn(
              'flex-1 min-w-0 px-2 py-1.5 bg-black/60 rounded font-mono text-xs appearance-none cursor-pointer',
              theme ? cn(theme.controlBorder, 'border', theme.valueText) : 'border border-primary/30 text-primary/90',
              'focus:outline-none',
              theme?.focusBorder ?? 'focus:border-primary/60',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            <option value="">{placeholder}</option>
            {availableSystem.length > 0 && (
              <optgroup label="System">
                {availableSystem.map((e) => (
                  <option key={e.ref} value={e.ref}>{optionLabel(e)}</option>
                ))}
              </optgroup>
            )}
            {availableUser.length > 0 && (
              <optgroup label="Custom">
                {availableUser.map((e) => (
                  <option key={e.ref} value={e.ref}>{optionLabel(e)}</option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={disabled || loading || !callTool}
            title={`Refresh ${kind}s`}
            className={cn(
              'flex items-center justify-center w-7 h-7 rounded border shrink-0',
              t.controlBorder,
              t.inactiveText,
              'hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          </button>
        </div>

        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selected.map((ref) => {
              const match = entities.find((e) => e.ref === ref)
              const labelText = match?.displayName && match.displayName !== ref
                ? match.displayName
                : ref.length > 28
                  ? `${ref.slice(0, 28)}…`
                  : ref
              return (
                <span
                  key={ref}
                  title={ref}
                  className={cn(
                    'inline-flex items-center gap-1 max-w-full px-1.5 py-0.5 rounded font-mono text-[10px]',
                    t.activeBg,
                    t.activeBorder,
                    'border',
                    t.activeText,
                  )}
                >
                  <span className="truncate">{labelText}</span>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => removeRef(ref)}
                    aria-label={`Remove ${ref}`}
                    className="shrink-0 opacity-70 hover:opacity-100"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )
            })}
          </div>
        )}

        {(error || description) && (
          <div className={cn('text-[9px] font-mono', error ? 'text-amber-300/80' : 'text-muted-foreground/70')}>
            {error ?? description}
          </div>
        )}
      </div>
    </GenField>
  )
}
