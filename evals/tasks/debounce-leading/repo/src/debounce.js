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
  let lastArgs;
  let result;
  const debounced = function (...args) {
    lastArgs = args;
    if (!timer && leading) result = fn.apply(this, args);
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (trailing) result = fn.apply(this, lastArgs);
    }, wait);
    return result;
  };
  debounced.cancel = () => { clearTimeout(timer); timer = undefined; };
  debounced.flush = () => {
    if (timer) { clearTimeout(timer); timer = undefined; result = fn(...lastArgs); }
    return result;
  };
  return debounced;
}
