/**
 * SSE parser that also captures the `event:` field (needed for Anthropic's
 * Messages API streaming protocol).
 */
export async function* parseSSEWithEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => reader.cancel().catch(() => {});
  if (signal) {
    if (signal.aborted) return;
    signal.addEventListener('abort', onAbort, { once: true });
  }

  let currentEvent = 'message';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          yield { event: currentEvent, data: line.slice(5).trimStart() };
        }
        // Blank line ends the block; reset event type.
        if (line === '') currentEvent = 'message';
      }
    }
    if (buffer.trim()) {
      const line = buffer.replace(/\r$/, '');
      if (line.startsWith('data:')) yield { event: currentEvent, data: line.slice(5).trimStart() };
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
