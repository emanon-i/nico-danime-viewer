const THEME_KEY = 'nico-danime-theme'

export type Theme = 'dark' | 'light'

export const THEME_KEY_NAME = THEME_KEY

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement
  // reduced-motion 時は View Transitions をスキップして即時切替（§6.3 / §17.6）
  if (typeof document.startViewTransition === 'function' && !prefersReducedMotion()) {
    void document.startViewTransition(() => {
      root.dataset.theme = theme
    })
  } else {
    root.dataset.theme = theme
  }
}

/** theme-init.js が head で適用済みのため実質 no-op。互換のため残す。 */
export function initTheme(): void {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.dataset.theme = stored
  }
}

export function getTheme(): Theme | null {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'dark' || stored === 'light') return stored
  return null
}

export function toggleTheme(): Theme {
  const current = getTheme()
  const isDark =
    current === 'dark' ||
    (current === null &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  const next: Theme = isDark ? 'light' : 'dark'
  localStorage.setItem(THEME_KEY, next)
  applyTheme(next)
  return next
}
