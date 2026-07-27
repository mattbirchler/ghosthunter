import { DOC_TYPES } from './types.ts';
import type { SyncResult, DocType } from './types.ts';
import type { GhostClient } from './ghost-client.ts';
import type { Store } from './store.ts';

const LAST_SYNC_KEY = 'last_sync_at';

export interface SyncOptions {
  /** Ignore the watermark and walk every page. */
  full?: boolean;
  /** Reconcile ids afterwards and drop anything the server no longer returns. */
  prune?: boolean;
  onProgress?: (message: string) => void;
}

function label(type: DocType, n: number): string {
  return n === 1 ? type : `${type}s`;
}

/**
 * Pull changes from Ghost into the local index.
 *
 * Two properties matter here. Each API page is committed on its own, so an
 * interrupted sync keeps everything fetched so far. And the watermark is
 * captured before the first request and only written after the last one
 * succeeds, so anything edited mid-sync is caught next time rather than missed.
 */
export async function sync(
  client: GhostClient,
  store: Store,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const lastSync = store.getMeta(LAST_SYNC_KEY);
  const isFull = opts.full === true || lastSync === null;
  const progress = opts.onProgress ?? ((): void => {});

  const result: SyncResult = { added: 0, updated: 0, removed: 0 };
  const counts: Record<string, number> = {};

  for (const type of DOC_TYPES) {
    const filter = isFull ? undefined : `updated_at:>'${lastSync}'`;
    let page = 1;
    let pages = 1;
    let seen = 0;

    while (page <= pages) {
      const res = await client.fetchPage({
        type,
        page,
        filter,
        order: isFull ? undefined : 'updated_at asc',
      });
      pages = Math.max(res.pages, 1);

      if (res.docs.length > 0) {
        const { added, updated } = store.upsert(res.docs);
        result.added += added;
        result.updated += updated;
        seen += res.docs.length;
      }

      if (isFull && pages > 1) {
        progress(`Syncing ${type}s, page ${page} of ${pages}`);
      }
      page++;
    }

    counts[type] = seen;
  }

  if (opts.prune === true) {
    progress('Checking for deleted documents');
    const live = new Set<string>();
    for (const type of DOC_TYPES) {
      let page = 1;
      let pages = 1;
      while (page <= pages) {
        const res = await client.fetchPage({ type, page, fieldsOnly: true });
        pages = Math.max(res.pages, 1);
        for (const d of res.docs) live.add(d.id);
        page++;
      }
    }
    result.removed = store.deleteMissing(live);
  }

  // Only now that everything succeeded. A thrown error above leaves the
  // previous watermark in place so the next run retries the same window.
  store.setMeta(LAST_SYNC_KEY, startedAt);

  const postCount = counts['post'] ?? 0;
  const pageCount = counts['page'] ?? 0;
  progress(
    `Synced ${postCount} ${label('post', postCount)} and ${pageCount} ${label('page', pageCount)}.`,
  );

  return result;
}

export function lastSyncAt(store: Store): string | null {
  return store.getMeta(LAST_SYNC_KEY);
}
