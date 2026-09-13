import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parse } from 'yaml';
import type { Skill } from '../types/skill.js';

export interface ParsedSkillFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Parse YAML frontmatter (delimited by ---) from a Markdown string. */
export function parseFrontmatter(text: string): ParsedSkillFile {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parse(m[1]!);
    frontmatter = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    frontmatter = {};
  }
  return { frontmatter, body: m[2] ?? '' };
}

export function parseSkill(name: string, text: string, opts?: { pluginId?: string; path?: string }): Skill {
  const { frontmatter, body } = parseFrontmatter(text);
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
  const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  return {
    name: asString(frontmatter.name) ?? name,
    description: asString(frontmatter.description) ?? '',
    purpose: asString(frontmatter.purpose) ?? asString(frontmatter.description) ?? '',
    instructions: body.trim(),
    constraints: asStringArray(frontmatter.constraints),
    requiredTools: asStringArray(frontmatter.required_tools ?? frontmatter.requiredTools),
    workflow: asStringArray(frontmatter.workflow),
    outputFormat: asString(frontmatter.output_format ?? frontmatter.outputFormat),
    triggers: asStringArray(frontmatter.triggers),
    pluginId: opts?.pluginId,
    path: opts?.path,
  };
}

export interface SkillLoadResult {
  skills: Skill[];
}

export interface SkillLoadOptions {
  pluginId?: string;
  /** If provided, only load skills declared by a plugin manifest from this dir. */
  onlyNames?: string[];
}

/** Discover and load skills from a directory tree (skills/<name>/SKILL.md or skills/<name>.md). */
export function loadSkillsFromDir(dir: string, opts: SkillLoadOptions = {}): Skill[] {
  const skills: Skill[] = [];
  if (!existsSync(dir)) return skills;
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    let mdPath: string | undefined;
    let skillName = entry;

    if (st.isDirectory()) {
      const skillMd = join(full, 'SKILL.md');
      if (existsSync(skillMd)) {
        mdPath = skillMd;
      } else {
        // Recurse one level for nested skill dirs.
        skills.push(...loadSkillsFromDir(full, opts));
        continue;
      }
    } else if (st.isFile() && (extname(entry) === '.md')) {
      mdPath = full;
      skillName = basename(entry, '.md');
    }

    if (!mdPath) continue;
    if (opts.onlyNames && !opts.onlyNames.includes(skillName)) continue;
    const text = readFileSync(mdPath, 'utf8');
    skills.push(parseSkill(skillName, text, { pluginId: opts.pluginId, path: dirname(mdPath) }));
  }
  return skills;
}
