import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Check, ChevronDown, Phone, WandSparkles } from 'lucide-react'
import type { ChatModelOption } from '@/videobook/chat-models'
import type { VoiceConversation } from '@/videobook/use-voice-conversation'
import type { VoicePhase } from '../../../server/src/voice-contract'
import { composerActivityStatus } from '@/videobook/composer-status'
import { usePhoneRing } from '@/videobook/use-phone-ring'
import {
  chatModelMenu,
  engineMenuInitialIndex,
  engineMenuItems,
  engineMenuStep,
  speechMenu,
  voiceModeLabel,
  type EngineMenuChoice,
  type EngineMenuGroup,
} from '@/videobook/composer-engine-menu'
import './ComposerModeSwitch.css'

// Two split buttons on the actions button's 32px tier. The voice half is a
// phone: click it and it rings over line static while the call connects, stays
// lit while you are on the line, and turns over into a hang-up on hover. Its
// chevron picks the speech provider. The text half is the send button joined to
// the chat model's menu, so the assistant you are typing to is named where you
// send to it.

export interface ComposerModeSwitchProps {
  chatModels: readonly ChatModelOption[]
  selectedModel: string
  modelSelectionDisabled: boolean
  sending: boolean
  context?: { description: string; label: string } | null
  voice?: VoiceConversation
  sendButton?: ReactNode
  onModelChange: (model: string) => void
  onToggleVoice: () => void
}

interface EngineMenuState {
  rootRef: RefObject<HTMLDivElement | null>
  triggerRef: RefObject<HTMLButtonElement | null>
  menuRef: RefObject<HTMLUListElement | null>
  open: boolean
  index: number
  toggle: () => void
  close: (restoreFocus: boolean) => void
  handleKey: (event: ReactKeyboardEvent<HTMLUListElement>) => void
}

interface EnginePickerProps {
  label: string
  menuLabel: string
  title?: string
  name: string
  icon?: ReactNode
  groups: readonly EngineMenuGroup[]
  disabled: boolean
  voicePhase?: string
  onChoose: (choice: EngineMenuChoice) => void
}

const MENU_ITEM_SELECTOR = 'button[role="menuitemradio"]'

function menuButtons(list: HTMLUListElement | null): HTMLButtonElement[] {
  return Array.from(list?.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR) ?? [])
}

function useEngineMenu(groups: readonly EngineMenuGroup[]): EngineMenuState {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const items = engineMenuItems(groups)

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
      triggerRef.current?.focus()
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

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const toggle = () => {
    if (open) { close(true); return }
    setIndex(engineMenuInitialIndex(items))
    setOpen(true)
  }

  const handleKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const next = engineMenuStep(items, index, event.key)
    if (next === null) return
    event.preventDefault()
    setIndex(next)
    menuButtons(menuRef.current)[next]?.focus()
  }

  return { rootRef, triggerRef, menuRef, open, index, toggle, close, handleKey }
}

function EngineMenuList({ menuRef, index, label, groups, onKeyDown, onPick }: {
  menuRef: RefObject<HTMLUListElement | null>
  index: number
  label: string
  groups: readonly EngineMenuGroup[]
  onKeyDown: (event: ReactKeyboardEvent<HTMLUListElement>) => void
  onPick: (choice: EngineMenuChoice) => void
}) {
  return <ul
    ref={menuRef}
    className="composer-engine-menu"
    role="menu"
    aria-label={label}
    onKeyDown={onKeyDown}
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
            onClick={() => onPick(item.choice)}
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
  </ul>
}

function EnginePicker({ label, menuLabel, title, name, icon, groups, disabled, voicePhase, onChoose }: EnginePickerProps) {
  const { rootRef, triggerRef, menuRef, open, index, toggle, close, handleKey } = useEngineMenu(groups)
  const closed = disabled || groups.length === 0
  const pick = (choice: EngineMenuChoice) => {
    onChoose(choice)
    close(true)
  }
  return <div ref={rootRef} className="composer-picker" data-open={open || undefined}>
    <button
      ref={triggerRef}
      type="button"
      className="composer-mode-cell composer-mode-picker"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      data-voice-phase={voicePhase}
      disabled={closed}
      title={title}
      onClick={toggle}
    >
      {icon}
      <span className="composer-mode-engine">{name}</span>
      {!closed && <ChevronDown size={11} aria-hidden="true" />}
    </button>
    {open && <EngineMenuList
      menuRef={menuRef}
      index={index}
      label={menuLabel}
      groups={groups}
      onKeyDown={handleKey}
      onPick={pick}
    />}
  </div>
}

