# GhostHunter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI that syncs a Ghost site's archive into a local SQLite FTS5 index and lets the owner search it and copy a link to any post in under a second.

**Architecture:** Seven modules with hard seams. `ghost-client` does HTTP and knows nothing about SQLite. `store` does SQLite and knows nothing about HTTP. `picker` does terminal UI and knows nothing about Ghost. `sync` orchestrates client into store, `search` turns a query string into ranked hits, `cli` wires it together. This lets ranking be tested against a fixture database with no network.

**Tech Stack:** Node 26 and TypeScript, run directly via native type stripping (no build step). `node:sqlite` for FTS5, `node:test` for tests, Web Crypto for Admin API JWT, `pbcopy` and the macOS `security` command via `child_process`.

## Global Constraints

- **Zero runtime dependencies.** No entry in `dependencies` in `package.json`, ever. Dev dependencies are also unnecessary; TypeScript is only needed for editor tooling and is optional.
- **Node 26+ required.** Relies on stable `node:sqlite` and native TypeScript type stripping. Declare `"engines": { "node": ">=26" }`.
- **Source files are `.ts` and run directly.** No `tsc` build, no `dist/`. The bin entrypoint uses `#!/usr/bin/env node`.
- **Type-stripping syntax only.** Native stripping does not support `enum`, `namespace`, parameter properties (`constructor(private x: T)`), or legacy decorators. Use `type`/`interface`/`as`/annotations only. Use `const` objects with union types instead of `enum`.
- **The Admin API key is read-only in practice.** No module may issue a POST, PUT, or DELETE to Ghost.
- **No em dashes in any user-facing string.** This covers all CLI output, help text, error messages, and README copy. Use a colon, parentheses, a comma, or two sentences.
- **Binary names:** `ghosthunter` and the short alias `ght`.
- **npm package name:** `@mattbirchler/ghosthunter` (the unscoped name is squatted).
- **`bm25()` returns negative scores.** More negative means a better match. Always `ORDER BY score ASC`.
- **`node:sqlite` returns null-prototype row objects.** Spreading works; `instanceof Object` and `hasOwnProperty` do not. Cast through the row type.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | Shared types. No logic, no imports. |
| `src/store.ts` | SQLite schema, upserts, FTS queries, sync metadata. |
| `src/query.ts` | Parse a raw query string into filters plus a safe FTS5 expression. |
| `src/search.ts` | Combine `query` and `store` into ranked hits. |
| `src/ghost-client.ts` | JWT signing, paginated Admin API fetches, response mapping. |
| `src/config.ts` | Config file plus Keychain credential storage, path resolution. |
| `src/sync.ts` | Full sync, incremental sync, prune. |
| `src/picker.ts` | Raw-mode TUI list with live re-query. Returns an action. |
| `src/clipboard.ts` | `pbcopy` and `open` shell-outs. Tiny, isolated for testability. |
| `src/cli.ts` | Arg parsing, command dispatch, output formatting. |
| `bin/ghosthunter.ts` | Shebang entrypoint, calls `cli.ts`. |
| `test/*.test.ts` | One test file per module. |
| `test/fixtures/` | Recorded Admin API JSON pages, synthetic document generator. |

---

### Task 1: Project scaffolding and shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/types.ts`, `test/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DocType`, `DocStatus`, `GhostDoc`, `ParsedQuery`, `SearchHit`, `SyncResult`, `PickerAction`. Every later task imports from here.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@mattbirchler/ghosthunter",
  "version": "0.1.0",
  "description": "Search your own Ghost blog from the terminal and get the link",
  "type": "module",
  "engines": { "node": ">=26" },
  "bin": {
    "ghosthunter": "bin/ghosthunter.ts",
    "ght": "bin/ghosthunter.ts"
  },
  "scripts": {
    "test": "node --test test/*.test.ts"
  },
  "files": ["bin", "src", "README.md", "LICENSE"],
  "license": "MIT"
}
```

- [ ] **Step 2: Create `tsconfig.json`** (editor tooling only, never invoked)

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "strict": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "bin"]
}
```

`erasableSyntaxOnly` makes the editor reject syntax that native type stripping cannot handle, which prevents a whole class of runtime failures.

- [ ] **Step 3: Write `src/types.ts`**

```ts
export type DocType = 'post' | 'page';
export type DocStatus = 'published' | 'draft' | 'scheduled' | 'sent';

export interface GhostDoc {
  id: string;
  type: DocType;
  status: DocStatus;
  title: string;
  slug: string;
  url: string | null;
  editorUrl: string;
  plaintext: string;
  tags: string[];
  publishedAt: string | null;
  updatedAt: string;
}

export interface ParsedQuery {
  fts: string;
  tag?: string;
  before?: string;
  after?: string;
  status?: DocStatus;
  type?: DocType;
}

export interface SearchHit {
  doc: GhostDoc;
  snippet: string;
  score: number;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
}

export type PickerAction =
  | { kind: 'copy-url'; doc: GhostDoc }
  | { kind: 'copy-markdown'; doc: GhostDoc }
  | { kind: 'open'; doc: GhostDoc }
  | { kind: 'edit'; doc: GhostDoc }
  | { kind: 'cancel' };

export function linkFor(doc: GhostDoc): string {
  return doc.status === 'published' || doc.status === 'sent'
    ? (doc.url ?? doc.editorUrl)
    : doc.editorUrl;
}
```

- [ ] **Step 4: Write `test/types.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkFor } from '../src/types.ts';
import type { GhostDoc } from '../src/types.ts';

const base: GhostDoc = {
  id: '1', type: 'post', status: 'published', title: 'T', slug: 't',
  url: 'https://x.com/t/', editorUrl: 'https://x.com/ghost/#/editor/post/1',
  plaintext: '', tags: [], publishedAt: '2024-01-01', updatedAt: '2024-01-01',
};

test('published docs link to the public URL', () => {
  assert.equal(linkFor(base), 'https://x.com/t/');
});

test('drafts link to the editor', () => {
  assert.equal(linkFor({ ...base, status: 'draft', url: null }),
    'https://x.com/ghost/#/editor/post/1');
});

test('scheduled docs link to the editor even when a URL exists', () => {
  assert.equal(linkFor({ ...base, status: 'scheduled' }),
    'https://x.com/ghost/#/editor/post/1');
});
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Add project scaffolding and shared types"
```

---

### Task 2: Store

**Files:**
- Create: `src/store.ts`, `test/store.test.ts`

