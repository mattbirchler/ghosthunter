import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, formatList, formatJson } from '../src/cli.ts';
import type { GhostDoc, SearchHit } from '../src/types.ts';

const d: GhostDoc = {
  id: 'a',
  type: 'post',
  status: 'published',
  title: 'Vision Pro, one year later',
  slug: 'v',
  url: 'https://x.com/v/',
  editorUrl: 'https://x.com/ghost/#/editor/post/a',
  plaintext: 'body',
  tags: ['apple'],
  publishedAt: '2025-02-11T00:00:00.000Z',
  updatedAt: '2025-02-11T00:00:00.000Z',
};

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

test('--limit takes a value', () => {
  const c = parseArgs(['vision', '--limit', '5']);
  assert.equal(c.kind === 'search' && c.limit, 5);
});

test('an invalid --limit falls back to the default', () => {
  const c = parseArgs(['vision', '--limit', 'banana']);
  assert.equal(c.kind === 'search' && c.limit, 50);
});

test('no arguments shows help', () => {
  assert.equal(parseArgs([]).kind, 'help');
  assert.equal(parseArgs(['--help']).kind, 'help');
  assert.equal(parseArgs(['-h']).kind, 'help');
});

test('--version is its own command', () => {
  assert.equal(parseArgs(['--version']).kind, 'version');
});

test('a query that looks like a subcommand still searches when it has more words', () => {
  const c = parseArgs(['status', 'of', 'the', 'union']);
  assert.equal(c.kind, 'search');
  assert.equal(c.kind === 'search' && c.query, 'status of the union');
});

test('a query using a filter is not mistaken for a subcommand', () => {
  const c = parseArgs(['status:draft']);
  assert.equal(c.kind, 'search');
});

test('flags only, with no query, shows help', () => {
  assert.equal(parseArgs(['--json']).kind, 'help');
});

test('formatList output is stable and has no em dashes', () => {
  const out = formatList(hits);
  assert.match(out, /Vision Pro, one year later/);
  assert.match(out, /https:\/\/x\.com\/v\//);
  assert.match(out, /2025-02-11/);
  assert.ok(!out.includes('—'));
});

test('formatList marks drafts and links them to the editor', () => {
  const draft = { ...d, status: 'draft' as const, url: null };
  const out = formatList([{ doc: draft, snippet: '', score: -1 }]);
  assert.match(out, /\[draft\]/);
  assert.match(out, /ghost\/#\/editor\/post\/a/);
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
  assert.deepEqual(parsed[0].tags, ['apple']);
});

test('formatJson omits the full body to keep output small', () => {
  const parsed = JSON.parse(formatJson(hits));
  assert.equal(parsed[0].plaintext, undefined);
  assert.equal(parsed[0].snippet, 'the [Vision] Pro');
});

test('formatJson of no hits is an empty array', () => {
  assert.deepEqual(JSON.parse(formatJson([])), []);
});
