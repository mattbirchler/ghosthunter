import { statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { linkFor } from './types.ts';
import type { SearchHit } from './types.ts';
import { Store } from './store.ts';
import { search } from './search.ts';
import { GhostClient } from './ghost-client.ts';
import { sync, lastSyncAt } from './sync.ts';
import { runPicker, markdownLink } from './picker.ts';
import { copyToClipboard, openInBrowser } from './clipboard.ts';
import {
  loadConfig,
  saveConfig,
  getAdminKey,
  setAdminKey,
  normalizeSiteUrl,
  dbPath,
  configDir,
  configPath,
} from './config.ts';

const VERSION = '0.1.0';
const DEFAULT_LIMIT = 50;

/** Exit codes. 2 means "not set up yet", which is distinct from a real failure. */
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NOT_CONFIGURED = 2;

export type Command =
  | {
      kind: 'search';
      query: string;
      json: boolean;
      list: boolean;
      offline: boolean;
      limit: number;
    }
  | { kind: 'sync'; full: boolean; prune: boolean }
  | { kind: 'init' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'version' };

const SUBCOMMANDS = ['init', 'sync', 'status'];

export function parseArgs(argv: string[]): Command {
  const words: string[] = [];
  let json = false;
  let list = false;
  let offline = false;
  let full = false;
  let prune = false;
  let help = false;
  let version = false;
  let limit = DEFAULT_LIMIT;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') json = true;
    else if (a === '--list') list = true;
    else if (a === '--offline') offline = true;
    else if (a === '--full') full = true;
    else if (a === '--prune') prune = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--version' || a === '-v') version = true;
    else if (a === '--limit') {
      const n = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    } else words.push(a);
  }

  if (help) return { kind: 'help' };
  if (version) return { kind: 'version' };

  // Only a lone word counts as a subcommand, so `ghosthunter status of the
  // union` searches rather than printing index stats.
  if (words.length === 1 && SUBCOMMANDS.includes(words[0]!)) {
    const name = words[0]!;
    if (name === 'sync') return { kind: 'sync', full, prune };
    if (name === 'init') return { kind: 'init' };
    return { kind: 'status' };
  }

  if (words.length === 0) return { kind: 'help' };

  return { kind: 'search', query: words.join(' '), json, list, offline, limit };
}

function dateOf(hit: SearchHit): string {
  return (hit.doc.publishedAt ?? hit.doc.updatedAt).slice(0, 10);
}

