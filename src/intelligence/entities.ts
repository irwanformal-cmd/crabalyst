/**
 * Entity Resolution — generic registry.
 *
 * The core ships a conservative generic resolver (capitalized tokens, quoted
 * names, ticker-like tokens). Domain plugins register specialized resolvers
 * (crypto symbols, companies, services, game objects, datasets, …). Resolvers
 * never guess silently: they only fire on explicit mentions.
 */
import type { ResolvedEntity } from './types.js';

export interface EntityResolver {
  id: string;
  /** Optional domain this resolver implies for matched entities. */
  domain?: string;
  /** Resolve entities mentioned in the query text. */
  resolve(text: string): ResolvedEntity[];
}

export interface EntitySynonyms {
  id: string;
  label: string;
  kind: string;
  domain?: string;
  /** Aliases that map to the canonical id (matched as whole words). */
  aliases: string[];
  meta?: Record<string, unknown>;
}

/** A synonym-table resolver, the most common plugin pattern. */
export class SynonymEntityResolver implements EntityResolver {
  constructor(
    public readonly id: string,
    private entries: EntitySynonyms[],
    public readonly domain?: string,
  ) {}

  resolve(text: string): ResolvedEntity[] {
    const found: ResolvedEntity[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries) {
      for (const alias of [entry.id, entry.label, ...entry.aliases]) {
        if (!alias) continue;
        const re = new RegExp(`\\b${escapeRe(alias)}\\b`, 'i');
        const m = text.match(re);
        if (m && !seen.has(entry.id)) {
          seen.add(entry.id);
          found.push({
            id: entry.id,
            label: entry.label,
            kind: entry.kind,
            domain: entry.domain ?? this.domain,
            resolverId: this.id,
            mention: m[0],
            meta: entry.meta,
          });
          break;
        }
      }
    }
    return found;
  }
}

/** Generic fallback: ticker-like tokens ($BTC, BTC/USD), quoted names, ALL-CAPS words. */
export class GenericEntityResolver implements EntityResolver {
  readonly id = 'generic';

  resolve(text: string): ResolvedEntity[] {
    const found: ResolvedEntity[] = [];
    const seen = new Set<string>();
    const push = (id: string, mention: string, kind: string) => {
      const key = id.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ id: key, label: mention, kind, resolverId: this.id, mention });
    };

    // $TICKER style.
    for (const m of text.matchAll(/\$([A-Za-z]{2,10})\b/g)) push(m[1]!, m[0], 'generic');
    // Quoted names: "Acme Corp", 'dataset-x'.
    for (const m of text.matchAll(/["']([^"']{2,40})["']/g)) push(m[1]!, m[1]!, 'generic');
    // ALL-CAPS tokens 2..8 chars (BTC, ETH, AAPL, CPU).
    for (const m of text.matchAll(/\b([A-Z]{2,8})\b/g)) push(m[1]!, m[1]!, 'generic');
    return found;
  }
}

export class EntityResolverRegistry {
  private resolvers: EntityResolver[] = [];

  register(resolver: EntityResolver): void {
    // Replace by id so plugins can hot-reload.
    this.resolvers = this.resolvers.filter((r) => r.id !== resolver.id);
    this.resolvers.push(resolver);
  }

  unregister(id: string): void {
    this.resolvers = this.resolvers.filter((r) => r.id !== id);
  }

  list(): EntityResolver[] {
    return [...this.resolvers];
  }

  /** Run all resolvers; earlier (domain) resolvers win on id collisions. */
  resolveAll(text: string): ResolvedEntity[] {
    const out: ResolvedEntity[] = [];
    const seen = new Set<string>();
    for (const resolver of this.resolvers) {
      if (resolver.id === 'generic') continue; // generic runs last
      for (const e of resolver.resolve(text)) {
        if (seen.has(e.id.toUpperCase())) continue;
        seen.add(e.id.toUpperCase());
        out.push(e);
      }
    }
    const generic = this.resolvers.find((r) => r.id === 'generic');
    if (generic) {
      for (const e of generic.resolve(text)) {
        if (seen.has(e.id.toUpperCase())) continue;
        seen.add(e.id.toUpperCase());
        out.push(e);
      }
    }
    return out;
  }
}

export function createEntityRegistry(): EntityResolverRegistry {
  const registry = new EntityResolverRegistry();
  registry.register(new GenericEntityResolver());
  return registry;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
