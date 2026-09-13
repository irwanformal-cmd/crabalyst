/**
 * Permission model.
 *
 * Every tool/plugin declares the permissions it needs. The permission system is
 * deliberately a flat, namespaced string space so that plugins can declare new
 * namespaces (e.g. `financial.data`) without modifying core code.
 */

/** A single permission, expressed as a namespaced string. */
export type Permission = string;

/** Standard, core-owned permission names. */
export const Permissions = {
  FilesystemRead: 'filesystem.read',
  FilesystemWrite: 'filesystem.write',
  TerminalExecute: 'terminal.execute',
  Network: 'network',
  GitRead: 'git.read',
  GitWrite: 'git.write',
  ProcessSpawn: 'process.spawn',
  Docker: 'docker',
  Browser: 'browser',
  HttpRequest: 'http.request',
} as const;

export type CorePermission = (typeof Permissions)[keyof typeof Permissions];

/** A permission grant decision. */
export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; reason?: string };

/**
 * Approval callback invoked before a dangerous operation runs.
 * Implementations (CLI prompt, web UI, test policy) decide the outcome.
 */
export interface ApprovalRequest {
  kind: 'tool' | 'command' | 'hook';
  permission: Permission;
  description: string;
  toolName?: string;
  input?: unknown;
  sessionId?: string;
}

export type Approver = (request: ApprovalRequest) => Promise<PermissionDecision> | PermissionDecision;

/** A set of granted permissions, used to build the effective policy. */
export interface PermissionSet {
  granted: Set<Permission>;
  denied: Set<Permission>;
}
