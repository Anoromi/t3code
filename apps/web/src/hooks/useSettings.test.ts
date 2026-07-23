import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  createClientSettingsPatchQueue,
  mergeEnvironmentSettings,
  persistIndependentSettingsPatches,
} from "./useSettings";

describe("persistIndependentSettingsPatches", () => {
  it("still persists client settings when the server update fails", async () => {
    const calls: string[] = [];
    await expect(
      persistIndependentSettingsPatches({
        persistServer: async () => {
          calls.push("server");
          throw new Error("server unavailable");
        },
        persistClient: async () => {
          calls.push("client");
        },
      }),
    ).rejects.toThrow("server unavailable");
    expect(calls).toEqual(["server", "client"]);
  });

  it("starts client persistence without waiting for the server write", async () => {
    let releaseServer: (() => void) | undefined;
    const server = new Promise<void>((resolve) => {
      releaseServer = resolve;
    });
    let clientStarted = false;
    const persistence = persistIndependentSettingsPatches({
      persistServer: () => server,
      persistClient: async () => {
        clientStarted = true;
      },
    });

    await Promise.resolve();
    expect(clientStarted).toBe(true);
    releaseServer?.();
    await expect(persistence).resolves.toBeUndefined();
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });
});

describe("createClientSettingsPatchQueue", () => {
  it("serializes writes, merges concurrent patches, and publishes only durable snapshots", async () => {
    let snapshot: ClientSettings = DEFAULT_CLIENT_SETTINGS;
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const persisted: ClientSettings[] = [];
    const persistPatch = createClientSettingsPatchQueue({
      read: () => snapshot,
      publish: (settings) => {
        snapshot = settings;
      },
      persist: async (settings) => {
        persisted.push(settings);
        if (persisted.length === 1) {
          await firstWriteBlocked;
        }
      },
    });

    const first = persistPatch({ confirmThreadArchive: true });
    await Promise.resolve();
    const second = persistPatch({ diffIgnoreWhitespace: false });

    expect(snapshot).toBe(DEFAULT_CLIENT_SETTINGS);
    expect(persisted).toHaveLength(1);

    releaseFirstWrite?.();
    await Promise.all([first, second]);

    expect(persisted).toHaveLength(2);
    expect(persisted[1]?.confirmThreadArchive).toBe(true);
    expect(persisted[1]?.diffIgnoreWhitespace).toBe(false);
    expect(snapshot.confirmThreadArchive).toBe(true);
    expect(snapshot.diffIgnoreWhitespace).toBe(false);
  });

  it("does not publish a settings patch when persistence fails", async () => {
    let snapshot: ClientSettings = DEFAULT_CLIENT_SETTINGS;
    const persistPatch = createClientSettingsPatchQueue({
      read: () => snapshot,
      publish: (settings) => {
        snapshot = settings;
      },
      persist: async () => {
        throw new Error("disk full");
      },
    });

    await expect(persistPatch({ defaultProjectHyprnavSettings: { bindings: [] } })).rejects.toThrow(
      "disk full",
    );
    expect(snapshot).toBe(DEFAULT_CLIENT_SETTINGS);
  });

  it("resolves functional updates against the preceding durable settings", async () => {
    let snapshot: ClientSettings = DEFAULT_CLIENT_SETTINGS;
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const persisted: ClientSettings[] = [];
    const persistPatch = createClientSettingsPatchQueue({
      read: () => snapshot,
      publish: (settings) => {
        snapshot = settings;
      },
      persist: async (settings) => {
        persisted.push(settings);
        if (persisted.length === 1) await firstWriteBlocked;
      },
    });

    const first = persistPatch((settings) => ({
      favorites: [
        ...settings.favorites,
        { provider: ProviderInstanceId.make("codex"), model: "a" },
      ],
    }));
    await Promise.resolve();
    const second = persistPatch((settings) => ({
      favorites: [
        ...settings.favorites,
        { provider: ProviderInstanceId.make("codex"), model: "b" },
      ],
    }));

    releaseFirstWrite?.();
    await Promise.all([first, second]);

    expect(persisted[1]?.favorites.map(({ model }) => model)).toEqual(["a", "b"]);
    expect(snapshot.favorites.map(({ model }) => model)).toEqual(["a", "b"]);
  });

  it("rebases later updates onto the last durable snapshot after a failure", async () => {
    let snapshot: ClientSettings = DEFAULT_CLIENT_SETTINGS;
    let writeCount = 0;
    const persisted: ClientSettings[] = [];
    const persistPatch = createClientSettingsPatchQueue({
      read: () => snapshot,
      publish: (settings) => {
        snapshot = settings;
      },
      persist: async (settings) => {
        writeCount += 1;
        if (writeCount === 1) throw new Error("disk full");
        persisted.push(settings);
      },
    });

    const failed = persistPatch((settings) => ({
      favorites: [
        ...settings.favorites,
        { provider: ProviderInstanceId.make("codex"), model: "failed" },
      ],
    }));
    const succeeding = persistPatch((settings) => ({
      favorites: [
        ...settings.favorites,
        { provider: ProviderInstanceId.make("codex"), model: "durable" },
      ],
    }));

    await expect(failed).rejects.toThrow("disk full");
    await expect(succeeding).resolves.toBeUndefined();
    expect(persisted[0]?.favorites.map(({ model }) => model)).toEqual(["durable"]);
    expect(snapshot.favorites.map(({ model }) => model)).toEqual(["durable"]);
  });
});
