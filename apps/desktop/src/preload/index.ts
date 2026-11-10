import { contextBridge, ipcRenderer } from 'electron'

const call = (ch: string) => (arg?: unknown) => ipcRenderer.invoke(ch, arg)
// The renderer gets exactly these functions, nothing else (R54).
const api = {
  saveDraft: call('saveDraft'),
  enqueueBatch: call('enqueueBatch'),
  pickRefs: call('pickRefs'),
  startBatch: call('startBatch'),
  pauseBatch: call('pauseBatch'),
  resumeBatch: call('resumeBatch'),
  stopBatch: call('stopBatch'),
  confirmUncertain: call('confirmUncertain'),
  archiveBatch: call('archiveBatch'),
  resetAssetBinding: call('resetAssetBinding'),
  rerun: call('rerun'),
  downloadBatch: call('downloadBatch'),
  retryDownload: call('retryDownload'),
  previewOutput: call('previewOutput'),
  revealOutput: call('revealOutput'),
  useTabs: call('useTabs'),
  enableAuto: call('enableAuto'),
  disableAuto: call('disableAuto'),
  listBatches: call('listBatches'),
  getBatch: call('getBatch'),
  onState(cb: (e: { entity: string; id: string; revision: number }) => void): () => void {
    const l = (_: unknown, e: { entity: string; id: string; revision: number }): void => cb(e)
    ipcRenderer.on('state', l)
    return () => ipcRenderer.removeListener('state', l)
  }
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
