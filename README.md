# GhostHunter

Search your own Ghost blog from the terminal and get the link.

Ghost's official CLI is built for people who host and develop Ghost. GhostHunter
is built for the person who writes the posts, and answers one question fast:

> When did I write about this, and what's the URL?

Run `ght` and you're in. Type to search, arrow through results, read the article
alongside the list, and press enter to put the link on your clipboard.

```
 GhostHunter                                          birchtree.ghost.io
 ❯ vision pro▌                                                   6 hits
────────────────────────────────────────────┬──────────────────────────
 ❯ Vision Pro, one year later    2025-02-11 │ Vision Pro, one year later
   The Vision Pro is not a fail… 2024-06-03 │ 2025-02-11 · post · apple
   My first week with Vision Pro 2024-02-09 │ https://birchtree.me/blog/…
   Thoughts on spatial computing 2024-01-15 │
   Untitled thoughts on headse…* 2026-07-01 │ I still think the Vision Pro
   Apple headset problem         2023-11-20 │ is the most interesting
                                            │ thing Apple has shipped in
                                            │ a decade, even if I barely
                                            │ use mine these days...
 ↵ copy   ⌥↵ markdown   ^O open   ^E edit   ⇧↑↓ scroll   ^C quit
```

Matching words are highlighted in the article text, and the index syncs in the
background as soon as the browser opens, so it starts instantly and refreshes
itself when new posts land.

## Why this exists

Ghost's API cannot answer that question on its own:

- NQL, the API's filter language, has no partial-match operator. You can filter
  `tag:apple`, but you cannot ask for "body contains Vision Pro".
- Ghost's native site search only indexes titles, excerpts, authors, and tags.
  It never looks at post bodies, and it stops at 10,000 posts.

What Ghost will do is hand you your entire archive as plaintext. So GhostHunter
syncs it down once, indexes it locally with SQLite FTS5, and searches that.
After the first sync, results are instant and work with no network at all.

## Install

Requires **Node 26 or newer** and macOS.

```sh
npm install -g @mattbirchler/ghosthunter
```

There are no dependencies. Nothing compiles, and nothing is downloaded beyond
the source itself.

## Setup

```sh
ghosthunter init
```

In Ghost, go to **Settings, Integrations, Add custom integration**. Name it
whatever you like. Both values init asks for are on that one screen:

1. **API URL.** Copy it exactly as Ghost shows it. On Ghost Pro this is usually
   `https://yourblog.ghost.io`, which is often **not** the domain your readers
   visit. If your site has a custom domain, the API URL is still the Ghost one.
2. **Admin API key.** The longer one, with a colon in the middle. The Content API
   key will not work, because it cannot see drafts.

Your posts' public links come from Ghost itself, so they use your real domain
even when the API URL differs. Init prints a sample link so you can confirm.

The key is stored in your macOS Keychain, never in a file. The first sync walks
your whole archive, which takes about a minute for a few thousand posts. Every
sync after that is incremental and takes about a fifth of a second.

## Usage

```sh
ght                            # open the browser
ght vision pro                 # open the browser on a search
ght vision pro --list          # print results, no browser
ght vision pro --json          # JSON, for scripts
ght sync                       # fetch what changed
ght sync --full                # rebuild from scratch
ght sync --prune               # also drop posts deleted in Ghost
ght status                     # index size and last sync time
```

You rarely need `sync` by hand. The browser does it for you on open.

Piping works as you would expect. When output is not a terminal, GhostHunter
prints a list instead of trying to draw a picker:

```sh
ght vision pro --json | jq -r '.[0].link'
```

### Query syntax

| Query | Finds |
|---|---|
| `vision pro` | Both words, ranked by relevance |
| `"one year later"` | That exact phrase |
| `vision -failure` | Has "vision", excludes "failure" |
| `title:nonogram` | Matches in the title only |
| `tag:apple` | Restricted to a tag |
| `after:2024` | Published on or after a date |
| `before:2023-06` | Published before a date |
| `status:draft` | Only drafts (also `published`, `scheduled`, `sent`) |
| `type:page` | Only pages (also `post`) |

Titles are weighted about ten times higher than body text, so a post actually
titled for your topic beats one that mentions it in passing. Search also stems
words, so `read` finds `reading`.

Nothing you type can break the query. Stray quotes, asterisks, and parentheses
are all treated as ordinary text.

### Browser keys

| Key | Action |
|---|---|
| `up` / `down` | Move the selection |
| `shift-up` / `shift-down` | Scroll the article text (or page up and page down) |
| `enter` | Copy the URL |
| `opt-enter` or `^L` | Copy a markdown link |
| `^O` | Open the post in your browser |
| `^E` | Open the post in the Ghost editor |
| `^U` | Clear the query |
| `^C` or `esc` | Quit |

Copying does not close the browser. It confirms in the footer and stays put, so
you can pull several links in one session. Quit with `^C` when you're done.

Results update as you type, so you can start broad and narrow down. On a narrow
terminal the article pane drops away and the list takes the full width.

`opt-enter` is swallowed by some terminal setups depending on how "Use Option as
Meta" is configured. `^L` does the same thing and always works.

### Drafts

Drafts and scheduled posts are indexed too, so you can check whether you already
started writing something. They have no public URL, so copying one gives you the
Ghost editor link instead. They're marked `[draft]` in results so you never paste
a dead link into a post.

## Where things live

| What | Where |
|---|---|
| Index | `~/.config/ghosthunter/index.db` |
| Site URL | `~/.config/ghosthunter/config.json` |
| Admin API key | macOS Keychain |

The Admin key is used strictly read-only. GhostHunter never writes to your site.

To start over, delete `~/.config/ghosthunter/` and run `ghosthunter init` again.

## Development

```sh
npm test
```

Tests run on Node's built-in runner against TypeScript directly. No build step.

The live smoke test that hits a real site is skipped by default:

```sh
GHOSTHUNTER_LIVE_TEST=1 \
GHOSTHUNTER_SITE_URL=https://yourblog.com \
GHOSTHUNTER_ADMIN_KEY=id:secret \
npm test
```

## License

MIT