function PhoneButton({ meterRef, phase, active, disabled, statusId, title, onToggle }: {
  meterRef: RefObject<HTMLButtonElement | null>
  phase: VoicePhase
  active: boolean
  disabled: boolean
  statusId: string
  title: string
  onToggle: () => void
}) {
  usePhoneRing(phase === 'connecting')
  return <button
    ref={meterRef}
    type="button"
    className="composer-mode-cell composer-phone"
    data-voice-phase={phase}
    aria-label={active ? 'Stop voice conversation' : 'Start voice conversation'}
    aria-describedby={statusId}
    aria-pressed={active}
    aria-busy={phase === 'connecting'}
    disabled={!active && disabled}
    title={title}
    onClick={onToggle}
  >
    <Phone className="composer-phone-handset" size={15} aria-hidden="true" />
  </button>
}

function voiceTitle(active: boolean, statusLabel: string, engineName: string, fallbackReason: string | undefined): string {
  if (!active) return 'Call: voice input + spoken replies'
  return [statusLabel, engineName, fallbackReason, 'Click to hang up'].filter(Boolean).join(' · ')
}

export function ComposerModeSwitch({
  chatModels,
  selectedModel,
  modelSelectionDisabled,
  sending,
  context,
  voice,
  sendButton,
  onModelChange,
  onToggleVoice,
}: ComposerModeSwitchProps) {
  const voiceStatusId = useId()
  const meterRef = voice?.meterRef
  const voicePhase = voice?.phase ?? 'off'
  const voiceActive = Boolean(voice?.active)
  const voiceDisabled = Boolean(voice?.disabled)
  const voiceMode = voice?.mode ?? 'auto'
  const voiceEngineName = voiceModeLabel(voiceActive ? voice?.provider ?? voiceMode : voiceMode)
  const voiceStatus = composerActivityStatus({
    sending: false,
    mcpRunning: 0,
    voicePhase: voice?.phase,
    voiceMessage: voice?.message,
    retrying: voice?.retrying,
    pendingReview: voice?.pendingReview,
  })
  const modelGroups = chatModelMenu({ chatModels, selectedModel, modelSelectable: !context })
  const selectedModelOption = chatModels.find((model) => model.id === selectedModel) ?? chatModels[0]
  const engineName = context ? context.label : selectedModelOption?.label ?? selectedModel
  const engineTitle = context ? context.description : selectedModelOption?.description

  const chooseModel = (choice: EngineMenuChoice) => {
    if (choice.kind === 'model') onModelChange(choice.model)
  }
  const callTitle = voiceTitle(voiceActive, voiceStatus.label, voiceEngineName, voice?.fallbackReason)
  const chooseSpeech = (choice: EngineMenuChoice) => {
    if (choice.kind === 'speech') voice?.selectMode(choice.mode)
  }

  return <div className="composer-mode-switch" role="group" aria-label="Input mode">
    {voice && meterRef && <div className="composer-mode-line composer-voice-line" role="group" aria-label="Voice call">
      <PhoneButton
        meterRef={meterRef}
        phase={voicePhase}
        active={voiceActive}
        disabled={voiceDisabled || sending}
        statusId={voiceStatusId}
        title={callTitle}
        onToggle={onToggleVoice}
      />
      <EnginePicker
        label="Voice provider"
        menuLabel="Voice provider"
        title={callTitle}
        name={voiceEngineName}
        groups={speechMenu(voiceMode)}
        disabled={sending}
        voicePhase={voicePhase}
        onChoose={chooseSpeech}
      />
      <span id={voiceStatusId} className="sr-only" role="status">{voiceStatus.label}</span>
    </div>}

    <div className="composer-mode-line composer-text-line" role="group" aria-label="Text message">
      {sendButton}
      <EnginePicker
        label={context ? 'Composer context' : 'Chat model'}
        menuLabel="Chat model"
        title={engineTitle}
        name={engineName}
        icon={context ? <WandSparkles size={13} aria-hidden="true" /> : undefined}
        groups={modelGroups}
        disabled={modelSelectionDisabled || sending}
        onChoose={chooseModel}
      />
    </div>
  </div>
}
