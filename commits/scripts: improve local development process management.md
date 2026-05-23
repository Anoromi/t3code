# scripts: improve local development process management

## Goal

Improve local development reliability with cleanup tooling and backend readiness checks.

## Included Changes

- Adds a script and tests for cleaning up local development processes.
- Improves dev backend proxy readiness behavior.
- Adds daemon readiness contract coverage used by development startup flows.

## Expected Behavior

Local development processes can be cleaned up predictably, and the web dev server waits on backend readiness more reliably before proxying requests.
