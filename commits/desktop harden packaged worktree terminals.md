# Desktop harden packaged worktree terminals

Bundle the worktree helper as CommonJS and execute it through packaged Electron's Node mode, removing the global Bun dependency.

Serialize cross-process registry operations with owner-token locks, recover stale locks and live windows, quarantine malformed state, and persist registry updates through fsync plus atomic rename.
