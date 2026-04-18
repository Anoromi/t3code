# server: rework Codex runtime and projections

## Goal

Rebase the server runtime onto upstream's Codex-first architecture while preserving the branch's fork, projection, checkpoint, keybinding, and terminal behavior.

## Implementation Summary

- Removes the branch-local ACP package and Cursor/OpenCode provider runtimes from the active workspace.
- Updates provider wiring, text-generation routing, model metadata, and settings contracts for the Codex-first runtime.
- Carries forward thread forking, worktree group title generation, projection snapshot compatibility, and migration repairs on top of upstream persistence code.
- Reworks checkpoint, provider runtime ingestion, terminal manager, keybinding, and desktop-control integration points around the rebased orchestration stack.
- Updates package manifests, lockfile, and turbo pipeline metadata to match the simplified workspace and restored test/build graph.

## Reimplementation Notes

- Prefer upstream/main's provider architecture and only keep branch behavior that still matters for Codex and Claude flows.
- Do not reintroduce the deleted ACP runtime stack.
- Keep migration numbering compatible with upstream and repair persisted state from earlier rebased migration layouts.
- Keep renderer-facing contracts aligned with the server changes so existing web and desktop features continue to compile against the rebased schemas.

## Expected Behavior

- The workspace installs without the local `effect-acp` package.
- Provider settings and model selection remain usable through the Codex-first runtime.
- Forked threads, generated worktree titles, checkpoint diffs, terminal sessions, and server projections keep working against existing persisted databases.
- Server and web tests continue to exercise provider registry, projection, keybinding, and selection behavior.
