export type Ping = { xhrSend: boolean; xhrOpen: boolean; fetch: boolean; id: string; seq: number; dropped: number; gen: number; t: number; version: string; email: string | null; seen?: string[] }; // seen: rpc names that completed OK since page load (names only)
export type TabProbe = { present: Record<string, boolean>; listeners: number; sawProjectLoad: boolean };
export type ClickResult = { found: boolean; disabled: boolean | null; listeners: number; called: number } | { noMainWorld: true };
export type DriverEvent =
  | { tabId: string; type: 'sent'; epoch: number; request: unknown } // raw request body as captured; the runner must parse it (readFReq) and never persist it (reCAPTCHA token slot)
  | { tabId: string; type: 'response'; epoch: number; rpc: string; text: string; request: unknown } // request = raw body of the request this answers (same XHR closure); parse, never persist // raw; runner parses with flow-protocol
  | { tabId: string; type: 'disconnected' };
export type FlowTab = { tabId: string; projectId: string | null; email: string | null; active: boolean }; // projectId: uuid of /project/<uuid> only; no URL, no query
export type DlInfo = { id: number; state: 'in_progress' | 'interrupted' | 'complete'; filename: string; fileSize: number; mime: string; error: string | null }; // filename: absolute path the browser reports; never a url
export type FetchMediaResult = { ok: true; downloadId: number } | { ok: false; code: string };
export interface FlowDriver {
  fetchMedia(tabId: string, p: { mediaId: string; filename: string }): Promise<FetchMediaResult>; // the extension reads the tile's src itself and starts chrome.downloads; the url never reaches the desktop
  downloads(q: { id?: number; filenamePrefix?: string }): Promise<DlInfo[]>;
  listTabs(): Promise<FlowTab[]>;
  ping(tabId: string): Promise<Ping>;
  prepare(tabId: string, p: { prompt: string; kind: 'image' | 'video'; settings: object; refIds: string[]; projectId?: string }): Promise<{ ok: true } | { ok: false; code: string }>;
  checkBeforeClick(tabId: string, projectId: string, refIds?: string[]): Promise<{ ok: true } | { ok: false; code: 'COVERED' | 'CREDIT_WARNING' | 'BUTTON_DISABLED' | 'CHIP_MISMATCH' | 'TARGET_CHANGED' }>; // TARGET_CHANGED: URL tab không còn là project của lô (AC-23)
  probeTab?(tabId: string): Promise<TabProbe>; // read-only self-check signals; granted tabs only. Absent ⇒ the self-check fails closed.
  click(tabId: string, epoch: number): Promise<ClickResult>; // throws ConnectorError on drop
  readProject(projectId: string): Promise<string>; // raw Zzl0ze body from a separate read tab
  arm(tabId: string, epoch: number | null): Promise<void>; // manual mode: the page stamps the user's next generate send with epoch; null disarms. Throws when the tab cannot be armed.
  focusTab(tabId: string): Promise<void>;
  onEvent(cb: (e: DriverEvent) => void): () => void;
}
export class ConnectorError extends Error {
  code = 'CONNECTOR_LOST';
}
