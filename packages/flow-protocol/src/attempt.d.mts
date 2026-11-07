export type ItemState = 'queued' | 'preparing' | 'submitting' | 'awaiting_user' | 'generating' | 'ready' | 'failed' | 'cancelled' | 'needs_review';
export type Stage = 'not_started' | 'rejected_before_dispatch' | 'intent_recorded' | 'accepted' | 'uncertain' | 'outcome_known';
export interface AttemptState {
  item: ItemState; stage: Stage; prompt: string; clicked: boolean; baseline: unknown;
  request: any; operations: any[] | null; outputs: any[] | null; resubmits: number; retryAt: number | null;
  error: any; admission: string; stopRequested: boolean; creditSpent: boolean; manual?: boolean; evidence?: unknown;
}
export type AttemptEvent =
  | { type: 'prepare'; now: number }
  | { type: 'prep_failed'; error: any }
  | { type: 'intent'; ping: any; now: number; manual?: true }
  | { type: 'skip'; ping: any; now: number }
  | { type: 'clicked'; result: any }
  | { type: 'sent'; request: any }
  | { type: 'rejected'; error: any; now: number }
  | { type: 'receipt'; receipt: any }
  | { type: 'poll'; operations: any[] }
  | { type: 'heartbeat'; ping: any; now: number }
  | { type: 'deadline' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'resolve'; to: 'ready' | 'failed' | 'sent' | 'not_sent'; evidence: unknown };
export class IllegalTransition extends Error { code: 'ILLEGAL_TRANSITION' }
export const initial: (prompt: string) => AttemptState;
export const canClick: (s: AttemptState) => boolean;
export function next(s: AttemptState, ev: AttemptEvent): AttemptState;
