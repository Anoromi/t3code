import { ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { findClientAddressForClass, make } from "./DesktopFocus.ts";

describe("DesktopFocus", () => {
  it("finds the desktop by current or initial WM class", () => {
    expect(
      findClientAddressForClass([{ address: "0xabc", initialClass: "t3code" }], "t3code"),
    ).toBe("0xabc");
  });

  it.effect("focuses the matching Hyprland client with direct argv", () => {
    const run = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(JSON.stringify([{ address: "0xabc", class: "t3code" }])))
      .mockReturnValueOnce(Effect.succeed(""));
    const focus = make(run, () => "t3code");

    return Effect.gen(function* () {
      yield* focus.focusForCorkdiff(ThreadId.make("thread-1"));
      expect(run).toHaveBeenNthCalledWith(1, ["-j", "clients"]);
      expect(run).toHaveBeenNthCalledWith(2, ["dispatch", "focuswindow", "address:0xabc"]);
    });
  });
});
