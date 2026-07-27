import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layout,
  windowFor,
  truncate,
  wrap,
  visibleWidth,
  pad,
} from '../src/layout.ts';
import type { LayoutState } from '../src/layout.ts';
import type { GhostDoc, SearchHit } from '../src/types.ts';

function doc(over: Partial<GhostDoc> = {}): GhostDoc {
  return {
    id: 'a',
    type: 'post',
    status: 'published',
    title: 'Vision Pro, one year later',
    slug: 'v',
    url: 'https://birchtree.me/blog/v/',
    editorUrl: 'https://birchtree.ghost.io/ghost/#/editor/post/a',
    plaintext: '',
    tags: ['apple'],
    publishedAt: '2025-02-11T00:00:00.000Z',
    updatedAt: '2025-02-11T00:00:00.000Z',
    ...over,
  };
}

const hit = (d: GhostDoc, snippet = 'a matching passage'): SearchHit => ({
  doc: d,
  snippet,
  score: -1,
});

function state(n: number, selected = 0): LayoutState {
  return {
    query: 'vision',
    hits: Array.from({ length: n }, (_, i) => hit(doc({ id: `d${i}`, title: `Post ${i}` }))),
    selected,
  };
}

const ctx = { site: 'birchtree.ghost.io' };
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

test('visibleWidth ignores colour escapes', () => {
  assert.equal(visibleWidth('\x1b[1mabc\x1b[0m'), 3);
});

test('truncate respects visible width and adds an ellipsis', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdef', 1), '…');
  assert.equal(truncate('abcdef', 0), '');
});

test('pad fills to the requested width', () => {
  assert.equal(pad('ab', 5), 'ab   ');
  assert.equal(pad('\x1b[1mab\x1b[0m', 5).replace(/\x1b\[[0-9;]*m/g, ''), 'ab   ');
});

test('wrap breaks on word boundaries and honours the line cap', () => {
  assert.deepEqual(wrap('one two three four', 9, 5), ['one two', 'three', 'four']);
  assert.equal(wrap('one two three four', 9, 1).length, 1);
});

test('wrap splits a word longer than the width', () => {
  assert.deepEqual(wrap('abcdefghij', 4, 5), ['abcd', 'efgh', 'ij']);
});

test('wrap on empty input returns nothing', () => {
  assert.deepEqual(wrap('', 10, 3), []);
});

test('windowFor keeps everything visible when it fits', () => {
  assert.deepEqual(windowFor(0, 5, 10), { start: 0, end: 5 });
});

test('windowFor scrolls to keep the selection on screen', () => {
  assert.deepEqual(windowFor(0, 100, 10), { start: 0, end: 10 });
  assert.deepEqual(windowFor(50, 100, 10), { start: 45, end: 55 });
  // Never scrolls past the end.
  assert.deepEqual(windowFor(99, 100, 10), { start: 90, end: 100 });
});

test('windowFor handles an empty list', () => {
  assert.deepEqual(windowFor(0, 0, 10), { start: 0, end: 0 });
});

test('layout fills exactly the requested height', () => {
  for (const h of [8, 12, 24, 40, 60]) {
    assert.equal(layout(state(30), { width: 80, height: h }, ctx).length, h);
  }
});

test('no layout line exceeds the terminal width', () => {
  for (const w of [20, 40, 80, 200]) {
    for (const line of layout(state(30), { width: w, height: 24 }, ctx)) {
      assert.ok(
        visibleWidth(line) <= w,
        `line of ${visibleWidth(line)} exceeds width ${w}: ${JSON.stringify(strip(line))}`,
      );
    }
  }
});

test('a very long title is truncated rather than wrapping the row', () => {
  const s: LayoutState = {
    query: 'x',
    hits: [hit(doc({ title: 'A'.repeat(500) }))],
    selected: 0,
  };
  for (const line of layout(s, { width: 60, height: 24 }, ctx)) {
    assert.ok(visibleWidth(line) <= 60);
  }
});

test('the header shows the site', () => {
  const out = layout(state(3), { width: 80, height: 24 }, ctx).map(strip);
  assert.match(out[0]!, /GhostHunter/);
  assert.match(out[0]!, /birchtree\.ghost\.io/);
});

test('the query line shows the query and hit count', () => {
  const out = layout(state(14), { width: 80, height: 24 }, ctx).map(strip);
  assert.match(out[1]!, /vision/);
  assert.match(out[1]!, /14 hits/);
});

test('a single result is described in the singular', () => {
  const out = layout(state(1), { width: 80, height: 24 }, ctx).map(strip);
  assert.match(out[1]!, /1 hit\b/);
});

test('an empty result set says so', () => {
  const out = layout(state(0), { width: 80, height: 24 }, ctx).map(strip).join('\n');
  assert.match(out, /No matches/);
});

test('the detail pane describes the selected result', () => {
  const s: LayoutState = {
    query: 'vision',
    hits: [hit(doc({ title: 'First' })), hit(doc({ id: 'b', title: 'Second' }))],
    selected: 1,
  };
  const out = layout(s, { width: 80, height: 24 }, ctx).map(strip).join('\n');
  assert.match(out, /Second/);
  assert.match(out, /https:\/\/birchtree\.me\/blog\/v\//);
  assert.match(out, /a matching passage/);
});

test('the detail pane links a draft to the editor', () => {
  const s: LayoutState = {
    query: 'x',
    hits: [hit(doc({ status: 'draft', url: null }))],
    selected: 0,
  };
  const out = layout(s, { width: 80, height: 24 }, ctx).map(strip).join('\n');
  assert.match(out, /ghost\.io\/ghost\/#\/editor\/post\/a/);
  assert.match(out, /\[draft\]/);
});

test('the footer shows the key hints by default', () => {
  const out = layout(state(3), { width: 100, height: 24 }, ctx).map(strip);
  assert.match(out[out.length - 1]!, /copy/);
});

test('a flash message replaces the key hints', () => {
  const out = layout(state(3), { width: 100, height: 24 }, {
    ...ctx,
    flash: 'Copied the URL',
  }).map(strip);
  assert.match(out[out.length - 1]!, /Copied the URL/);
});

test('an offline notice is surfaced in the footer', () => {
  const out = layout(state(3), { width: 100, height: 24 }, {
    ...ctx,
    notice: 'Offline. Index last updated 2 days ago.',
  }).map(strip);
  assert.match(out[out.length - 1]!, /Offline/);
});

test('a tiny terminal still produces a valid frame', () => {
  const out = layout(state(30), { width: 20, height: 8 }, ctx);
  assert.equal(out.length, 8);
  for (const line of out) assert.ok(visibleWidth(line) <= 20);
});

test('layout never throws on extreme sizes', () => {
  for (const size of [
    { width: 1, height: 1 },
    { width: 0, height: 0 },
    { width: 500, height: 200 },
  ]) {
    assert.doesNotThrow(() => layout(state(30), size, ctx));
  }
});

test('the selected row is highlighted', () => {
  const withSel = layout(state(5, 2), { width: 80, height: 24 }, ctx);
  const inverted = withSel.filter((l) => l.includes('\x1b[7m'));
  assert.equal(inverted.length, 1);
  assert.match(strip(inverted[0]!), /Post 2/);
});
