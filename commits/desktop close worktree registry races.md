# Desktop close worktree registry races

Require an exclusive recovery claim plus matching owner token and filesystem identity before removing a stale worktree-terminal lock, preventing delayed contenders from deleting a replacement lock.

Propagate filesystem read failures and quarantine only malformed registry content so transient I/O errors cannot silently discard live assignments.
