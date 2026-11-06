// Flow error table: maps every PUBLIC_ERROR_* in Flow's frontend enum (_.qu in flow-boq-m_b.js) to the
// ToolFlow catalogue of docs/app/07 §2. `observed` = seen live in spike 01; others come from the source only.
//
// admission: continue = only this item ends; throttle = slow down (halve in-flight) and keep the queue;
//            pause = stop admitting new items for this provider/mode; stop_profile = stop all auto on the
//            browser profile and fall back to manual (ADR-0002).

const R = 'RATE_LIMIT', B = 'CONTENT_BLOCKED', C = 'CAPABILITY_UNAVAILABLE', U = 'PROVIDER_ERROR_UNKNOWN';

// [enum number, name without PUBLIC_ERROR_, ToolFlow code, admission, note]
const ROWS = [
  [0, 'UNSPECIFIED', U, 'continue'],
  [1, 'UNSAFE_GENERATION', B, 'continue'],
  [2, 'USER_QUOTA_REACHED', R, 'pause', 'quota; do not guess the reset time; in Flow quota set _.YRb'],
  [3, 'USER_REQUESTS_THROTTLED', R, 'throttle', 'observed: lượt 25/27/28, not charged, OK again after 30-45 s'],
  [4, 'HIGH_TRAFFIC', R, 'throttle', 'Flow itself labels it RETRY'],
  [5, 'MODEL_DISABLED_DUE_TO_TRAFFIC', R, 'pause', 'model off for a while; user picks another model'],
  [7, 'NON_ENGLISH_PROMPT', B, 'continue', 'prompt rejected for its language'],
  [8, 'UNSAFE_IMAGE_UPLOAD', B, 'continue', 'ref blocked'],
  [9, 'GENERATION_ALREADY_IN_PROGRESS', 'SUBMIT_UNCERTAIN', 'pause', 'something of ours may already be running: reconcile'],
  [11, 'MODEL_ACCESS_DENIED', C, 'pause'],
  [12, 'PROMINENT_PEOPLE_FILTER_FAILED', B, 'continue'],
  [14, 'VIOLENCE_FILTER', B, 'continue'],
  [15, 'DANGER_FILTER', B, 'continue'],
  [16, 'SEXUAL', B, 'continue'],
  [17, 'MINOR_UPLOAD', B, 'continue', 'ref blocked'],
  [18, 'SEXUAL_UPLOAD', B, 'continue', 'ref blocked'],
  [19, 'PROMINENT_PEOPLE_UPLOAD', B, 'continue', 'ref blocked'],
  [20, 'PHOTOREAL_UPLOAD', B, 'continue', 'ref blocked'],
  [21, 'MINOR', B, 'continue'],
  [22, 'MINOR_HARM_UPLOAD', B, 'continue', 'ref blocked'],
  [23, 'PHOTOREAL_INPUT_IMAGE', B, 'continue', 'ref blocked'],
  [24, 'PROMINENT_PEOPLE_INPUT_IMAGE', B, 'continue', 'ref blocked'],
  [25, 'MINOR_INPUT_IMAGE', B, 'continue', 'ref blocked'],
  [26, 'UNKNOWN_IMAGE_FILE_FORMAT', C, 'continue', 'ref format'],
  [27, 'VIDEO_GENERATION_TIMED_OUT', U, 'continue', 'Flow labels it RETRY, but the generation existed: never auto-resubmit'],
  [28, 'MODEL_OVERLOADED', R, 'throttle', 'Flow itself labels it RETRY'],
  [29, 'HANDLE_INVALID', U, 'continue', 'feature unused by ToolFlow'],
  [30, 'HANDLE_TAKEN', U, 'continue', 'feature unused by ToolFlow'],
  [31, 'IMAGE_TOO_LARGE', C, 'continue', 'ref size'],
  [32, 'PER_MODEL_DAILY_QUOTA_REACHED', R, 'pause', 'quota for this model; in Flow quota set _.YRb'],
  [33, 'AUDIO_FILTERED', B, 'continue'],
  [34, 'PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE', R, 'pause', 'quota for this model; in Flow quota set _.YRb'],
  [35, 'SOMETHING_WENT_WRONG', U, 'continue'],
  [36, 'COLLECTION_INVALID', U, 'continue', 'feature unused by ToolFlow'],
  [39, 'COLLECTION_FULL', U, 'continue', 'feature unused by ToolFlow'],
  [40, 'COLLECTION_DEPTH_EXCEEDED', U, 'continue', 'feature unused by ToolFlow'],
  [41, 'IP_INPUT_IMAGE', B, 'continue', 'ref blocked'],
  [42, 'APP_UNAVAILABLE', U, 'pause'],
  [44, 'IMAGE_TOO_SMALL', C, 'continue', 'ref size'],
  [45, 'USER_REGION_DISALLOWED', C, 'pause'],
  [46, 'USER_MINOR', C, 'pause'],
  [47, 'IMAGE_OUTPUT_IP_FILTER', B, 'continue'],
  [48, 'WORKSPACE_ACCOUNT_QUOTA_REACHED', R, 'pause', 'quota; in Flow quota set _.YRb'],
  [49, 'UNUSUAL_ACTIVITY', 'HUMAN_REQUIRED', 'stop_profile', 'observed: lượt 1, 4-9 (CDP); account flagged'],
  [50, 'UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC', 'HUMAN_REQUIRED', 'stop_profile', 'account flagged'],
  [51, 'CONCURRENT_LIMIT_REACHED', R, 'throttle', 'Flow itself labels it RETRY'],
  [52, 'MEDIA_GENERATION_CANNOT_BE_CANCELED', U, 'continue', 'feature unused by ToolFlow'],
  [53, 'UNSAFE_VIDEO_UPLOAD', B, 'continue', 'ref blocked'],
  [54, 'VIDEO_UPLOAD_TIMEOUT', 'UPLOAD_NOT_VERIFIED', 'continue'],
  [55, 'VIDEO_DURATION_TOO_LONG', C, 'continue'],
  [56, 'APPLET_SIZE_LIMIT_EXCEEDED', U, 'continue', 'feature unused by ToolFlow'],
  [57, 'APPLET_STORAGE_QUOTA_EXCEEDED', U, 'continue', 'feature unused by ToolFlow'],
  [58, 'VIDEO_UPLOAD_FAILED', 'UPLOAD_NOT_VERIFIED', 'continue'],
  [59, 'SPEECH_EDIT', U, 'continue', 'feature unused by ToolFlow'],
  [60, 'VIDEO_EDIT', U, 'continue', 'feature unused by ToolFlow'],
  [61, 'REPUTATIONAL', B, 'continue'],
  [63, 'UNDERSPECIFIED_ANIMAL', B, 'continue'],
  [64, 'RESPONSE_TOO_LONG', U, 'continue'],
  [65, 'PROJECT_NOT_ALLOWLISTED', C, 'pause'],
  [66, 'USER_ROLE_NOT_GRANTED', C, 'pause'],
  [67, 'PROJECT_FLOW_ENTERPRISE_NOT_ENABLED', C, 'pause'],
  [68, 'VERTEX_SAFETY_FILTER_TRIGGERED', B, 'continue'],
  [69, 'VERTEX_UNSUPPORTED_INPUT', C, 'continue'],
  [70, 'VERTEX_QUOTA_EXHAUSTED', R, 'pause', 'quota; in Flow quota set _.YRb'],
  [71, 'VERTEX_QUOTA_EXHAUSTED_ADMIN', R, 'pause', 'quota; in Flow quota set _.YRb'],
  [72, 'VERTEX_SERVICE_UNAVAILABLE', U, 'pause'],
  [73, 'UNSAFE_SEARCH', B, 'continue'],
  [74, 'IAM_POLICY_DENIED', C, 'pause'],
  [75, 'PUBLISH_TIME_LIMIT_REACHED', U, 'continue', 'feature unused by ToolFlow'],
  [76, 'USER_BANNED', 'HUMAN_REQUIRED', 'stop_profile', 'account banned'],
];

