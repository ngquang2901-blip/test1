// Light / dark / follow the OS. Kept in localStorage (a renderer preference, nothing for main to know); applied to <html data-theme>.
export type Theme = 'light' | 'dark' | 'system'
const KEY = 'toolflow.theme'

export const getTheme = (): Theme => {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}
export const isDark = (t: Theme): boolean => t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t)
  document.documentElement.dataset.theme = t
}
