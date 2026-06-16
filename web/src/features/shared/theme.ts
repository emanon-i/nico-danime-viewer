const THEME_KEY = 'nico-danime-theme'

export type Theme = 'dark' | 'light'

export const THEME_KEY_NAME = THEME_KEY

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.classList.toggle('light', theme === 'light')
}

export function initTheme(): void {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'dark' || stored === 'light') {
    applyTheme(stored)
  }
  // null → OS 追従（CSS prefers-color-scheme に委ねる）
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
