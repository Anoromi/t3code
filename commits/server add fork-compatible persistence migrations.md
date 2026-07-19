# server add fork-compatible persistence migrations

## Goal

Preserve the fork's existing persistence additions while rebasing onto canonical upstream migrations 31 and 32 without corrupting databases that already recorded the fork's historical migration ids.

## Included Changes

- Keeps upstream authorization-scope and proof-key migrations at ids 31 and 32.
- Moves the fork's thread-origin, Hyprnav project settings, projection repair, and runtime index migrations to ids 33 through 39.
- Adds migration 40 as an idempotent compatibility repair for databases whose historical ledger already ends at fork migration 37.
- Removes legacy not-null model columns after backfilling canonical model-selection JSON, so upstream projection writes remain valid on fork databases.
- Replays idempotent canonical model-option and projection-index effects whose ids were also occupied by historical fork migrations.
- Serializes the one-time compatibility preflight, retries SQLite snapshot contention during overlapping startup, and preserves bounded no-op semantics while preparing bounded forward upgrades.
- Explicitly persists inherited Hyprnav state for new projects, avoiding stale SQL defaults from historical fork databases.
- Adds shared Hyprnav contracts for legacy normalization, scoped slots, managed or absolute workspaces, and external Corkdiff defaults.
- Tests fresh databases, divergent and partial fork ledgers, bounded migration behavior, startup contention, idempotency, auth cutover, and explicit real-database copies.

## Compatibility

Migration 40 does not rewrite historical ledger rows. Legacy role-bearing auth credentials are intentionally invalidated during the upstream scope cutover because their capabilities cannot be inferred safely.

## Reimplementation Sources

This intent reimplements source commit `bd47655631` against canonical upstream migrations 31 and 32. Its focused scenarios are enumerated above and retained in the migration compatibility, contention, and isolated real-database tests.
