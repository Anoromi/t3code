# test: configure desktop Playwright E2E harness

## Goal

Add a local Electron Playwright E2E harness that can exercise desktop flows against a deterministic server/provider runtime without depending on a real Codex installation or Hyprland/Ghostty process state.

## Implementation Summary

- Adds desktop Playwright configuration, package scripts, and Vitest exclusions so Playwright specs live under `apps/desktop/e2e` while unit tests continue to run through Vitest.
- Adds a fake Codex provider mode behind `T3CODE_E2E_FAKE_PROVIDER=1`, including deterministic provider snapshots and session/turn runtime events.
- Adds desktop E2E runtime helpers for backend child env sanitization, E2E backend cwd overrides, and E2E log forwarding.
- Adds a shared Electron Playwright fixture that creates isolated git repositories, launches the built desktop app, optionally installs fake external executables, captures process invocations, and cleans up temporary repositories/worktrees.

## Reimplementation Notes

- The harness is local-only and intentionally does not add CI stack validation.
- `T3CODE_E2E_BACKEND_CWD` is honored only when fake provider mode is enabled.
- Desktop-injected backend env vars are stripped before backend launch so the child server starts with a clean app-server environment.

## Expected Behavior

- `bun run test:desktop-playwright` runs Electron Playwright specs from `apps/desktop/e2e`.
- Desktop E2E launches can create isolated git worktree state and receive deterministic provider responses.
- Fake `ghostty`, `hyprctl`, and `hyprnav` executables can be injected by tests to verify desktop-owned external tool control paths without launching real external tools.
