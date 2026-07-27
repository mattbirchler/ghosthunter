import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GhostClient, signJwt, mapDoc } from '../src/ghost-client.ts';

const KEY = '6413ab12ef34:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b';
const SITE = 'https://birchtree.me';

function fixture(): Promise<string> {
  return readFile(new URL('./fixtures/posts-page-1.json', import.meta.url), 'utf8');
}

test('signJwt produces a three part token with kid, aud and expiry', async () => {
  const parts = (await signJwt(KEY)).split('.');
  assert.equal(parts.length, 3);
  const h = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
  const p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
  assert.equal(h.kid, '6413ab12ef34');
  assert.equal(h.alg, 'HS256');
  assert.equal(h.typ, 'JWT');
  assert.equal(p.aud, '/admin/');
  assert.equal(p.exp - p.iat, 300);
});

test('signJwt rejects a malformed key', async () => {
  await assert.rejects(() => signJwt('nocolon'), /admin api key/i);
  await assert.rejects(() => signJwt(''), /admin api key/i);
  await assert.rejects(() => signJwt('id:'), /admin api key/i);
  await assert.rejects(() => signJwt(':secret'), /admin api key/i);
});

test('signJwt rejects a non-hex secret', async () => {
  await assert.rejects(() => signJwt('abc:nothexatall'), /admin api key/i);
});

test('mapDoc maps a published post', () => {
  const raw = {
    id: 'p1', title: 'T', slug: 's', status: 'published',
    url: 'https://x.com/s/', plaintext: 'body', published_at: '2025-01-01',
    updated_at: '2025-01-02', tags: [{ slug: 'apple' }],
  };
  const d = mapDoc(raw, 'post', SITE);
  assert.equal(d.url, 'https://x.com/s/');
  assert.deepEqual(d.tags, ['apple']);
  assert.equal(d.editorUrl, 'https://birchtree.me/ghost/#/editor/post/p1');
  assert.equal(d.type, 'post');
});

test('mapDoc gives drafts a null url but a valid editor url', () => {
  const d = mapDoc(
    { id: 'p2', title: 'D', slug: 'd', status: 'draft', url: null,
      plaintext: '', published_at: null, updated_at: '2026-01-01', tags: [] },
    'post', SITE,
  );
  assert.equal(d.url, null);
  assert.equal(d.editorUrl, 'https://birchtree.me/ghost/#/editor/post/p2');
});

test('mapDoc builds a page editor url for pages', () => {
  const d = mapDoc(
    { id: 'x', title: 'About', slug: 'about', status: 'published', url: 'u',
      published_at: null, updated_at: '2026-01-01' },
    'page', SITE,
  );
  assert.equal(d.editorUrl, 'https://birchtree.me/ghost/#/editor/page/x');
});

test('mapDoc tolerates missing plaintext and tags', () => {
  const d = mapDoc(
    { id: 'x', title: 'X', slug: 'x', status: 'published', url: 'u',
      published_at: null, updated_at: '2026-01-01' },
    'post', SITE,
  );
  assert.equal(d.plaintext, '');
  assert.deepEqual(d.tags, []);
});

test('mapDoc falls back to a safe status and title', () => {
  const d = mapDoc(
    { id: 'x', slug: 'x', status: 'weird-new-status', url: null,
      published_at: null, updated_at: '2026-01-01' },
    'post', SITE,
  );
  assert.equal(d.status, 'draft');
  assert.equal(d.title, '(untitled)');
});

test('mapDoc rejects an object with no id', () => {
  assert.throws(() => mapDoc({ title: 'x' }, 'post', SITE), /missing an id/i);
  assert.throws(() => mapDoc(null, 'post', SITE), /missing an id/i);
});

