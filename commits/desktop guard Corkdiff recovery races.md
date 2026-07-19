# Desktop: guard Corkdiff recovery races

## Goal

Prevent stale recovery work from damaging a replacement Corkdiff session and stop refresh promptly when its window closes.

## Included Changes

- Deletes session state only when the captured generation is still current.
- Treats a different same-class client address as a completed stale-window close.
- Rechecks the managed window after rejected Neovim refresh commands and reports closure immediately.

## Validation Coverage

Preserve focused replacement-generation, rejected-probe, same-class address, rejected-refresh closure, concurrency, and bounded cleanup scenarios.

## Review Provenance

Resolves both findings from `codex review --commit 73f30ce5da`.
