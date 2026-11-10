import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // only the native module stays in node_modules: the installer then needs no workspace links (flow-protocol is a local package)
  main: { build: { externalizeDeps: { exclude: ['@toolflow/flow-protocol', 'ws', '@electron-toolkit/utils'] } } },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
