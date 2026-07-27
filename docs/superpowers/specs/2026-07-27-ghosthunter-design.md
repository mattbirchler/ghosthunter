# GhostHunter design

Date: 2026-07-27
Status: approved, ready for implementation planning

## Problem

Ghost publishes an official CLI, but it is aimed at people who host and develop
Ghost. It does nothing for a writer who wants to answer "when did I write about
this, and what is the link?"

That question is surprisingly hard to answer with Ghost's own tools:

- Both the Content and Admin APIs cap at `limit=100` per page, so everything is
  paginated.
- NQL, the `filter` parameter, has no `like` or partial-match operator. You can
  filter `tag:apple` or `featured:true`, but you cannot ask for "body contains
  Vision Pro".
- Ghost's native site search indexes only titles, excerpts, authors, and tags.
  It explicitly does not search post bodies, and it caps at 10,000 posts.

So Ghost cannot search your archive server-side. What it will do is hand you the
entire archive as plaintext via `&formats=plaintext`.

This project uses the **Admin API** rather than the Content API. The limitations
above apply equally to both, so the choice is driven by coverage: only the Admin
API returns drafts and scheduled posts, which are in scope.

That single fact defines this project. GhostHunter is a local full-text index of
your Ghost site with a sync command on one side and a fast picker on the other.
Once synced, search is instant and works offline, and it can answer questions
Ghost's own search never will.

## Target user and scale

Built for a single site owner searching their own archive. The reference site is
birchtree.me at 4,846 published posts, which is the scale the design assumes.
That is roughly 50 API requests for a first sync and about 40MB on disk.

## Scope

The primary job is **link lookup**. You are mid-writing, you want to reference an
old post, and you need its URL. Everything else is secondary.

Confirmed decisions:

- Interactive picker as the main interface, with a live-filtered list and a
  preview of the matching passage.
- Index covers posts of every status (published, draft, scheduled, sent) plus
  pages. This requires an Admin API key rather than a Content API key.
- Single site. No multi-site profiles.

### Explicitly out of scope

- Fuzzy matching beyond FTS5's Porter stemming.
- Storing full HTML. Plaintext is what you search, the URL is what you want.
- Multi-site support.
- Any write operation. The Admin key is used strictly read-only.

## Architecture

Package `@mattbirchler/ghosthunter`. Two binary names from one package:
`ghosthunter` for discoverability, `ght` as the short alias.

Node and TypeScript with **zero runtime dependencies**:

- `node:sqlite` ships with Node and its bundled SQLite has FTS5 compiled in
  (verified on Node 26.5), so full-text search needs no native module.
- Admin API JWT signing uses Web Crypto, ported from the working implementation
  in `~/Apps/ghosty-posty-obsidian/src/ghost-api.ts`.
- Clipboard writes shell out to `pbcopy`.
- Credential storage shells out to the macOS `security` command.

### Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `config` | Resolve site URL and Admin key | Keychain, config file |
| `ghost-client` | JWT auth, paginated Admin API fetches | nothing local |
| `store` | SQLite schema, upserts, FTS queries | `node:sqlite` |
| `sync` | Orchestrates client into store | `ghost-client`, `store` |
| `search` | Query string into ranked results | `store` |
| `picker` | TUI list, returns a chosen action | nothing |
| `cli` | Arg parsing and wiring | all of the above |

The seams that matter: `ghost-client` knows nothing about SQLite, `store` knows
nothing about HTTP, and `picker` knows nothing about Ghost. Search ranking is
therefore testable against a fixture database with no network, and the picker is
testable with fake rows.

### Credentials

Site URL lives in `~/.config/ghosthunter/config.json`. The Admin API key goes in
the macOS Keychain via the built-in `security` command, so no secret is ever
written to a plaintext file.

## Data model

```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,        -- Ghost object id
  type TEXT NOT NULL,         -- post | page
  status TEXT NOT NULL,       -- published | draft | scheduled | sent
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  url TEXT,                   -- public URL, NULL for drafts
  editor_url TEXT NOT NULL,   -- always available
  plaintext TEXT,
  tags TEXT,
  published_at TEXT,
  updated_at TEXT NOT NULL    -- drives incremental sync
);

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, plaintext, tags,
  content='documents', content_rowid='rowid',
  tokenize='porter unicode61'
);
```

Triggers keep `documents_fts` in sync with `documents`. A `meta` table stores
`last_sync_at`.

Ranking uses BM25 with the title weighted roughly 10x the body and tags roughly
3x, so a post titled "Vision Pro, one year later" outranks one that mentions the
term in passing. The preview pane uses FTS5's built-in `snippet()`. The `porter`
tokenizer means searching "reading" also matches "read" and "reads".

Queries return in single-digit milliseconds at 4,846 documents.

### Draft URL handling

Published and sent documents copy their public URL. Drafts and scheduled
documents have no public URL, so they copy the Ghost editor URL instead. The
picker marks them `[draft]` so a dead link never gets pasted into a post.

## Sync

- **First run** paginates `/posts/` and `/pages/` at `limit=100` with
  `formats=plaintext` and `include=tags`, roughly 50 requests, with a progress
  line.
