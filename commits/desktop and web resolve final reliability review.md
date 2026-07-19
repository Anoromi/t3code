# Desktop and web: resolve final reliability review

## Goal

Prevent normal concurrency and worktree-creation races from leaving Corkdiff or Hyprnav in a partially applied state.

## Included Changes

- Coalesces concurrent inspections and serializes per-thread Corkdiff adoption so every distinct supplied connection is applied.
- Preserves a successfully adopted viewer when a queued connection refresh fails, while marking the session unhealthy for explicit recovery.
- Detects successful Hyprnav publications that omit requested scopes during stale-worktree recovery and retries them on the normal bounded background cadence.
- Preserves compatibility with desktop bridges that predate explicit `appliedScopes` reporting.

## Validation Coverage

- Concurrent unmanaged Corkdiff adoption with successful credential rotation and failed queued refresh.
- Missing versus complete Hyprnav scope acknowledgements and legacy results without scope metadata.

## Review Provenance

Resolves both findings from the final `codex review --base ebe8afb1df357423a0e036b388af3e739d640205` and the connection-freshness finding from `codex review --commit 85b5f3625d`.
