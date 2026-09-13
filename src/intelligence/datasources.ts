/**
 * Universal Data Source abstraction — domain-neutral registry.
 *
 * Data sources expose structured metadata (kinds, metrics, entities) and
 * return DataTables with provenance. Finance market feeds, CSV files,
 * databases, MCP resources and plugin providers all plug in through the same
 * interface. Mock sources must be marked `mock: true`.
 */
import type { DataRequest, DataSource, DataSourceInfo, DataTable } from './types.js';

export class DataSourceRegistry {
  private sources = new Map<string, DataSource>();

  register(source: DataSource): void {
    this.sources.set(source.id, source);
  }

  unregister(id: string): boolean {
    return this.sources.delete(id);
  }

  get(id: string): DataSource | undefined {
    return this.sources.get(id);
  }

  list(): DataSourceInfo[] {
    return [...this.sources.values()].map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      domains: s.domains,
      provides: s.provides,
      pluginId: s.pluginId,
      mock: s.mock,
    }));
  }

  /** Live handles (with fetch), for the engine. */
  listSources(): DataSource[] {
    return [...this.sources.values()];
  }

  async fetchFrom(ids: string[], req: DataRequest): Promise<{ tables: DataTable[]; errors: Array<{ sourceId: string; error: string }> }> {
    const tables: DataTable[] = [];
    const errors: Array<{ sourceId: string; error: string }> = [];
    for (const id of ids) {
      const source = this.sources.get(id);
      if (!source) {
        errors.push({ sourceId: id, error: 'not registered' });
        continue;
      }
      try {
        const fetched = await source.fetch(req);
        for (const t of fetched) tables.push(t);
      } catch (err) {
        errors.push({ sourceId: id, error: (err as Error).message });
      }
    }
    return { tables, errors };
  }
}

// ---------------------------------------------------------------------------
// Built-in: user-provided inline data (CSV / JSON pasted by the user).
// ---------------------------------------------------------------------------

/**
 * Parses CSV or JSON array data embedded in the query itself, e.g.
 * "find anomalies in this dataset: 1,2,3,4,20,6,7". Never fabricates data:
 * it only sees what the user provided.
 */
export const inlineDataSource: DataSource = {
  id: 'inline-data',
  label: 'User-provided data',
  kind: 'inline',
  provides: { kinds: ['timeseries', 'table'] },
  async fetch(req) {
    const parsed = parseInlineData(req.query.raw);
    if (!parsed) return [];
    return [parsed];
  },
};

export function parseInlineData(text: string): DataTable | undefined {
  // JSON array of numbers or objects.
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]) as unknown[];
      if (Array.isArray(arr) && arr.length >= 2) {
        if (arr.every((x) => typeof x === 'number')) {
          return {
            id: 'inline-json-series',
            sourceId: 'inline-data',
            label: 'user series',
            kind: 'timeseries',
            columns: [
              { key: 'i', label: 'index', type: 'number' },
              { key: 'value', label: 'value', type: 'number' },
            ],
            rows: arr.map((v, i) => ({ i, value: v })),
            provenance: 'user-provided JSON array',
            quality: { completeness: 1 },
          };
        }
        if (arr.every((x) => x && typeof x === 'object')) {
          const keys = Object.keys(arr[0] as Record<string, unknown>);
          const columns = keys.map((k) => ({
            key: k,
            label: k,
            type: (typeof (arr[0] as Record<string, unknown>)[k] === 'number' ? 'number' : 'string') as 'number' | 'string',
          }));
          if (columns.some((c) => c.type === 'number')) {
            return {
              id: 'inline-json-table',
              sourceId: 'inline-data',
              label: 'user table',
              kind: 'table',
              columns,
              rows: arr as Array<Record<string, unknown>>,
              provenance: 'user-provided JSON rows',
              quality: { completeness: 1 },
            };
          }
        }
      }
    } catch {
      /* fall through to CSV */
    }
  }

  // CSV-like list of numbers: "dataset: 1, 2, 3, 20, 6"
  const numMatch = text.match(/(?:data(?:set)?|series|angka|values?)\s*[:=]?\s*((?:-?\d+(?:\.\d+)?[,\s]+){2,}-?\d+(?:\.\d+)?)/i);
  if (numMatch) {
    const values = numMatch[1]!.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n));
    if (values.length >= 3) {
      return {
        id: 'inline-series',
        sourceId: 'inline-data',
        label: 'user series',
        kind: 'timeseries',
        columns: [
          { key: 'i', label: 'index', type: 'number' },
          { key: 'value', label: 'value', type: 'number' },
        ],
        rows: values.map((v, i) => ({ i, value: v })),
        provenance: 'user-provided number list',
        quality: { completeness: 1 },
      };
    }
  }
  return undefined;
}

export function createDataSourceRegistry(): DataSourceRegistry {
  const registry = new DataSourceRegistry();
  registry.register(inlineDataSource);
  return registry;
}
