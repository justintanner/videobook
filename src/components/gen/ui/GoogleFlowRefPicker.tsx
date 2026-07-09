import { useState } from 'react'
import { Loader2, Plus, RefreshCw, User, X, Swords } from 'lucide-react'
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
  /** Up to 2 image @slugs used to seed forge slots when opening create. */
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

function displayNameForRef(ref: string, entities: GoogleFlowEntityOption[]): string {
  const match = entities.find((e) => e.ref === ref)
  if (match?.displayName && match.displayName !== ref) return match.displayName
  if (ref.length > 18) return `${ref.slice(0, 18)}…`
  return ref
}

function portraitGlyph(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const letter = trimmed.replace(/^@/, '')[0]
  return letter ? letter.toUpperCase() : '?'
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

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [primarySlot, setPrimarySlot] = useState<SlotAsset | null>(null)
  const [altSlot, setAltSlot] = useState<SlotAsset | null>(null)

  const t = theme ?? genThemes.video

  function addRef(ref: string) {
    if (!ref || selectedSet.has(ref) || atCap) return
    onChange([...selected, ref])
  }

  function removeRef(ref: string) {
    onChange(selected.filter((r) => r !== ref))
  }

  function openForge() {
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

  function closeForge() {
    setCreateOpen(false)
    setCreateError(null)
    setCreating(false)
  }

  function resetForgeSlots() {
    setPrimarySlot(null)
    setAltSlot(null)
    setCreateName('')
    setCreateError(null)
  }

  async function handleCreateCharacter() {
    if (!callTool || !projectSlug) return
    const images = [primarySlot?.slug, altSlot?.slug].filter((s): s is string => !!s && s.trim() !== '')
    if (images.length === 0) {
      setCreateError('Drop a primary image into Slot 01')
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
      const parsed = JSON.parse(text) as { character_ref?: string }
      const ref = typeof parsed.character_ref === 'string' ? parsed.character_ref : ''
      await refresh()
      if (ref && !selectedSet.has(ref) && !atCap) {
        onChange([...selected, ref])
      }
      resetForgeSlots()
      setCreateOpen(false)
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const placeholder =
    atCap
      ? `Max ${maxItems}`
      : loading
        ? 'Loading…'
        : loaded
          ? kind === 'character'
            ? 'Recruit character…'
            : `Add ${kind}…`
          : kind === 'character'
            ? 'Load roster…'
            : `Load ${kind}s…`

  const canForge =
    !disabled
    && !creating
    && !!callTool
    && !!projectSlug
    && !!primarySlot?.slug
    && !atCap

  // ── Character: party roster + forge ──────────────────────────────────────
  if (kind === 'character') {
    return (
      <GenField label={label} required={required} theme={theme} className="w-full min-w-[280px]">
        <div className="flex flex-col gap-2.5 w-full">
          {/* Party header */}
          <div className="flex items-center justify-between gap-2">
            <div className={cn('text-[9px] font-mono uppercase tracking-[0.2em]', t.inactiveText)}>
              Party
            </div>
            <div
              className={cn(
                'px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase tracking-wider',
                atCap ? cn(t.activeBg, t.activeBorder, t.activeText) : cn(t.controlBorder, t.inactiveText),
              )}
            >
              {selected.length}/{maxItems}
            </div>
          </div>

          {/* Party strip */}
          <div className="flex flex-wrap gap-2">
            {selected.map((ref) => {
              const name = displayNameForRef(ref, entities)
              return (
                <div
                  key={ref}
                  title={ref}
                  className={cn(
                    'group relative flex flex-col items-center w-[4.5rem] rounded border overflow-hidden',
                    t.activeBg,
                    t.activeBorder,
                    'bg-black/50',
                  )}
                  style={{ boxShadow: t.activeGlow }}
                >
                  <div
                    className={cn(
                      'w-full aspect-square flex items-center justify-center',
                      'bg-gradient-to-b from-violet-500/20 to-black/80',
                      'border-b',
                      t.activeBorder,
                    )}
                  >
                    <span className={cn('text-xl font-mono font-bold', t.activeText)}>
                      {portraitGlyph(name)}
                    </span>
                  </div>
                  <div className="w-full px-1 py-1 flex items-center gap-0.5">
                    <span className={cn('flex-1 min-w-0 truncate text-[9px] font-mono font-bold', t.activeText)}>
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
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                </div>
              )
            })}

            {!atCap && (
              <button
                type="button"
                disabled={disabled || !callTool || !projectSlug}
                onClick={openForge}
                title="Forge new character"
                className={cn(
                  'flex flex-col items-center justify-center w-[4.5rem] aspect-[3/4] rounded border border-dashed',
                  t.controlBorder,
                  t.inactiveText,
                  'hover:border-violet-400/50 hover:text-violet-200/90 transition-colors',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  'bg-black/30',
                )}
              >
                <Plus className="w-4 h-4 mb-1" />
                <span className="text-[8px] font-mono uppercase tracking-wider">Forge</span>
              </button>
            )}

            {selected.length === 0 && (
              <div className={cn('flex-1 min-w-[8rem] self-center text-[9px] font-mono', t.inactiveText)}>
                No party members — forge one or recruit existing
              </div>
            )}
          </div>

          {/* Recruit existing */}
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
              {available.map((e) => (
                <option key={e.ref} value={e.ref}>{optionLabel(e)}</option>
              ))}
              {loaded && available.length === 0 && (
                <option value="" disabled>
                  No characters yet — forge one below
                </option>
              )}
            </select>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={disabled || loading || !callTool}
              title="Refresh roster"
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

          {/* Forge panel */}
          {!atCap && (
            <div className="flex flex-col gap-1">
              {!createOpen ? (
                <button
                  type="button"
                  disabled={disabled || !callTool || !projectSlug}
                  onClick={openForge}
                  className={cn(
                    'inline-flex items-center gap-1.5 self-start px-2.5 py-1.5 rounded border text-[10px] font-mono uppercase tracking-wider',
                    t.controlBorder,
                    t.inactiveText,
                    'hover:border-violet-400/50 hover:text-violet-100 transition-colors',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                  )}
                >
                  <Swords className="w-3 h-3" />
                  Forge character
                </button>
              ) : (
                <div
                  className={cn(
                    'relative flex flex-col gap-2.5 p-3 rounded border',
                    t.controlBorder,
                    'bg-black/50',
                  )}
                  style={primarySlot ? { boxShadow: t.activeGlow } : undefined}
                >
                  {/* Corner brackets */}
                  <div className={cn('pointer-events-none absolute top-1 left-1 w-2 h-2 border-t border-l', t.activeBorder)} />
                  <div className={cn('pointer-events-none absolute top-1 right-1 w-2 h-2 border-t border-r', t.activeBorder)} />
                  <div className={cn('pointer-events-none absolute bottom-1 left-1 w-2 h-2 border-b border-l', t.activeBorder)} />
                  <div className={cn('pointer-events-none absolute bottom-1 right-1 w-2 h-2 border-b border-r', t.activeBorder)} />

                  <div className="flex items-center gap-2">
                    <User className={cn('w-3.5 h-3.5', t.activeText)} />
                    <span className={cn('text-[10px] font-mono font-bold uppercase tracking-[0.18em]', t.activeText)}>
                      New character
                    </span>
                  </div>

                  <label className="block">
                    <div className={cn('text-[9px] font-mono uppercase tracking-wider mb-1', t.inactiveText)}>
                      Name plate
                    </div>
                    <input
                      type="text"
                      value={createName}
                      onChange={(e) => setCreateName(e.target.value)}
                      placeholder="Display name"
                      disabled={disabled || creating}
                      autoFocus
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
                      <div className={cn('text-[9px] font-mono uppercase tracking-[0.16em] mb-1', t.inactiveText)}>
                        Slot 01 · Primary
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
                      <div className={cn('text-[9px] font-mono uppercase tracking-[0.16em] mb-1', t.inactiveText)}>
                        Slot 02 · Alt
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
                    Drop 1–2 reference angles from the sidebar. Primary required.
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={!canForge}
                      onClick={() => void handleCreateCharacter()}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-[10px] font-mono uppercase tracking-wider transition-colors',
                        canForge
                          ? cn(t.activeBg, t.activeBorder, t.activeText, 'hover:opacity-90')
                          : 'border-zinc-700 text-zinc-500 cursor-not-allowed bg-zinc-900/40',
                      )}
                    >
                      {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Swords className="w-3 h-3" />}
                      {creating ? 'Forging…' : 'Forge'}
                    </button>
                    <button
                      type="button"
                      disabled={creating}
                      onClick={closeForge}
                      className={cn(
                        'px-2 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider',
                        t.inactiveText,
                        'hover:opacity-90',
                      )}
                    >
                      Cancel
                    </button>
                  </div>

                  {createError && (
                    <div className="text-[9px] font-mono text-amber-300/80">{createError}</div>
                  )}
                </div>
              )}
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

  // ── Voice (unchanged select + chips) ─────────────────────────────────────
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
