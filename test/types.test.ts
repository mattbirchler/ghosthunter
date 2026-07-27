import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkFor } from '../src/types.ts';
import type { GhostDoc } from '../src/types.ts';

const base: GhostDoc = {
  id: '1',
  type: 'post',
  status: 'published',
  title: 'T',
  slug: 't',
  url: 'https://x.com/t/',
  editorUrl: 'https://x.com/ghost/#/editor/post/1',
  plaintext: '',
  tags: [],
  publishedAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

test('published docs link to the public URL', () => {
  assert.equal(linkFor(base), 'https://x.com/t/');
});

test('drafts link to the editor', () => {
  assert.equal(
    linkFor({ ...base, status: 'draft', url: null }),
    'https://x.com/ghost/#/editor/post/1',
  );
});

test('scheduled docs link to the editor even when a URL exists', () => {
  assert.equal(
    linkFor({ ...base, status: 'scheduled' }),
    'https://x.com/ghost/#/editor/post/1',
  );
});

test('sent newsletters link to the public URL', () => {
  assert.equal(linkFor({ ...base, status: 'sent' }), 'https://x.com/t/');
});

test('a published doc with a missing URL falls back to the editor', () => {
  assert.equal(
    linkFor({ ...base, url: null }),
    'https://x.com/ghost/#/editor/post/1',
  );
});
