import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { search } from '../src/search.ts';
import type { GhostDoc } from '../src/types.ts';

function seed(): Store {
  const s = new Store(':memory:');
  const mk = (
    id: string,
    title: string,
    body: string,
    tags: string[],
    pub: string,
  ): GhostDoc => ({
    id,
    type: 'post',
    status: 'published',
    title,
    slug: id,
    url: `https://x.com/${id}/`,
    editorUrl: `https://x.com/ghost/#/editor/post/${id}`,
    plaintext: body,
    tags,
    publishedAt: pub,
    updatedAt: pub,
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
  assert.equal(search(s, 'vision pro')[0]!.doc.id, 'a');
  s.close();
});

test('respects filters combined with terms', () => {
  const s = seed();
  assert.equal(search(s, 'vision tag:apple after:2025').length, 1);
  s.close();
});

test('never throws on hostile input', () => {
  const s = seed();
  const hostile = [
    '"', '((', '*', 'a NEAR/', 'OR', '""""', '- ', 'tag:', 'AND', 'NOT',
    '^', '{}', 'a:b:c', '\\', 'NEAR(a b', '"unclosed', '-', '--', '* *',
    'title:', 'status:', 'before:', 'after:99999999999',
  ];
  for (const bad of hostile) {
    assert.doesNotThrow(() => search(s, bad), `threw on ${JSON.stringify(bad)}`);
  }
  s.close();
});

test('never throws on hostile input in prefix mode either', () => {
  const s = seed();
  for (const bad of ['"', '*', '((', 'a NEAR/', '-', 'tag:']) {
    assert.doesNotThrow(
      () => search(s, bad, { prefixLastTerm: true }),
      `threw on ${JSON.stringify(bad)}`,
    );
  }
  s.close();
});

test('a filter-only query returns matching docs newest first', () => {
  const s = seed();
  const hits = search(s, 'tag:apple');
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.doc.id, 'a');
  s.close();
});

test('prefix mode finds partial words while typing', () => {
  const s = seed();
  assert.ok(search(s, 'visio', { prefixLastTerm: true }).length > 0);
  assert.equal(search(s, 'visio').length, 0);
  s.close();
});

test('an empty query returns everything newest first', () => {
  const s = seed();
  const hits = search(s, '');
  assert.equal(hits.length, 3);
  assert.equal(hits[0]!.doc.id, 'a');
  s.close();
});

test('limit is honoured', () => {
  const s = seed();
  assert.equal(search(s, '', { limit: 2 }).length, 2);
  s.close();
});

test('a query matching nothing returns an empty array', () => {
  const s = seed();
  assert.deepEqual(search(s, 'zzzzznotfound'), []);
  s.close();
});

test('negation excludes matching docs', () => {
  const s = seed();
  const all = search(s, 'vision');
  const filtered = search(s, 'vision -failure');
  assert.equal(all.length, 2);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.doc.id, 'a');
  s.close();
});
