# Fix local Electron sandbox startup

Keep the preload compatible with Electron's sandboxed renderer and preserve the standard Nix Electron launcher so local Wayland startup uses the packaged Chromium sandbox correctly.
