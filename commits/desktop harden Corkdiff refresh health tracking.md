# Desktop: harden Corkdiff refresh health tracking

## Goal

Make stale Corkdiff recovery reliable across command timeouts and concurrent focus operations.

## Included Changes

- Marks the current managed session unhealthy when Neovim credential replacement rejects or times out, not only on nonzero exits.
- Gives each managed session a generation so stale asynchronous work cannot mutate a replacement session.
- Merges focus bookkeeping into the latest same-generation state so it cannot erase a concurrent refresh failure.
- Treats a rejected fresh-connection probe as stale and routes it through bounded window replacement.

## Validation Coverage

Preserve focused timeout, nonzero-exit, concurrent focus/refresh, healthy outage focus, stale closure, and successful refresh scenarios.

## Review Provenance

Resolves both findings from `codex review --commit adaabc9731`.
