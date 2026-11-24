import { test, expect } from 'vitest'
import { findChrome, launchChrome } from '../src/main/chrome'

const REG = (path: string) => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\r\n    (Default)    REG_SZ    ${path}\r\n\r\n`
const none = (): string => { throw new Error('key not found') }
const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }

test('findChrome: the App Paths key first (machine, then user), then the usual install folders; only a file that exists', () => {
  const at = (...files: string[]) => (p: string) => files.includes(p)
  const asked: string[] = []
  const reg = (k: string) => { asked.push(k); return k.startsWith('HKCU') ? REG('D:\\Chrome\\chrome.exe') : none() }
  expect(findChrome({ platform: 'win32', env, exists: at('D:\\Chrome\\chrome.exe'), reg })).toBe('D:\\Chrome\\chrome.exe')
  expect(asked).toEqual(['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'])
  expect(findChrome({ platform: 'win32', env, exists: at('C:\\X\\chrome.exe'), reg: () => REG('"C:\\X\\chrome.exe"') })).toBe('C:\\X\\chrome.exe') // a quoted value
  expect(findChrome({ platform: 'win32', env, exists: at('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'), reg: () => REG('C:\\Gone\\chrome.exe') })).toBe('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe') // a stale key
  expect(findChrome({ platform: 'win32', env, exists: at('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'), reg: none })).toBe('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe') // per-user install
  expect(findChrome({ platform: 'win32', env: {}, exists: () => false, reg: none })).toBeNull()
  expect(findChrome({ platform: 'linux', env, exists: () => true, reg: () => REG('C:\\X\\chrome.exe') })).toBeNull()
})

// Measured (Chrome 157, Windows): a covered Chrome window counts as hidden (no frame drawn, timers ~10x late) and Flow's settings panel
// does not open; with this switch at Chrome's start it stays visible and runs normally. A minimised window stays hidden either way.
test('launchChrome starts Chrome with window occlusion off, then the page', () => {
  const seen: string[][] = []
  launchChrome('C:\\c\\chrome.exe', 'https://labs.google/fx/tools/flow', ((_e: string, a: string[]) => { seen.push(a); return { on() {}, unref() {} } }) as never)
  expect(seen).toEqual([['--disable-features=CalculateNativeWinOcclusion', 'https://labs.google/fx/tools/flow']])
})
