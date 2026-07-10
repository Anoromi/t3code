// @effect-diagnostics nodeBuiltinImport:off
import { DesktopCorkdiffFocusError, type ThreadId } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const MAX_HYPRCTL_OUTPUT_BYTES = 64 * 1024;
const HYPRCTL_TIMEOUT_MS = 2_000;

interface HyprClient {
  readonly address?: unknown;
  readonly class?: unknown;
  readonly initialClass?: unknown;
}

const HyprClientsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      address: Schema.optionalKey(Schema.Unknown),
      class: Schema.optionalKey(Schema.Unknown),
      initialClass: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const decodeHyprClientsJson = Schema.decodeUnknownEffect(HyprClientsJson);

export function findClientAddressForClass(
  clients: readonly HyprClient[],
  className: string,
): string | null {
  const client = clients.find(
    (candidate) => candidate.class === className || candidate.initialClass === className,
  );
  return typeof client?.address === "string" && client.address.trim().length > 0
    ? client.address
    : null;
}

export interface DesktopFocusService {
  readonly focusForCorkdiff: (threadId: ThreadId) => Effect.Effect<void, DesktopCorkdiffFocusError>;
}

type RunHyprctl = (args: readonly string[]) => Effect.Effect<string, DesktopCorkdiffFocusError>;

const runHyprctlLive: RunHyprctl = (args) =>
  Effect.callback<string, DesktopCorkdiffFocusError>((resume) => {
    const child = NodeChildProcess.execFile(
      "hyprctl",
      [...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_HYPRCTL_OUTPUT_BYTES,
        timeout: HYPRCTL_TIMEOUT_MS,
      },
      (cause, stdout, stderr) => {
        if (cause) {
          resume(
            Effect.fail(
              new DesktopCorkdiffFocusError({
                message: stderr.trim() || cause.message,
              }),
            ),
          );
          return;
        }
        resume(Effect.succeed(stdout));
      },
    );
    return Effect.sync(() => child.kill());
  });

export function make(
  runHyprctl: RunHyprctl,
  resolveClassName: () => string | undefined = () => process.env.T3CODE_DESKTOP_WM_CLASS,
): DesktopFocusService {
  const focusForCorkdiff = Effect.fn("desktopFocus.focusForCorkdiff")(function* (
    threadId: ThreadId,
  ) {
    yield* Effect.annotateCurrentSpan({ threadId });
    const className = resolveClassName()?.trim();
    if (!className) {
      return yield* new DesktopCorkdiffFocusError({
        message: "This server was not started by the T3 Code desktop app.",
      });
    }

    const clientsJson = yield* runHyprctl(["-j", "clients"]);
    const clients = yield* decodeHyprClientsJson(clientsJson).pipe(
      Effect.mapError(
        () => new DesktopCorkdiffFocusError({ message: "hyprctl returned invalid client data." }),
      ),
    );
    const address = findClientAddressForClass(clients, className);
    if (address === null) {
      return yield* new DesktopCorkdiffFocusError({
        message: "The T3 Code desktop window was not found in Hyprland.",
      });
    }
    yield* runHyprctl(["dispatch", "focuswindow", `address:${address}`]);
  });

  return { focusForCorkdiff };
}

export const live = make(runHyprctlLive);