export const PUBLIC_ERRORS = Object.fromEntries(ROWS.map(([num, name, code, admission, note = '']) =>
  ['PUBLIC_ERROR_' + name, { num, code, admission, note, observed: note.startsWith('observed') }]));

// docs/app/07 §3 exception (user decision 06/11/2026): only these codes, and only when they come back in the
// generate response itself (no media id, nothing created, not charged), may be resubmitted automatically.
export const RESUBMITTABLE = new Set(['PUBLIC_ERROR_USER_REQUESTS_THROTTLED', 'PUBLIC_ERROR_HIGH_TRAFFIC',
  'PUBLIC_ERROR_MODEL_OVERLOADED', 'PUBLIC_ERROR_CONCURRENT_LIMIT_REACHED']);

// 30 s doubling to a 5 min cap, at most 5 resubmits per attempt; then RATE_LIMIT + pause (user decides).
export const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000];
export const resubmitDelay = (resubmitsSoFar) => BACKOFF_MS[resubmitsSoFar] ?? null;

const SEVERITY = ['continue', 'throttle', 'pause', 'stop_profile'];
const UNKNOWN = { code: U, admission: 'pause', note: 'not in the qualified table: treat as drift', drift: true };

function pick(reasons) {
  const rows = reasons.map((r) => PUBLIC_ERRORS[r] || UNKNOWN);
  if (!rows.length) return UNKNOWN;
  return rows.reduce((a, b) => (SEVERITY.indexOf(b.admission) > SEVERITY.indexOf(a.admission) ? b : a));
}

