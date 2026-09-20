import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Check, ChevronDown, LoaderCircle, Mic, Type, WandSparkles } from 'lucide-react'
import type { ChatModelOption } from '@/videobook/chat-models'
import type { VoiceConversation } from '@/videobook/use-voice-conversation'
import { composerActivityStatus } from '@/videobook/composer-status'
import {
  composerEngineMenu,
  engineMenuInitialIndex,
  engineMenuItems,
  engineMenuStep,
  voiceModeLabel,
  type EngineMenuChoice,
  type EngineMenuGroup,
} from '@/videobook/composer-engine-menu'
import './ComposerModeSwitch.css'

// One strip on the same 32px tier as the actions button, in place of the old
// model select, provider select and 44px microphone circle. Exactly one cell is
// lit: it names the mode you are in AND carries that mode's engine inline, and
// its chevron opens the one menu that holds both engines. The other cell is a
// glyph-only button whose whole job is to switch mode — starting voice when you
// are typing, stopping it when you are talking — so the accessible names the
// microphone used to carry ride along with it.

export interface ComposerModeSwitchProps {
  chatModels: readonly ChatModelOption[]
  selectedModel: string
  modelSelectionDisabled: boolean
  sending: boolean
  context?: { description: string; label: string } | null
  voice?: VoiceConversation
  onModelChange: (model: string) => void
  onToggleVoice: () => void
}

const MENU_ITEM_SELECTOR = 'button[role="menuitemradio"]'
const LIVE_CELL_SELECTOR = '.composer-mode-cell-live'

function menuButtons(list: HTMLUListElement | null): HTMLButtonElement[] {
  return Array.from(list?.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR) ?? [])
}

function VoiceLevelMeter() {
  return <span className="composer-mode-meter" aria-hidden="true">
    <span /><span /><span />
  </span>
}

