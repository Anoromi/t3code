import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { NetService } from "@t3tools/shared/Net";
import { cli } from "./cli.ts";
import packageJson from "../package.json" with { type: "json" };

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const knownSubcommands = new Set(["start", "serve", "auth", "project"]);
const rawArgv = process.argv.slice(2);
const normalizedArgv =
  rawArgv.length === 0
    ? ["start"]
    : knownSubcommands.has(rawArgv[0] ?? "") ||
        rawArgv[0] === "--help" ||
        rawArgv[0] === "-h" ||
        rawArgv[0] === "--version" ||
        rawArgv[0] === "-v"
      ? rawArgv
      : rawArgv[0]?.startsWith("-")
        ? ["start", ...rawArgv]
        : ["start", ...rawArgv];

process.argv.splice(2, process.argv.length - 2, ...normalizedArgv);

Command.run(cli, { version: packageJson.version }).pipe(
  Effect.scoped,
  Effect.provide(CliRuntimeLayer),
  NodeRuntime.runMain,
);