export function formatList(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return 'No matches. Try fewer words, or drop any tag: and date filters.';
  }

  const lines: string[] = [];
  hits.forEach((h, i) => {
    const isDraft = h.doc.status !== 'published' && h.doc.status !== 'sent';
    const marker = isDraft ? ` [${h.doc.status}]` : '';
    lines.push(`${String(i + 1).padStart(2)}. ${h.doc.title}${marker}  ${dateOf(h)}`);
    lines.push(`    ${linkFor(h.doc)}`);
    const snip = h.snippet.replaceAll(/\s+/g, ' ').trim();
    if (snip !== '') lines.push(`    ${snip}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function formatJson(hits: SearchHit[]): string {
  return JSON.stringify(
    hits.map((h) => ({
      id: h.doc.id,
      type: h.doc.type,
      status: h.doc.status,
      title: h.doc.title,
      slug: h.doc.slug,
      link: linkFor(h.doc),
      url: h.doc.url,
      editorUrl: h.doc.editorUrl,
      tags: h.doc.tags,
      publishedAt: h.doc.publishedAt,
      updatedAt: h.doc.updatedAt,
      snippet: h.snippet,
      score: h.score,
    })),
    null,
    2,
  );
}

const HELP = `GhostHunter ${VERSION}
Search your own Ghost blog and get the link.

USAGE
  ghosthunter <query>            Search and pick a result (alias: ght)
  ghosthunter init               Set up the site URL and API key
  ghosthunter sync               Fetch what changed since the last sync
  ghosthunter status             Show index size and last sync time

OPTIONS
  --list          Print results instead of opening the picker
  --json          Print results as JSON
  --offline       Skip the automatic sync before searching
  --limit N       Return at most N results (default 50)
  --full          With sync: re-fetch everything
  --prune         With sync: drop posts deleted in Ghost
  -h, --help      Show this help
  -v, --version   Show the version

QUERY SYNTAX
  vision pro               Both words, ranked by relevance
  "one year later"         An exact phrase
  vision -failure          Exclude a word
  title:nonogram           Match in the title only
  tag:apple                Restrict to a tag
  after:2024               Published on or after a date
  before:2023-06           Published before a date
  status:draft             Only drafts (also: published, scheduled, sent)
  type:page                Only pages (also: post)

PICKER KEYS
  up, down        Move the selection
  enter           Copy the URL and exit
  opt-enter, ^L   Copy a markdown link and exit
  ^O              Open the post in your browser
  ^E              Open the post in the Ghost editor
  ^U              Clear the query
  esc             Quit without copying
`;

/**
 * Ghost returning documents with no body text would make every body search come
 * back empty for no visible reason. Say so plainly instead.
 */
function warnIfBodiesEmpty(store: Store): void {
  const total = store.count();
  if (total === 0) return;
  const empty = store.emptyBodyCount();
  if (empty < total * 0.9) return;

  process.stderr.write(
    `\nWarning: ${empty} of ${total} documents came back with no body text.\n` +
      'Titles and tags are still searchable, but searching post contents will not work.\n' +
      'This usually means the Ghost version does not return the plaintext format.\n',
  );
}

function notConfigured(): number {
  process.stderr.write('GhostHunter is not set up yet. Run: ghosthunter init\n');
  return EXIT_NOT_CONFIGURED;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ageOf(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

async function runInit(): Promise<number> {
  // readline stops resolving questions once a piped stdin hits EOF, which would
  // hang with no output. Fail with an explanation instead.
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      'ghosthunter init needs an interactive terminal.\n' +
        'To configure without one, set GHOSTHUNTER_ADMIN_KEY and write the API URL to\n' +
        `${configPath()} as {"siteUrl": "https://yourblog.ghost.io"}, then run: ghosthunter sync --full\n`,
    );
    return EXIT_ERROR;
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write('GhostHunter setup\n\n');
    process.stderr.write(
      'In Ghost, go to Settings, then Integrations, then your custom integration\n' +
        '(or Add custom integration). Both values below are on that one screen.\n\n',
    );

    const existing = loadConfig();
    const urlPrompt = existing
      ? `API URL [${existing.siteUrl}]: `
      : 'API URL (for example https://yourblog.ghost.io): ';
    const rawUrl = (await rl.question(urlPrompt)).trim();
    const siteUrl = normalizeSiteUrl(rawUrl === '' && existing ? existing.siteUrl : rawUrl);

    process.stderr.write(
      '\nCopy the Admin API key, not the Content API key. It has a colon in it.\n',
    );
    const key = (await rl.question('Admin API key: ')).trim();
    if (key === '') {
      process.stderr.write('No key entered. Setup cancelled.\n');
      return EXIT_ERROR;
    }
    if (!key.includes(':')) {
      process.stderr.write(
        '\nThat looks like the Content API key. GhostHunter needs the Admin API key,\n' +
          'which is longer and has a colon in the middle.\n',
      );
      return EXIT_ERROR;
    }

    process.stderr.write('\nChecking the connection...\n');
    const client = new GhostClient(siteUrl, key);
    const probe = await client.fetchPage({ type: 'post', page: 1, limit: 1 });
    process.stderr.write(`Connected. Found ${probe.total} posts.\n`);

    // Public URLs come from Ghost, not from the API URL entered above. On a
    // split setup those differ, so show a real one to confirm it is right.
    const sample = probe.docs.find((d) => d.url !== null);
    if (sample?.url != null) {
      process.stderr.write(`Links will look like: ${sample.url}\n`);
    }

    saveConfig({ siteUrl });
    setAdminKey(key);

    const store = new Store(dbPath());
    try {
      process.stderr.write('\nBuilding the index. This runs once and takes a minute.\n');
      const r = await sync(client, store, {
        full: true,
        onProgress: (m) => process.stderr.write(`  ${m}\n`),
      });
      process.stderr.write(`\nReady. Indexed ${r.added} documents.\n`);
      warnIfBodiesEmpty(store);
      process.stderr.write('Try: ghosthunter <something you have written about>\n');
    } finally {
      store.close();
    }
    return EXIT_OK;
  } finally {
    rl.close();
  }
}

async function runSync(cmd: { full: boolean; prune: boolean }): Promise<number> {
  const config = loadConfig();
  const key = getAdminKey();
  if (config === null || key === null) return notConfigured();

  const store = new Store(dbPath());
  try {
    const client = new GhostClient(config.siteUrl, key);
    const r = await sync(client, store, {
      full: cmd.full,
      prune: cmd.prune,
      onProgress: (m) => process.stderr.write(`${m}\n`),
    });
    process.stderr.write(
      `Added ${r.added}, updated ${r.updated}, removed ${r.removed}.\n`,
    );
    if (cmd.full) warnIfBodiesEmpty(store);
    return EXIT_OK;
  } finally {
    store.close();
  }
}

function runStatus(): number {
  const config = loadConfig();
  if (config === null) return notConfigured();

  const store = new Store(dbPath());
  try {
    const last = lastSyncAt(store);
    let size = 0;
    try {
      size = statSync(dbPath()).size;
    } catch {
      // A missing file just reports as zero.
    }
    process.stderr.write(`Site:      ${config.siteUrl}\n`);
    process.stderr.write(`Documents: ${store.count()}\n`);
    process.stderr.write(`Last sync: ${last === null ? 'never' : `${ageOf(last)} (${last})`}\n`);
    process.stderr.write(`Index:     ${humanSize(size)} at ${dbPath()}\n`);
    process.stderr.write(`Config:    ${configDir()}\n`);
    return EXIT_OK;
  } finally {
    store.close();
  }
}

async function runSearch(cmd: Extract<Command, { kind: 'search' }>): Promise<number> {
  const config = loadConfig();
  const key = getAdminKey();
  if (config === null) return notConfigured();

  const store = new Store(dbPath());
  try {
    if (store.count() === 0 && key === null) return notConfigured();

    let notice: string | null = null;

    // Search must never fail because of the network, so a sync error only
    // downgrades to a notice.
    if (!cmd.offline && key !== null) {
      try {
        await sync(new GhostClient(config.siteUrl, key), store);
      } catch {
        const last = lastSyncAt(store);
        notice =
          last === null
            ? 'Offline. The index has not been built yet.'
            : `Offline. Index last updated ${ageOf(last)}.`;
      }
    }

    const interactive = process.stdout.isTTY === true && !cmd.json && !cmd.list;

    if (!interactive) {
      const hits = search(store, cmd.query, { limit: cmd.limit });
      if (notice !== null) process.stderr.write(`${notice}\n`);
      process.stdout.write(`${cmd.json ? formatJson(hits) : formatList(hits)}\n`);
      return EXIT_OK;
    }

    const action = await runPicker({
      initialQuery: cmd.query,
      notice,
      run: (q) => search(store, q, { limit: cmd.limit, prefixLastTerm: true }),
    });

    if (action.kind === 'cancel') return EXIT_OK;

    if (action.kind === 'copy-url') {
      const link = linkFor(action.doc);
      copyToClipboard(link);
      process.stderr.write(`Copied: ${link}\n`);
    } else if (action.kind === 'copy-markdown') {
      const md = markdownLink(action.doc);
      copyToClipboard(md);
      process.stderr.write(`Copied: ${md}\n`);
    } else if (action.kind === 'open') {
      openInBrowser(linkFor(action.doc));
    } else {
      openInBrowser(action.doc.editorUrl);
    }
    return EXIT_OK;
  } finally {
    store.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const cmd = parseArgs(argv);

  try {
    switch (cmd.kind) {
      case 'help':
        process.stdout.write(HELP);
        return EXIT_OK;
      case 'version':
        process.stdout.write(`${VERSION}\n`);
        return EXIT_OK;
      case 'init':
        return await runInit();
      case 'sync':
        return await runSync(cmd);
      case 'status':
        return runStatus();
      case 'search':
        return await runSearch(cmd);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_ERROR;
  }
}
