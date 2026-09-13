/**
 * Query Understanding — turns natural language into a StructuredQuery.
 *
 * Fully deterministic: intent classification + entity resolution + time-range
 * parsing + what-if parsing + metric/dimension hints. No LLM required, so the
 * pipeline works with MockProvider and offline. Domain plugins extend the
 * underlying intent/entity registries.
 */
import type { EntityResolverRegistry } from './entities.js';
import type { IntentEngine } from './intent.js';
import type { IntentCategory, StructuredQuery, TimeRange, WhatIfRequest } from './types.js';

const TIME_PATTERNS: Array<{ re: RegExp; make: (m: RegExpMatchArray) => TimeRange }> = [
  { re: /\b(today|hari ini)\b/i, make: () => ({ kind: 'today', label: 'today' }) },
  { re: /\b(yesterday|kemarin)\b/i, make: () => ({ kind: 'past', amount: 1, unit: 'day', label: 'yesterday' }) },
  { re: /\b(this week|minggu ini)\b/i, make: () => ({ kind: 'past', amount: 1, unit: 'week', label: 'this week' }) },
  { re: /\b(this month|bulan ini)\b/i, make: () => ({ kind: 'past', amount: 1, unit: 'month', label: 'this month' }) },
  { re: /\blast\s+(\d+)\s*(minutes?|menit|hours?|jam|days?|hari|weeks?|minggu|months?|bulan|years?|tahun)\b/i, make: (m) => ({ kind: 'past', amount: Number(m[1]), unit: normalizeUnit(m[2]!), label: `last ${m[1]} ${m[2]}` }) },
  { re: /\b(\d+)\s*(minutes?|menit|hours?|jam|days?|hari|weeks?|minggu|months?|bulan)\s+(ago|lalu)\b/i, make: (m) => ({ kind: 'past', amount: Number(m[1]), unit: normalizeUnit(m[2]!), label: `${m[1]} ${m[2]} ago` }) },
];

const METRIC_HINTS: Array<{ re: RegExp; metric: string; analysisTypes: string[] }> = [
  { re: /\b(whale|paus|bandar)\b/i, metric: 'whale', analysisTypes: ['onchain', 'flow', 'accumulation_distribution'] },
  { re: /\b(on-?chain|onchain)\b/i, metric: 'onchain', analysisTypes: ['onchain', 'flow'] },
  { re: /\b(volume|vol)\b/i, metric: 'volume', analysisTypes: ['volume'] },
  { re: /\b(volatility|volatilitas)\b/i, metric: 'volatility', analysisTypes: ['risk', 'statistical'] },
  { re: /\b(sentimen|sentiment)\b/i, metric: 'sentiment', analysisTypes: ['sentiment'] },
  { re: /\b(macro|makro)\b/i, metric: 'macro', analysisTypes: ['macro'] },
  { re: /\b(teknikal|technical)\b/i, metric: 'technical', analysisTypes: ['technical'] },
  { re: /\b(fundamental)\b/i, metric: 'fundamental', analysisTypes: ['fundamental'] },
  { re: /\b(revenue|pendapatan|omzet|omset)\b/i, metric: 'revenue', analysisTypes: ['trend', 'comparison'] },
  { re: /\b(sales|penjualan)\b/i, metric: 'sales', analysisTypes: ['trend', 'seasonality'] },
  { re: /\b(conversion|konversi)\b/i, metric: 'conversion', analysisTypes: ['funnel', 'comparison'] },
  { re: /\b(fps|frame\s?rate)\b/i, metric: 'fps', analysisTypes: ['performance', 'anomaly'] },
  { re: /\b(cpu|gpu|memory|memori|ram)\b/i, metric: 'system', analysisTypes: ['performance', 'correlation'] },
  { re: /\b(latency|latensi|response time)\b/i, metric: 'latency', analysisTypes: ['performance'] },
  { re: /\b(traffic|pengunjung|visits)\b/i, metric: 'traffic', analysisTypes: ['trend'] },
  { re: /\b(temperature|suhu|temperatur)\b/i, metric: 'temperature', analysisTypes: ['correlation'] },
  { re: /\b(energy|listrik|energi|power)\b/i, metric: 'energy', analysisTypes: ['correlation'] },
];

export interface QueryUnderstandingDeps {
  intents: IntentEngine;
  entities: EntityResolverRegistry;
}

export class QueryUnderstanding {
  constructor(private deps: QueryUnderstandingDeps) {}

