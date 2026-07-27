import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import type { GhostDoc } from '../src/types.ts';

function doc(over: Partial<GhostDoc> = {}): GhostDoc {
  return {
    id: 'a',
    type: 'post',
    status: 'published',
    title: 'Hello world',
    slug: 'hello',
    url: 'https://x.com/hello/',
    editorUrl: 'https://x.com/ghost/#/editor/post/a',
    plaintext: 'the body text',
    tags: [],
    publishedAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...over,
  };
}

test('upsert inserts then updates without duplicating', () => {
  const s = new Store(':memory:');
  assert.deepEqual(s.upsert([doc()]), { added: 1, updated: 0 });
  assert.deepEqual(s.upsert([doc({ title: 'Changed' })]), { added: 0, updated: 1 });
  assert.equal(s.count(), 1);
  assert.equal(s.search({ fts: '"Changed"' }, 10)[0]!.doc.title, 'Changed');
  s.close();
});

test('upsert round-trips every field including tags', () => {
  const s = new Store(':memory:');
  const d = doc({ tags: ['apple', 'vision-pro'], status: 'draft', url: null, publishedAt: null });
  s.upsert([d]);
  const got = s.search({ fts: '' }, 10)[0]!.doc;
  assert.deepEqual(got, d);
  s.close();
});

test('title matches outrank body matches', () => {
  const s = new Store(':memory:');
  s.upsert([
    doc({ id: 'body', title: 'Unrelated', plaintext: 'a passing mention of nonogram here' }),
    doc({ id: 'title', title: 'Nonogram app', plaintext: 'nothing relevant' }),
  ]);
  const hits = s.search({ fts: '"nonogram"' }, 10);
  assert.equal(hits[0]!.doc.id, 'title');
  s.close();
});

test('snippet marks the matched term', () => {
  const s = new Store(':memory:');
  s.upsert([doc({ plaintext: 'I still think the Vision Pro is interesting hardware' })]);
  const hits = s.search({ fts: '"vision"' }, 10);
  assert.match(hits[0]!.snippet, /\[Vision\]/);
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

test('the tag filter does not match a partial tag name', () => {
  const s = new Store(':memory:');
  s.upsert([doc({ id: '1', tags: ['apple-tv'] })]);
  assert.equal(s.search({ fts: '', tag: 'apple' }, 10).length, 0);
  assert.equal(s.search({ fts: '', tag: 'apple-tv' }, 10).length, 1);
  s.close();
});

test('the type filter separates posts from pages', () => {
  const s = new Store(':memory:');
  s.upsert([doc({ id: '1', type: 'post' }), doc({ id: '2', type: 'page' })]);
  assert.equal(s.search({ fts: '', type: 'page' }, 10).length, 1);
  assert.equal(s.search({ fts: '', type: 'page' }, 10)[0]!.doc.id, '2');
  s.close();
});

test('an empty fts expression returns recent docs instead of erroring', () => {
  const s = new Store(':memory:');
  s.upsert([
    doc({ id: '1', publishedAt: '2024-01-01T00:00:00.000Z' }),
    doc({ id: '2', publishedAt: '2025-01-01T00:00:00.000Z' }),
  ]);
  const hits = s.search({ fts: '' }, 10);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.doc.id, '2');
  s.close();
});

test('limit is respected', () => {
  const s = new Store(':memory:');
  s.upsert([doc({ id: '1' }), doc({ id: '2' }), doc({ id: '3' })]);
  assert.equal(s.search({ fts: '' }, 2).length, 2);
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

test('deleteMissing keeps the fts index consistent', () => {
  const s = new Store(':memory:');
  s.upsert([
    doc({ id: '1', plaintext: 'unique keyword alpha' }),
    doc({ id: '2', plaintext: 'unique keyword alpha' }),
  ]);
  assert.equal(s.search({ fts: '"alpha"' }, 10).length, 2);
  s.deleteMissing(new Set(['1']));
  assert.equal(s.search({ fts: '"alpha"' }, 10).length, 1);
  s.close();
});

test('updating a doc keeps the fts index consistent', () => {
  const s = new Store(':memory:');
  s.upsert([doc({ plaintext: 'original wording' })]);
  assert.equal(s.search({ fts: '"original"' }, 10).length, 1);
  s.upsert([doc({ plaintext: 'replacement wording' })]);
  assert.equal(s.search({ fts: '"original"' }, 10).length, 0);
  assert.equal(s.search({ fts: '"replacement"' }, 10).length, 1);
  s.close();
});

test('meta round-trips', () => {
  const s = new Store(':memory:');
  assert.equal(s.getMeta('last_sync_at'), null);
  s.setMeta('last_sync_at', '2026-01-01T00:00:00.000Z');
  assert.equal(s.getMeta('last_sync_at'), '2026-01-01T00:00:00.000Z');
  s.setMeta('last_sync_at', '2026-02-02T00:00:00.000Z');
  assert.equal(s.getMeta('last_sync_at'), '2026-02-02T00:00:00.000Z');
  s.close();
});
