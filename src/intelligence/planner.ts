/**
 * Analysis Planner — dynamic analyst selection and workflow routing.
 *
 * Given a StructuredQuery plus the analyst/data-source registries, the planner
 * picks the SMALLEST appropriate workflow: only analysts whose analysis types
 * or intents match the query, and only data sources that can serve the
 * resolved entities/domain. Nothing is hard-coded per subject.
 */
import type { AnalystRegistry } from './analysts.js';
import type { DataSourceRegistry } from './datasources.js';
import type { Analyst, AnalysisPlan, PlanStep, StructuredQuery } from './types.js';

export interface PlannerDeps {
  analysts: AnalystRegistry;
  dataSources: DataSourceRegistry;
}

/** Workflow routing rules, ordered — first match wins. Plugins may add more. */
export interface WorkflowRule {
  id: string;
  /** Human label for the workflow. */
  label: string;
  /** Returns a score > 0 when this workflow applies. */
  match(query: StructuredQuery): number;
  /** Extra analysis types this workflow requires. */
  addAnalysisTypes?: string[];
}

export const DEFAULT_WORKFLOWS: WorkflowRule[] = [
  {
    id: 'what-if',
    label: 'What-if simulation',
    match: (q) => (q.whatIf || q.intent === 'what-if' ? 10 : 0),
    addAnalysisTypes: ['scenario', 'sensitivity'],
  },
  {
    id: 'comparison',
    label: 'Cross-entity comparison',
    match: (q) => (q.intentCategory === 'compare' && q.entities.length >= 2 ? 10 : q.compareTargets.length >= 1 ? 6 : 0),
    addAnalysisTypes: ['comparison'],
  },
  {
    id: 'relationship',
    label: 'Relationship analysis',
    match: (q) => (q.intentCategory === 'relationship' ? 10 : 0),
    addAnalysisTypes: ['correlation', 'regression'],
  },
  {
    id: 'forecast',
    label: 'Forecasting',
    match: (q) => (q.intentCategory === 'predict' ? 10 : 0),
    addAnalysisTypes: ['forecast', 'trend'],
  },
  {
    id: 'diagnostic',
    label: 'Multi-signal diagnosis',
    match: (q) => (q.intentCategory === 'diagnose' ? 10 : 0),
    addAnalysisTypes: ['trend', 'anomaly', 'causal'],
  },
  {
    id: 'discovery',
    label: 'Pattern discovery',
    match: (q) => (q.intent === 'anomaly' || q.intent === 'discover' || q.intent === 'pattern' ? 8 : 0),
  },
  {
    id: 'evaluation',
    label: 'Evaluation',
    match: (q) => (q.intentCategory === 'evaluate' || q.intentCategory === 'decide' ? 8 : 0),
  },
  {
    id: 'subject-analysis',
    label: 'Subject analysis',
    match: (q) => (q.subject ? 3 : 0),
  },
  {
    id: 'generic',
    label: 'Generic analysis',
    match: () => 1,
  },
];

export class AnalysisPlanner {
  private workflows: WorkflowRule[] = [...DEFAULT_WORKFLOWS];

  constructor(private deps: PlannerDeps) {}

  /** Plugins can register additional workflows (sorted in by score at plan time). */
  registerWorkflow(rule: WorkflowRule): void {
    this.workflows = this.workflows.filter((w) => w.id !== rule.id);
    this.workflows.push(rule);
  }

