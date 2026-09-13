import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../types/provider.js';
import type { SessionRecord, SessionSummary } from '../types/session.js';
import type { SessionRepository } from './repository.js';

export class SessionManager {
  constructor(private repo: SessionRepository) {}

  async create(input: {
    title?: string;
    workspacePath: string;
    providerId: string;
    model: string;
    plugins?: string[];
    metadata?: Record<string, unknown>;
    messages?: ChatMessage[];
  }): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: randomUUID().slice(0, 8),
      title: input.title ?? 'untitled',
      workspacePath: input.workspacePath,
      providerId: input.providerId,
      model: input.model,
      createdAt: now,
      updatedAt: now,
      plugins: input.plugins ?? [],
      metadata: input.metadata ?? {},
      messages: input.messages ?? [],
    };
    await this.repo.create(session);
    return session;
  }

  async resume(id: string): Promise<SessionRecord> {
    const session = await this.repo.get(id);
    if (!session) throw new Error(`session "${id}" not found`);
    return session;
  }

  async list(): Promise<SessionSummary[]> {
    return this.repo.list();
  }

  async delete(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }

  async save(session: SessionRecord): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await this.repo.update(session);
  }

  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    await this.repo.appendMessage(sessionId, message);
  }
}
