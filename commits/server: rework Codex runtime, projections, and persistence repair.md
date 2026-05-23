# server: rework Codex runtime, projections, and persistence repair

## Goal

Rework the server around the upstream Codex-first runtime while preserving branch-owned fork-origin compatibility, projection repair, and live persisted-state safety.

## Included Changes

- Keeps the upstream provider/runtime architecture as canonical instead of reviving stale branch runtime code.
- Adds orchestration-level fork commands and forked-thread events with canonical `forkSource*` origin fields.
- Keeps decode-only compatibility for old `source*` fork-origin, fork-command, and provider-fork payloads.
- Removes stale provider-runtime compatibility aliases and updates Claude adapter status typing to use `RuntimeTurnState`.
- Extends projection threads and snapshot mapping with fork-origin columns while preserving legacy column rename compatibility.
- Remaps globally keyed fork history rows when creating forked threads so source messages, proposed plans, activities, and checkpoint references are not stolen by the fork.
- Repairs projected latest-turn IDs for threads with persisted turn history and proposed plans.
- Preserves queued turn-start state in shell snapshots before providers report a concrete turn ID.
- Updates provider turn-start handling so successful sends immediately project the running session and active turn.
- Restores stale user-input recovery for providers that report old non-hyphenated or Codex-specific unknown pending request errors after app restarts, including first-click fallback into a normal follow-up turn.
- Restores worktree-group title regeneration commands/events and a server-side title reactor.
- Adds tests for canonical fork-origin/provider input names, legacy decode, projector replay, snapshot output, safe fork remapping, projection repair, and worktree-title regeneration.

## Expected Behavior

Existing live fork-origin data can still replay, newly emitted commands/events/projections use canonical `forkSource*` naming, forked history remains attached to both source and fork threads, and repaired projections expose actionable plans reliably.
