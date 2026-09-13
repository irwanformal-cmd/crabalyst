/**
 * Visualization Recommendation Engine.
 *
 * Chooses visualization types from intent + data shape — the user never picks
 * chart types. Emits structured VisualizationSpecs consumed by the web canvas
 * renderer (web/viz.js). Every spec carries stable ids and links back to
 * findings/evidence/analysts/sources.
 */
import { columnValues, pearson, round2 } from './stats.js';
import { nextId } from './analysts.js';
import type {
  AnalystOutput,
  DataTable,
  ImportantLevel,
  StructuredQuery,
  VisualizationSpec,
  VizSeries,
} from './types.js';

export interface VizInput {
  query: StructuredQuery;
  tables: DataTable[];
  outputs: AnalystOutput[];
  /** Important levels (R1/R2, supports, current, invalidation) drawn on price charts. */
  levels?: ImportantLevel[];
}

const TIME_KEYS = ['t', 'timestamp', 'time', 'date', 'ts'];

export function recommendVisualizations(input: VizInput): VisualizationSpec[] {
  const specs: VisualizationSpec[] = [];
  const { query, tables, outputs } = input;
  // Chart-drawable levels: compact {label, value, kind} for the canvas renderer.
  const chartLevels = (input.levels ?? [])
    .filter((l) => Number.isFinite(l.value))
    .map((l) => ({ label: l.label, value: l.value, kind: l.kind }));

  const seriesTables = tables.filter((t) => t.kind === 'timeseries' || t.kind === 'ohlcv');

  // 1. Main series visualization: candlestick for OHLCV, line/area otherwise.
  for (const table of seriesTables.slice(0, 2)) {
    if (table.kind === 'ohlcv') {
      specs.push({
        id: nextId('viz'),
        type: 'candlestick',
        title: table.label,
        xType: 'time',
        data: { candles: table.rows.map((r) => ({ t: Number(r.t ?? r.timestamp), o: Number(r.open ?? r.o), h: Number(r.high ?? r.h), l: Number(r.low ?? r.l), c: Number(r.close ?? r.c), v: Number(r.volume ?? r.v ?? 0) })), levels: chartLevels },
        links: { sourceIds: [table.sourceId], findingIds: linkedFindings(outputs, table.sourceId) },
      });
    } else {
      const key = table.columns.find((c) => c.key === 'value' || c.key === 'close')?.key ?? table.columns.find((c) => c.type === 'number')?.key;
      if (!key) continue;
      const timeKey = table.columns.find((c) => c.type === 'timestamp' || TIME_KEYS.includes(c.key))?.key;
      const series: VizSeries = {
        id: table.id,
        label: table.label,
        points: table.rows.map((r, i) => {
          const xRaw = timeKey ? r[timeKey] : i;
          const x = typeof xRaw === 'number' ? xRaw : Date.parse(String(xRaw));
          return [Number.isFinite(x) ? (x as number) : i, Number(r[key])] as [number, number];
        }).filter(([, y]) => Number.isFinite(y)),
      };
      const anomalies = outputs.flatMap((o) => o.anomalies ?? []).filter((a) => a.metric);
      specs.push({
        id: nextId('viz'),
        type: query.visualizationPreference === 'area' ? 'area' : 'line',
        title: table.label,
        xType: timeKey ? 'time' : 'number',
        data: {
          series: [series],
          anomalies: anomalies.map((a) => ({ index: a.index, x: a.index !== undefined && series.points[a.index] ? series.points[a.index]![0] : undefined, y: a.value, severity: a.severity })).filter((a) => a.x !== undefined),
          levels: chartLevels,
        },
        links: { sourceIds: [table.sourceId], findingIds: linkedFindings(outputs, table.sourceId) },
      });
    }
  }

  // 2. Intent-driven supporting visualizations.
  const wantsComparison = query.intentCategory === 'compare' && seriesTables.length >= 2;
  if (wantsComparison) {
    const categories: string[] = [];
    const changeValues: number[] = [];
    for (const t of seriesTables) {
      const key = t.columns.find((c) => c.key === 'close' || c.key === 'value')?.key ?? t.columns.find((c) => c.type === 'number')?.key;
      if (!key) continue;
      const values = columnValues(t.rows, key);
      if (values.length < 2) continue;
      categories.push(t.entity ?? t.label);
      changeValues.push(round2(((values[values.length - 1]! - values[0]!) / (Math.abs(values[0]!) || 1)) * 100));
    }
    if (categories.length >= 2) {
      specs.push({
        id: nextId('viz'),
        type: 'bar',
        title: 'Relative change (%)',
        data: { categories, series: [{ id: 'change', label: 'change %', values: changeValues }] },
        links: { sourceIds: seriesTables.map((t) => t.sourceId) },
      });
      // Normalized overlay (rebased to 100).
      const overlay: VizSeries[] = seriesTables.slice(0, 4).map((t) => {
        const key = t.columns.find((c) => c.key === 'close' || c.key === 'value')?.key ?? t.columns.find((c) => c.type === 'number')?.key!;
        const values = columnValues(t.rows, key);
        const base = Math.abs(values[0] ?? 1) || 1;
        return { id: t.id, label: t.entity ?? t.label, points: values.map((v, i) => [i, round2((v / base) * 100)] as [number, number]) };
      });
      specs.push({
        id: nextId('viz'),
        type: 'line',
        title: 'Normalized comparison (base=100)',
        xType: 'number',
        data: { series: overlay },
        links: { sourceIds: seriesTables.map((t) => t.sourceId) },
      });
    }
  }

  const wantsRelationship = query.intentCategory === 'relationship' || query.analysisTypes.includes('correlation');
  if (wantsRelationship) {
    const picks = seriesTables
      .map((t) => {
        const key = t.columns.find((c) => c.key === 'close' || c.key === 'value')?.key ?? t.columns.find((c) => c.type === 'number')?.key;
        return key ? { label: t.entity ?? t.label, values: columnValues(t.rows, key) } : undefined;
      })
      .filter((p): p is { label: string; values: number[] } => !!p && p.values.length >= 3);
    if (picks.length >= 2) {
      const [a, b] = picks;
      const n = Math.min(a!.values.length, b!.values.length);
      specs.push({
        id: nextId('viz'),
        type: 'scatter',
        title: `${a!.label} vs ${b!.label}`,
        data: { points: a!.values.slice(0, n).map((v, i) => ({ x: v, y: b!.values[i]! })), xLabel: a!.label, yLabel: b!.label, correlation: round2(pearson(a!.values, b!.values)) },
        links: { sourceIds: seriesTables.map((t) => t.sourceId) },
      });
    }
    if (picks.length >= 3) {
      specs.push({
        id: nextId('viz'),
        type: 'correlation-matrix',
        title: 'Correlation matrix',
        data: {
          labels: picks.map((p) => p.label),
          values: picks.map((p1) => picks.map((p2) => round2(pearson(p1.values, p2.values)))),
        },
      });
    }
  }

  // 3. Histogram when distribution matters (anomaly/discover intents).
  if ((query.intent === 'anomaly' || query.intent === 'discover' || query.analysisTypes.includes('statistical')) && seriesTables.length) {
    const t = seriesTables[0]!;
    const key = t.columns.find((c) => c.key === 'close' || c.key === 'value')?.key ?? t.columns.find((c) => c.type === 'number')?.key;
    if (key) {
      const values = columnValues(t.rows, key);
      if (values.length >= 10) {
        specs.push({
          id: nextId('viz'),
          type: 'histogram',
          title: `Distribution of ${t.label}`,
          data: { bins: histogramBins(values, 12) },
          links: { sourceIds: [t.sourceId] },
        });
      }
    }
  }

  // 4. Network tables (dependency graphs) render directly.
  for (const t of tables.filter((t) => t.kind === 'network')) {
    specs.push({
      id: nextId('viz'),
      type: 'network',
      title: t.label,
      data: t.meta?.graph ?? { nodes: [], edges: [] },
      links: { sourceIds: [t.sourceId] },
    });
  }

  // 5. KPI summary strip from statistical output.
  const stat = outputs.find((o) => o.analystId === 'statistical' && o.ok);
  if (stat) {
    const items = stat.evidence.slice(0, 4).map((e) => ({ label: e.metric, value: typeof e.value === 'number' ? e.value : JSON.stringify(e.value), evidenceId: e.id }));
    specs.push({
      id: nextId('viz'),
      type: 'kpi',
      title: 'Key metrics',
      data: { items },
      links: { analystIds: ['statistical'], evidenceIds: stat.evidence.map((e) => e.id) },
    });
  }

  // Explicit user preference overrides the primary chart type when possible.
  if (query.visualizationPreference && specs.length) {
    const pref = query.visualizationPreference;
    const idx = specs.findIndex((s) => s.type === pref);
    if (idx > 0) {
      const [hit] = specs.splice(idx, 1);
      specs.unshift(hit!);
    }
  }

  return specs;
}

function linkedFindings(outputs: AnalystOutput[], sourceId: string): string[] {
  const ids: string[] = [];
  for (const o of outputs) {
    for (const e of o.evidence) {
      if (e.sourceId === sourceId) ids.push(...e.findingIds);
    }
  }
  return [...new Set(ids)];
}

export function histogramBins(values: number[], binCount: number): Array<{ x0: number; x1: number; count: number }> {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) return [{ x0: lo, x1: hi + 1, count: values.length }];
  const width = (hi - lo) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({ x0: lo + i * width, x1: lo + (i + 1) * width, count: 0 }));
  for (const v of values) {
    const idx = Math.min(binCount - 1, Math.floor((v - lo) / width));
    bins[idx]!.count++;
  }
  return bins.map((b) => ({ x0: round2(b.x0), x1: round2(b.x1), count: b.count }));
}
