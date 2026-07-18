# Desktop use portable kernel recovery mutex

Replace the external `flock` dependency with a Linux abstract Unix-socket mutex for stale registry recovery.

Kernel binding is atomic, releases on process death, and leaves no filesystem artifact across Nix and generic Linux packages.
