# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.
- All of `bun fmt`, `bun lint`, and `bun typecheck` must also pass for fork-owned changes.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

- For frontend UI work, read and apply `.agents/uncodixify/AGENTS.md` before making design decisions.

## Rebase Work

- When resolving rebase conflicts or post-rebase regressions in this repo, use the project skill `$t3code-rebase-conflict-resolution` from `.codex/skills/t3code-rebase-conflict-resolution`.
- Follow that skill before declaring the rebase done. In particular, inspect upstream replacements first, audit migrations/events/projections/settings compatibility, and validate against real persisted state when the rebase touches startup or persistence.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Corkdiff

- Browser/web keeps the in-app diff viewer.
- Electron desktop launches Corkdiff externally through `hyprnav spawn --print-workspace-id rand -- ghostty ...`; do not restore the old embedded Corkdiff terminal path.
- External Corkdiff session ownership is per thread and lives in Electron main, not the renderer.
- `Ctrl+D` in desktop opens or focuses external Corkdiff for the active thread. `Ctrl+D` inside Corkdiff returns focus to T3 Code without closing Ghostty.
- When changing this flow, inspect both this repo and the local `corkdiff.nvim` checkout because its Neovim plugin participates in the control path.

# btca MCP Usage Instructions

Use btca whenever a task depends on understanding an external repository, documentation site, or configured resource more accurately than a generic model can.

Use it whenever the user says "use btca", or when you need information that should come from the listed resources. Do not use it to understand this repository; inspect this repository locally.

## Tools

The btca MCP server provides these tools:

- `listResources` - List all available documentation resources.
- `ask` - Ask a question about specific resources.

## Resources

Resources are defined by the end user in their btca dashboard. If a required resource is unavailable from `listResources`, proceed without btca and clearly note the missing access.

## Critical Workflow

**Always call `listResources` first** before using `ask`. The `ask` tool requires exact resource names from the list.

1. Call `listResources`.
2. Use the exact returned resource `name` values.
3. Call `ask` with the question and those exact resource names.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `bun run sync:repos`; use `bun run sync:repos --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.

### Thoroughly

Let's be clear, I'm so so so so annoyed by goddamn issues that come up when I open the app and try to use it. Something like agent didn't implement the feature completely when I asked it to do something, or ui feature doesn't work because it decided not to test it. Unnacceptable. Almost always do that. In plan mode you can ask if this needs to be done but otherwise unless I ask not to do proper checks.
The checks include:

- Running `codex review` after changes to get feedback
- creating tests, in some cases e2e tests to verify the feature
