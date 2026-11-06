// Attempt state machine for one Flow generate attempt (docs/app/02 §2–3, 07 §3, ADR-0002).
// Pure reducer: next(state, event) → new state, or throws IllegalTransition. The runner journals every
// (event, new state) before acting on it; the only side-effect gate is canClick().
// shortcut: lives in flow-protocol until the app has a domain package; Item.state/dispatchStage names are 02's.
import { correlate } from './parse.mjs';
import { classifyGenerateError, classifyPollFailure, resubmitDelay } from './errors.mjs';
import { checkHeartbeat } from './heartbeat.mjs';

export class IllegalTransition extends Error {
  constructor(state, event) {
    super(`${event.type} not allowed in ${state.item}/${state.stage}`);
    this.code = 'ILLEGAL_TRANSITION';
  }
}

export const initial = (prompt) => ({
  item: 'queued', stage: 'not_started', prompt, clicked: false, baseline: null,
  request: null, operations: null, outputs: null, resubmits: 0, retryAt: null,
  error: null, admission: 'continue', stopRequested: false, creditSpent: false,
});

const fail = (s, e) => ({ ...s, item: 'failed', stage: 'outcome_known', error: e, admission: e.admission ?? 'continue' });
// D-11: an uncertain attempt always counts as credit spent, whatever is decided later.
const review = (s, code, extra = {}) => {
  const stage = s.stage === 'accepted' ? 'accepted' : 'uncertain';
  return { ...s, item: 'needs_review', stage, error: { code, ...extra }, admission: 'pause', creditSpent: s.creditSpent || stage === 'uncertain' };
};
// A generate request was seen and no response yet; a late response is evidence even after SUBMIT_UNCERTAIN.
const awaitingReceipt = (s) => !!s.request && (s.item === 'submitting' || (s.item === 'needs_review' && s.stage === 'uncertain' && s.error?.code === 'SUBMIT_UNCERTAIN' && !s.error.double));
const notSent = (s) => s.stage === 'not_started' || s.stage === 'rejected_before_dispatch';

/** The one place that allows a click: intent recorded, not yet used. */
export const canClick = (s) => s.item === 'submitting' && s.stage === 'intent_recorded' && !s.clicked && !s.stopRequested;

