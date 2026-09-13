import type { ChatMessage } from './provider.js';

export interface SessionRecord {
  id: string;
  title: string;
  workspacePath: string;
  providerId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** Active plugin ids at last write. */
  plugins: string[];
  /** Free-form metadata. */
  metadata: Record<string, unknown>;
  /** Conversation history. */
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  workspacePath: string;
  providerId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  pluginCount: number;
  messageCount: number;
}
