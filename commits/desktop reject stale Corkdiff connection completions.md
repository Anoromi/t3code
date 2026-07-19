# Desktop: reject stale Corkdiff connection completions

## Goal

Prevent out-of-order ticket resolution from reconnecting an adopted Corkdiff viewer to an older backend or credential.

## Included Changes

- Assigns a per-thread generation after inspection determines that fresh credentials are required.
- Skips superseded connection completions before adoption and waits for the current adoption result.
- Prevents stale callers from launching or scheduling credential refresh with their older connection.

## Validation Coverage

- A late old-backend ticket cannot enter the adoption queue or replace the newest connection.
- Existing and pending adopted viewers remain reusable without cancelling the current refresh schedule.

## Review Provenance

Resolves the finding from `codex review --commit 95b5282424`.