export function next(s, ev) {
  const bad = () => { throw new IllegalTransition(s, ev); };
  switch (ev.type) {
    case 'prepare': // queued → preparing; a resubmit waits for its backoff
      if (s.item !== 'queued' || s.stopRequested) bad();
      if (s.retryAt !== null && ev.now < s.retryAt) bad();
      return { ...s, item: 'preparing', retryAt: null };

    case 'prep_failed': // deterministic failure before intent (settings, ref chip, credit button…)
      if (s.item !== 'preparing' || !notSent(s)) bad();
      return { ...fail(s, ev.error), stage: s.stage };

    case 'intent': { // durable intent; refuses (stays preparing) when the observer is not alive
      if (s.item !== 'preparing' || !notSent(s) || s.stopRequested) bad();
      const hb = checkHeartbeat(ev.ping, { now: ev.now });
      if (!hb.alive) return { ...s, error: { code: 'CONFIG_INCOMPLETE', signal: 'OBSERVER_DEAD', reasons: hb.reasons }, admission: 'pause' };
      return { ...s, item: 'submitting', stage: 'intent_recorded', clicked: false, baseline: ev.ping, request: null, error: null };
    }

    case 'clicked': { // result of the page script: {found, disabled, listeners, called}
      if (!canClick(s)) bad();
      if (ev.result.called === 0) // fail-closed: no listener ran, nothing can have reached Flow
        return { ...s, item: 'preparing', stage: 'rejected_before_dispatch', error: { code: 'CONFIG_INCOMPLETE', signal: 'SUBMIT_LISTENER_MISSING', result: ev.result }, admission: 'pause' };
      return { ...s, clicked: true };
    }

    case 'sent': { // observer saw the generate request leave the page
      if (s.item !== 'submitting' || !s.clicked) bad();
      if (s.request) return review(s, 'SUBMIT_UNCERTAIN', { double: true, why: 'second generate request for one click' });
      if (!ev.request.items.every((i) => i.prompt === s.prompt)) return review(s, 'USER_INTERFERENCE', { why: 'prompt on the wire differs' });
      return { ...s, request: ev.request };
    }

    case 'rejected': { // RPC-level error on the generate response itself: Flow created nothing
      if (!awaitingReceipt(s)) bad();
      const c = classifyGenerateError(ev.error);
      if (s.item === 'needs_review') return fail(s, c);                 // late evidence settles, never resubmits
      if (c.resubmit && s.stopRequested) return { ...s, item: 'cancelled', stage: 'outcome_known', error: c };
      const delay = c.resubmit ? resubmitDelay(s.resubmits) : null;
      if (delay !== null) // 07 §3 narrow exception: same attempt goes again after backoff
        return { ...s, item: 'queued', stage: 'rejected_before_dispatch', clicked: false, request: null, resubmits: s.resubmits + 1, retryAt: ev.now + delay, error: c, admission: c.admission };
      return fail(s, c.resubmit ? { ...c, admission: 'pause', exhausted: true } : c);
    }

    case 'receipt': { // parsed image or video receipt; may also settle a SUBMIT_UNCERTAIN (lượt 30)
      if (!awaitingReceipt(s)) bad();
      const own = correlate(s.request, ev.receipt);
      if (!own.owned) return review(s, 'RESULT_OWNERSHIP_AMBIGUOUS', { why: own.reason });
      if (own.outputs) return { ...s, item: 'ready', stage: 'outcome_known', outputs: own.outputs, error: null };
      return { ...s, item: 'generating', stage: 'accepted', operations: own.operations, error: null };
    }

    case 'poll': { // parsed poll: operations of any attempt; only ours count
      if (!s.operations || !(s.item === 'generating' || (s.item === 'needs_review' && s.stage === 'accepted'))) bad();
      const mine = s.operations.map((o) => ev.operations.find((p) => p.operationId === o.operationId) || o);
      if (mine.some((o) => o.status === 'accepted' || o.status === 'running')) return { ...s, operations: mine };
      const ok = mine.filter((o) => o.status === 'succeeded');
      if (ok.length) return { ...s, item: 'ready', stage: 'outcome_known', operations: mine, outputs: ok };
      return { ...fail(s, classifyPollFailure(mine[0].failure)), operations: mine };
    }

    case 'heartbeat': { // ping after the click: a reload/re-patch/overflow means a missing receipt proves nothing
      if (s.item !== 'submitting') bad();
      const hb = checkHeartbeat(ev.ping, { now: ev.now, baseline: s.baseline });
      return hb.alive ? s : review(s, 'SUBMIT_UNCERTAIN', { signal: 'OBSERVER_DEAD', reasons: hb.reasons });
    }

    case 'deadline': // timeout is a limit of observation, not proof (07 §3); intent without a journaled click
      // may still have clicked before a crash (02 §3), so it is uncertain too
      if (s.item === 'submitting') return review(s, 'SUBMIT_UNCERTAIN');
      if (s.item === 'generating') return review(s, 'PROVIDER_ERROR_UNKNOWN', { why: 'no terminal poll before deadline' });
      return bad();

    case 'restart': // D-04: after a restart every intent without a receipt is uncertain, never resent
      return s.item === 'submitting' ? review(s, 'SUBMIT_UNCERTAIN', { why: 'restart' }) : s;

    case 'stop':
      if (['ready', 'failed', 'cancelled'].includes(s.item)) return s;
      if (notSent(s) && s.item !== 'submitting') return { ...s, item: 'cancelled', stopRequested: true, retryAt: null };
      return { ...s, stopRequested: true }; // possibly sent: observe to an outcome, never fake "cancelled"

    case 'resolve': // needs_review → outcome, only with evidence (07 §4); never back to submitting
      if (s.item !== 'needs_review' || !ev.evidence || !['ready', 'failed', 'sent', 'not_sent'].includes(ev.to)) bad();
      if (ev.to === 'sent' || ev.to === 'not_sent') // D-11 user confirmation: settles and unblocks, never reruns
        return { ...s, item: 'failed', stage: 'outcome_known', error: { ...s.error, resolution: ev.to, userConfirmed: true, evidence: ev.evidence } };
      return { ...s, item: ev.to, stage: 'outcome_known', error: ev.to === 'failed' ? { ...s.error, evidence: ev.evidence } : null, evidence: ev.evidence };

    default:
      return bad();
  }
}
