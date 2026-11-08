// Classic script, loaded before main-world.js (MAIN world). Binds each generate XHR to the epoch of the ONE click that caused it;
// shortcut: a manual send made while our own click is pending binds as ours (the one epoch is used once); reconcile is the backstop.
// two clicks before a send are ambiguous, so both are dropped (fail closed; the desktop's deadline/reconcile settles them).
globalThis.makeEpochTracker = () => {
  let cur, pending = false, gen = 0;
  return {
    submit(epoch, called) { if (!called) return; cur = pending ? undefined : epoch; pending = true; },
    clear() { pending = false; cur = undefined; },
    get gen() { return gen; }, // every generate send the page makes, ours or not: a manual skip is only "nothing sent" if this did not move
    send() { gen++; if (!pending) return undefined; const e = cur; pending = false; cur = undefined; return e; },
  };
};