export function ComposerModeSwitch({
  chatModels,
  selectedModel,
  modelSelectionDisabled,
  sending,
  context,
  voice,
  onModelChange,
  onToggleVoice,
}: ComposerModeSwitchProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const voiceStatusId = useId()

  const meterRef = voice?.meterRef
  const voiceActive = Boolean(voice?.active)
  const voicePhase = voice?.phase
  const voiceDisabled = Boolean(voice?.disabled)
  const voiceStatus = composerActivityStatus({
    sending: false,
    mcpRunning: 0,
    voicePhase,
    voiceMessage: voice?.message,
    retrying: voice?.retrying,
    pendingReview: voice?.pendingReview,
  })
  const voiceEngineName = voiceModeLabel(voice?.provider ?? voice?.mode ?? 'auto')
  const voiceTitle = [voiceStatus.label, voiceEngineName, voice?.fallbackReason].filter(Boolean).join(' · ')
  const groups = composerEngineMenu({
    chatModels,
    selectedModel,
    modelSelectable: !context,
    voiceMode: voice?.mode ?? null,
  })
  const items = engineMenuItems(groups)
  const menuDisabled = items.length === 0 || modelSelectionDisabled || sending
  const selectedModelOption = chatModels.find((model) => model.id === selectedModel) ?? chatModels[0]
  const engineName = context ? context.label : selectedModelOption?.label ?? selectedModel
  const engineTitle = context ? context.description : selectedModelOption?.description

  // Whichever cell is lit is the cell that opened the menu, so focus goes back
  // to it by class rather than by a second ref onto the voice button, which
  // already carries the conversation's own meter ref.
  const focusLiveCell = () => {
    rootRef.current?.querySelector<HTMLButtonElement>(LIVE_CELL_SELECTOR)?.focus()
  }

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) focusLiveCell()
  }

  useEffect(() => {
    if (!open) return
    const root = rootRef.current
    const handleOutside = (event: PointerEvent | FocusEvent) => {
      if (root?.contains(event.target as Node)) return
      setOpen(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      root?.querySelector<HTMLButtonElement>(LIVE_CELL_SELECTOR)?.focus()
    }
    document.addEventListener('pointerdown', handleOutside)
    document.addEventListener('focusin', handleOutside)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handleOutside)
      document.removeEventListener('focusin', handleOutside)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])

  const toggleMenu = () => {
    if (open) { closeMenu(true); return }
    setIndex(engineMenuInitialIndex(items))
    setOpen(true)
  }

  const choose = (choice: EngineMenuChoice) => {
    if (choice.kind === 'model') onModelChange(choice.model)
    else voice?.selectMode(choice.mode)
    closeMenu(true)
  }

  const handleMenuKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const next = engineMenuStep(items, index, event.key)
    if (next === null) return
    event.preventDefault()
    setIndex(next)
    menuButtons(menuRef.current)[next]?.focus()
  }

  const liveCellProps = {
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    className: 'composer-mode-cell composer-mode-cell-live',
    disabled: menuDisabled,
    onClick: toggleMenu,
  } as const

  return <div ref={rootRef} className="composer-mode-switch" role="group" aria-label="Input mode">
    {voiceActive
      ? <button
          type="button"
          className="composer-mode-cell composer-mode-cell-idle"
          aria-label="Stop voice conversation"
          aria-pressed={true}
          title="Stop microphone and spoken replies"
          onClick={onToggleVoice}
        >
          <Type size={14} aria-hidden="true" />
        </button>
      : <button
          {...liveCellProps}
          type="button"
          aria-label={context ? 'Composer context' : 'Chat model'}
          title={engineTitle}
        >
          {context
            ? <WandSparkles size={13} aria-hidden="true" />
            : <Type size={14} aria-hidden="true" />}
          <span className="composer-mode-name">TEXT</span>
          <span className="composer-mode-divider" aria-hidden="true">·</span>
          <span className="composer-mode-engine">{engineName}</span>
          {!menuDisabled && <ChevronDown size={11} aria-hidden="true" />}
        </button>}

    {voice && (voiceActive
      ? <button
          {...liveCellProps}
          ref={meterRef}
          type="button"
          data-voice-phase={voicePhase}
          aria-label="Voice provider"
          aria-describedby={voiceStatusId}
          aria-busy={voicePhase === 'connecting'}
          title={voiceTitle}
        >
          {voicePhase === 'connecting'
            ? <LoaderCircle className="composer-mode-connecting" size={14} aria-hidden="true" />
            : <VoiceLevelMeter />}
          <span className="composer-mode-name">VOICE</span>
          <span className="composer-mode-divider" aria-hidden="true">·</span>
          <span className="composer-mode-engine">{voicePhase === 'connecting' ? voiceStatus.label : voiceEngineName}</span>
          {!menuDisabled && <ChevronDown size={11} aria-hidden="true" />}
        </button>
      : <button
          ref={meterRef}
          type="button"
          className="composer-mode-cell composer-mode-cell-idle"
          data-voice-phase={voicePhase}
          aria-label="Start voice conversation"
          aria-describedby={voiceStatusId}
          aria-pressed={false}
          disabled={voiceDisabled || sending}
          title="Voice input + spoken replies"
          onClick={onToggleVoice}
        >
          <Mic size={15} aria-hidden="true" />
        </button>)}

    {voice && <span id={voiceStatusId} className="sr-only" role="status">{voiceStatus.label}</span>}

    {open && <ul
      ref={menuRef}
      className="composer-engine-menu"
      role="menu"
      aria-label="Chat model and voice provider"
      onKeyDown={handleMenuKey}
    >
      {groups.map((group: EngineMenuGroup) => [
        <li key={`${group.id}-label`} role="presentation" className="composer-engine-group">{group.label}</li>,
        ...group.items.map((item) => {
          // The option is named by its label alone, so it is addressable and so
          // a reader hears "Astra", not the whole row; the raw id and the note
          // ride along as its description.
          const noteId = `${item.id.replace(':', '-')}-note`
          return <li key={item.id} role="none">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={item.checked}
              aria-label={item.label}
              aria-describedby={item.note ? noteId : undefined}
              autoFocus={item.position === index}
              tabIndex={item.position === index ? 0 : -1}
              className="composer-engine-item"
              onClick={() => choose(item.choice)}
            >
              <span className="composer-engine-check" aria-hidden="true">
                {item.checked && <Check size={13} />}
              </span>
              <span className="composer-engine-copy">
                <span className="composer-engine-head">
                  <strong>{item.label}</strong>
                  {item.detail && <small>{item.detail}</small>}
                </span>
                {item.note && <small id={noteId} className="composer-engine-note">{item.note}</small>}
              </span>
            </button>
          </li>
        }),
      ])}
    </ul>}
  </div>
}
