# Desktop: serialize Corkdiff credential adoption

## Goal

Apply every connection supplied by concurrent Corkdiff adoption requests without allowing a failed queued refresh to close an already adopted viewer.

## Included Changes

- Serializes per-thread adoption while continuing to coalesce read-only inspections.
- Applies rotated websocket tickets in request order instead of discarding later connections.
- Marks an adopted session unhealthy when a queued refresh fails and preserves the live viewer for explicit recovery.

## Validation Coverage

- Concurrent successful adoption installs the newest ticket.
- A failed queued refresh preserves the adopted Ghostty window and records unhealthy state.

## Review Provenance

Resolves the finding from `codex review --commit 85b5f3625d`.