**Interfaces:**
- Consumes: `GhostDoc`, `ParsedQuery`, `SearchHit` from `src/types.ts`.
- Produces:
  - `new Store(dbPath: string)` where `':memory:'` is valid
  - `store.upsert(docs: GhostDoc[]): { added: number; updated: number }`
  - `store.search(q: ParsedQuery, limit: number): SearchHit[]`
  - `store.count(): number`
  - `store.allIds(): Set<string>`
  - `store.deleteMissing(keep: Set<string>): number`
  - `store.getMeta(k: string): string | null` / `store.setMeta(k: string, v: string): void`
  - `store.close(): void`

- [ ] **Step 1: Write the failing test `test/store.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import type { GhostDoc } from '../src/types.ts';

function doc(over: Partial<GhostDoc> = {}): GhostDoc {
  return {
    id: 'a', type: 'post', status: 'published', title: 'Hello world', slug: 'hello',
    url: 'https://x.com/hello/', editorUrl: 'https://x.com/ghost/#/editor/post/a',
    plaintext: 'the body text', tags: [], publishedAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z', ...over,
  };
}

test('upsert inserts then updates without duplicating', () => {
  const s = new Store(':memory:');
  assert.deepEqual(s.upsert([doc()]), { added: 1, updated: 0 });
  assert.deepEqual(s.upsert([doc({ title: 'Changed' })]), { added: 0, updated: 1 });
  assert.equal(s.count(), 1);
  assert.equal(s.search({ fts: '"Changed"' }, 10)[0].doc.title, 'Changed');
  s.close();
});

test('title matches outrank body matches', () => {
  const s = new Store(':memory:');
  s.upsert([
    doc({ id: 'body', title: 'Unrelated', plaintext: 'a passing mention of nonogram here' }),
    doc({ id: 'title', title: 'Nonogram app', plaintext: 'nothing relevant' }),
  ]);
  const hits = s.search({ fts: '"nonogram"' }, 10);
  assert.equal(hits[0].doc.id, 'title');
  s.close();
});

test('snippet marks the matched term', () => {
  const s = new Store(':memory:');
  s.upsert([doc({ plaintext: 'I still think the Vision Pro is interesting hardware' })]);
  const hits = s.search({ fts: '"vision"' }, 10);
  assert.match(hits[0].snippet, /\[Vision\]/);
  s.close();
});

test('porter stemming matches word variants', () => {
  const s = new Store(':memory:');
  s.upsert([doc({ plaintext: 'I enjoy reading books' })]);
  assert.equal(s.search({ fts: '"read"' }, 10).length, 1);
  s.close();
});

test('filters narrow results', () => {
  const s = new Store(':memory:');
  s.upsert([
    doc({ id: '1', tags: ['apple'], status: 'published', publishedAt: '2024-06-01T00:00:00.000Z' }),
    doc({ id: '2', tags: ['android'], status: 'draft', publishedAt: null }),
    doc({ id: '3', tags: ['apple'], status: 'published', publishedAt: '2022-01-01T00:00:00.000Z' }),
  ]);
  assert.equal(s.search({ fts: '"body"', tag: 'apple' }, 10).length, 2);
  assert.equal(s.search({ fts: '"body"', status: 'draft' }, 10).length, 1);
  assert.equal(s.search({ fts: '"body"', after: '2023-01-01' }, 10).length, 1);
  assert.equal(s.search({ fts: '"body"', before: '2023-01-01' }, 10).length, 1);
  s.close();
});

test('an empty fts expression returns recent docs instead of erroring', () => {
  const s = new Store(':memory:');
  s.upsert([doc({ id: '1', publishedAt: '2024-01-01T00:00:00.000Z' }),
            doc({ id: '2', publishedAt: '2025-01-01T00:00:00.000Z' })]);
  const hits = s.search({ fts: '' }, 10);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].doc.id, '2');
  s.close();
});

test('deleteMissing prunes rows Ghost no longer returns', () => {
  const s = new Store(':memory:');
  s.upsert([doc({ id: '1' }), doc({ id: '2' })]);
  assert.equal(s.deleteMissing(new Set(['1'])), 1);
  assert.equal(s.count(), 1);
  assert.deepEqual([...s.allIds()], ['1']);
  s.close();
});

test('meta round-trips', () => {
  const s = new Store(':memory:');
  assert.equal(s.getMeta('last_sync_at'), null);
  s.setMeta('last_sync_at', '2026-01-01T00:00:00.000Z');
  assert.equal(s.getMeta('last_sync_at'), '2026-01-01T00:00:00.000Z');
  s.close();
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npm test`. Expected: cannot find module `../src/store.ts`.

- [ ] **Step 3: Implement `src/store.ts`**

Schema, created in the constructor with `CREATE TABLE IF NOT EXISTS`:

```sql
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
  title TEXT NOT NULL, slug TEXT NOT NULL, url TEXT, editor_url TEXT NOT NULL,
  plaintext TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
  published_at TEXT, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, plaintext, tags, content='documents', content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Plus the three external-content sync triggers (`AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE`) that write to `documents_fts`. The delete and update triggers must use the `'delete'` command form:

```sql
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, plaintext, tags)
  VALUES ('delete', old.rowid, old.title, old.plaintext, old.tags);
END;
```

Set `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = NORMAL` for sync throughput.

`upsert` runs inside a transaction, uses `INSERT ... ON CONFLICT(id) DO UPDATE SET ...`, and counts added versus updated by checking `SELECT 1 FROM documents WHERE id = ?` before each write. Tags are stored as a comma-joined string and split back on read.

`search` builds SQL in two shapes. When `q.fts` is non-empty:

```sql
SELECT d.*, snippet(documents_fts, 1, '[', ']', '…', 12) AS snip,
       bm25(documents_fts, 10.0, 1.0, 3.0) AS score
FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
WHERE documents_fts MATCH ? <extra filters>
ORDER BY score ASC LIMIT ?
```

When `q.fts` is empty, skip the FTS join entirely and select from `documents` ordered by `published_at DESC`, with `snip` as the first 160 characters of plaintext and `score` as 0. This is what makes an empty query useful rather than an error.

Filter clauses appended as parameterized `AND` fragments: `tag` uses `(',' || d.tags || ',') LIKE '%,' || ? || ',%'`, `status` and `type` use equality, `before`/`after` compare `d.published_at`.

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add SQLite FTS5 store with ranked search and pruning"
```

---

### Task 3: Query parser

**Files:**
- Create: `src/query.ts`, `test/query.test.ts`

**Interfaces:**
- Consumes: `ParsedQuery`, `DocStatus`, `DocType`.
- Produces: `parseQuery(input: string, opts?: { prefixLastTerm?: boolean }): ParsedQuery`

