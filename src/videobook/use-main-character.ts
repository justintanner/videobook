import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { MainCharacterView } from './goals'

type CharacterRequest = (args: Record<string, unknown>) => Promise<MainCharacterView>

const SHEET_POLL_MS = 2_000
const SHEET_POLL_LIMIT = 150

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function useMainCharacter(request: CharacterRequest, wanted: boolean) {
  const [character, setCharacter] = useState<MainCharacterView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const polls = useRef(0)
  const read = useEffectEvent(async (current: () => boolean) => {
    try {
      const next = await request({})
      if (!current()) return
      setCharacter(next)
      setError(null)
    } catch (cause) {
      if (current()) setError(errorText(cause))
    }
  })

  useEffect(() => {
    if (!wanted) return
    let active = true
    polls.current = 0
    const timer = window.setTimeout(() => { void read(() => active) }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [wanted])

  useEffect(() => {
    if (!character?.sheet.pending || polls.current >= SHEET_POLL_LIMIT) return
    let active = true
    const timer = window.setTimeout(() => {
      polls.current += 1
      void read(() => active)
    }, SHEET_POLL_MS)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [character])

  const act = async (args: Record<string, unknown>) => {
    const next = await request(args)
    polls.current = 0
    setCharacter(next)
    setError(null)
    return next
  }

  return { character, error, act }
}
