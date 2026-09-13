/**
 * GameDev — Intelligence Layer contributions.
 *
 * Makes game projects analyzable by the universal engine:
 *  - data source: game project (FPS/frame-time logs when present, dependency graph)
 *  - analysts: Performance Analyst (FPS drops, frame-time anomalies),
 *    Dependency Analyst (module graph)
 *
 * This validates that the core engine is domain-agnostic.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import type { Analyst, DataTable } from '../../src/intelligence/types.js';
import type { PluginIntelligence } from '../../src/types/plugin.js';
import type { WorkflowRule } from '../../src/intelligence/planner.js';
import { makeEvidence, makeFinding, nextId } from '../../src/intelligence/analysts.js';
import { columnValues, detectAnomalies, detectChangePoint, mean, round2 } from '../../src/intelligence/stats.js';

const PERF_LOG_NAMES = ['fps.csv', 'fps.log', 'perf.csv', 'performance.csv', 'frametime.csv'];
const CODE_EXTENSIONS = new Set(['.ts', '.js', '.gd', '.cs', '.cpp', '.h', '.lua', '.py']);

function findPerfLog(root: string, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const name of PERF_LOG_NAMES) {
    if (entries.includes(name)) return join(root, name);
  }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const full = join(root, e);
    try {
      if (statSync(full).isDirectory()) {
        const hit = findPerfLog(full, depth + 1);
        if (hit) return hit;
      }
    } catch {
      /* skip */
    }
  }
  return undefined;
}

/** Parse "fps" or "time,fps" / "time,frame_ms" CSV-ish logs. */
export function parsePerfLog(content: string, filePath: string): DataTable | undefined {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length < 5) return undefined;
  const rows: Array<Record<string, unknown>> = [];
  let valueKey = 'fps';
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i]!.split(/[,\t;]/).map((p) => p.trim());
    if (i === 0 && parts.some((p) => /[a-zA-Z]/.test(p))) {
      // Header row.
      valueKey = parts.find((p) => /fps|frame|ms/i.test(p)) ?? parts[parts.length - 1]!;
      continue;
    }
    const value = Number(parts[parts.length - 1]);
    if (!Number.isFinite(value)) continue;
    rows.push({ i: rows.length, value });
  }
  if (rows.length < 5) return undefined;
  return {
    id: `perf-${basename(filePath)}`,
    sourceId: 'game-project',
    label: `${valueKey} · ${basename(filePath)}`,
    kind: 'timeseries',
    columns: [
      { key: 'i', label: 'sample', type: 'number' },
      { key: 'value', label: valueKey, type: 'number', unit: /fps/i.test(valueKey) ? 'fps' : 'ms' },
    ],
    rows,
    provenance: `workspace file: ${filePath}`,
    quality: { completeness: 1 },
  };
}

/** Build a simple dependency network from code-file import statements. */
export function buildDependencyGraph(root: string, maxFiles = 40): { nodes: Array<{ id: string; label: string; kind: string }>; edges: Array<{ from: string; to: string; kind: string }> } {
  const nodes: Array<{ id: string; label: string; kind: string }> = [];
  const edges: Array<{ from: string; to: string; kind: string }> = [];
  const files: string[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 4 || files.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e.startsWith('.') || files.length >= maxFiles) continue;
      const full = join(dir, e);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full, depth + 1);
        else if (CODE_EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) files.push(full);
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);

  const idFor = new Map<string, string>();
  for (const f of files) {
    const id = relative(root, f);
    idFor.set(basename(f), id);
    nodes.push({ id, label: basename(f), kind: 'module' });
  }
  const importRe = /(?:import\s+.*?from\s+|require\()\s*['"]([^'"]+)['"]/g;
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, 'utf8').slice(0, 50_000);
    } catch {
      continue;
    }
    for (const m of content.matchAll(importRe)) {
      const spec = m[1]!;
      if (!spec.startsWith('.')) continue; // local imports only
      const base = basename(spec).replace(/\.(js|ts|gd|cs|cpp|h|lua|py)$/, '');
      for (const [fileBase, id] of idFor) {
        if (fileBase.replace(/\.[^.]+$/, '') === base) {
          edges.push({ from: relative(root, f), to: id, kind: 'depends-on' });
          break;
        }
      }
    }
  }
  return { nodes, edges };
}

