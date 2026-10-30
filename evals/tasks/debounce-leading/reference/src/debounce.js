/**
 * debounce(fn, wait, { leading = false, trailing = true })
 * Groups calls into bursts: a burst ends when `wait` ms pass without a call.
 *   leading:  call fn at the start of a burst.
 *   trailing: call fn at the end of a burst with the arguments and `this` of the last call, but only if the
 *             debounced function was called during the burst after the leading call (one call never runs twice).
 * The debounced function returns the result of the latest fn invocation (undefined before the first one).
 * debounced.cancel(): drops the pending trailing call and ends the burst.
 * debounced.flush(): ends the burst now, running the pending trailing call if there is one; returns the latest result.
 */
export function debounce(fn, wait, { leading = false, trailing = true } = {}) {
  let timer;
  let pending; // { self, args } of the last call not yet passed to fn
  let result;
  const invoke = () => {
    const { self, args } = pending;
    pending = undefined;
    result = fn.apply(self, args);
    return result;
  };
  const end = () => {
    clearTimeout(timer);
    timer = undefined;
    if (trailing && pending) invoke();
    pending = undefined;
  };
  const debounced = function (...args) {
    const starting = timer === undefined;
    clearTimeout(timer);
    timer = setTimeout(end, wait);
    pending = { self: this, args };
    if (starting && leading) return invoke();
    return result;
  };
  debounced.cancel = () => { clearTimeout(timer); timer = undefined; pending = undefined; };
  debounced.flush = () => {
    if (timer !== undefined) end();
    return result;
  };
  return debounced;
}
