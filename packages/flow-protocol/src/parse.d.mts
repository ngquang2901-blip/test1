export class ProtocolDrift extends Error {
  constructor(where: string, path: (string | number)[], value?: unknown);
  code: 'PROTOCOL_DRIFT';
  where: string;
  path: (string | number)[];
}
export function at(root: unknown, path: (string | number)[], check: ((v: any) => boolean) | undefined, where: string): any;
export function opt(root: unknown, path: (string | number)[], check?: (v: any) => boolean): any;
export function parseEnvelope(text: unknown): unknown[];
export type RpcError = { grpc: number; reasons: string[] };
export function parseRpcResponse(text: unknown, rpc: string): { payload: unknown } | { error: RpcError };
export function readFReq(body: unknown): string;
export type GenerateItem = { prompt: string; model: string; seed?: number; aspectCode?: number; refIds?: string[] };
export type GenerateRequest = { rpc: string; batchId: string; items: GenerateItem[] };
export function parseGenerateRequest(fReq: string): GenerateRequest;
export function parseUploadRequest(fReq: string): { mime: string; fileName: string };
export function parseUploadReceipt(payload: unknown): {
  mediaId: string; workflowId: string; projectId: string; fileName: string; mime: string | null; width: number; height: number;
};
export type ImageOutput = {
  mediaId: string; workflowId: string; seed: number; url: string; width: number; height: number;
  title: string | null; rewrittenPrompt: string | null; prompt: string | null;
};
export type ImageReceipt = { batchId: string; outputs: ImageOutput[] };
export function parseImageReceipt(payload: unknown): ImageReceipt;
export type OperationStatus = 'accepted' | 'running' | 'succeeded' | 'failed';
export type Operation = {
  operationId: string; projectId: string; workflowId: string; model: string; status: OperationStatus;
  prompt: string | null; refIds: string[]; seed: number | null;
  failure?: RpcError; title?: string | null;
};
export type VideoReceipt = { batchId: string; credits: number | null; operations: Operation[] };
export function parseVideoReceipt(payload: unknown): VideoReceipt;
export function parsePoll(payload: unknown): { credits: number | null; operations: Operation[] };
export function correlate(request: GenerateRequest, receipt: ImageReceipt | VideoReceipt):
  | { owned: false; reason: 'batch_mismatch' | 'seed_mismatch' | 'count_mismatch' }
  | { owned: true; outputs: (ImageOutput & { item: number })[]; operations?: undefined }
  | { owned: true; operations: Operation[]; outputs?: undefined };
