import * as NFS from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { FileSystem, Schema } from "effect";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { readBootstrapEnvelope, resolveFdPath } from "./bootstrap";
import { assertNone, assertSome } from "@effect/vitest/utils";

const TestEnvelopeSchema = Schema.Struct({ mode: Schema.String });

it.layer(NodeServices.layer)("readBootstrapEnvelope", (it) => {
  it.effect("uses platform-specific fd paths", () =>
    Effect.sync(() => {
      assert.equal(resolveFdPath(3, "linux"), "/proc/self/fd/3");
      assert.equal(resolveFdPath(3, "darwin"), "/dev/fd/3");
      assert.equal(resolveFdPath(3, "win32"), undefined);
    }),
  );

  it.effect("reads a bootstrap envelope from a provided fd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });

      yield* fs.writeFileString(
        filePath,
        `${yield* Schema.encodeEffect(Schema.fromJsonString(TestEnvelopeSchema))({
          mode: "desktop",
        })}\n`,
      );

      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NFS.openSync(filePath, "r")),
        (fd) => Effect.sync(() => NFS.closeSync(fd)),
      );

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, { timeoutMs: 100 });
      assertSome(payload, {
        mode: "desktop",
      });
    }),
  );

  it.effect("reads a bootstrap envelope from an inherited pipe fd", () =>
    Effect.gen(function* () {
      const scriptPath = path.join(process.cwd(), `tmp-bootstrap-child-${crypto.randomUUID()}.ts`);
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          NFS.writeFileSync(
            scriptPath,
            [
              'import * as Effect from "effect/Effect";',
              'import * as Option from "effect/Option";',
              'import { Schema } from "effect";',
              'import { readBootstrapEnvelope } from "./src/bootstrap.ts";',
              "const result = await Effect.runPromise(",
              "  readBootstrapEnvelope(Schema.Struct({ mode: Schema.String }), 3, { timeoutMs: 1000 }),",
              ");",
              "console.log(JSON.stringify(Option.isSome(result) ? result.value : null));",
              "",
            ].join("\n"),
            "utf8",
          ),
        ),
        () => Effect.sync(() => NFS.rmSync(scriptPath, { force: true })),
      );

      const result = yield* Effect.promise<string>(
        () =>
          new Promise((resolve, reject) => {
            const child = spawn("bun", ["run", scriptPath], {
              cwd: process.cwd(),
              stdio: ["ignore", "pipe", "inherit", "pipe"],
            });
            const stdout = child.stdout;
            const bootstrapInput = child.stdio[3];

            if (!stdout || !bootstrapInput || !("write" in bootstrapInput)) {
              reject(new Error("child process bootstrap streams were not available"));
              return;
            }

            let stdoutText = "";
            stdout.on("data", (chunk) => {
              stdoutText += chunk.toString();
            });
            child.once("error", reject);
            child.once("exit", (code) => {
              if (code === 0) {
                resolve(stdoutText.trim());
                return;
              }
              reject(new Error(`child exited with code ${code ?? "null"}`));
            });

            bootstrapInput.write('{"mode":"desktop"}\n');
            bootstrapInput.end();
          }),
      );

      assert.deepStrictEqual(JSON.parse(result), {
        mode: "desktop",
      });
    }),
  );

  it.effect("returns none when the fd is unavailable", () =>
    Effect.gen(function* () {
      const fd = NFS.openSync("/dev/null", "r");
      NFS.closeSync(fd);

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, { timeoutMs: 100 });
      assertNone(payload);
    }),
  );

  it.effect("returns none when the bootstrap read times out before any value arrives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bootstrap-" });
      const fifoPath = path.join(tempDir, "bootstrap.pipe");

      yield* Effect.sync(() => execFileSync("mkfifo", [fifoPath]));

      const _writer = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawn("sh", ["-c", 'exec 3>"$1"; sleep 60', "sh", fifoPath], {
            stdio: ["ignore", "ignore", "ignore"],
          }),
        ),
        (writer) =>
          Effect.sync(() => {
            writer.kill("SIGKILL");
          }),
      );

      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NFS.openSync(fifoPath, "r")),
        (fd) => Effect.sync(() => NFS.closeSync(fd)),
      );

      const fiber = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
        timeoutMs: 100,
      }).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(100));

      const payload = yield* Fiber.join(fiber);
      assertNone(payload);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
