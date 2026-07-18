# Desktop use kernel registry recovery locks

Use util-linux `flock` to serialize stale registry-lock recovery without filesystem election races.

Kernel ownership releases automatically after crashes, while normal registry transactions retain atomic directory acquisition.
