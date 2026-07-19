# Desktop and web: resolve final reliability review

## Goal

Prevent normal concurrency and worktree-creation races from leaving Corkdiff or Hyprnav in a partially applied state.

## Included Changes

- Coalesces concurrent per-thread Corkdiff inspection and adoption requests so a duplicate failed refresh cannot close a viewer another request successfully adopted.
- Detects successful Hyprnav publications that omit requested scopes during stale-worktree recovery and retries them on the normal bounded background cadence.
- Preserves compatibility with desktop bridges that predate explicit `appliedScopes` reporting.

## Validation Coverage

- Concurrent unmanaged Corkdiff adoption through one shared Neovim refresh.
- Missing versus complete Hyprnav scope acknowledgements and legacy results without scope metadata.

## Review Provenance

Resolves both findings from the final `codex review --base ebe8afb1df357423a0e036b388af3e739d640205`.
