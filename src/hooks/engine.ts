import type { Hook, HookContext, HookPoint } from '../types/hook.js';
import { HookPoints } from '../types/hook.js';

export class HookEngine {
  private hooks = new Map<HookPoint, Hook[]>();

  register(hook: Hook): void {
    const list = this.hooks.get(hook.point) ?? [];
    list.push(hook);
    this.hooks.set(hook.point, list);
  }

  unregister(name: string): boolean {
    let removed = false;
    for (const [point, list] of this.hooks) {
      const next = list.filter((h) => h.name !== name);
      if (next.length !== list.length) removed = true;
      this.hooks.set(point, next);
    }
    return removed;
  }

  /** Fire all hooks for a point sequentially, collecting errors without halting. */
  async fire(point: HookPoint, context: Omit<HookContext, 'hookPoint'>): Promise<Error[]> {
    const errors: Error[] = [];
    const list = this.hooks.get(point) ?? [];
    for (const hook of list) {
      try {
        await hook.run({ ...context, hookPoint: point });
      } catch (err) {
        errors.push(err as Error);
      }
    }
    return errors;
  }

  list(point?: HookPoint): Hook[] {
    if (point) return this.hooks.get(point) ?? [];
    return [...this.hooks.values()].flat();
  }

  get size(): number {
    return this.hooks.size;
  }
}

export { HookPoints };
