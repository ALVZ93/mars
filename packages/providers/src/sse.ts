import { MarsError, checkAbort } from '../../core/src/index.js';

/** JSON SSE frames; retain partial CRLF and UTF-8 sequences across transport chunks. */
export async function* jsonSse(response: Response, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new MarsError('ProviderUnavailableError', 'Provider returned no stream body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const chunk = await reader.read();
      checkAbort(signal);
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (chunk.done && buffer.trim()) buffer += '\n\n';
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        if (boundary > 1_000_000) throw new MarsError('ContextLimitError', 'Provider stream frame exceeded the limit.');
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
        if (data && data !== '[DONE]') {
          let value: unknown;
          try { value = JSON.parse(data); }
          catch { throw new MarsError('ProviderUnavailableError', 'Provider returned malformed streaming data.'); }
          if (value && typeof value === 'object' && !Array.isArray(value)) yield value as Record<string, unknown>;
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (buffer.length > 1_000_000) throw new MarsError('ContextLimitError', 'Provider stream frame exceeded the limit.');
      if (chunk.done) break;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
