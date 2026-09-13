/**
 * Intent Engine — extensible universal intent taxonomy.
 *
 * Intents are classified deterministically from keyword patterns (English,
 * with Indonesian aliases so bilingual queries keep working). Plugins can
 * register additional intents or extra keywords for existing intents. The
 * classifier returns a ranked list; the top intent wins and its analysis
 * types seed the planner.
 */
import type { IntentCategory } from './types.js';

export interface IntentDefinition {
  id: string;
  category: IntentCategory;
  /** Keyword/phrase patterns matched case-insensitively against the query. */
  keywords: string[];
  /** Analysis type tags this intent implies. */
  analysisTypes: string[];
  /** Optional priority boost when several intents match equally. */
  priority?: number;
}

const BUILTIN_INTENTS: IntentDefinition[] = [
  // UNDERSTAND
  { id: 'explain', category: 'understand', keywords: ['explain', 'jelaskan', 'what is', 'apa itu', 'describe', 'deskripsikan'], analysisTypes: ['descriptive'] },
  { id: 'summarize', category: 'understand', keywords: ['summarize', 'summary', 'ringkas', 'rangkum', 'overview'], analysisTypes: ['descriptive', 'statistical'] },

  // COMPARE
  { id: 'compare', category: 'compare', keywords: ['compare', 'bandingkan', 'vs', 'versus', 'dibanding', 'perbandingan'], analysisTypes: ['comparison'], priority: 2 },
  { id: 'rank', category: 'compare', keywords: ['rank', 'ranking', 'peringkat', 'urutkan', 'terbaik', 'worst', 'terburuk', 'top '], analysisTypes: ['comparison', 'ranking'] },
  { id: 'benchmark', category: 'compare', keywords: ['benchmark', 'tolok ukur'], analysisTypes: ['comparison', 'performance'] },

  // DIAGNOSE
  { id: 'diagnose', category: 'diagnose', keywords: ['why', 'kenapa', 'mengapa', 'root cause', 'akar masalah', 'penyebab', 'turun?', 'naik?'], analysisTypes: ['trend', 'anomaly', 'causal', 'comparison'], priority: 2 },
  { id: 'troubleshoot', category: 'diagnose', keywords: ['troubleshoot', 'debug', 'error', 'gagal', 'failed', 'broken', 'rusak', 'drop', 'jatuh', 'fell', 'fell?', 'crash'], analysisTypes: ['anomaly', 'trend', 'causal'] },

  // DISCOVER
  { id: 'discover', category: 'discover', keywords: ['find', 'cari', 'discover', 'temukan', 'detect', 'deteksi', 'scan', 'breakout'], analysisTypes: ['anomaly', 'statistical', 'pattern'] },
  { id: 'pattern', category: 'discover', keywords: ['pattern', 'pola', 'structure', 'struktur'], analysisTypes: ['pattern', 'trend'] },
  { id: 'trend', category: 'discover', keywords: ['trend', 'tren', 'arah'], analysisTypes: ['trend'] },
  { id: 'anomaly', category: 'discover', keywords: ['anomaly', 'anomali', 'outlier', 'abnormal', 'janggal', 'unusual'], analysisTypes: ['anomaly', 'statistical'] },
  { id: 'clustering', category: 'discover', keywords: ['cluster', 'clustering', 'kelompok', 'segment'], analysisTypes: ['clustering', 'statistical'] },

  // PREDICT
  { id: 'forecast', category: 'predict', keywords: ['predict', 'prediction', 'forecast', 'prediksi', 'ramalan', 'proyeksi', 'projection', 'next month', 'bulan depan', 'besok'], analysisTypes: ['forecast', 'trend', 'seasonality'], priority: 2 },
  { id: 'probability', category: 'predict', keywords: ['probability', 'probabilitas', 'kemungkinan', 'chance', 'odds', 'peluang'], analysisTypes: ['forecast', 'scenario'] },

  // EVALUATE
  { id: 'evaluate', category: 'evaluate', keywords: ['evaluate', 'evaluasi', 'assess', 'nilai', 'quality', 'kualitas', 'sehat', 'health'], analysisTypes: ['statistical', 'trend'] },
  { id: 'risk', category: 'evaluate', keywords: ['risk', 'risiko', 'bahaya', 'volatility', 'volatilitas', 'drawdown'], analysisTypes: ['risk', 'statistical'] },
  { id: 'performance', category: 'evaluate', keywords: ['performance', 'performa', 'kinerja', 'fps', 'latency', 'latensi', 'throughput'], analysisTypes: ['performance', 'trend', 'statistical'] },
  { id: 'opportunity', category: 'evaluate', keywords: ['opportunity', 'peluang', 'potensi', 'potential'], analysisTypes: ['opportunity', 'comparison'] },

  // DECIDE
  { id: 'recommend', category: 'decide', keywords: ['recommend', 'rekomendasi', 'should i', 'haruskah', 'saran', 'advice', 'buy', 'sell', 'beli', 'jual'], analysisTypes: ['recommendation', 'risk', 'trend'] },
  { id: 'optimize', category: 'decide', keywords: ['optimize', 'optimasi', 'optimalkan', 'improve', 'tingkatkan', 'percepat'], analysisTypes: ['optimization', 'statistical'] },
  { id: 'prioritize', category: 'decide', keywords: ['prioritize', 'prioritas', 'dahulukan'], analysisTypes: ['ranking', 'comparison'] },

  // RELATIONSHIP
  { id: 'relationship', category: 'relationship', keywords: ['relationship', 'hubungan', 'relation', 'kaitan', 'related', 'relate'], analysisTypes: ['correlation', 'regression'], priority: 2 },
  { id: 'correlation', category: 'relationship', keywords: ['correlation', 'korelasi', 'correlated'], analysisTypes: ['correlation', 'regression'] },
  { id: 'dependency', category: 'relationship', keywords: ['dependency', 'dependencies', 'dependensi', 'ketergantungan', 'depends'], analysisTypes: ['dependency', 'network'] },
  { id: 'influence', category: 'relationship', keywords: ['influence', 'pengaruh', 'affect', 'mempengaruhi', 'impact of'], analysisTypes: ['influence', 'regression'] },

  // SIMULATE
  { id: 'what-if', category: 'simulate', keywords: ['what if', 'bagaimana jika', 'jika ', 'if ', 'what happens if', 'gimana kalau'], analysisTypes: ['scenario', 'sensitivity'], priority: 2 },
  { id: 'scenario', category: 'simulate', keywords: ['scenario', 'skenario', 'scenarios'], analysisTypes: ['scenario'] },
  { id: 'sensitivity', category: 'simulate', keywords: ['sensitivity', 'sensitivitas'], analysisTypes: ['sensitivity'] },

  // Generic analysis fallback
  { id: 'analyze', category: 'discover', keywords: ['analyze', 'analisis', 'analysis', 'analyse', 'telusuri', 'look at', 'cek', 'check'], analysisTypes: ['trend', 'statistical'], priority: -1 },
];

