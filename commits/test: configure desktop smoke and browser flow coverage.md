# test: configure desktop smoke and browser flow coverage

## Goal

Configure deterministic desktop smoke coverage while moving detailed desktop-style user flows into faster browser tests.

## Included Changes

- Adds Electron Playwright configuration and desktop E2E launch fixtures.
- Adds fake provider mode for deterministic desktop test state.
- Keeps one Electron smoke test for packaged launch, preload bridge, chat rendering, and thread selection.
- Supports browser coverage for worktree, navigation, terminal drawer, and external-tool intent flows.

## Expected Behavior

Desktop Playwright validates only the packaging/preload safety path, while browser tests cover the higher-volume UI flows without repeated Electron relaunches.
