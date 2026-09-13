import type { Skill } from '../types/skill.js';
import { loadSkillsFromDir } from './loader.js';

/**
 * Skill manager: holds discovered skills and selects relevant ones by
 * keyword/trigger matching against the current user request.
 */
export class SkillManager {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  registerAll(skills: Skill[]): void {
    for (const s of skills) this.skills.set(s.name, s);
  }

  unregister(name: string): boolean {
    return this.skills.delete(name);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  loadDir(dir: string, opts?: { pluginId?: string; onlyNames?: string[] }): void {
    this.registerAll(loadSkillsFromDir(dir, opts));
  }

  /**
   * Select skills relevant to the request. A skill is selected when its
   * triggers/name/purpose/description share a token with the request.
   */
  select(request: string, limit = 5): Skill[] {
    const tokens = [...tokenize(request)];
    if (tokens.length === 0) return [];
    const scored = this.list()
      .map((skill) => {
        const haystack = tokenize(
          [skill.name, skill.purpose, skill.description, ...(skill.triggers ?? [])].join(' '),
        );
        const score = tokens.reduce((sum, t) => sum + (haystack.has(t) ? 1 : 0), 0);
        return { skill, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.skill);
  }

  /** Render selected skills as a compact context block. */
  renderContext(skills: Skill[]): string {
    if (skills.length === 0) return '';
    const sections = skills.map((s) => {
      const lines = [
        `## Skill: ${s.name}`,
        `Purpose: ${s.purpose}`,
      ];
      if (s.constraints.length) lines.push(`Constraints:\n${s.constraints.map((c) => `- ${c}`).join('\n')}`);
      if (s.requiredTools.length) lines.push(`Required tools: ${s.requiredTools.join(', ')}`);
      if (s.workflow.length) lines.push(`Workflow:\n${s.workflow.map((w) => `${w}`).join('\n')}`);
      if (s.outputFormat) lines.push(`Output format: ${s.outputFormat}`);
      lines.push('', s.instructions);
      return lines.join('\n');
    });
    return `<skills>\n${sections.join('\n\n---\n\n')}\n</skills>`;
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}
