import { useEffect } from 'react'
import phoneRingUrl from '@/assets/phone-ring.mp3'

const PHONE_RING_VOLUME = 0.35

export function usePhoneRing(ringing: boolean): void {
  useEffect(() => {
    if (!ringing) return
    const audio = new Audio(phoneRingUrl)
    audio.loop = true
    audio.volume = PHONE_RING_VOLUME
    void audio.play().catch(() => undefined)
    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }, [ringing])
}
