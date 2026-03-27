---
name: t3code-rebase-conflict-resolution
description: Resolve rebase conflicts and post-rebase regressions in T3 Code. Use when rebasing onto upstream/main or another long-lived branch changes persistence, migrations, orchestration events, projection schemas, settings, sidebar structure, or desktop startup behavior, and the branch must be reconciled onto upstream implementations instead of reviving stale local code.
---

# T3code Rebase Conflict Resolution

Rebase T3 Code onto upstream behavior without breaking persisted state, desktop startup, or read-model-driven UI. Prefer upstream architectures when they already replaced the branch version.

## Workflow

1. Inspect the rebase surface before editing.
   Run `git diff --name-only --diff-filter=U`.
   Search for conflict markers with `rg -n '<<<<<<<|=======|>>>>>>>'`.
   Read the surrounding upstream implementation before choosing a side.

2. Rebase onto upstream implementations, not deleted local subsystems.
   If upstream replaced a module, route, settings store, or persistence shape, keep the upstream architecture and re-apply the branch feature onto it.
   Treat deleted files as suspect until you confirm they were not intentionally superseded.

3. Audit compatibility surfaces explicitly.
   Check migrations for numbering drift versus upstream.
   Check orchestration event types and payload shapes for legacy rows.
   Check projection tables and snapshot queries for mixed old/new schemas.
   Check settings and local storage migrations when web state models changed.
   Check sidebar or routing logic when upstream changed grouping, ordering, or thread/project shapes.

4. Preserve mixed-schema compatibility during the transition.
   Keep read paths tolerant of old persisted shapes.
   Keep write paths compatible with legacy not-null or still-present scalar columns until migrations are proven on real data.
   Normalize legacy event payloads during replay instead of assuming all rows were rewritten.

5. Validate on real state, not only clean fixtures.
   Run `bun fmt`, `bun lint`, and `bun typecheck`.
   Run focused `bun run test ...` regressions for every compatibility patch.
   If persistence or startup was touched, smoke boot the desktop app.
   If available, use an isolated copy of a real database snapshot rather than only an empty dev DB.

## T3 Code Hotspots

- `apps/server/src/persistence/Migrations.ts` and `apps/server/src/persistence/Migrations/`
- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/persistence/Layers/ProjectionProjects.ts`
- `apps/server/src/persistence/Layers/ProjectionThreads.ts`
- `apps/web/src/components/Sidebar.logic.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/routes/` and settings/model-selection hooks

## Decision Rules

- Do not treat a clean git index as proof that the rebase is finished.
- Do not renumber or reuse migrations without checking upstream IDs first.
- Do not assume production snapshots match the newest projection schema.
- Do not reintroduce old settings or state modules if upstream already replaced them.
- Do add regression tests immediately when a copied real database exposes a bug.
