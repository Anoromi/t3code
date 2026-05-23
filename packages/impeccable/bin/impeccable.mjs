#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_SKILL_DIR = "/home/anoromi/.agents/skills/impeccable";
const skillDir = process.env.IMPECCABLE_SKILL_DIR || DEFAULT_SKILL_DIR;
const scriptsDir = join(skillDir, "scripts");

function scriptPath(name) {
  return join(scriptsDir, name);
}

function runScript(name, args = []) {
  const file = scriptPath(name);
  if (!existsSync(file)) {
    console.error(`Cannot find Impeccable script: ${file}`);
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

function printHelp() {
  console.log(`Usage: impeccable <command> [options]

Local T3 Code wrapper for the installed Impeccable skill.

Commands:
  live                  Prepare live visual iteration
  live resume [opts]    Resume an active live session
  live status           Print live server/session status
  live stop [opts]      Stop the live helper and remove injection
  poll [opts]           Poll or reply to live browser events
  resume [opts]         Alias for live resume
  status                Alias for live status

The npm impeccable package does not currently expose the live command; this
workspace wrapper keeps npx impeccable live on the documented skill path.`);
}

const [command, subcommand, ...rest] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h" || command === "help") {
  printHelp();
  process.exit(0);
}

if (command === "live") {
  if (!subcommand) {
    runScript("live.mjs");
  }

  if (subcommand === "resume") {
    runScript("live-resume.mjs", rest);
  }

  if (subcommand === "status") {
    runScript("live-status.mjs", rest);
  }

  if (subcommand === "stop") {
    runScript("live-server.mjs", ["stop", ...rest]);
  }

  if (subcommand === "poll") {
    runScript("live-poll.mjs", rest);
  }

  if (subcommand === "complete") {
    runScript("live-complete.mjs", rest);
  }

  console.error(`Unknown impeccable live command: ${subcommand}`);
  process.exit(1);
}

if (command === "poll") {
  runScript(
    "live-poll.mjs",
    [subcommand, ...rest].filter((arg) => arg !== undefined),
  );
}

if (command === "resume") {
  runScript(
    "live-resume.mjs",
    [subcommand, ...rest].filter((arg) => arg !== undefined),
  );
}

if (command === "status") {
  runScript(
    "live-status.mjs",
    [subcommand, ...rest].filter((arg) => arg !== undefined),
  );
}

console.error(
  `The local impeccable wrapper only supports live iteration commands. Unsupported command: ${command}`,
);
process.exit(1);