const gameProjectSource = {
  id: 'game-project',
  label: 'Game project (workspace)',
  kind: 'filesystem',
  domains: ['gamedev'],
  provides: { kinds: ['timeseries', 'network'] as Array<'timeseries' | 'network'>, metrics: ['fps', 'frametime'] },
  async fetch(req: { query: { analysisTypes: string[]; metrics: string[] }; workspacePath?: string }) {
    const root = req.workspacePath ?? process.cwd();
    const tables: DataTable[] = [];

    const wantsPerf = req.query.metrics.includes('fps') || req.query.metrics.includes('system') || req.query.analysisTypes.includes('performance') || req.query.analysisTypes.includes('anomaly');
    if (wantsPerf) {
      const log = findPerfLog(root);
      if (log) {
        try {
          const table = parsePerfLog(readFileSync(log, 'utf8'), log);
          if (table) tables.push(table);
        } catch {
          /* unreadable log */
        }
      }
    }

    const wantsDeps = req.query.analysisTypes.includes('dependency') || req.query.analysisTypes.includes('network');
    if (wantsDeps) {
      const graph = buildDependencyGraph(root);
      if (graph.nodes.length) {
        tables.push({
          id: 'dep-graph',
          sourceId: 'game-project',
          label: 'module dependencies',
          kind: 'network',
          columns: [],
          rows: [],
          provenance: `workspace scan: ${root}`,
          quality: { completeness: 1 },
          meta: { graph },
        });
      }
    }
    return tables;
  },
};

const performanceAnalyst: Analyst = {
  id: 'game-performance',
  name: 'Performance Analyst',
  description: 'FPS/frame-time analysis: drops, anomalies, change points.',
  supportedIntents: ['diagnose', 'troubleshoot', 'performance', 'analyze', 'evaluate'],
  analysisTypes: ['performance', 'anomaly', 'trend'],
  domains: ['gamedev'],
  requiredDataTypes: ['timeseries'],
  reliability: 0.8,
  run(ctx) {
    const table = ctx.tables.find((t) => t.sourceId === 'game-project' && t.kind === 'timeseries');
    if (!table) {
      return {
        analystId: 'game-performance',
        ok: false,
        findings: [],
        evidence: [],
        error: 'no performance log found (drop fps.csv / perf.csv into the project)',
        headline: 'no perf data',
      };
    }
    const values = columnValues(table.rows, 'value');
    const isFps = /fps/i.test(table.columns.find((c) => c.key === 'value')?.label ?? 'fps');
    const anomalies = detectAnomalies(values, { method: 'rolling', window: Math.max(10, Math.floor(values.length / 6)), threshold: 3, metric: table.label, idPrefix: 'perf' });
    const cp = detectChangePoint(values);
    const avg = mean(values);

    const evidence = [
      makeEvidence({ sourceId: 'game-project', analystId: 'game-performance', metric: 'avg', value: round2(avg), reliability: 'high', label: `average ${table.label} = ${round2(avg)}` }),
    ];
    const findings = [];
    if (cp) {
      const dropPct = round2((cp.magnitude / (Math.abs(mean(values.slice(0, cp.index))) || 1)) * 100);
      const ev = makeEvidence({
        sourceId: 'game-project',
        analystId: 'game-performance',
        metric: 'change_point',
        value: { index: cp.index, magnitude: round2(cp.magnitude), pct: dropPct },
        reliability: 'medium',
        label: `${isFps ? 'FPS' : 'frame-time'} shift at sample #${cp.index} (${dropPct}%)`,
      });
      evidence.push(ev);
      const f = makeFinding({
        title: `${isFps ? 'FPS' : 'frame-time'} shifted at sample #${cp.index} (${dropPct > 0 ? '+' : ''}${dropPct}%)`,
        detail: `${anomalies.length} anomalous samples detected. Correlate the change point with recent code/asset changes.`,
        analystId: 'game-performance',
        confidence: 0.6,
        evidenceIds: [ev.id],
        tags: ['performance', 'causal'],
      });
      ev.findingIds.push(f.id);
      findings.push(f);
    }
    return {
      analystId: 'game-performance',
      ok: true,
      findings,
      evidence,
      anomalies,
      confidence: 0.6,
      headline: cp ? `shift at #${cp.index}` : `avg ${round2(avg)}`,
    };
  },
};

