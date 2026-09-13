import type { AgentEvent } from '../types/events.js';

export type AgentEventListener = (event: AgentEvent) => void;

/** In-process event bus for structured agent events. */
export class AgentEventBus {
  private listeners = new Set<AgentEventListener>();
  private seq = 0;

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    this.seq++;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a listener must not break the loop */
      }
    }
  }

  get sequence(): number {
    return this.seq;
  }
}
