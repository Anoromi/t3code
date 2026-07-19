# Desktop: preserve Corkdiff refresh ownership

## Goal

Keep an adopted viewer's credential refresh active until a newer connection has actually replaced it.

## Included Changes

- Separates logical open-request generations from installed refresh ownership.
- Allows an older successful adoption to retain refresh ownership while a newer request is still resolving or fails.
- Transfers ownership monotonically after successful adoption or launch and ignores late older schedules.

## Validation Coverage

- Starting a newer request does not revoke the current refresh owner.
- Successful newer installation transfers ownership and prevents an older continuation from reclaiming it.

## Review Provenance

Resolves the finding from `codex review --commit 8b87729809`.