/** RPC-level error on the generate request ({grpc, reasons} from parseRpcResponse). Nothing was created. */
export function classifyGenerateError(error) {
  const row = pick(error.reasons);
  return {
    code: row.code, admission: row.admission, drift: !!row.drift,
    dispatch: 'rejected_by_provider',
    resubmit: error.reasons.length > 0 && error.reasons.every((r) => RESUBMITTABLE.has(r)),
    reasons: error.reasons,
  };
}

/** Failed operation in a poll: the generation existed, so never auto-resubmit (07 §3). */
export function classifyPollFailure(failure) {
  const flow = failure.reasons.filter((r) => r.startsWith('PUBLIC_ERROR_'));
  if (flow.length) {
    const row = pick(flow);
    return { code: row.code, admission: row.admission, drift: !!row.drift, dispatch: 'accepted', resubmit: false, reasons: failure.reasons };
  }
  // gRPC 13 INTERNAL: observed lượt 21/28, tile promised a refund, refund seen within ~10 min.
  if (failure.grpc === 13) return { code: U, admission: 'continue', drift: false, dispatch: 'accepted', resubmit: false, refundExpected: true, reasons: failure.reasons };
  return { code: U, admission: 'pause', drift: true, dispatch: 'accepted', resubmit: false, reasons: failure.reasons };
}

// Signals the driver reads outside the network (docs/app/adr/0002). All mean: nothing was sent.
export const CLIENT_SIGNALS = {
  INSUFFICIENT_CREDIT: { code: R, admission: 'pause', note: 'button.prompt-warning-button "không đủ tín dụng"; 0-credit models still work' },
  SUBMIT_LISTENER_MISSING: { code: 'CONFIG_INCOMPLETE', admission: 'pause', note: 'listener count on the submit button is not 1' },
  OBSERVER_DEAD: { code: 'CONFIG_INCOMPLETE', admission: 'pause', note: 'MAIN-world XHR/fetch hooks are not ours or silent' },
  PROTOCOL_DRIFT: { code: 'CONFIG_INCOMPLETE', admission: 'pause', note: 'ProtocolDrift thrown by parse.mjs' },
};