test('fetchPage requests the right URL and parses pagination', async () => {
  const body = await fixture();
  let seen = '';
  let headers: Record<string, string> = {};
  const fake: typeof fetch = async (url, init) => {
    seen = String(url);
    headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(body, { status: 200 });
  };
  const c = new GhostClient(SITE, KEY, fake);
  const r = await c.fetchPage({ type: 'post', page: 1 });

  assert.match(seen, /\/ghost\/api\/admin\/posts\//);
  assert.match(seen, /formats=plaintext/);
  assert.match(seen, /include=tags/);
  assert.match(seen, /limit=100/);
  assert.match(seen, /page=1/);
  assert.match(headers['Authorization'] ?? '', /^Ghost ey/);
  assert.equal(headers['Accept-Version'], 'v5.0');

  assert.equal(r.pages, 3);
  assert.equal(r.total, 250);
  assert.equal(r.docs.length, 2);
  assert.equal(r.docs[0]!.title, 'Vision Pro, one year later');
  assert.deepEqual(r.docs[0]!.tags, ['apple', 'vr']);
  assert.equal(r.docs[1]!.status, 'draft');
  assert.equal(r.docs[1]!.url, null);
});

test('fetchPage requests the pages endpoint for type page', async () => {
  let seen = '';
  const fake: typeof fetch = async (url) => {
    seen = String(url);
    return new Response('{"pages":[],"meta":{"pagination":{"pages":1,"total":0}}}', { status: 200 });
  };
  const c = new GhostClient(SITE, KEY, fake);
  const r = await c.fetchPage({ type: 'page', page: 1 });
  assert.match(seen, /\/ghost\/api\/admin\/pages\//);
  assert.equal(r.docs.length, 0);
});

test('fetchPage passes a filter through', async () => {
  let seen = '';
  const fake: typeof fetch = async (url) => {
    seen = String(url);
    return new Response('{"posts":[],"meta":{"pagination":{"pages":1,"total":0}}}', { status: 200 });
  };
  const c = new GhostClient(SITE, KEY, fake);
  await c.fetchPage({ type: 'post', page: 1, filter: "updated_at:>'2024-01-01'" });
  assert.match(decodeURIComponent(seen), /filter=updated_at:>'2024-01-01'/);
});

test('fieldsOnly makes a cheap id-only request', async () => {
  let seen = '';
  const fake: typeof fetch = async (url) => {
    seen = String(url);
    return new Response(
      '{"posts":[{"id":"a","updated_at":"2024-01-01"}],"meta":{"pagination":{"pages":1,"total":1}}}',
      { status: 200 },
    );
  };
  const c = new GhostClient(SITE, KEY, fake);
  const r = await c.fetchPage({ type: 'post', page: 1, fieldsOnly: true });
  assert.match(decodeURIComponent(seen), /fields=id,updated_at/);
  assert.ok(!seen.includes('formats='));
  assert.ok(!seen.includes('include='));
  assert.equal(r.docs.length, 1);
  assert.equal(r.docs[0]!.id, 'a');
});

test('fetchPage surfaces a friendly error for a bad key', async () => {
  const fake: typeof fetch = async () =>
    new Response('{"errors":[{"message":"Unknown Admin API Key"}]}', { status: 401 });
  const c = new GhostClient(SITE, KEY, fake);
  await assert.rejects(() => c.fetchPage({ type: 'post', page: 1 }), /API key was rejected/i);
});

test('a 401 is not retried', async () => {
  let calls = 0;
  const fake: typeof fetch = async () => {
    calls++;
    return new Response('{}', { status: 401 });
  };
  const c = new GhostClient(SITE, KEY, fake);
  await assert.rejects(() => c.fetchPage({ type: 'post', page: 1 }));
  assert.equal(calls, 1);
});

test('a 404 reports the site URL as the likely problem', async () => {
  const fake: typeof fetch = async () => new Response('not found', { status: 404 });
  const c = new GhostClient(SITE, KEY, fake);
  await assert.rejects(() => c.fetchPage({ type: 'post', page: 1 }), /could not be found/i);
});

test('fetchPage retries on 5xx then succeeds', async () => {
  const body = await fixture();
  let calls = 0;
  const fake: typeof fetch = async () => {
    calls++;
    return calls < 3 ? new Response('nope', { status: 503 }) : new Response(body, { status: 200 });
  };
  const c = new GhostClient(SITE, KEY, fake, [0, 0]);
  const r = await c.fetchPage({ type: 'post', page: 1 });
  assert.equal(calls, 3);
  assert.equal(r.docs.length, 2);
});

test('fetchPage retries a network throw', async () => {
  const body = await fixture();
  let calls = 0;
  const fake: typeof fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response(body, { status: 200 });
  };
  const c = new GhostClient(SITE, KEY, fake, [0, 0]);
  const r = await c.fetchPage({ type: 'post', page: 1 });
  assert.equal(calls, 2);
  assert.equal(r.docs.length, 2);
});

test('fetchPage gives up after three attempts', async () => {
  let calls = 0;
  const fake: typeof fetch = async () => {
    calls++;
    return new Response('nope', { status: 500 });
  };
  const c = new GhostClient(SITE, KEY, fake, [0, 0]);
  await assert.rejects(() => c.fetchPage({ type: 'post', page: 1 }), /after 3 attempts/i);
  assert.equal(calls, 3);
});

test('malformed JSON produces a clear error', async () => {
  const fake: typeof fetch = async () => new Response('<html>nope</html>', { status: 200 });
  const c = new GhostClient(SITE, KEY, fake, [0, 0]);
  await assert.rejects(() => c.fetchPage({ type: 'post', page: 1 }), /unreadable response/i);
});

// Testing layer 3 from the spec: opt-in, hits the real site, normally skipped.
test('live smoke test', { skip: !process.env.GHOSTHUNTER_LIVE_TEST }, async () => {
  const key = process.env.GHOSTHUNTER_ADMIN_KEY;
  const site = process.env.GHOSTHUNTER_SITE_URL;
  assert.ok(key, 'set GHOSTHUNTER_ADMIN_KEY to run the live test');
  assert.ok(site, 'set GHOSTHUNTER_SITE_URL to run the live test');
  const c = new GhostClient(site, key);
  const r = await c.fetchPage({ type: 'post', page: 1, limit: 1 });
  assert.ok(r.total > 0);
  assert.equal(r.docs.length, 1);
  assert.ok(r.docs[0]!.title.length > 0);
});
