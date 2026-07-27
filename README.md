# GhostHunter

Search your own Ghost blog from the terminal and get the link.

Ghost's official CLI is built for people who host and develop Ghost. GhostHunter
is built for the person who writes the posts, and answers one question fast:

> When did I write about this, and what's the URL?

Ghost's API can't answer that on its own. Its filter syntax has no partial-match
operator, and its native search only looks at titles, excerpts, authors, and
tags, never post bodies. So GhostHunter syncs your archive down as plaintext,
indexes it locally with SQLite FTS5, and searches that. Once synced, results are
instant and work offline.

```
$ ght vision pro
┌──────────────────────────────────────────────┐
│ > vision pro                          14 hits│
├──────────────────────────────────────────────┤
│ ❯ Vision Pro, one year later      2025-02-11 │
│   The Vision Pro is not a failure 2024-06-03 │
│   My first week with Vision Pro   2024-02-09 │
├──────────────────────────────────────────────┤
│ ...still think the Vision Pro is the most    │
│ interesting thing Apple has shipped in a     │
│ decade, even if I barely use mine...         │
└──────────────────────────────────────────────┘
  ↵ copy URL   ⌥↵ copy markdown link   ^O open
```

## Status

Design approved, implementation not started. See
[the design spec](docs/superpowers/specs/2026-07-27-ghosthunter-design.md).

## License

MIT
