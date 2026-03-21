import { resolveCatalogDependencies } from "./resolve-catalog.ts";

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, unknown> | undefined,
  catalog: Record<string, unknown>,
): Record<string, unknown> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(([dependencyName]) => dependencyName !== "electron"),
  );

  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}
