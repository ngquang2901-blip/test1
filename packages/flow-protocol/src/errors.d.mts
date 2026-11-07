export type Admission = 'continue' | 'throttle' | 'pause' | 'stop_profile';
export type ErrorRow = { num: number; code: string; admission: Admission; note: string; observed: boolean };
export const PUBLIC_ERRORS: Record<string, ErrorRow>;
export const RESUBMITTABLE: Set<string>;
export const BACKOFF_MS: number[];
export function resubmitDelay(resubmitsSoFar: number): number | null;
export type Classification = {
  code: string; admission: Admission; drift: boolean; dispatch: 'rejected_by_provider' | 'accepted';
  resubmit: boolean; reasons: string[]; refundExpected?: true;
};
export function classifyGenerateError(error: { reasons: string[] }): Classification;
export function classifyPollFailure(failure: { grpc: number; reasons: string[] }): Classification;
export const CLIENT_SIGNALS: Record<'INSUFFICIENT_CREDIT' | 'SUBMIT_LISTENER_MISSING' | 'OBSERVER_DEAD' | 'PROTOCOL_DRIFT',
  { code: string; admission: Admission; note: string }>;