export interface IntentMatch {
  id: string;
  category: IntentCategory;
  score: number;
  analysisTypes: string[];
}

export class IntentEngine {
  private intents = new Map<string, IntentDefinition>();

  constructor() {
    for (const def of BUILTIN_INTENTS) this.register(def);
  }

  /** Register or extend an intent. Plugins use this to extend the taxonomy. */
  register(def: IntentDefinition): void {
    const existing = this.intents.get(def.id);
    if (existing) {
      existing.keywords = [...new Set([...existing.keywords, ...def.keywords])];
      existing.analysisTypes = [...new Set([...existing.analysisTypes, ...def.analysisTypes])];
      if (def.priority !== undefined) existing.priority = def.priority;
      return;
    }
    this.intents.set(def.id, { ...def, keywords: [...def.keywords], analysisTypes: [...def.analysisTypes] });
  }

  list(): IntentDefinition[] {
    return [...this.intents.values()];
  }

  get(id: string): IntentDefinition | undefined {
    return this.intents.get(id);
  }

  /** Rank intents for a piece of text. Highest score first. */
  classify(text: string): IntentMatch[] {
    const q = ` ${text.toLowerCase()} `;
    const matches: IntentMatch[] = [];
    for (const def of this.intents.values()) {
      let score = 0;
      for (const kw of def.keywords) {
        const needle = kw.toLowerCase();
        // Multi-word keywords match as substrings; single words need word-ish boundaries.
        const hit = needle.includes(' ')
          ? q.includes(needle)
          : new RegExp(`(^|[^a-z])${escapeRe(needle.trim())}([^a-z]|$)`, 'i').test(q);
        if (hit) score += needle.includes(' ') ? 2 : 1;
      }
      if (score > 0) {
        matches.push({
          id: def.id,
          category: def.category,
          score: score * 10 + (def.priority ?? 0),
          analysisTypes: def.analysisTypes,
        });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    return matches;
  }

  /** Top intent, defaulting to a generic analyze intent. */
  top(text: string): IntentMatch {
    return this.classify(text)[0] ?? {
      id: 'analyze',
      category: 'discover',
      score: 0,
      analysisTypes: this.intents.get('analyze')?.analysisTypes ?? ['trend'],
    };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
