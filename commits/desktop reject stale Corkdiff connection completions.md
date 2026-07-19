# Desktop: reject stale Corkdiff connection completions

## Goal

Prevent out-of-order ticket resolution from reconnecting an adopted Corkdiff viewer to an older backend or credential.

## Included Changes

- Assigns a per-thread generation after inspection determines that fresh credentials are required.
- Skips superseded connection completions before adoption and waits for the current adoption result.
- Prevents stale callers from launching or scheduling credential refresh with their older connection.
- Transfers credential-refresh ownership only when a connection is successfully adopted or launched, so a newer failed ticket lookup cannot orphan the prior viewer.

## Validation Coverage

- A late old-backend ticket cannot enter the adoption queue or replace the newest connection.
- Existing and pending adopted viewers remain reusable without cancelling the current refresh schedule.
- Refresh ownership advances monotonically and rejects late older schedules.

## Review Provenance

Resolves the findings from `codex review --commit 95b5282424` and `codex review --commit 8b87729809`.
