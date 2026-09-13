/**
 * Evidence Engine — merges analyst evidence, links findings, and builds the
 * user-facing Evidence Graph (auditable reasoning structure only; no hidden
 * chain-of-thought is ever exposed).
 */
import type {
  AnalystOutput,
  EvidenceGraph,
  EvidenceGraphEdge,
  EvidenceGraphNode,
  EvidenceItem,
  Finding,
} from './types.js';

export interface EvidenceBundle {
  evidence: EvidenceItem[];
  findings: Finding[];
}

/** Merge evidence/findings across analyst outputs, keeping id links intact. */
export function collectEvidence(outputs: AnalystOutput[]): EvidenceBundle {
  const evidence: EvidenceItem[] = [];
  const findings: Finding[] = [];
  const evIds = new Set<string>();
  const fIds = new Set<string>();
  for (const out of outputs) {
    for (const e of out.evidence) {
      if (evIds.has(e.id)) continue;
      evIds.add(e.id);
      evidence.push(e);
    }
    for (const f of out.findings) {
      if (fIds.has(f.id)) continue;
      fIds.add(f.id);
      findings.push(f);
    }
  }
  return { evidence, findings };
}

/** Aggregate evidence strength from reliability and coverage. */
export function evidenceStrength(evidence: EvidenceItem[], findings: Finding[]): 'high' | 'medium' | 'low' | 'insufficient' {
  if (!evidence.length || !findings.length) return 'insufficient';
  const weight = evidence.reduce((s, e) => s + (e.reliability === 'high' ? 1 : e.reliability === 'medium' ? 0.6 : 0.3), 0);
  const coverage = findings.filter((f) => f.evidenceIds.length > 0).length / findings.length;
  const score = weight * (0.5 + 0.5 * coverage);
  if (score >= 6) return 'high';
  if (score >= 2.5) return 'medium';
  return 'low';
}

/** Build the interactive evidence graph for an analysis. */
export function buildEvidenceGraph(input: {
  decisionSummary?: string;
  decisionId?: string;
  outputs: AnalystOutput[];
  sources: Array<{ id: string; label: string }>;
  assumptions?: string[];
  scenarioNames?: string[];
  forecastPresent?: boolean;
}): EvidenceGraph {
  const nodes: EvidenceGraphNode[] = [];
  const edges: EvidenceGraphEdge[] = [];
  const seen = new Set<string>();

  const addNode = (n: EvidenceGraphNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    nodes.push(n);
  };

  let conclusionId: string | undefined;
  if (input.decisionSummary) {
    conclusionId = input.decisionId ?? 'conclusion';
    addNode({ id: conclusionId, kind: 'conclusion', label: input.decisionSummary });
  }

  for (const src of input.sources) {
    addNode({ id: `source:${src.id}`, kind: 'source', label: src.label });
  }

  for (const out of input.outputs) {
    const analystNodeId = `analyst:${out.analystId}`;
    if (out.ok) {
      addNode({ id: analystNodeId, kind: 'analyst', label: out.analystId });
      if (conclusionId) edges.push({ from: analystNodeId, to: conclusionId, kind: 'contributes-to' });
    }
    for (const finding of out.findings) {
      addNode({ id: finding.id, kind: 'finding', label: finding.title, detail: finding.detail });
      if (out.ok) edges.push({ from: finding.id, to: analystNodeId, kind: 'derived-from' });
      for (const evId of finding.evidenceIds) {
        const ev = out.evidence.find((e) => e.id === evId);
        if (!ev) continue;
        addNode({
          id: ev.id,
          kind: 'evidence',
          label: ev.label,
          detail: `metric=${ev.metric} value=${JSON.stringify(ev.value)}${ev.baseline !== undefined ? ` baseline=${JSON.stringify(ev.baseline)}` : ''} reliability=${ev.reliability}`,
        });
        edges.push({ from: ev.id, to: finding.id, kind: 'supports' });
        if (ev.sourceId) {
          addNode({ id: `source:${ev.sourceId}`, kind: 'source', label: ev.sourceId });
          edges.push({ from: `source:${ev.sourceId}`, to: ev.id, kind: 'derived-from' });
        }
      }
    }
    for (const anomaly of out.anomalies ?? []) {
      addNode({ id: anomaly.id, kind: 'anomaly', label: `${anomaly.metric}: ${anomaly.value} (${anomaly.deviation}σ)`, detail: anomaly.explanation });
      edges.push({ from: anomaly.id, to: analystNodeId, kind: 'derived-from' });
    }
  }

  for (const assumption of input.assumptions ?? []) {
    const id = `assumption:${assumption.slice(0, 40)}`;
    addNode({ id, kind: 'assumption', label: assumption });
    if (conclusionId) edges.push({ from: conclusionId, to: id, kind: 'depends-on' });
  }

  for (const name of input.scenarioNames ?? []) {
    const id = `scenario:${name}`;
    addNode({ id, kind: 'scenario', label: name });
    if (conclusionId) edges.push({ from: id, to: conclusionId, kind: 'contributes-to' });
  }

  if (input.forecastPresent && conclusionId) {
    const id = 'forecast';
    addNode({ id, kind: 'forecast', label: 'forecast (model estimate)' });
    edges.push({ from: id, to: conclusionId, kind: 'contributes-to' });
  }

  return { nodes, edges };
}
