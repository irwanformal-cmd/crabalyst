/**
 * Minimal Server-Sent Events (SSE) line parser for OpenAI- and
 * Anthropic-compatible streaming responses. Avoids heavyweight deps.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => reader.cancel().catch(() => {});
  if (signal) {
    if (signal.aborted) return;
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '' || line.startsWith(':')) continue; // comment/heartbeat
        if (line.startsWith('data:')) {
          yield line.slice(5).trimStart();
        }
      }
    }
    // Flush remaining buffer without trailing newline.
    if (buffer.trim()) {
      const line = buffer.replace(/\r$/, '');
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
