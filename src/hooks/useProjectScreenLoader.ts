import { useEffect, useRef } from 'react'

interface ProjectScreenLoaderOptions {
  active: boolean
  load: () => Promise<void>
}

export function useProjectScreenLoader({
  active,
  load,
}: ProjectScreenLoaderOptions) {
  const loadedForVisit = useRef(false)

  useEffect(() => {
    if (!active) {
      loadedForVisit.current = false
      return
    }
    if (loadedForVisit.current) return
    loadedForVisit.current = true
    void load().catch(() => {
      loadedForVisit.current = false
    })
  }, [active, load])
}