  plan(query: StructuredQuery): AnalysisPlan {
    // 1. Route to the smallest matching workflow.
    let best: { rule: WorkflowRule; score: number } | undefined;
    for (const rule of this.workflows) {
      const score = rule.match(query);
      if (score > 0 && (!best || score > best.score)) best = { rule, score };
    }
    const workflow = best?.rule ?? DEFAULT_WORKFLOWS[DEFAULT_WORKFLOWS.length - 1]!;

    // 2. Effective analysis types = query types + workflow additions.
    const wantedTypes = new Set(query.analysisTypes);
    for (const t of workflow.addAnalysisTypes ?? []) wantedTypes.add(t);
    if (query.depth === 'deep') {
      wantedTypes.add('statistical');
      wantedTypes.add('anomaly');
    }

    // 3. Dynamic analyst selection.
    const selected = this.selectAnalysts(query, wantedTypes);

    // 4. Data source selection: sources matching domain/kinds the analysts need.
    const selectedSources = this.selectSources(query, selected);

    // 5. Human-readable plan steps.
    const steps: PlanStep[] = [];
    let stepSeq = 0;
    const step = (label: string): PlanStep => ({ id: `step-${++stepSeq}`, label, status: 'pending' });
    steps.push(step(`Understand query: intent=${query.intent}${query.subject ? `, subject=${query.subject}` : ''}`));
    if (query.entities.length) steps.push(step(`Resolve entities: ${query.entities.map((e) => e.id).join(', ')}`));
    steps.push(step(`Route workflow: ${workflow.label}`));
    if (selectedSources.length) steps.push(step(`Collect data from: ${selectedSources.map((s) => s.id).join(', ')}`));
    else steps.push({ ...step('Collect data'), status: 'skipped', detail: 'no matching data source' });
    for (const a of selected) steps.push(step(`Run analyst: ${a.name}`));
    steps.push(step('Synthesize evidence'));
    steps.push(step('Select visualizations'));
    steps.push(step('Compose decision summary'));

    return {
      workflow: workflow.id,
      rationale: `${workflow.label}: intent "${query.intent}" (${query.intentCategory}), analysis types [${[...wantedTypes].join(', ')}]`,
      analystIds: selected.map((a) => a.id),
      sourceIds: selectedSources.map((s) => s.id),
      steps,
    };
  }

  /**
   * Select analysts whose declared capabilities intersect the query.
   * An analyst is eligible when:
   *  - its domain constraint (if any) includes the query domain (or query has none), AND
   *  - it supports the intent/category OR shares an analysis type.
   * Sorted by number of matching signals; capped to keep workflows minimal
   * unless depth=deep.
   */
  selectAnalysts(query: StructuredQuery, wantedTypes: Set<string>): Analyst[] {
    const scored: Array<{ analyst: Analyst; score: number }> = [];
    for (const analyst of this.deps.analysts.list()) {
      if (analyst.domains?.length && query.domain && !analyst.domains.includes(query.domain)) continue;
      if (analyst.domains?.length && !query.domain) {
        // Domain specialists (e.g. on-chain) require a matching domain or an explicit analysis-type hit.
        const explicit = analyst.analysisTypes.some((t) => query.analysisTypes.includes(t));
        if (!explicit) continue;
      }
      const typeHits = analyst.analysisTypes.filter((t) => wantedTypes.has(t)).length;
      // Workflow isolation: when the query carries specific metric hints
      // (whale, sentiment, macro, fps, …), a domain specialist must share an
      // analysis type with the query — an intent match alone is not enough.
      if (analyst.domains?.length && query.metrics.length > 0 && typeHits === 0) continue;
      let score = 0;
      if (analyst.supportedIntents.includes(query.intent)) score += 3;
      if (analyst.supportedIntents.includes(query.intentCategory)) score += 2;
      score += typeHits * 2;
      if (score > 0) scored.push({ analyst, score });
    }
    scored.sort((a, b) => b.score - a.score || (b.analyst.reliability ?? 0.5) - (a.analyst.reliability ?? 0.5));
    const cap = query.depth === 'deep' ? 10 : query.depth === 'quick' ? 4 : 7;
    return scored.slice(0, cap).map((s) => s.analyst);
  }

  private selectSources(query: StructuredQuery, analysts: Analyst[]) {
    const neededKinds = new Set<string>();
    for (const a of analysts) for (const k of a.requiredDataTypes ?? []) neededKinds.add(k);
    const sources = this.deps.dataSources.list().filter((s) => {
      if (s.domains?.length && query.domain && !s.domains.includes(query.domain)) return false;
      if (s.domains?.length && !query.domain) return false;
      if (!neededKinds.size) return true;
      return s.provides.kinds.some((k) => neededKinds.has(k));
    });
    return sources.slice(0, 6);
  }
}
