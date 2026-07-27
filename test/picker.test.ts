import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleKey, markdownLink } from '../src/picker.ts';
import type { PickerState, Key } from '../src/picker.ts';
import type { GhostDoc, SearchHit } from '../src/types.ts';

function doc(over: Partial<GhostDoc> = {}): GhostDoc {
  return {
    id: 'a',
    type: 'post',
    status: 'published',
    title: 'Vision Pro, one year later',
    slug: 'v',
    url: 'https://x.com/v/',
    editorUrl: 'https://x.com/ghost/#/editor/post/a',
    plaintext: '',
    tags: [],
    publishedAt: '2025-01-01',
    updatedAt: '2025-01-01',
    ...over,
  };
}

const hit = (d: GhostDoc): SearchHit => ({ doc: d, snippet: '', score: -1 });

function state(over: Partial<PickerState> = {}): PickerState {
  return {
    query: 'vision',
    hits: [hit(doc()), hit(doc({ id: 'b', title: 'Second' }))],
    selected: 0,
    ...over,
  };
}

const key = (k: Partial<Key>): Key => k;

test('markdownLink escapes brackets in titles', () => {
  assert.equal(
    markdownLink(doc({ title: 'A [bracketed] title' })),
    '[A \\[bracketed\\] title](https://x.com/v/)',
  );
});

test('markdownLink uses the editor url for drafts', () => {
  assert.equal(
    markdownLink(doc({ status: 'draft', url: null, title: 'D' })),
    '[D](https://x.com/ghost/#/editor/post/a)',
  );
});

test('down and up move the selection without wrapping past the ends', () => {
  assert.equal(handleKey(state(), key({ name: 'down' })).state.selected, 1);
  assert.equal(handleKey(state({ selected: 1 }), key({ name: 'down' })).state.selected, 1);
  assert.equal(handleKey(state({ selected: 0 }), key({ name: 'up' })).state.selected, 0);
  assert.equal(handleKey(state({ selected: 1 }), key({ name: 'up' })).state.selected, 0);
});

test('ctrl-n and ctrl-p mirror the arrow keys', () => {
  assert.equal(handleKey(state(), key({ name: 'n', ctrl: true })).state.selected, 1);
  assert.equal(
    handleKey(state({ selected: 1 }), key({ name: 'p', ctrl: true })).state.selected,
    0,
  );
});

test('moving the selection does not trigger a requery', () => {
  assert.equal(handleKey(state(), key({ name: 'down' })).requery, false);
});

test('typing appends to the query and resets the selection', () => {
  const r = handleKey(state({ selected: 1 }), key({ name: 'x', sequence: 'x' }));
  assert.equal(r.state.query, 'visionx');
  assert.equal(r.state.selected, 0);
  assert.equal(r.requery, true);
});

test('typing a space is treated as input, not a command', () => {
  const r = handleKey(state(), key({ name: 'space', sequence: ' ' }));
  assert.equal(r.state.query, 'vision ');
  assert.equal(r.requery, true);
});

test('control characters are not appended to the query', () => {
  const r = handleKey(state(), key({ name: 'a', ctrl: true, sequence: '' }));
  assert.equal(r.state.query, 'vision');
  assert.equal(r.requery, false);
});

test('backspace removes a character and requeries', () => {
  const r = handleKey(state(), key({ name: 'backspace' }));
  assert.equal(r.state.query, 'visio');
  assert.equal(r.requery, true);
});

test('backspace on an empty query is a no-op', () => {
  const r = handleKey(state({ query: '' }), key({ name: 'backspace' }));
  assert.equal(r.state.query, '');
  assert.equal(r.action, undefined);
});

test('ctrl-u clears the whole query', () => {
  const r = handleKey(state(), key({ name: 'u', ctrl: true }));
  assert.equal(r.state.query, '');
  assert.equal(r.requery, true);
});

test('enter emits copy-url for the selected hit', () => {
  const r = handleKey(state({ selected: 1 }), key({ name: 'return' }));
  assert.equal(r.action?.kind, 'copy-url');
  assert.equal(r.action?.kind === 'copy-url' && r.action.doc.id, 'b');
});

test('option-enter emits copy-markdown', () => {
  const r = handleKey(state(), key({ name: 'return', meta: true }));
  assert.equal(r.action?.kind, 'copy-markdown');
});

test('ctrl-l is the documented fallback for copy-markdown', () => {
  const r = handleKey(state(), key({ name: 'l', ctrl: true }));
  assert.equal(r.action?.kind, 'copy-markdown');
});

test('ctrl-o opens and ctrl-e edits', () => {
  assert.equal(handleKey(state(), key({ name: 'o', ctrl: true })).action?.kind, 'open');
  assert.equal(handleKey(state(), key({ name: 'e', ctrl: true })).action?.kind, 'edit');
});

test('escape and ctrl-c cancel', () => {
  assert.deepEqual(handleKey(state(), key({ name: 'escape' })).action, { kind: 'cancel' });
  assert.deepEqual(handleKey(state(), key({ name: 'c', ctrl: true })).action, {
    kind: 'cancel',
  });
});

test('enter with no hits cancels rather than crashing', () => {
  const r = handleKey(state({ hits: [], selected: 0 }), key({ name: 'return' }));
  assert.deepEqual(r.action, { kind: 'cancel' });
});

test('every action key is safe with no hits', () => {
  const empty = state({ hits: [], selected: 0 });
  for (const k of [
    key({ name: 'return' }),
    key({ name: 'return', meta: true }),
    key({ name: 'l', ctrl: true }),
    key({ name: 'o', ctrl: true }),
    key({ name: 'e', ctrl: true }),
    key({ name: 'down' }),
    key({ name: 'up' }),
  ]) {
    assert.doesNotThrow(() => handleKey(empty, k));
  }
});

test('the selection is clamped when the hit list shrinks', () => {
  const r = handleKey(state({ hits: [hit(doc())], selected: 5 }), key({ name: 'down' }));
  assert.equal(r.state.selected, 0);
});