This is the module most likely to make the tool feel broken, because raw input reaching `MATCH` throws a syntax error. Every term is wrapped in double quotes with internal quotes doubled, which makes any input safe by construction.

- [ ] **Step 1: Write the failing test `test/query.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../src/query.ts';

test('bare words become AND-joined quoted terms', () => {
  assert.equal(parseQuery('vision pro').fts, '"vision" AND "pro"');
});

test('quoted phrases stay together', () => {
  assert.equal(parseQuery('"one year later"').fts, '"one year later"');
});

test('filters are extracted and removed from the fts expression', () => {
  const q = parseQuery('keyboard tag:apple after:2024 status:draft type:page');
  assert.equal(q.fts, '"keyboard"');
  assert.equal(q.tag, 'apple');
  assert.equal(q.after, '2024-01-01');
  assert.equal(q.status, 'draft');
  assert.equal(q.type, 'page');
});

test('before and after normalize partial dates', () => {
  assert.equal(parseQuery('x before:2023-06').before, '2023-06-01');
  assert.equal(parseQuery('x after:2023').after, '2023-01-01');
  assert.equal(parseQuery('x after:2023-06-15').after, '2023-06-15');
});

test('leading dash negates a term', () => {
  assert.equal(parseQuery('ipad -mini').fts, '"ipad" NOT "mini"');
});

test('a negation with no positive term is dropped', () => {
  assert.equal(parseQuery('-mini').fts, '');
});

test('title: restricts to the title column', () => {
  assert.equal(parseQuery('title:nonogram').fts, 'title:"nonogram"');
});

test('unbalanced quotes cannot produce a syntax error', () => {
  assert.equal(parseQuery('say "hello').fts, '"say" AND "hello"');
});

test('fts operators in user input are neutralized', () => {
  assert.equal(parseQuery('a* OR b NEAR c').fts,
    '"a*" AND "OR" AND "b" AND "NEAR" AND "c"');
});

test('embedded double quotes are escaped by doubling', () => {
  assert.equal(parseQuery('the ""scare"" quotes').fts.includes('""""'), false);
  assert.doesNotThrow(() => parseQuery('""""""'));
});

test('empty and whitespace input yield an empty expression', () => {
  assert.equal(parseQuery('').fts, '');
  assert.equal(parseQuery('   ').fts, '');
  assert.equal(parseQuery('tag:apple').fts, '');
});

test('prefixLastTerm appends a prefix operator for live typing', () => {
  assert.equal(parseQuery('nonog', { prefixLastTerm: true }).fts, '"nonog"*');
  assert.equal(parseQuery('vision pr', { prefixLastTerm: true }).fts,
    '"vision" AND "pr"*');
});

test('prefixLastTerm does not apply to a closed phrase', () => {
  assert.equal(parseQuery('"exact phrase"', { prefixLastTerm: true }).fts,
    '"exact phrase"');
});

test('unknown filter prefixes are treated as search terms', () => {
  assert.equal(parseQuery('author:matt').fts, '"author:matt"');
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `node --test test/query.test.ts`. Expected: cannot find module.

- [ ] **Step 3: Implement `src/query.ts`**

Tokenize character by character, respecting double quotes so `"one year later"` is a single token and an unterminated quote simply runs to end of input. For each token:

1. If it matches `^(tag|before|after|status|type):(.+)$`, assign the filter and drop it from the term list. Validate `status` against the four known values and `type` against `post`/`page`; an invalid value falls through to being a search term.
2. If it matches `^title:(.+)$`, emit `title:"<escaped>"`.
3. If it starts with `-` and has more characters, mark it negated.
4. Otherwise it is a positive term.

Escape with `term.replaceAll('"', '""')`, then wrap in `"`. Join positives with ` AND `, then append ` NOT "x"` for each negation only if at least one positive term exists. Apply `*` after the closing quote of the last positive term when `prefixLastTerm` is set and that token was not a quoted phrase.

Date normalization: `2023` becomes `2023-01-01`, `2023-06` becomes `2023-06-01`, a full date passes through. Anything else is ignored and the token is treated as a search term.

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add query parser with injection-safe FTS5 expression building"
```

---

### Task 4: Search

**Files:**
- Create: `src/search.ts`, `test/search.test.ts`

**Interfaces:**
- Consumes: `Store` from Task 2, `parseQuery` from Task 3.
- Produces: `search(store: Store, input: string, opts?: { limit?: number; prefixLastTerm?: boolean }): SearchHit[]`

- [ ] **Step 1: Write the failing test `test/search.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { search } from '../src/search.ts';
import type { GhostDoc } from '../src/types.ts';

function seed(): Store {
  const s = new Store(':memory:');
  const mk = (id: string, title: string, body: string, tags: string[], pub: string): GhostDoc => ({
    id, type: 'post', status: 'published', title, slug: id,
    url: `https://x.com/${id}/`, editorUrl: `https://x.com/ghost/#/editor/post/${id}`,
    plaintext: body, tags, publishedAt: pub, updatedAt: pub,
  });
  s.upsert([
    mk('a', 'Vision Pro, one year later', 'still the most interesting hardware', ['apple'], '2025-02-11T00:00:00.000Z'),
    mk('b', 'The Vision Pro is not a failure', 'calling it a flop misreads Apple', ['apple'], '2024-06-03T00:00:00.000Z'),
    mk('c', 'Android thoughts', 'nothing about headsets', ['android'], '2023-01-05T00:00:00.000Z'),
  ]);
  return s;
}

test('ranks title matches first', () => {
  const s = seed();
  assert.equal(search(s, 'vision pro')[0].doc.id, 'a');
  s.close();
});

test('respects filters combined with terms', () => {
  const s = seed();
  assert.equal(search(s, 'vision tag:apple after:2025').length, 1);
  s.close();
});

test('never throws on hostile input', () => {
  const s = seed();
  for (const bad of ['"', '((', '*', 'a NEAR/', 'OR', '""""', '- ', 'tag:']) {
    assert.doesNotThrow(() => search(s, bad), `threw on ${JSON.stringify(bad)}`);
  }
  s.close();
});

test('a filter-only query returns matching docs newest first', () => {
  const s = seed();
  const hits = search(s, 'tag:apple');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].doc.id, 'a');
  s.close();
});

