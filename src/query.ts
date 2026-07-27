import { DOC_STATUSES, DOC_TYPES } from './types.ts';
import type { ParsedQuery, DocStatus, DocType } from './types.ts';

/**
 * Turns a raw user query into filters plus an FTS5 MATCH expression.
 *
 * The central safety property: every term is wrapped in double quotes with any
 * internal quote doubled. Inside an FTS5 string literal nothing is an operator,
 * so no input can produce a syntax error. Without this, typing a lone `"` or a
 * stray `*` would throw and the tool would feel broken.
 */

interface Token {
  text: string;
  /** True when the user explicitly quoted this token. */
  quoted: boolean;
}

/**
 * Splits on whitespace but keeps double-quoted runs together. An unterminated
 * quote simply runs to the end of input rather than being an error.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let buf = '';
  let inQuotes = false;
  let quotedRun = false;

  const flush = (): void => {
    if (buf !== '') tokens.push({ text: buf, quoted: quotedRun });
    buf = '';
    quotedRun = false;
  };

  for (const ch of input) {
    if (ch === '"') {
      if (inQuotes) {
        // Closing quote ends the token even if it is empty.
        inQuotes = false;
        if (buf !== '') tokens.push({ text: buf, quoted: true });
        buf = '';
        quotedRun = false;
      } else {
        // An opening quote starts a fresh quoted run.
        flush();
        inQuotes = true;
        quotedRun = true;
      }
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      flush();
      continue;
    }
    buf += ch;
  }

  // Unterminated quote: treat whatever accumulated as a normal token.
  if (buf !== '') tokens.push({ text: buf, quoted: false });

  return tokens;
}

/** Escape for use inside an FTS5 double-quoted string. */
function ftsString(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/**
 * Accepts `2023`, `2023-06`, or `2023-06-15` and normalizes to a full ISO date.
 * Returns null for anything else so the token falls back to being a search term.
 */
function normalizeDate(value: string): string | null {
  let m = /^(\d{4})$/.exec(value);
  if (m) return `${m[1]}-01-01`;

  m = /^(\d{4})-(\d{2})$/.exec(value);
  if (m) return `${m[1]}-${m[2]}-01`;

  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  return null;
}

const FILTER_KEYS = ['tag', 'before', 'after', 'status', 'type'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

function isFilterKey(k: string): k is FilterKey {
  return (FILTER_KEYS as readonly string[]).includes(k);
}

export interface ParseOptions {
  /**
   * Treat the final positive term as a prefix so results narrow while typing.
   * Never applied to an explicitly quoted phrase or to a negation.
   */
  prefixLastTerm?: boolean;
}

export function parseQuery(input: string, opts: ParseOptions = {}): ParsedQuery {
  const result: ParsedQuery = { fts: '' };

  /** Positive terms, already escaped, in order. */
  const positives: { expr: string; quoted: boolean }[] = [];
  const negatives: string[] = [];

  for (const token of tokenize(input)) {
    const { text, quoted } = token;

    // A quoted token is always literal content, never a filter.
    if (!quoted) {
      const colon = text.indexOf(':');
      if (colon > 0) {
        const rawKey = text.slice(0, colon);
        const key = rawKey.toLowerCase();
        const value = text.slice(colon + 1);

        if (value !== '') {
          if (key === 'title') {
            positives.push({ expr: `title:${ftsString(value)}`, quoted: true });
            continue;
          }
          if (isFilterKey(key)) {
            const applied = applyFilter(result, key, value);
            if (applied) continue;
            // Fall through: an invalid value stays a search term.
          }
        }
      }

      if (text.startsWith('-') && text.length > 1) {
        negatives.push(ftsString(text.slice(1)));
        continue;
      }
    }

    positives.push({ expr: ftsString(text), quoted });
  }

  if (positives.length > 0 && opts.prefixLastTerm) {
    const last = positives[positives.length - 1]!;
    // A prefix operator is meaningless on a closed phrase.
    if (!last.quoted) last.expr = `${last.expr}*`;
  }

  let fts = positives.map((p) => p.expr).join(' AND ');

  // FTS5 has no standalone NOT, so negations need something to subtract from.
  if (fts !== '' && negatives.length > 0) {
    fts += negatives.map((n) => ` NOT ${n}`).join('');
  }

  result.fts = fts;
  return result;
}

/** Returns true when the value was valid and the filter was set. */
function applyFilter(target: ParsedQuery, key: FilterKey, value: string): boolean {
  if (key === 'tag') {
    target.tag = value;
    return true;
  }
  if (key === 'before' || key === 'after') {
    const d = normalizeDate(value);
    if (d === null) return false;
    target[key] = d;
    return true;
  }
  if (key === 'status') {
    const v = value.toLowerCase();
    if (!(DOC_STATUSES as readonly string[]).includes(v)) return false;
    target.status = v as DocStatus;
    return true;
  }
  // key === 'type'
  const v = value.toLowerCase();
  if (!(DOC_TYPES as readonly string[]).includes(v)) return false;
  target.type = v as DocType;
  return true;
}
