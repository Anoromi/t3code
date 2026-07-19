# Desktop: preserve Corkdiff stale-session recovery

## Goal

Distinguish backend ticket outages from an unhealthy managed Corkdiff Neovim process.

## Included Changes

- Marks a live managed session unhealthy only after its Neovim RPC endpoint rejects credential replacement.
- Keeps healthy managed windows focusable while ticket issuance retries in the background.
- Routes unhealthy managed windows through a fresh connection probe and the existing bounded close-and-relaunch path.

## Validation Coverage

Preserve focused scenarios for ticket outages, successful in-place refresh, failed RPC refresh, stale-window closure, and relaunch eligibility.

## Review Provenance

Resolves the follow-up finding from `codex review --commit 700323c0c4`.
