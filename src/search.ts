import { parseQuery } from './query.ts';
import type { Store } from './store.ts';
import type { SearchHit } from './types.ts';

const DEFAULT_LIMIT = 50;

export interface SearchOptions {
  limit?: number;
  /** Treat the last term as a prefix. Used by the picker while typing. */
  prefixLastTerm?: boolean;
}

/**
 * Parse a raw query and run it against the index.
 *
 * `query.ts` already guarantees a syntactically valid FTS5 expression, so the
 * fallback here should be unreachable. It exists because a search that throws
 * mid-keystroke would take the picker down with it, and degrading to a
 * filters-only result is always better than crashing.
 */
export function search(store: Store, input: string, opts: SearchOptions = {}): SearchHit[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const parsed = parseQuery(input, { prefixLastTerm: opts.prefixLastTerm });

  try {
    return store.search(parsed, limit);
  } catch {
    return store.search({ ...parsed, fts: '' }, limit);
  }
}
