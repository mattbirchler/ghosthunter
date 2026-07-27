import { DatabaseSync } from 'node:sqlite';
import type { GhostDoc, ParsedQuery, SearchHit, DocType, DocStatus } from './types.ts';

/**
 * BM25 column weights. Title is weighted far above body so that a post actually
 * titled "Vision Pro, one year later" beats one that mentions it in passing.
 * Order matches the FTS5 column order: title, plaintext, tags.
 */
const BM25_WEIGHTS = '10.0, 1.0, 3.0';

/** Characters wrapped around a match inside a snippet. */
const SNIPPET_OPEN = '[';
const SNIPPET_CLOSE = ']';
const SNIPPET_ELLIPSIS = '…';
const SNIPPET_TOKENS = 12;

/** Length of the fallback snippet used when there is no text query to match. */
const PLAIN_SNIPPET_CHARS = 160;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  url TEXT,
  editor_url TEXT NOT NULL,
  plaintext TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, plaintext, tags,
  content='documents',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, plaintext, tags)
  VALUES (new.rowid, new.title, new.plaintext, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, plaintext, tags)
  VALUES ('delete', old.rowid, old.title, old.plaintext, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, plaintext, tags)
  VALUES ('delete', old.rowid, old.title, old.plaintext, old.tags);
  INSERT INTO documents_fts(rowid, title, plaintext, tags)
  VALUES (new.rowid, new.title, new.plaintext, new.tags);
END;

CREATE INDEX IF NOT EXISTS documents_published_at ON documents(published_at DESC);
`;

/** Shape of a row as it comes back from SQLite (null-prototype object). */
interface DocRow {
  id: string;
  type: string;
  status: string;
  title: string;
  slug: string;
  url: string | null;
  editor_url: string;
  plaintext: string;
  tags: string;
  published_at: string | null;
  updated_at: string;
  snip: string;
  score: number;
}

function rowToHit(r: DocRow): SearchHit {
  const doc: GhostDoc = {
    id: r.id,
    type: r.type as DocType,
    status: r.status as DocStatus,
    title: r.title,
    slug: r.slug,
    url: r.url,
    editorUrl: r.editor_url,
    plaintext: r.plaintext,
    tags: r.tags === '' ? [] : r.tags.split(','),
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
  };
  return { doc, snippet: r.snip, score: r.score };
}

/**
 * Builds the parameterized WHERE fragments shared by both query shapes.
 * Returns SQL fragments (each prefixed with AND) and their bound values.
 */
function filterClauses(q: ParsedQuery): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];

  if (q.tag !== undefined) {
    // Wrap both sides in commas so "apple" cannot match "apple-tv".
    parts.push(`AND (',' || d.tags || ',') LIKE ('%,' || ? || ',%')`);
    params.push(q.tag);
  }
  if (q.status !== undefined) {
    parts.push('AND d.status = ?');
    params.push(q.status);
  }
  if (q.type !== undefined) {
    parts.push('AND d.type = ?');
    params.push(q.type);
  }
  if (q.after !== undefined) {
    parts.push('AND d.published_at IS NOT NULL AND d.published_at >= ?');
    params.push(q.after);
  }
  if (q.before !== undefined) {
    parts.push('AND d.published_at IS NOT NULL AND d.published_at < ?');
    params.push(q.before);
  }

  return { sql: parts.join(' '), params };
}

export class Store {
  #db: DatabaseSync;

  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA synchronous = NORMAL');
    }
    this.#db.exec(SCHEMA);
  }

  /**
   * Insert or update documents in a single transaction. Callers sync one API
   * page at a time so that an interrupted sync keeps everything already
   * committed.
   */
  upsert(docs: GhostDoc[]): { added: number; updated: number } {
    if (docs.length === 0) return { added: 0, updated: 0 };

    const exists = this.#db.prepare('SELECT 1 FROM documents WHERE id = ?');
    const write = this.#db.prepare(`
      INSERT INTO documents
        (id, type, status, title, slug, url, editor_url, plaintext, tags, published_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        status = excluded.status,
        title = excluded.title,
        slug = excluded.slug,
        url = excluded.url,
        editor_url = excluded.editor_url,
        plaintext = excluded.plaintext,
        tags = excluded.tags,
        published_at = excluded.published_at,
        updated_at = excluded.updated_at
    `);

    let added = 0;
    let updated = 0;

    this.#db.exec('BEGIN');
    try {
      for (const d of docs) {
        if (exists.get(d.id) === undefined) added++;
        else updated++;
        write.run(
          d.id,
          d.type,
          d.status,
          d.title,
          d.slug,
          d.url,
          d.editorUrl,
          d.plaintext,
          d.tags.join(','),
          d.publishedAt,
          d.updatedAt,
        );
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }

    return { added, updated };
  }

  search(q: ParsedQuery, limit: number): SearchHit[] {
    const { sql: filterSql, params: filterParams } = filterClauses(q);

    if (q.fts === '') {
      // No text query: fall back to newest first with a plain leading excerpt.
      const rows = this.#db
        .prepare(`
          SELECT d.*,
                 substr(d.plaintext, 1, ${PLAIN_SNIPPET_CHARS}) AS snip,
                 0.0 AS score
          FROM documents d
          WHERE 1 = 1 ${filterSql}
          ORDER BY d.published_at DESC, d.updated_at DESC
          LIMIT ?
        `)
        .all(...filterParams, limit) as unknown as DocRow[];
      return rows.map(rowToHit);
    }

    const rows = this.#db
      .prepare(`
        SELECT d.*,
               snippet(documents_fts, 1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '${SNIPPET_ELLIPSIS}', ${SNIPPET_TOKENS}) AS snip,
               bm25(documents_fts, ${BM25_WEIGHTS}) AS score
        FROM documents_fts
        JOIN documents d ON d.rowid = documents_fts.rowid
        WHERE documents_fts MATCH ? ${filterSql}
        ORDER BY score ASC
        LIMIT ?
      `)
      .all(q.fts, ...filterParams, limit) as unknown as DocRow[];
    return rows.map(rowToHit);
  }

  count(): number {
    const r = this.#db.prepare('SELECT COUNT(*) AS n FROM documents').get() as
      | { n: number }
      | undefined;
    return r?.n ?? 0;
  }

  allIds(): Set<string> {
    const rows = this.#db.prepare('SELECT id FROM documents').all() as unknown as {
      id: string;
    }[];
    return new Set(rows.map((r) => r.id));
  }

  /** Drop every local row whose id is not in `keep`. Returns the number removed. */
  deleteMissing(keep: Set<string>): number {
    const ids = [...this.allIds()].filter((id) => !keep.has(id));
    if (ids.length === 0) return 0;

    const del = this.#db.prepare('DELETE FROM documents WHERE id = ?');
    this.#db.exec('BEGIN');
    try {
      for (const id of ids) del.run(id);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return ids.length;
  }

  getMeta(key: string): string | null {
    const r = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  close(): void {
    this.#db.close();
  }
}
