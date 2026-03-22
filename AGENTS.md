# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
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

## Rebase Work

- When resolving rebase conflicts or post-rebase regressions in this repo, use the project skill `$t3code-rebase-conflict-resolution` from `.codex/skills/t3code-rebase-conflict-resolution`.
- Follow that skill before declaring the rebase done. In particular, inspect upstream replacements first, audit migrations/events/projections/settings compatibility, and validate against real persisted state when the rebase touches startup or persistence.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

# btca MCP Usage Instructions

Use btca whenever a task depends on understanding a repo, docs site, or configured resource
more accurately than a generic model can.

Use it whenever the user says "use btca", or when you need info that should come from the listed resources.

## Tools

The btca MCP server provides these tools:

- `listResources` - List all available documentation resources
- `ask` - Ask a question about specific resources

## resources

The resources available are defined by the end user in their btca dashboard. If there's a resource you need but it's not available in `listResources`, proceed without btca. When your task is done, clearly note that you'd like access to the missing resource.

## Critical Workflow

**Always call `listResources` first** before using `ask`. The `ask` tool requires exact resource names from the list.

### Example

1. Call listResources to get available resources
2. Note the "name" field for each resource (e.g., "svelteKit", not "SvelteKit" or "svelte-kit")
3. Call ask with:
   - question: "How do I create a load function?"
   - resources: ["svelteKit"]
