/**
 * Calls `fn` until it resolves, up to `attempts` times. Rejects with the last error.
 * `fn` may be synchronous or return a promise.
 */
export async function retry(fn, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