  understand(raw: string): StructuredQuery {
    const text = raw.trim();
    const intentMatches = this.deps.intents.classify(text);
    const topIntent = intentMatches[0] ?? this.deps.intents.top(text);

    const entities = this.deps.entities.resolveAll(text);
    const subject = entities[0];
    const compareTargets = /\b(vs|versus|dibanding(?:kan)?(?: dengan)?|compare(?:d)? (?:with|to)|dengan)\b/i.test(text)
      ? entities.slice(1)
      : entities.slice(1);

    // Merge analysis types from the top-2 intents plus metric hints.
    const analysisTypes = new Set<string>();
    for (const m of intentMatches.slice(0, 2)) {
      for (const t of m.analysisTypes) analysisTypes.add(t);
    }
    if (intentMatches.length === 0) {
      for (const t of topIntent.analysisTypes) analysisTypes.add(t);
    }

    const metrics: string[] = [];
    for (const hint of METRIC_HINTS) {
      if (hint.re.test(text)) {
        metrics.push(hint.metric);
        for (const t of hint.analysisTypes) analysisTypes.add(t);
      }
    }

    const timeRange = parseTimeRange(text);
    const whatIf = parseWhatIf(text);

    // "full/complete/lengkap" analysis widens depth; quick questions stay narrow.
    const depth: StructuredQuery['depth'] = /\b(lengkap|full|complete|mendalam|deep|komprehensif)\b/i.test(text)
      ? 'deep'
      : /\b(cepat|quick|singkat|brief)\b/i.test(text)
        ? 'quick'
        : 'standard';

    const visualizationPreference = parseVizPreference(text);

    return {
      raw: text,
      intent: topIntent.id,
      intentCategory: topIntent.category as IntentCategory,
      subject: subject?.id,
      subjectLabel: subject?.label,
      domain: subject?.domain,
      entities,
      analysisTypes: [...analysisTypes],
      timeRange,
      dimensions: [],
      metrics,
      compareTargets,
      requestedOutput: [],
      visualizationPreference,
      depth,
      whatIf,
    };
  }
}

function parseTimeRange(text: string): TimeRange | undefined {
  for (const { re, make } of TIME_PATTERNS) {
    const m = text.match(re);
    if (m) return make(m);
  }
  return undefined;
}

/** "if conversion increases 20%" / "jika konversi naik 20%" */
export function parseWhatIf(text: string): WhatIfRequest | undefined {
  const m = text.match(
    /(?:if|jika|bagaimana jika|what if|gimana kalau)\s+([a-zA-Z][a-zA-Z0-9 _-]{1,30}?)\s+(naik|turun|increases?|decrease?s?|drops?|grows?|meningkat|menurun)\s*(?:by|sebesar)?\s*([+-]?\d+(?:\.\d+)?)\s*(%|percent|persen)?/i,
  );
  if (!m) return undefined;
  const directionWord = m[2]!.toLowerCase();
  const direction = /turun|decrease|drop|menurun/.test(directionWord) ? 'decrease' : 'increase';
  const value = Number(m[3]);
  const isPct = !!m[4];
  return {
    variable: m[1]!.trim(),
    direction,
    changePct: isPct ? (direction === 'decrease' ? -Math.abs(value) : Math.abs(value)) : undefined,
    changeAbs: !isPct ? (direction === 'decrease' ? -Math.abs(value) : Math.abs(value)) : undefined,
  };
}

function parseVizPreference(text: string): string | undefined {
  const prefs: Array<[RegExp, string]> = [
    [/\b(candlestick|candle)\b/i, 'candlestick'],
    [/\b(scatter|sebaran)\b/i, 'scatter'],
    [/\b(histogram|distribusi)\b/i, 'histogram'],
    [/\b(heatmap|peta panas)\b/i, 'heatmap'],
    [/\b(bar chart|batang)\b/i, 'bar'],
    [/\b(line chart|garis)\b/i, 'line'],
    [/\b(pie|donut)\b/i, 'pie'],
    [/\b(network|graph|graf|jaringan)\b/i, 'network'],
  ];
  for (const [re, type] of prefs) if (re.test(text)) return type;
  return undefined;
}

function normalizeUnit(word: string): TimeRange['unit'] {
  const w = word.toLowerCase();
  if (/^m(odule)?/.test(w)) {
    if (/^(minute|menit)/.test(w)) return 'minute';
    if (/^(month|bulan)/.test(w)) return 'month';
  }
  if (/^(hour|jam)/.test(w)) return 'hour';
  if (/^(day|hari)/.test(w)) return 'day';
  if (/^(week|minggu)/.test(w)) return 'week';
  if (/^(quarter|kuartal)/.test(w)) return 'quarter';
  if (/^(year|tahun)/.test(w)) return 'year';
  return 'day';
}
