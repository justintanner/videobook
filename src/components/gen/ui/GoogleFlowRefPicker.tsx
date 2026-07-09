import { useState } from 'react'
import { Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { GenField } from '@/components/ui/GenField'
import type { GenTheme } from './gen-themes'
import { genThemes } from './gen-themes'
import { cn } from '@/lib/utils'
import {
  useGoogleFlowEntities,
  type GoogleFlowEntityKind,
  type GoogleFlowEntityOption,
} from '@/hooks/useGoogleFlowEntities'
import type { UseMcpResult } from 'use-mcp/react'

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
  /** Up to 2 image @slugs used when creating a character from this panel. */
  imageSlugCandidates?: string[]
}

function optionLabel(e: GoogleFlowEntityOption): string {
  if (e.displayName === e.ref) return e.ref
  if (e.source === 'system') return e.displayName
  const short = e.ref.length > 24 ? `${e.ref.slice(0, 24)}…` : e.ref
  return `${e.displayName} · ${short}`
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

  function addRef(ref: string) {
    if (!ref || selectedSet.has(ref) || atCap) return
    onChange([...selected, ref])
  }

  function removeRef(ref: string) {
    onChange(selected.filter((r) => r !== ref))
  }

  async function handleCreateCharacter() {
    if (!callTool || !projectSlug) return
    const images = imageSlugCandidates.filter(Boolean).slice(0, 2)
    if (images.length === 0) {
      setCreateError('Add a reference image or first frame first')
      return
    }
    const displayName = createName.trim() || images[0].replace(/^@?img-/, '') || 'Character'
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
      setCreateOpen(false)
      setCreateName('')
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const t = theme ?? genThemes.video
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
            {kind === 'voice' ? (
              <>
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
              </>
            ) : (
              available.map((e) => (
                <option key={e.ref} value={e.ref}>{optionLabel(e)}</option>
              ))
            )}
            {kind === 'character' && loaded && available.length === 0 && (
              <option value="" disabled>
                No characters yet — create one below
              </option>
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

        {kind === 'character' && !atCap && (
          <div className="flex flex-col gap-1">
            {!createOpen ? (
              <button
                type="button"
                disabled={disabled || !callTool || !projectSlug}
                onClick={() => {
                  void ensureLoaded()
                  setCreateOpen(true)
                  if (!createName && imageSlugCandidates[0]) {
                    setCreateName(imageSlugCandidates[0].replace(/^@?img-/, ''))
                  }
                }}
                className={cn(
                  'inline-flex items-center gap-1 self-start px-2 py-1 rounded border text-[10px] font-mono uppercase tracking-wider',
                  t.controlBorder,
                  t.inactiveText,
                  'hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                <Plus className="w-3 h-3" />
                Create character
              </button>
            ) : (
              <div className={cn('flex flex-col gap-1.5 p-2 rounded border', t.controlBorder, 'bg-black/40')}>
                <input
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="Display name"
                  disabled={disabled || creating}
                  className={cn(
                    'w-full px-2 py-1 bg-black/60 rounded font-mono text-xs',
                    theme ? cn(theme.controlBorder, 'border', theme.valueText) : 'border border-primary/30 text-primary/90',
                    'focus:outline-none',
                    theme?.focusBorder ?? 'focus:border-primary/60',
                  )}
                />
                <div className="text-[9px] font-mono text-muted-foreground/80">
                  {imageSlugCandidates.length > 0
                    ? `Images: ${imageSlugCandidates.slice(0, 2).join(', ')}`
                    : 'Add a reference image or first frame first'}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={
                      disabled
                      || creating
                      || !callTool
                      || !projectSlug
                      || imageSlugCandidates.length === 0
                    }
                    onClick={() => void handleCreateCharacter()}
                    className={cn(
                      'inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-mono uppercase tracking-wider',
                      t.activeBg,
                      t.activeBorder,
                      t.activeText,
                      'disabled:opacity-40 disabled:cursor-not-allowed',
                    )}
                  >
                    {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                    {creating ? 'Creating…' : 'Create'}
                  </button>
                  <button
                    type="button"
                    disabled={creating}
                    onClick={() => {
                      setCreateOpen(false)
                      setCreateError(null)
                    }}
                    className={cn(
                      'px-2 py-1 rounded text-[10px] font-mono uppercase tracking-wider',
                      t.inactiveText,
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
