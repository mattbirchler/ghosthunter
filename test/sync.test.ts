import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { sync } from '../src/sync.ts';
import type { GhostDoc, DocType } from '../src/types.ts';
import type { FetchPageOptions, FetchPageResult } from '../src/ghost-client.ts';

function mk(id: string, updated: string, type: DocType = 'post'): GhostDoc {
  return {
    id,
    type,
    status: 'published',
    title: `Post ${id}`,
    slug: id,
    url: `https://x.com/${id}/`,
    editorUrl: `https://x.com/ghost/#/editor/${type}/${id}`,
    plaintext: `body of ${id}`,
    tags: [],
    publishedAt: updated,
    updatedAt: updated,
  };
}

/**
 * A hand-written fake rather than a mocking library, so the test states the
 * exact contract sync depends on.
 */
class FakeClient {
  calls: FetchPageOptions[] = [];
  pages: Partial<Record<DocType, GhostDoc[][]>>;

  // Not a parameter property: native type stripping cannot erase those.
  constructor(pages: Partial<Record<DocType, GhostDoc[][]>>) {
    this.pages = pages;
  }

  async fetchPage(o: FetchPageOptions): Promise<FetchPageResult> {
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
    page: [[mk('c', '2024-01-03T00:00:00.000Z', 'page')]],
  });
  const r = await sync(c as never, s, { full: true });

  assert.equal(r.added, 3);
  assert.equal(r.updated, 0);
  assert.equal(s.count(), 3);
  assert.equal(c.calls.filter((x) => x.type === 'post').length, 2);
  assert.equal(c.calls.filter((x) => x.type === 'page').length, 1);
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
  const f = c.calls.find((x) => x.type === 'post')?.filter ?? '';
  assert.match(f, /updated_at:>'2024-06-01T00:00:00\.000Z'/);
  s.close();
});

test('an incremental sync counts updates separately from additions', async () => {
  const s = new Store(':memory:');
  s.upsert([mk('a', '2024-01-01T00:00:00.000Z')]);
  s.setMeta('last_sync_at', '2024-06-01T00:00:00.000Z');

  const c = new FakeClient({ post: [[mk('a', '2024-07-01T00:00:00.000Z')]], page: [[]] });
  const r = await sync(c as never, s);

  assert.equal(r.added, 0);
  assert.equal(r.updated, 1);
  assert.equal(s.count(), 1);
  s.close();
});

test('the first sync is full even without the full flag', async () => {
  const s = new Store(':memory:');
  const c = new FakeClient({ post: [[mk('a', '2024-01-01T00:00:00.000Z')]], page: [[]] });
  await sync(c as never, s);
  assert.equal(c.calls[0]!.filter, undefined);
  s.close();
});

test('prune removes local docs the server no longer returns', async () => {
  const s = new Store(':memory:');
  s.upsert([mk('a', '2024-01-01T00:00:00.000Z'), mk('gone', '2024-01-01T00:00:00.000Z')]);
  s.setMeta('last_sync_at', '2024-06-01T00:00:00.000Z');

  const c = new FakeClient({ post: [[mk('a', '2024-01-01T00:00:00.000Z')]], page: [[]] });
  const r = await sync(c as never, s, { prune: true });

  assert.equal(r.removed, 1);
  assert.ok(c.calls.some((x) => x.fieldsOnly));
  assert.deepEqual([...s.allIds()], ['a']);
  s.close();
});

test('prune keeps pages as well as posts', async () => {
  const s = new Store(':memory:');
  s.upsert([mk('p', '2024-01-01T00:00:00.000Z'), mk('g', '2024-01-01T00:00:00.000Z', 'page')]);
  s.setMeta('last_sync_at', '2024-06-01T00:00:00.000Z');

  const c = new FakeClient({
    post: [[mk('p', '2024-01-01T00:00:00.000Z')]],
    page: [[mk('g', '2024-01-01T00:00:00.000Z', 'page')]],
  });
  const r = await sync(c as never, s, { prune: true });

  assert.equal(r.removed, 0);
  assert.equal(s.count(), 2);
  s.close();
});

test('progress is reported during a full sync', async () => {
  const s = new Store(':memory:');
  const msgs: string[] = [];
  const c = new FakeClient({ post: [[mk('a', '2024-01-01T00:00:00.000Z')]], page: [[]] });

  await sync(c as never, s, { full: true, onProgress: (m) => msgs.push(m) });

  assert.ok(msgs.length > 0);
  assert.ok(msgs.every((m) => !m.includes('—')), 'no em dashes in user-facing output');
  s.close();
});

test('last_sync_at is not advanced when a fetch fails midway', async () => {
  const s = new Store(':memory:');
  s.setMeta('last_sync_at', '2024-06-01T00:00:00.000Z');
  const c = {
    async fetchPage(): Promise<FetchPageResult> {
      throw new Error('network down');
    },
  };
  await assert.rejects(() => sync(c as never, s, { full: true }));
  assert.equal(s.getMeta('last_sync_at'), '2024-06-01T00:00:00.000Z');
  s.close();
});

test('pages already fetched survive a failure partway through', async () => {
  const s = new Store(':memory:');
  let calls = 0;
  const c = {
    async fetchPage(o: FetchPageOptions): Promise<FetchPageResult> {
      calls++;
      if (calls === 2) throw new Error('network down');
      return { docs: [mk(`d${calls}`, '2024-01-01T00:00:00.000Z')], pages: 3, total: 3 };
    },
  };
  await assert.rejects(() => sync(c as never, s, { full: true }));
  // The first page committed before the second failed.
  assert.equal(s.count(), 1);
  s.close();
});

test('the watermark is taken before fetching, not after', async () => {
  const s = new Store(':memory:');
  const before = new Date().toISOString();
  const c = new FakeClient({ post: [[mk('a', '2024-01-01T00:00:00.000Z')]], page: [[]] });
  await sync(c as never, s, { full: true });
  const after = new Date().toISOString();

  const watermark = s.getMeta('last_sync_at')!;
  assert.ok(watermark >= before, 'watermark should not predate the sync');
  assert.ok(watermark <= after, 'watermark should not postdate the sync');
  s.close();
});
