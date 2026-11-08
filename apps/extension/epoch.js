// Classic script, loaded before main-world.js (MAIN world). Binds each generate XHR to the epoch of the ONE click that caused it;
// two clicks before a send are ambiguous, so both are dropped (fail closed; the desktop's deadline/reconcile settles them).
globalThis.makeEpochTracker = () => {
  let cur, pending = false;
  return {
    submit(epoch, called) { if (!called) return; cur = pending ? undefined : epoch; pending = true; },
    send() { if (!pending) return undefined; const e = cur; pending = false; cur = undefined; return e; },
  };
};
