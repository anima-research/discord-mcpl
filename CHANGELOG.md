# Changelog

Notable operator-facing changes. Started 2026-07-29; earlier history lives
in the git log and PR descriptions.

## Unreleased

### Added

- **Reserved-reaction projection policy** (`DISCORD_RESERVED_REACTIONS_FILE`,
  issue #21): reaction emojis reserved for classifier signaling are filtered
  out of every model-visible surface — live reaction events (including their
  event ids), `fetch_history` / `fetch_around` results, and channel-open
  backscroll metadata — before any text or token is produced. Policy is a
  versioned JSON file (custom-emoji ids, exact unicode after NFC/presentation
  normalization, and families covering skin-tone variants); unset means no
  protection and startup says so; a configured-but-broken file fails closed
  (all reactions suppressed, `reactionsUnavailable: true` marks history
  messages) until repaired; the file hot-reloads with last-known-good on bad
  rewrites. Raw Discord state is untouched — this is projection, not
  deletion. A production glyph set must be supplied at deploy time.

### Changed

- **Text attachments now inline into context only up to
  `DISCORD_ATTACHMENT_INLINE_MAX_BYTES` (default 5120 bytes)** — previously
  live delivery inlined text attachments up to 256KiB. Over the cap, the
  agent gets a name+size+URL note instead. The bound is enforced on actual
  received bytes, not Discord's declared attachment size. `0` disables text
  auto-inlining; values clamp to the 262144-byte (256KiB) absolute ceiling;
  malformed or negative values log an error and fall back to the default.
  Raising the cap intentionally restores the prior always-inline behavior.
  Images are unaffected: they inline as native image blocks under their own
  ceilings. (issue #30, PR #12)
