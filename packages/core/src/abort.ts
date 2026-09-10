import { MarsError } from './errors.js';

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new MarsError(
    signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'CancelledError',
    signal.reason?.name === 'TimeoutError' ? 'Operation timed out.' : 'Operation cancelled.',
  );
}

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { try { checkAbort(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