const dependencyAnalyst: Analyst = {
  id: 'game-dependency',
  name: 'Dependency Analyst',
  description: 'Module dependency network from local imports.',
  supportedIntents: ['dependency', 'relationship', 'analyze'],
  analysisTypes: ['dependency', 'network'],
  domains: ['gamedev'],
  requiredDataTypes: ['network'],
  reliability: 0.8,
  run(ctx) {
    const table = ctx.tables.find((t) => t.sourceId === 'game-project' && t.kind === 'network');
    const graph = table?.meta?.graph as { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> } | undefined;
    if (!table || !graph) {
      return { analystId: 'game-dependency', ok: false, findings: [], evidence: [], error: 'no dependency graph', headline: 'no graph' };
    }
    const relationships = graph.edges.slice(0, 40).map((e) => ({
      id: nextId('rel'),
      kind: 'dependency' as const,
      a: e.from,
      b: e.to,
      direction: 'positive' as const,
      evidenceIds: [] as string[],
    }));
    const ev = makeEvidence({
      sourceId: 'game-project',
      analystId: 'game-dependency',
      metric: 'dependency_graph',
      value: { modules: graph.nodes.length, edges: graph.edges.length },
      reliability: 'high',
      label: `${graph.nodes.length} modules, ${graph.edges.length} local dependencies`,
    });
    const f = makeFinding({
      title: `Project has ${graph.nodes.length} modules with ${graph.edges.length} local dependencies`,
      analystId: 'game-dependency',
      evidenceIds: [ev.id],
      tags: ['dependency'],
    });
    ev.findingIds.push(f.id);
    return { analystId: 'game-dependency', ok: true, findings: [f], evidence: [ev], relationships, headline: `${graph.edges.length} deps` };
  },
};

const gamedevWorkflow: WorkflowRule = {
  id: 'gamedev-diagnosis',
  label: 'Game project diagnosis',
  match: (q) => (q.domain === 'gamedev' || q.metrics.includes('fps') ? 18 : 0),
  addAnalysisTypes: ['performance', 'anomaly', 'causal'],
};

export const gamedevIntelligence: PluginIntelligence = {
  entityResolvers: [
    {
      id: 'gamedev-project',
      resolve: (text) =>
        /\b(game|gim|project|proyek|fps|scene|sprite|engine)\b/i.test(text)
          ? [{ id: 'game-project', label: 'game project', kind: 'project', domain: 'gamedev', resolverId: 'gamedev-project', mention: text.match(/\b(game|gim|project|proyek|fps|scene|sprite|engine)\b/i)![0] }]
          : [],
    },
  ],
  dataSources: [gameProjectSource],
  analysts: [performanceAnalyst, dependencyAnalyst],
  workflows: [gamedevWorkflow],
  intents: [
    { id: 'performance', category: 'evaluate', keywords: ['fps drop', 'frame drop', 'stutter', 'patah-patah', 'lag'], analysisTypes: ['performance', 'anomaly', 'causal'] },
  ],
};
