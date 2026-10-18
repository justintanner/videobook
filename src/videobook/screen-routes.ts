export type Screen = 'notebook' | 'jobs' | 'settings'

const routedScreens: Record<Exclude<Screen, 'notebook'>, { path: string; name: string }> = {
  jobs: { path: '/jobs', name: 'Jobs' },
  settings: { path: '/settings', name: 'Settings' },
}

const routedScreenEntries = Object.entries(routedScreens) as Array<
  [Exclude<Screen, 'notebook'>, { path: string; name: string }]
>

export function screenFromPath(pathname: string): Screen {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  const match = routedScreenEntries.find(([, route]) => route.path === normalized)
  return match?.[0] ?? 'notebook'
}

export function pathForScreen(screen: Screen): string {
  return screen === 'notebook' ? '/' : routedScreens[screen].path
}

export function screenTitle(screen: Screen): string {
  return screen === 'notebook'
    ? 'VIDEOBOOK'
    : `${routedScreens[screen].name} · VIDEOBOOK`
}
