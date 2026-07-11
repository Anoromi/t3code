# Web restore Hyprnav settings and runtime sync

Expose Hyprnav in Settings and project/group context menus, with editable scoped bindings, validation, inheritance, grouped-project behavior, reset/save flows, and explicit runtime status.

Settings persist before best-effort desktop publication. Primary-local active threads synchronize and lock their Hyprnav environments, retry transient failures, and leave remote/browser projects unchanged. Browser and unit tests cover editing, validation, persistence, runtime publication, and unavailable-runtime warnings.
