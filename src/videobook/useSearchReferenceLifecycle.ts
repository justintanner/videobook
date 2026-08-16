import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import { releaseSearchReference } from './search-reference'
import {
  createSearchReferenceLifecycle,
  initialSearchReferenceLifecycleState,
  type SearchReferenceLifecycle,
  type SearchReferenceLifecycleState,
  type SearchReferenceMode,
} from './search-reference-lifecycle'

export function useSearchReferenceLifecycle(
  initialMode: SearchReferenceMode = 'text',
) {
  const [state, setState] = useState<SearchReferenceLifecycleState>(() =>
    initialSearchReferenceLifecycleState(initialMode))
  const [lifecycle] = useState<SearchReferenceLifecycle>(() =>
    createSearchReferenceLifecycle({
      initialMode,
      onStateChange: setState,
      release: releaseSearchReference,
    }))

  useEffect(() => () => {
    lifecycle.stop()
  }, [lifecycle])

  return useMemo(() => ({ state, lifecycle }), [lifecycle, state])
}
