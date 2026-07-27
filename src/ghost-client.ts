import { DOC_STATUSES } from './types.ts';
import type { GhostDoc, DocType, DocStatus } from './types.ts';

/** Ghost Admin API tokens are short lived by design. */
const TOKEN_TTL_SECONDS = 300;

/** Ghost caps page size at 100 for both APIs. */
const MAX_PAGE_SIZE = 100;

const ACCEPT_VERSION = 'v5.0';

/** Backoff between retries, in milliseconds. Length also sets the retry count. */
const DEFAULT_RETRY_DELAYS = [500, 1500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Sign a Ghost Admin API JWT. The key is `id:secret` where the secret is hex.
 * Ported from the working implementation in ghosty-posty-obsidian.
 */
export async function signJwt(adminKey: string): Promise<string> {
  const parts = adminKey.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Invalid Admin API key: expected the id:secret form.');
  }
  const [id, secret] = parts as [string, string];

  if (!/^[0-9a-fA-F]+$/.test(secret) || secret.length % 2 !== 0) {
    throw new Error('Invalid Admin API key: the secret half is not hexadecimal.');
  }

  const header = b64url(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id })),
  );
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({ iat, exp: iat + TOKEN_TTL_SECONDS, aud: '/admin/' }),
    ),
  );

  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(secret, 'hex'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );

  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Map a raw Admin API object into our own shape. */
export function mapDoc(raw: unknown, type: DocType, siteUrl: string): GhostDoc {
  if (!isRecord(raw) || typeof raw['id'] !== 'string') {
    throw new Error('Ghost returned a document missing an id.');
  }
  const id = raw['id'];

  const rawStatus = str(raw['status']);
  // An unknown status is safer treated as a draft: it will link to the editor
  // rather than to a URL that might not resolve.
  const status: DocStatus = (DOC_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as DocStatus)
    : 'draft';

  const tagsRaw = raw['tags'];
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
        .map((t) => (isRecord(t) ? str(t['slug']) : ''))
        .filter((s) => s !== '')
    : [];

  const url = typeof raw['url'] === 'string' ? raw['url'] : null;
  const publishedAt = typeof raw['published_at'] === 'string' ? raw['published_at'] : null;

  return {
    id,
    type,
    status,
    title: str(raw['title']) || '(untitled)',
    slug: str(raw['slug']),
    url,
    editorUrl: `${siteUrl}/ghost/#/editor/${type}/${id}`,
    plaintext: str(raw['plaintext']),
    tags,
    publishedAt,
    updatedAt: str(raw['updated_at']),
  };
}

export interface FetchPageOptions {
  type: DocType;
  page: number;
  limit?: number;
  filter?: string;
  order?: string;
  /**
   * Request only id and updated_at. Used by prune, where fetching full
   * plaintext for every document would be wasteful.
   */
  fieldsOnly?: boolean;
}

export interface FetchPageResult {
  docs: GhostDoc[];
  pages: number;
  total: number;
}

export class GhostClient {
  #siteUrl: string;
  #adminKey: string;
  #fetch: typeof fetch;
  #retryDelays: number[];

  constructor(
    siteUrl: string,
    adminKey: string,
    fetchImpl: typeof fetch = fetch,
    retryDelays: number[] = DEFAULT_RETRY_DELAYS,
  ) {
    this.#siteUrl = siteUrl.replace(/\/+$/, '');
    this.#adminKey = adminKey;
    this.#fetch = fetchImpl;
    this.#retryDelays = retryDelays;
  }

  #buildUrl(o: FetchPageOptions): string {
    const url = new URL(`${this.#siteUrl}/ghost/api/admin/${o.type}s/`);
    const p = url.searchParams;
    p.set('limit', String(o.limit ?? MAX_PAGE_SIZE));
    p.set('page', String(o.page));

    if (o.fieldsOnly) {
      p.set('fields', 'id,updated_at');
    } else {
      p.set('formats', 'plaintext');
      p.set('include', 'tags');
    }
    if (o.filter !== undefined) p.set('filter', o.filter);
    if (o.order !== undefined) p.set('order', o.order);

    return url.toString();
  }

  async fetchPage(o: FetchPageOptions): Promise<FetchPageResult> {
    const url = this.#buildUrl(o);
    const token = await signJwt(this.#adminKey);
    const attempts = this.#retryDelays.length + 1;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(url, {
          headers: {
            Authorization: `Ghost ${token}`,
            'Accept-Version': ACCEPT_VERSION,
          },
        });
      } catch (err) {
        // Network-level failure. Worth retrying.
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = this.#retryDelays[attempt];
        if (delay !== undefined) await sleep(delay);
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error(
          'Your Ghost API key was rejected. Check the integration in Ghost admin under Settings, Integrations.',
        );
      }
      if (res.status === 404) {
        throw new Error(
          `The Ghost Admin API could not be found at ${this.#siteUrl}. Check the site URL.`,
        );
      }
      if (res.status >= 500) {
        lastError = new Error(`Ghost returned ${res.status}.`);
        const delay = this.#retryDelays[attempt];
        if (delay !== undefined) await sleep(delay);
        continue;
      }
      if (!res.ok) {
        throw new Error(await this.#describeError(res));
      }

      return this.#parse(await res.text(), o.type);
    }

    throw new Error(
      `Ghost did not respond after ${attempts} attempts. Last error: ${lastError?.message ?? 'unknown'}`,
    );
  }

  async #describeError(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as unknown;
      if (isRecord(body) && Array.isArray(body['errors'])) {
        const first = body['errors'][0];
        if (isRecord(first) && typeof first['message'] === 'string') {
          return `Ghost rejected the request: ${first['message']}`;
        }
      }
    } catch {
      // Fall through to the generic message.
    }
    return `Ghost returned an unexpected status (${res.status}).`;
  }

  #parse(text: string, type: DocType): FetchPageResult {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        'Ghost sent an unreadable response. This usually means the site URL points at something other than a Ghost site.',
      );
    }

    if (!isRecord(body)) {
      throw new Error('Ghost sent an unreadable response.');
    }

    const collection = body[`${type}s`];
    const rawDocs = Array.isArray(collection) ? collection : [];
    const docs = rawDocs.map((d) => mapDoc(d, type, this.#siteUrl));

    const meta = isRecord(body['meta']) ? body['meta'] : {};
    const pagination = isRecord(meta['pagination']) ? meta['pagination'] : {};
    const pages = typeof pagination['pages'] === 'number' ? pagination['pages'] : 1;
    const total = typeof pagination['total'] === 'number' ? pagination['total'] : docs.length;

    return { docs, pages, total };
  }
}
