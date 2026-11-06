// Observer heartbeat (ADR-0002: "observer network còn sống" before every submit).
// A ping comes from the MAIN-world observer: {xhrSend, xhrOpen, fetch, id, seq, dropped, t}.
// Take one before intent (baseline) and one after the click; if anything below breaks in between,
// records may be missing and an absent receipt proves nothing (→ SUBMIT_UNCERTAIN, never resubmit).

export const MAX_AGE_MS = 5_000;

export function checkHeartbeat(ping, { now = Date.now(), baseline = null } = {}) {
  const reasons = [];
  if (!ping || typeof ping !== 'object') return { alive: false, reasons: ['no_ping'] };
  if (ping.xhrSend !== true) reasons.push('hook_xhr_send');   // someone re-patched XHR after us
  if (ping.xhrOpen !== true) reasons.push('hook_xhr_open');
  if (ping.fetch !== true) reasons.push('hook_fetch');
  if (typeof ping.id !== 'string' || !Number.isInteger(ping.seq) || !Number.isInteger(ping.dropped)) reasons.push('old_observer');
  if (!Number.isFinite(ping.t) || now - ping.t > MAX_AGE_MS || ping.t - now > MAX_AGE_MS) reasons.push('stale');
  if (baseline) {
    if (ping.id !== baseline.id) reasons.push('page_reloaded');          // new observer: old buffer is gone
    else {
      if (ping.seq < baseline.seq) reasons.push('seq_backwards');
      if (ping.dropped > baseline.dropped) reasons.push('records_dropped'); // ring buffer overflowed
    }
  }
  return { alive: reasons.length === 0, reasons };
}