test('prefix mode finds partial words while typing', () => {
  const s = seed();
  assert.ok(search(s, 'visio', { prefixLastTerm: true }).length > 0);
  assert.equal(search(s, 'visio').length, 0);
  s.close();
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `node --test test/search.test.ts`

- [ ] **Step 3: Implement `src/search.ts`**

Thin by design: call `parseQuery`, hand the result to `store.search`, default `limit` to 50. The one piece of real logic is a `try/catch` around `store.search` that falls back to a filters-only query if FTS still somehow throws, so a search can never crash the picker mid-keystroke.

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add search layer combining query parsing and the store"
```

---

### Task 5: Ghost client

**Files:**
- Create: `src/ghost-client.ts`, `test/ghost-client.test.ts`, `test/fixtures/posts-page-1.json`

**Interfaces:**
- Consumes: `GhostDoc`, `DocType`.
- Produces:
  - `signJwt(adminKey: string): Promise<string>`
  - `mapDoc(raw: unknown, type: DocType, siteUrl: string): GhostDoc`
  - `new GhostClient(siteUrl: string, adminKey: string, fetchImpl?: typeof fetch)`
  - `client.fetchPage(o: { type: DocType; page: number; limit?: number; filter?: string; fieldsOnly?: boolean }): Promise<{ docs: GhostDoc[]; pages: number; total: number }>`

The `fetchImpl` parameter is what makes this testable without a network.

- [ ] **Step 1: Create `test/fixtures/posts-page-1.json`**

A two-post Admin API response covering one published post with tags and one draft with a null URL:

```json
{
  "posts": [
    { "id": "p1", "title": "Vision Pro, one year later", "slug": "vision-pro-one-year",
      "status": "published", "url": "https://birchtree.me/blog/vision-pro-one-year/",
      "plaintext": "still the most interesting hardware Apple ships",
      "published_at": "2025-02-11T12:00:00.000Z", "updated_at": "2025-02-11T12:00:00.000Z",
      "tags": [{ "name": "Apple", "slug": "apple" }, { "name": "VR", "slug": "vr" }] },
    { "id": "p2", "title": "Untitled draft", "slug": "untitled-draft",
      "status": "draft", "url": null, "plaintext": "half a thought",
      "published_at": null, "updated_at": "2026-07-01T09:00:00.000Z", "tags": [] }
  ],
  "meta": { "pagination": { "page": 1, "limit": 100, "pages": 3, "total": 250 } }
}
```

- [ ] **Step 2: Write the failing test `test/ghost-client.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GhostClient, signJwt, mapDoc } from '../src/ghost-client.ts';

const KEY = '6413ab12ef34:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b';
const SITE = 'https://birchtree.me';

test('signJwt produces a three part token with kid, aud and expiry', async () => {
  const parts = (await signJwt(KEY)).split('.');
  assert.equal(parts.length, 3);
  const h = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.equal(h.kid, '6413ab12ef34');
  assert.equal(h.alg, 'HS256');
  assert.equal(p.aud, '/admin/');
  assert.ok(p.exp - p.iat === 300);
});

test('signJwt rejects a malformed key', async () => {
  await assert.rejects(() => signJwt('nocolon'), /admin api key/i);
});

test('mapDoc maps a published post', () => {
  const raw = { id: 'p1', title: 'T', slug: 's', status: 'published',
    url: 'https://x.com/s/', plaintext: 'body', published_at: '2025-01-01',
    updated_at: '2025-01-02', tags: [{ slug: 'apple' }] };
  const d = mapDoc(raw, 'post', SITE);
  assert.equal(d.url, 'https://x.com/s/');
  assert.deepEqual(d.tags, ['apple']);
  assert.equal(d.editorUrl, 'https://birchtree.me/ghost/#/editor/post/p1');
});

test('mapDoc gives drafts a null url but a valid editor url', () => {
  const d = mapDoc({ id: 'p2', title: 'D', slug: 'd', status: 'draft', url: null,
    plaintext: '', published_at: null, updated_at: '2026-01-01', tags: [] }, 'post', SITE);
  assert.equal(d.url, null);
  assert.equal(d.editorUrl, 'https://birchtree.me/ghost/#/editor/post/p2');
});

test('mapDoc tolerates missing plaintext and tags', () => {
  const d = mapDoc({ id: 'x', title: 'X', slug: 'x', status: 'published',
    url: 'u', published_at: null, updated_at: '2026-01-01' }, 'post', SITE);
  assert.equal(d.plaintext, '');
  assert.deepEqual(d.tags, []);
});

test('fetchPage requests the right URL and parses pagination', async () => {
  const body = await readFile(new URL('./fixtures/posts-page-1.json', import.meta.url), 'utf8');
  let seen = '';
  const fake: typeof fetch = async (url) => {
    seen = String(url);
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const c = new GhostClient(SITE, KEY, fake);
  const r = await c.fetchPage({ type: 'post', page: 1 });
  assert.match(seen, /\/ghost\/api\/admin\/posts\//);
  assert.match(seen, /formats=plaintext/);
  assert.match(seen, /include=tags/);
  assert.match(seen, /limit=100/);
  assert.equal(r.pages, 3);
  assert.equal(r.total, 250);
  assert.equal(r.docs.length, 2);
  assert.equal(r.docs[1].status, 'draft');
});

test('fetchPage surfaces a friendly error for a bad key', async () => {
  const fake: typeof fetch = async () =>
    new Response('{"errors":[{"message":"Unknown Admin API Key"}]}', { status: 401 });
  const c = new GhostClient(SITE, KEY, fake);
  await assert.rejects(() => c.fetchPage({ type: 'post', page: 1 }),
    /API key was rejected/i);
});

test('fetchPage retries on 5xx then succeeds', async () => {
  const body = await readFile(new URL('./fixtures/posts-page-1.json', import.meta.url), 'utf8');
  let calls = 0;
  const fake: typeof fetch = async () => {
    calls++;
    return calls < 3 ? new Response('nope', { status: 503 })
                     : new Response(body, { status: 200 });
  };
  const c = new GhostClient(SITE, KEY, fake);
  const r = await c.fetchPage({ type: 'post', page: 1 });
  assert.equal(calls, 3);
  assert.equal(r.docs.length, 2);
});

test('fetchPage gives up after three attempts', async () => {
  const fake: typeof fetch = async () => new Response('nope', { status: 500 });
  const c = new GhostClient(SITE, KEY, fake);
  await assert.rejects(() => c.fetchPage({ type: 'post', page: 1 }), /after 3 attempts/i);
});
```

- [ ] **Step 3: Run and verify it fails**

Run: `node --test test/ghost-client.test.ts`

- [ ] **Step 4: Implement `src/ghost-client.ts`**

`signJwt` splits the key on `:`, throws `new Error('Invalid Admin API key: expected the id:secret form')` if it does not yield exactly two non-empty parts, decodes the secret with `Buffer.from(secret, 'hex')`, and signs `{alg:'HS256',typ:'JWT',kid:id}` over `{iat, exp: iat+300, aud:'/admin/'}` using `crypto.subtle`. Base64url encoding uses `Buffer.from(x).toString('base64url')`.

`fetchPage` builds `${siteUrl}/ghost/api/admin/${type}s/` with `formats=plaintext`, `include=tags`, `limit` (default 100), `page`, and optional `filter` and `order`. When `fieldsOnly` is set, it instead sends `fields=id,updated_at` and omits `formats` and `include`, which is what makes prune cheap. Header is `Authorization: Ghost <jwt>` plus `Accept-Version: v5.0`.

Retry loop: up to 3 attempts on a 5xx or a network throw, with backoff of 500ms then 1500ms. A 401 or 403 throws immediately with `Your Ghost API key was rejected. Check the integration in Ghost admin under Settings, Integrations.` Other 4xx throw with the message from Ghost's error body when present. Exhausting retries throws `Ghost did not respond after 3 attempts.`

Note for the implementer: retry backoff uses real timers. Keep the delays as a module-level `const RETRY_DELAYS = [500, 1500]` so tests stay fast if they ever need to override it. The tests above pass because the fake fetch resolves immediately and only two delays elapse.

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Add Ghost Admin API client with JWT auth and retries"
```

---

### Task 6: Config and credentials

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `configDir(): string`, `configPath(): string`, `dbPath(): string`
  - `loadConfig(): { siteUrl: string } | null`
  - `saveConfig(c: { siteUrl: string }): void`
  - `normalizeSiteUrl(input: string): string`
  - `getAdminKey(): string | null`, `setAdminKey(key: string): void`

Paths honour `GHOSTHUNTER_HOME` so tests never touch the real config.

- [ ] **Step 1: Write the failing test `test/config.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSiteUrl, saveConfig, loadConfig, configDir } from '../src/config.ts';

test('normalizeSiteUrl adds https and strips trailing slashes and admin paths', () => {
  assert.equal(normalizeSiteUrl('birchtree.me'), 'https://birchtree.me');
  assert.equal(normalizeSiteUrl('https://birchtree.me/'), 'https://birchtree.me');
  assert.equal(normalizeSiteUrl('https://birchtree.me/ghost/'), 'https://birchtree.me');
  assert.equal(normalizeSiteUrl('https://birchtree.me/ghost/#/dashboard'), 'https://birchtree.me');
  assert.equal(normalizeSiteUrl('  http://localhost:2368  '), 'http://localhost:2368');
});

test('normalizeSiteUrl rejects nonsense', () => {
  assert.throws(() => normalizeSiteUrl(''), /site URL/i);
  assert.throws(() => normalizeSiteUrl('not a url'), /site URL/i);
});

test('config round-trips through disk', () => {
  const home = mkdtempSync(join(tmpdir(), 'gh-'));
  process.env.GHOSTHUNTER_HOME = home;
  try {
    assert.equal(loadConfig(), null);
    saveConfig({ siteUrl: 'https://birchtree.me' });
    assert.deepEqual(loadConfig(), { siteUrl: 'https://birchtree.me' });
    assert.ok(configDir().startsWith(home));
  } finally {
    delete process.env.GHOSTHUNTER_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a corrupt config file reads as null rather than throwing', () => {
  const home = mkdtempSync(join(tmpdir(), 'gh-'));
  process.env.GHOSTHUNTER_HOME = home;
  try {
    const { writeFileSync, mkdirSync } = require('node:fs');
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), 'config.json'), '{ broken');
    assert.equal(loadConfig(), null);
  } finally {
    delete process.env.GHOSTHUNTER_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `node --test test/config.test.ts`

- [ ] **Step 3: Implement `src/config.ts`**

`configDir()` returns `process.env.GHOSTHUNTER_HOME ?? join(homedir(), '.config', 'ghosthunter')`. `dbPath()` returns `join(configDir(), 'index.db')`, overridable with `GHOSTHUNTER_DB`.

`normalizeSiteUrl` trims, prepends `https://` when there is no scheme, parses with `new URL`, throws `new Error('That does not look like a valid site URL.')` on failure, then returns `origin` only, which discards `/ghost/`, hashes, and trailing slashes in one move.

`saveConfig` creates the directory with `{ recursive: true }` and writes JSON with mode `0o600`. `loadConfig` returns `null` on a missing file and on a `JSON.parse` failure, so a corrupt file is recoverable by running `init` again rather than being a hard failure.

Keychain access shells out with `execFileSync`, which avoids the shell entirely so the key is never exposed in a command line that another process could read via `ps`:

- `setAdminKey`: `security add-generic-password -a ghosthunter -s ghosthunter-admin-key -w <key> -U`
- `getAdminKey`: `security find-generic-password -a ghosthunter -s ghosthunter-admin-key -w`, returning `null` when the exit status is non-zero (meaning not found).

Both are wrapped so a non-macOS platform falls back to the `GHOSTHUNTER_ADMIN_KEY` environment variable, and `getAdminKey` checks that variable first regardless of platform. Keychain calls are not unit tested, since testing them would mean writing to the real Keychain; the env var path is what tests and CI use.

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add config file and Keychain credential storage"
```

---

### Task 7: Sync

**Files:**
- Create: `src/sync.ts`, `test/sync.test.ts`

**Interfaces:**
- Consumes: `GhostClient` (Task 5), `Store` (Task 2).
- Produces: `sync(client: GhostClient, store: Store, opts?: { full?: boolean; prune?: boolean; onProgress?: (msg: string) => void }): Promise<SyncResult>`

- [ ] **Step 1: Write the failing test `test/sync.test.ts`**

Uses a hand-rolled fake client rather than a mocking library, so the test documents the exact contract `sync` depends on.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { sync } from '../src/sync.ts';
import type { GhostDoc, DocType } from '../src/types.ts';

function mk(id: string, updated: string): GhostDoc {
  return { id, type: 'post', status: 'published', title: `Post ${id}`, slug: id,
    url: `https://x.com/${id}/`, editorUrl: `https://x.com/ghost/#/editor/post/${id}`,
    plaintext: `body of ${id}`, tags: [], publishedAt: updated, updatedAt: updated };
}

class FakeClient {
  calls: Array<{ type: DocType; page: number; filter?: string; fieldsOnly?: boolean }> = [];
  constructor(private pages: Record<string, GhostDoc[][]>) {}
  async fetchPage(o: { type: DocType; page: number; filter?: string; fieldsOnly?: boolean }) {
    this.calls.push(o);
    const set = this.pages[o.type] ?? [[]];
    const docs = set[o.page - 1] ?? [];
    return { docs, pages: set.length, total: set.flat().length };
  }
}

test('a full sync walks every page of posts and pages', async () => {
  const s = new Store(':memory:');
  const c = new FakeClient({
    post: [[mk('a', '2024-01-01T00:00:00.000Z')], [mk('b', '2024-01-02T00:00:00.000Z')]],
    page: [[mk('c', '2024-01-03T00:00:00.000Z')]],
  });
  const r = await sync(c as never, s, { full: true });
  assert.equal(r.added, 3);
  assert.equal(s.count(), 3);
  assert.equal(c.calls.filter(x => x.type === 'post').length, 2);
  assert.ok(s.getMeta('last_sync_at'));
  s.close();
});

test('an incremental sync filters on updated_at and keeps existing rows', async () => {
  const s = new Store(':memory:');
  s.upsert([mk('a', '2024-01-01T00:00:00.000Z')]);
  s.setMeta('last_sync_at', '2024-06-01T00:00:00.000Z');
  const c = new FakeClient({ post: [[mk('b', '2024-07-01T00:00:00.000Z')]], page: [[]] });
  const r = await sync(c as never, s);
  assert.equal(r.added, 1);
  assert.equal(s.count(), 2);
  const f = c.calls.find(x => x.type === 'post')?.filter ?? '';
  assert.match(f, /updated_at:>'2024-06-01T00:00:00\.000Z'/);
  s.close();
});

test('the first sync is full even without the full flag', async () => {
  const s = new Store(':memory:');
  const c = new FakeClient({ post: [[mk('a', '2024-01-01T00:00:00.000Z')]], page: [[]] });
  await sync(c as never, s);
  assert.equal(c.calls[0].filter, undefined);
  s.close();
});

test('prune removes local docs the server no longer returns', async () => {
  const s = new Store(':memory:');
  s.upsert([mk('a', '2024-01-01T00:00:00.000Z'), mk('gone', '2024-01-01T00:00:00.000Z')]);
  s.setMeta('last_sync_at', '2024-06-01T00:00:00.000Z');
  const c = new FakeClient({ post: [[mk('a', '2024-01-01T00:00:00.000Z')]], page: [[]] });
  const r = await sync(c as never, s, { prune: true });
  assert.equal(r.removed, 1);
  assert.ok(c.calls.some(x => x.fieldsOnly));
  assert.deepEqual([...s.allIds()], ['a']);
  s.close();
});

test('progress is reported during a full sync', async () => {
  const s = new Store(':memory:');
  const msgs: string[] = [];
  const c = new FakeClient({ post: [[mk('a', '2024-01-01T00:00:00.000Z')]], page: [[]] });
  await sync(c as never, s, { full: true, onProgress: m => msgs.push(m) });
  assert.ok(msgs.length > 0);
  assert.ok(msgs.every(m => !m.includes('—')), 'no em dashes in user-facing output');
  s.close();
});

test('last_sync_at is not advanced when a fetch fails midway', async () => {
  const s = new Store(':memory:');
  s.setMeta('last_sync_at', '2024-06-01T00:00:00.000Z');
  const c = {
    async fetchPage() { throw new Error('network down'); },
  };
  await assert.rejects(() => sync(c as never, s, { full: true }));
  assert.equal(s.getMeta('last_sync_at'), '2024-06-01T00:00:00.000Z');
  s.close();
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `node --test test/sync.test.ts`

- [ ] **Step 3: Implement `src/sync.ts`**

Capture `startedAt = new Date().toISOString()` before any fetch, so documents changed during a long sync are caught by the next run rather than skipped.

Decide the mode: full when `opts.full` is set or when `store.getMeta('last_sync_at')` is null. Incremental otherwise, passing `filter: \`updated_at:>'${lastSync}'\`` and `order: 'updated_at asc'`.

For each of `post` and `page`, loop pages from 1 until `page >= pages`, calling `store.upsert` once per page. Upserting per page rather than at the end is what makes an interrupted sync resumable: each page is its own transaction and already-committed pages survive a Ctrl-C.

When `opts.prune` is set, after the main loop fetch every page with `fieldsOnly: true` for both types, collect the ids into a `Set`, and call `store.deleteMissing(ids)`.

Only after everything succeeds, call `store.setMeta('last_sync_at', startedAt)`. Let exceptions propagate so a failed sync leaves the watermark untouched.

`onProgress` messages take the form `Syncing posts, page 3 of 49` and `Synced 4846 posts and 12 pages.` No em dashes.

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add full, incremental and prune sync"
```

---

### Task 8: Clipboard and picker

**Files:**
- Create: `src/clipboard.ts`, `src/picker.ts`, `test/picker.test.ts`

**Interfaces:**
- Consumes: `SearchHit`, `PickerAction`, `linkFor`.
- Produces:
  - `copyToClipboard(text: string): void`, `openInBrowser(url: string): void`
  - `markdownLink(doc: GhostDoc): string`
  - `handleKey(state: PickerState, key: Key): PickerResult` (pure, fully tested)
  - `runPicker(o: { initialQuery: string; run: (q: string) => SearchHit[] }): Promise<PickerAction>`

The key insight for testability: all picker logic lives in the pure function `handleKey`. `runPicker` only does terminal I/O and delegates every decision to it. The terminal parts are not unit tested; the logic is fully covered.

- [ ] **Step 1: Write the failing test `test/picker.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleKey, markdownLink } from '../src/picker.ts';
import type { PickerState } from '../src/picker.ts';
import type { GhostDoc, SearchHit } from '../src/types.ts';

function doc(over: Partial<GhostDoc> = {}): GhostDoc {
  return { id: 'a', type: 'post', status: 'published', title: 'Vision Pro, one year later',
    slug: 'v', url: 'https://x.com/v/', editorUrl: 'https://x.com/ghost/#/editor/post/a',
    plaintext: '', tags: [], publishedAt: '2025-01-01', updatedAt: '2025-01-01', ...over };
}
const hit = (d: GhostDoc): SearchHit => ({ doc: d, snippet: '', score: -1 });

function state(over: Partial<PickerState> = {}): PickerState {
  return { query: 'vision', hits: [hit(doc()), hit(doc({ id: 'b', title: 'Second' }))],
    selected: 0, ...over };
}

test('markdownLink escapes brackets in titles', () => {
  assert.equal(markdownLink(doc({ title: 'A [bracketed] title' })),
    '[A \\[bracketed\\] title](https://x.com/v/)');
});

test('markdownLink uses the editor url for drafts', () => {
  assert.equal(markdownLink(doc({ status: 'draft', url: null, title: 'D' })),
    '[D](https://x.com/ghost/#/editor/post/a)');
});

test('down and up move the selection without wrapping past the ends', () => {
  assert.equal(handleKey(state(), { name: 'down' }).state.selected, 1);
  assert.equal(handleKey(state({ selected: 1 }), { name: 'down' }).state.selected, 1);
  assert.equal(handleKey(state({ selected: 0 }), { name: 'up' }).state.selected, 0);
  assert.equal(handleKey(state({ selected: 1 }), { name: 'up' }).state.selected, 0);
});

test('ctrl-n and ctrl-p mirror the arrow keys', () => {
  assert.equal(handleKey(state(), { name: 'n', ctrl: true }).state.selected, 1);
  assert.equal(handleKey(state({ selected: 1 }), { name: 'p', ctrl: true }).state.selected, 0);
});

test('typing appends to the query and resets the selection', () => {
  const r = handleKey(state({ selected: 1 }), { name: 'x', sequence: 'x' });
  assert.equal(r.state.query, 'visionx');
  assert.equal(r.state.selected, 0);
  assert.equal(r.requery, true);
});

test('backspace removes a character and requeries', () => {
  const r = handleKey(state(), { name: 'backspace' });
  assert.equal(r.state.query, 'visio');
  assert.equal(r.requery, true);
});

test('backspace on an empty query is a no-op', () => {
  const r = handleKey(state({ query: '' }), { name: 'backspace' });
  assert.equal(r.state.query, '');
});

test('enter emits copy-url for the selected hit', () => {
  const r = handleKey(state({ selected: 1 }), { name: 'return' });
  assert.deepEqual(r.action, { kind: 'copy-url', doc: r.state.hits[1].doc });
});

test('option-enter emits copy-markdown', () => {
  const r = handleKey(state(), { name: 'return', meta: true });
  assert.equal(r.action?.kind, 'copy-markdown');
});

test('ctrl-l is the documented fallback for copy-markdown', () => {
  const r = handleKey(state(), { name: 'l', ctrl: true });
  assert.equal(r.action?.kind, 'copy-markdown');
});

test('ctrl-o opens and ctrl-e edits', () => {
  assert.equal(handleKey(state(), { name: 'o', ctrl: true }).action?.kind, 'open');
  assert.equal(handleKey(state(), { name: 'e', ctrl: true }).action?.kind, 'edit');
});

test('escape and ctrl-c cancel', () => {
  assert.deepEqual(handleKey(state(), { name: 'escape' }).action, { kind: 'cancel' });
  assert.deepEqual(handleKey(state(), { name: 'c', ctrl: true }).action, { kind: 'cancel' });
});

test('enter with no hits cancels rather than crashing', () => {
  const r = handleKey(state({ hits: [], selected: 0 }), { name: 'return' });
  assert.deepEqual(r.action, { kind: 'cancel' });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `node --test test/picker.test.ts`

- [ ] **Step 3: Implement `src/clipboard.ts`**

```ts
import { execFileSync } from 'node:child_process';

export function copyToClipboard(text: string): void {
  execFileSync('pbcopy', { input: text });
}

export function openInBrowser(url: string): void {
  execFileSync('open', [url]);
}
```

- [ ] **Step 4: Implement `src/picker.ts`**

Export the state and key types:

```ts
export interface PickerState { query: string; hits: SearchHit[]; selected: number; }
export interface Key { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string; }
export interface PickerResult { state: PickerState; action?: PickerAction; requery: boolean; }
```

`markdownLink` escapes `[` and `]` in the title with a backslash and uses `linkFor(doc)`.

`handleKey` is a pure switch returning a new state. Selection clamps at both ends rather than wrapping, which keeps arrow-key mashing predictable. Any printable key (a `sequence` of length 1 with no ctrl or meta, code point 32 or above) appends to the query, sets `selected` to 0, and sets `requery`.

`runPicker` sets `process.stdin.setRawMode(true)`, uses `readline.emitKeypressEvents`, renders to `process.stderr` so that stdout stays clean for piping, and redraws on every keystroke. Rendering shows the query line with a hit count, up to 10 rows with the selected row marked `❯`, a `[draft]` marker for unpublished docs, the snippet of the selected hit, and the key hint footer. It restores the terminal in a `finally` block so a crash never leaves the terminal in raw mode.

Re-query calls `run(state.query)` with `prefixLastTerm: true` supplied by the caller.

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Add clipboard helpers and interactive picker"
```

---

### Task 9: CLI

**Files:**
- Create: `src/cli.ts`, `bin/ghosthunter.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `parseArgs(argv: string[]): Command`, `main(argv: string[]): Promise<number>`

- [ ] **Step 1: Write the failing test `test/cli.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, formatList, formatJson } from '../src/cli.ts';
import type { GhostDoc, SearchHit } from '../src/types.ts';

const d: GhostDoc = { id: 'a', type: 'post', status: 'published',
  title: 'Vision Pro, one year later', slug: 'v', url: 'https://x.com/v/',
  editorUrl: 'https://x.com/ghost/#/editor/post/a', plaintext: 'body', tags: ['apple'],
  publishedAt: '2025-02-11T00:00:00.000Z', updatedAt: '2025-02-11T00:00:00.000Z' };
const hits: SearchHit[] = [{ doc: d, snippet: 'the [Vision] Pro', score: -1 }];

test('a bare query parses as a search', () => {
  const c = parseArgs(['vision', 'pro']);
  assert.equal(c.kind, 'search');
  assert.equal(c.kind === 'search' && c.query, 'vision pro');
});

test('subcommands are recognized', () => {
  assert.equal(parseArgs(['init']).kind, 'init');
  assert.equal(parseArgs(['status']).kind, 'status');
  assert.equal(parseArgs(['sync']).kind, 'sync');
});

test('sync flags parse', () => {
  const c = parseArgs(['sync', '--full', '--prune']);
  assert.deepEqual(c, { kind: 'sync', full: true, prune: true });
});

test('search flags parse and are stripped from the query', () => {
  const c = parseArgs(['vision', '--json', '--offline']);
  assert.equal(c.kind, 'search');
  if (c.kind === 'search') {
    assert.equal(c.query, 'vision');
    assert.equal(c.json, true);
    assert.equal(c.offline, true);
  }
});

test('no arguments shows help', () => {
  assert.equal(parseArgs([]).kind, 'help');
  assert.equal(parseArgs(['--help']).kind, 'help');
});

test('a query that looks like a subcommand still searches when it has more words', () => {
  const c = parseArgs(['status', 'of', 'the', 'union']);
  assert.equal(c.kind, 'search');
});

test('formatList output is stable and has no em dashes', () => {
  const out = formatList(hits);
  assert.match(out, /Vision Pro, one year later/);
  assert.match(out, /https:\/\/x\.com\/v\//);
  assert.match(out, /2025-02-11/);
  assert.ok(!out.includes('—'));
});

test('formatList marks drafts', () => {
  const draft = { ...d, status: 'draft' as const, url: null };
  assert.match(formatList([{ doc: draft, snippet: '', score: -1 }]), /\[draft\]/);
});

test('formatList handles zero hits with a helpful message', () => {
  const out = formatList([]);
  assert.match(out, /No matches/i);
  assert.ok(!out.includes('—'));
});

test('formatJson emits parseable records with a link field', () => {
  const parsed = JSON.parse(formatJson(hits));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].link, 'https://x.com/v/');
  assert.equal(parsed[0].title, 'Vision Pro, one year later');
  assert.equal(parsed[0].status, 'published');
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `node --test test/cli.test.ts`

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
export type Command =
  | { kind: 'search'; query: string; json: boolean; list: boolean; offline: boolean; limit: number }
  | { kind: 'sync'; full: boolean; prune: boolean }
  | { kind: 'init' } | { kind: 'status' } | { kind: 'help' } | { kind: 'version' };
```

`parseArgs` pulls out `--json`, `--list`, `--offline`, `--limit N`, `--full`, `--prune`, `--help`, `--version` first, then treats the remaining words as either a subcommand (only when it is the single remaining word and matches `init`, `sync`, or `status`) or a search query. That single-word rule is what makes `ghosthunter status of the union` search rather than print index stats.

`main` dispatches:

- **search:** load config and key, open the store, auto-sync unless `--offline` (catching and ignoring any sync error, since search must work offline), then either run the picker when `process.stdout.isTTY` and neither `--json` nor `--list` is set, or print `formatList` / `formatJson`. On a picker action, perform the copy or open and print a one-line confirmation to stderr.
- **init:** prompt for the site URL and Admin key with `node:readline/promises`, reading the key with input echo disabled, normalize and save, verify by fetching one page, then run a full sync with progress.
- **sync:** run `sync()` with progress on stderr.
- **status:** print document count, last sync time, database size on disk, and the site URL.
- **help:** usage text listing every command, flag, and query filter, plus the picker keys.

Exit codes: 0 on success, 1 on error, 2 when not configured (with a message pointing at `ghosthunter init`).

Guard rail: when config or the Admin key is missing for a search or sync, print `GhostHunter is not set up yet. Run: ghosthunter init` and return 2.

- [ ] **Step 4: Implement `bin/ghosthunter.ts`**

```ts
#!/usr/bin/env node
import { main } from '../src/cli.ts';
process.exitCode = await main(process.argv.slice(2));
```

Make it executable with `chmod +x bin/ghosthunter.ts`.

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 6: Verify the CLI runs end to end without config**

Run: `node bin/ghosthunter.ts --help` and `node bin/ghosthunter.ts vision`
Expected: help text prints; the search exits 2 with the setup message rather than a stack trace.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "Add CLI with search, sync, init and status commands"
```

---

### Task 10: Packaging and docs

**Files:**
- Create: `Formula/ghosthunter.rb` in `~/Apps/homebrew-tap` (separate repo, do not commit here)
- Modify: `README.md`

**Interfaces:**
- Consumes: the finished CLI.
- Produces: an installable tool.

- [ ] **Step 1: Verify a global link works**

Run: `npm link` then `ght --help` and `ghosthunter --help`
Expected: both binary names resolve and print help.

- [ ] **Step 2: Rewrite `README.md`**

Cover: what it does and why Ghost cannot do it natively, install (npm and brew), `ghosthunter init` walkthrough including where to get an Admin API key (Ghost admin, Settings, Integrations, Add custom integration, copy the Admin API Key), the full query syntax table, the picker key table, and a note that the index lives in `~/.config/ghosthunter/index.db` and the key lives in the macOS Keychain. No em dashes anywhere.

- [ ] **Step 3: Write the brew formula** in the tap repo

A `Formula/ghosthunter.rb` that depends on `node` and installs via `libexec` using `std_npm_args`, matching the existing pattern in `chapterize.rb`. Do not commit this to the ghosthunter repo.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add install docs and packaging"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Zero runtime dependencies | Global Constraints, Task 1 |
| Module seams (client/store/picker isolation) | Tasks 2, 5, 8 |
| Keychain credential storage | Task 6 |
| `documents` schema and FTS5 virtual table | Task 2 |
| BM25 title weighting and `snippet()` | Task 2 |
| Porter stemming | Task 2 |
| Draft URL handling | Tasks 1, 5, 8 |
| Full sync with pagination and progress | Task 7 |
| Incremental sync via `updated_at` | Task 7 |
| Prune via `fields=id,updated_at` | Tasks 5, 7 |
| Resumable interrupted sync | Task 7 (per-page commits) |
| Command surface including `--json` and `--list` | Task 9 |
| Non-TTY falls back to list output | Task 9 |
| Query syntax filters | Task 3 |
| Injection-safe FTS expressions | Tasks 3, 4 |
| Live prefix filtering in the picker | Tasks 3, 8 |
| Picker key bindings and Ctrl+L fallback | Task 8 |
| Offline behavior and error messages | Tasks 5, 9 |
| Retry with backoff | Task 5 |
| Three-layer testing strategy | Tasks 2 to 9 (layers 1 and 2); layer 3 noted below |
| Distribution via npm and brew | Task 10 |

**Gap found and closed:** the spec calls for an opt-in live smoke test as testing layer 3. It is not a separate task because it belongs with the client. Add to Task 5 as a final step: a test guarded by `process.env.GHOSTHUNTER_LIVE_TEST` that constructs a real `GhostClient` from `GHOSTHUNTER_ADMIN_KEY` and asserts one page fetch returns at least one document, skipped via `{ skip: !process.env.GHOSTHUNTER_LIVE_TEST }` otherwise.

**Placeholder scan:** no TBDs, no "add error handling" without specifics, no "similar to Task N". Every code step has real code.

**Type consistency:** `GhostDoc` field names are consistent across Tasks 1, 2, 5, 7, 8, 9. `store.search(q, limit)` matches its callers in Task 4. `fetchPage` returns `{ docs, pages, total }` in both Task 5 and the fake in Task 7. `linkFor` is defined in Task 1 and used in Tasks 8 and 9. `handleKey` returns `{ state, action?, requery }` consistently.

**Open risk carried from the spec:** `Option+Enter` may be swallowed by terminal configuration. Task 8 implements `Ctrl+L` as an always-available equivalent and both are tested, so the fallback exists regardless of which one works on the day.
