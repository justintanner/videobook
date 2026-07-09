import { Loader2, RefreshCw, X } from 'lucide-react'
import { GenField } from '@/components/ui/GenField'
import type { GenTheme } from './gen-themes'
import { genThemes } from './gen-themes'
import { cn } from '@/lib/utils'
import {
  useGoogleFlowEntities,
  type GoogleFlowEntityOption,
} from '@/hooks/useGoogleFlowEntities'
import type { UseMcpResult } from 'use-mcp/react'

interface GoogleFlowRefPickerProps {
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
}

function optionLabel(e: GoogleFlowEntityOption): string {
  if (e.displayName === e.ref) return e.ref
  if (e.source === 'system') return e.displayName
  const short = e.ref.length > 24 ? `${e.ref.slice(0, 24)}…` : e.ref
  return `${e.displayName} · ${short}`
}

export function GoogleFlowRefPicker({
  label,
  value,
  onChange,
  maxItems = 5,
  required,
  disabled,
  theme,
  callTool,
  mcpState,
  description,
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
  } = useGoogleFlowEntities('voice', callTool, mcpState)

  const selected = value.filter(Boolean)
  const atCap = selected.length >= maxItems
  const selectedSet = new Set(selected)
  const availableSystem = systemEntities.filter((e) => !selectedSet.has(e.ref))
  const availableUser = userEntities.filter((e) => !selectedSet.has(e.ref))

  const t = theme ?? genThemes.video

  function addRef(ref: string) {
    if (!ref || selectedSet.has(ref) || atCap) return
    onChange([...selected, ref])
  }

  function removeRef(ref: string) {
    onChange(selected.filter((r) => r !== ref))
  }

  const placeholder =
    atCap
      ? `Max ${maxItems}`
      : loading
        ? 'Loading…'
        : loaded
          ? 'Add voice…'
          : 'Load voices…'

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
            title="Refresh voices"
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
