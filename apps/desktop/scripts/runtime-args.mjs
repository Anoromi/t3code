const VALID_DESKTOP_OZONE_PLATFORMS = new Set(["auto", "wayland", "x11"]);

export function resolveDesktopOzoneArgs(env = process.env) {
  if (process.platform !== "linux") {
    return [];
  }

  const ozonePlatform = env.T3CODE_DESKTOP_OZONE_PLATFORM?.trim().toLowerCase();
  if (!ozonePlatform || !VALID_DESKTOP_OZONE_PLATFORMS.has(ozonePlatform)) {
    return [];
  }

  return [
    "--enable-features=UseOzonePlatform",
    ozonePlatform === "auto" ? "--ozone-platform-hint=auto" : `--ozone-platform=${ozonePlatform}`,
  ];
}

export function isDesktopProfileEnabled(env = process.env) {
  const value = env.T3CODE_DESKTOP_PROFILE?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function resolveDesktopProfileArgs(env = process.env) {
  if (!isDesktopProfileEnabled(env)) {
    return [];
  }

  return ["--enable-precise-memory-info"];
}