- **Every run after** sends one request filtered by
  `updated_at:>'<last_sync>'` ordered ascending. This normally returns zero rows
  and costs about 200ms, which is cheap enough that search auto-syncs on launch.
  `--offline` skips it.
- **Deletions** cannot be detected incrementally, because a deleted post simply
  stops appearing. `ghosthunter sync --prune` reconciles by fetching only
  `fields=id,updated_at` across all pages, which is small enough to be cheap,
  and drops local rows Ghost no longer returns.

## Command surface

```
ghosthunter <query>              search, opens the picker
ghosthunter <query> --list       print ranked results, no TUI
ghosthunter <query> --json       machine-readable, for scripts and Raycast
ghosthunter init                 one-time setup: site URL, Admin key, first sync
ghosthunter sync [--full] [--prune]
ghosthunter status               document count, last sync time, index size
```

When stdout is not a terminal, a bare query behaves as `--list`, so piping into
`head` or `grep` works instead of drawing a TUI into a pipe.

### Query syntax

```
ghosthunter vision pro                 both words, ranked
ghosthunter "one year later"           exact phrase
ghosthunter vision pro tag:apple       restrict by tag
ghosthunter keyboard after:2024        only posts since 2024
ghosthunter ipad before:2023-06 -mini  exclude a term
ghosthunter title:nonogram             match in the title only
ghosthunter status:draft newsletter    search unpublished work
```

`tag:`, `before:`, `after:`, `status:`, and `type:` are extracted and become SQL
`WHERE` clauses. The remainder becomes the FTS5 `MATCH` expression.

**Raw user input must never reach `MATCH` directly.** An unbalanced quote or a
stray `*` makes FTS5 throw a syntax error, which would make ordinary typing feel
broken. The `search` module parses input and emits a known-good FTS expression,
so no input can produce a syntax error. This gets direct test coverage.

### Picker

The picker re-queries the index on every keystroke rather than filtering a fixed
result set, which is affordable because queries are single-digit milliseconds.
The final token is treated as a prefix, so `nonog` matches `nonogram` and results
narrow as you type.

| Key | Action |
|---|---|
| `Up` / `Down` | Move selection |
| `Enter` | Copy URL, exit |
| `Option+Enter` | Copy `[Title](url)` markdown link, exit |
| `Ctrl+O` | Open the live post in a browser |
| `Ctrl+E` | Open in the Ghost editor |
| `Esc` | Quit without copying |

Open question deferred to implementation: `Option+Enter` is swallowed by some
terminal configurations depending on the "Use Option as Meta" setting. If it
proves unreliable, fall back to `Ctrl+L` and document it.

## Failure handling

A search should never fail because of the network.

| Situation | Behavior |
|---|---|
| Offline, index exists | Auto-sync fails silently, search runs locally, footer notes "offline, index 3 days old" |
| Offline, no index yet | Clear error directing you to run `ghosthunter init` while connected |
| Bad or revoked API key | Named error pointing at Integrations in Ghost admin, not a raw 401 |
| Sync interrupted midway | Each page commits in its own transaction, so a resumed sync continues rather than restarting |
| Rate limit or 5xx | Retry with backoff, up to 3 attempts, then keep whatever synced successfully |
| Query matches nothing | Suggest dropping filters if any were used, since `tag:` typos are the usual cause |

The interrupted-sync case is designed for rather than patched later. A first sync
of 50 requests is long enough that it will get interrupted at least once.

## Testing

Three layers. The module seams are what keep this cheap.

1. **`store` and `search` against fixtures.** A generated database of a few
   hundred synthetic documents, no network. Covers the query parser (especially
   unbalanced quotes and stray operators), BM25 ranking putting title matches on
   top, the `tag:`/`before:`/`after:`/`status:` filters, and snippet extraction.
   Most tests live here.
2. **`ghost-client` against recorded responses.** Saved JSON fixtures of real
   Admin API pages cover pagination, the incremental `updated_at` filter, and
   draft-versus-published URL resolution. No live site required, so tests stay
   fast and deterministic.
3. **One opt-in live smoke test**, gated behind an env var, hitting the real site
   to confirm auth and a single page fetch still work. This catches Ghost
   changing its API. It stays out of the normal test run.

The picker is tested by asserting on the action returned for a given keypress
sequence, not by snapshotting terminal output, which is brittle.

## Distribution

- `npm i -g @mattbirchler/ghosthunter`, or
- A `ghosthunter.rb` formula in the existing `~/Apps/homebrew-tap`, alongside
  `chapterize.rb` and `quicksubs.rb`.

The unscoped npm name `ghosthunter` is squatted by a dead 0.0.0 placeholder from
2022, and `ghost-hunter` is an unrelated sourcemap tool, hence the scoped name.

## Prior art in this codebase

- `~/Apps/ghosty-posty-obsidian/src/ghost-api.ts` has a working zero-dependency
  Admin API JWT implementation using Web Crypto. Port it.
- `~/Apps/ghost-for-raycast` searches the latest 20 posts via the Content API and
  handles headless setups where the admin domain differs from the front end. The
  `--json` output mode exists partly so this extension could later be backed by
  GhostHunter's index instead of live API calls.
