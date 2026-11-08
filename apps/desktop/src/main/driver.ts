export type Ping = { xhrSend: boolean; xhrOpen: boolean; fetch: boolean; id: string; seq: number; dropped: number; t: number; version: string; email: string | null };
export type ClickResult = { found: boolean; disabled: boolean | null; listeners: number; called: number } | { noMainWorld: true };
export type DriverEvent =
  | { tabId: string; type: 'sent'; epoch: number; request: unknown } // raw request body as captured; the runner must parse it (readFReq) and never persist it (reCAPTCHA token slot)
  | { tabId: string; type: 'response'; epoch: number; rpc: string; text: string; request: unknown } // request = raw body of the request this answers (same XHR closure); parse, never persist // raw; runner parses with flow-protocol
  | { tabId: string; type: 'disconnected' };
export interface FlowDriver {
  ping(tabId: string): Promise<Ping>;
  prepare(tabId: string, p: { prompt: string; kind: 'image' | 'video'; settings: object; refIds: string[] }): Promise<{ ok: true } | { ok: false; code: string }>;
  checkBeforeClick(tabId: string, projectId: string): Promise<{ ok: true } | { ok: false; code: 'COVERED' | 'CREDIT_WARNING' | 'BUTTON_DISABLED' | 'CHIP_MISMATCH' | 'TARGET_CHANGED' }>; // TARGET_CHANGED: URL tab không còn là project của lô (AC-23)
  click(tabId: string, epoch: number): Promise<ClickResult>; // throws ConnectorError on drop
  readProject(projectId: string): Promise<string>; // raw Zzl0ze body from a separate read tab
  focusTab(tabId: string): Promise<void>;
  onEvent(cb: (e: DriverEvent) => void): () => void;
}
export class ConnectorError extends Error {
  code = 'CONNECTOR_LOST';
}
