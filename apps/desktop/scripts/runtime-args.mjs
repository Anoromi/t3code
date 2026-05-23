const VALID_DESKTOP_OZONE_PLATFORMS = new Set(["auto", "wayland", "x11"]);

function resolveConfiguredOzonePlatform(env) {
  const explicit = env.T3CODE_DESKTOP_OZONE_PLATFORM?.trim().toLowerCase();
  if (explicit) {
    return explicit;
  }

  const electronHint = env.ELECTRON_OZONE_PLATFORM_HINT?.trim().toLowerCase();
  if (electronHint) {
    return electronHint;
  }

  if (env.NIXOS_OZONE_WL === "1") {
    return "wayland";
  }

  return "";
}

export function resolveDesktopOzoneArgs(env = process.env) {
  if (process.platform !== "linux") {
    return [];
  }

  const ozonePlatform = resolveConfiguredOzonePlatform(env);
  if (!ozonePlatform || !VALID_DESKTOP_OZONE_PLATFORMS.has(ozonePlatform)) {
    return [];
  }

  return [
    "--enable-features=UseOzonePlatform",
    `--ozone-platform-hint=${ozonePlatform}`,
    ...(ozonePlatform === "auto" ? [] : [`--ozone-platform=${ozonePlatform}`]),
  ];
}

export function resolveDesktopOzoneEnv(env = process.env) {
  if (process.platform !== "linux") {
    return {};
  }

  const ozonePlatform = resolveConfiguredOzonePlatform(env);
  if (!ozonePlatform || !VALID_DESKTOP_OZONE_PLATFORMS.has(ozonePlatform)) {
    return {};
  }

  return {
    ELECTRON_OZONE_PLATFORM_HINT: ozonePlatform,
    ...(ozonePlatform === "wayland" ? { NIXOS_OZONE_WL: "1" } : {}),
  };
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
