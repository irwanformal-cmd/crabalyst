import type { Approver, Permission, PermissionDecision } from '../types/permissions.js';

export interface PermissionPolicyOptions {
  allow?: Permission[];
  deny?: Permission[];
  approver?: Approver;
}

/**
 * Fail-closed permission policy. A permission is granted only when explicitly
 * allowed (or approved interactively); anything unknown is denied unless an
 * approver grants it.
 */
export class PermissionPolicy {
  private allow: Set<Permission>;
  private deny: Set<Permission>;
  private approver?: Approver;

  constructor(options?: PermissionPolicyOptions) {
    this.allow = new Set(options?.allow ?? []);
    this.deny = new Set(options?.deny ?? []);
    this.approver = options?.approver;
  }

  setApprover(approver?: Approver) {
    this.approver = approver;
  }

  grant(p: Permission) {
    this.allow.add(p);
    this.deny.delete(p);
  }

  revoke(p: Permission) {
    this.deny.add(p);
    this.allow.delete(p);
  }

  has(p: Permission): boolean {
    return this.allow.has(p);
  }

  /** Evaluate a request for multiple required permissions. */
  async check(required: Permission[], context?: {
    description?: string;
    toolName?: string;
    input?: unknown;
    sessionId?: string;
  }): Promise<PermissionDecision> {
    // Any explicit deny wins.
    const denied = required.find((p) => this.deny.has(p));
    if (denied) return { allowed: false, reason: `permission "${denied}" is denied` };

    const missing = required.filter((p) => !this.allow.has(p));
    if (missing.length === 0) return { allowed: true };

    if (!this.approver) {
      return { allowed: false, reason: `permission "${missing[0]}" not granted and no approver is configured` };
    }

    return this.approver({
      kind: 'tool',
      permission: missing[0]!,
      description: context?.description ?? `requires permission "${missing[0]}"`,
      toolName: context?.toolName,
      input: context?.input,
      sessionId: context?.sessionId,
    });
  }
}
