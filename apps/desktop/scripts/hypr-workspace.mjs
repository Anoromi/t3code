import { spawnSync } from "node:child_process";

const DEFAULT_MOVE_ATTEMPTS = 20;
const DEFAULT_MOVE_DELAY_MS = 100;
const REQUIRED_STABLE_POLLS = 3;

export function parseHyprWorkspaceEnv(env) {
  const rawWorkspace = env.T3CODE_HYPR_WORKSPACE?.trim();
  if (!rawWorkspace) {
    return null;
  }

  const workspace = Number(rawWorkspace);
  if (!Number.isInteger(workspace) || workspace <= 0) {
    console.warn(
      `[desktop] ignoring invalid T3CODE_HYPR_WORKSPACE='${rawWorkspace}'; expected a positive integer`,
    );
    return null;
  }

  return workspace;
}

function dispatchMoveToWorkspace(workspace, pid) {
  return spawnSync(
    "hyprctl",
    ["dispatch", "movetoworkspacesilent", `${String(workspace)},pid:${String(pid)}`],
    {
      stdio: "ignore",
    },
  );
}

function listClients() {
  const result = spawnSync("hyprctl", ["-j", "clients"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function moveClientAddressToWorkspace(workspace, address) {
  return spawnSync(
    "hyprctl",
    ["dispatch", "movetoworkspacesilent", `${String(workspace)},address:${address}`],
    {
      stdio: "ignore",
    },
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeMoveFailure(result) {
  if (result.error) {
    return String(result.error);
  }
  if (typeof result.status === "number") {
    return `status ${String(result.status)}`;
  }
  if (result.signal) {
    return `signal ${result.signal}`;
  }
  return "unknown failure";
}

export async function movePidToHyprWorkspace(input) {
  const {
    workspace,
    pid,
    attempts = DEFAULT_MOVE_ATTEMPTS,
    delayMs = DEFAULT_MOVE_DELAY_MS,
    dispatch = dispatchMoveToWorkspace,
    listClientsImpl = listClients,
    moveAddressImpl = moveClientAddressToWorkspace,
    sleepImpl = sleep,
    logWarn = (message) => {
      console.warn(message);
    },
  } = input;

  if (!Number.isInteger(workspace) || workspace <= 0) {
    throw new Error(`Invalid workspace '${String(workspace)}': expected a positive integer.`);
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  let lastFailureDescription = "unknown failure";
  let sawMatchingClient = false;
  let stablePolls = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const clients = listClientsImpl();
    const matchingClients =
      clients?.filter(
        (client) =>
          client &&
          typeof client === "object" &&
          client.pid === pid &&
          typeof client.address === "string" &&
          client.address.length > 0 &&
          typeof client.workspace?.id === "number",
      ) ?? [];

    if (matchingClients.length > 0) {
      sawMatchingClient = true;
      const clientsToMove = matchingClients.filter((client) => client.workspace.id !== workspace);
      if (clientsToMove.length === 0) {
        stablePolls += 1;
        if (stablePolls >= REQUIRED_STABLE_POLLS) {
          return true;
        }

        lastFailureDescription = "waiting for Electron windows to settle";
        if (attempt + 1 < attempts) {
          await sleepImpl(delayMs);
        }
        continue;
      }

      stablePolls = 0;
      let movedAnyClient = false;
      for (const client of clientsToMove) {
        const result = moveAddressImpl(workspace, client.address);
        if (!result.error && result.status === 0) {
          movedAnyClient = true;
          continue;
        }

        lastFailureDescription = describeMoveFailure(result);
      }

      if (movedAnyClient) {
        await sleepImpl(delayMs);
        continue;
      }
    }

    stablePolls = 0;
    const result = dispatch(workspace, pid);
    if (!result.error && result.status === 0) {
      lastFailureDescription = sawMatchingClient
        ? "additional Electron windows still pending"
        : "window move still pending";
      await sleepImpl(delayMs);
      continue;
    }

    lastFailureDescription = describeMoveFailure(result);
    if (attempt + 1 < attempts) {
      await sleepImpl(delayMs);
    }
  }

  logWarn(
    `[desktop] failed to move Electron pid ${String(pid)} to Hypr workspace ${String(workspace)} after ${String(attempts)} attempts (${lastFailureDescription})`,
  );
  return false;
}
