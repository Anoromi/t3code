# Desktop: bind Corkdiff refresh to installed connection

## Goal

Prevent a superseded caller from claiming refresh ownership for a ticket it never installed.

## Included Changes

- Records the logical generation whenever Neovim accepts a Corkdiff connection update.
- Schedules adoption refresh only when the caller's generation is still the installed connection.
- Keeps stale read-only fallback results reusable without changing credential ownership or expiry.

## Validation Coverage

- The newest adopted generation is recorded as installed.
- A late older connection completion reuses the viewer without being recorded or scheduled.

## Review Provenance

Resolves the finding from `codex review --commit c5c63db928`.
