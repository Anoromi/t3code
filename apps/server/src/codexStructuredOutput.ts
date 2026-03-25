import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const DEFAULT_CODEX_REASONING_EFFORT = "low";
export const DEFAULT_CODEX_TIMEOUT_MS = 180_000;

function toCodexOutputJsonSchema(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return {
      ...document.schema,
      $defs: document.definitions,
    };
  }
  return document.schema;
}

export function runCodexStructuredOutput<S extends Schema.Top, E>(input: {
  operation: string;
  cwd: string;
  prompt: string;
  outputSchema: S;
  imagePaths?: ReadonlyArray<string>;
  cleanupPaths?: ReadonlyArray<string>;
  model: string;
  timeoutMs?: number;
  reasoningEffort?: string;
  createError: (detail: string, cause?: unknown) => E;
}): Effect.Effect<
  S["Type"],
  E,
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | S["DecodingServices"]
> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  const reasoningEffort = input.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;

  const readStreamAsString = <Cause>(
    stream: Stream.Stream<Uint8Array, Cause>,
  ): Effect.Effect<string, E> =>
    Stream.runFold(
      stream,
      () => "",
      (text, chunk) => text + Buffer.from(chunk).toString("utf8"),
    ).pipe(
      Effect.mapError((cause) => input.createError("Failed to collect process output", cause)),
    );

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

    const writeTempFile = (prefix: string, content: string): Effect.Effect<string, E> => {
      const filePath = path.join(tempDir, `t3code-${prefix}-${process.pid}-${randomUUID()}.tmp`);
      return fileSystem.writeFileString(filePath, content).pipe(
        Effect.mapError((cause) =>
          input.createError(`Failed to write temp file at ${filePath}.`, cause),
        ),
        Effect.as(filePath),
      );
    };

    const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
      fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

    const schemaPath = yield* writeTempFile(
      `${input.operation}-schema`,
      JSON.stringify(toCodexOutputJsonSchema(input.outputSchema)),
    );
    const outputPath = yield* writeTempFile(`${input.operation}-output`, "");

    const cleanup = Effect.all(
      [schemaPath, outputPath, ...(input.cleanupPaths ?? [])].map((filePath) =>
        safeUnlink(filePath),
      ),
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.asVoid);

    const runCodexCommand = Effect.gen(function* () {
      const command = ChildProcess.make(
        "codex",
        [
          "exec",
          "--ephemeral",
          "-s",
          "read-only",
          "--model",
          input.model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...(input.imagePaths ?? []).flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        {
          cwd: input.cwd,
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.make(new TextEncoder().encode(input.prompt)),
          },
        },
      );

      const child = yield* commandSpawner.spawn(command).pipe(
        Effect.mapError((cause) => {
          const error = cause instanceof Error ? cause : null;
          const lower = error?.message.toLowerCase() ?? "";
          if (
            error?.message.includes("Command not found: codex") ||
            lower.includes("spawn codex") ||
            lower.includes("enoent")
          ) {
            return input.createError(
              "Codex CLI (`codex`) is required but not available on PATH.",
              cause,
            );
          }
          return input.createError("Failed to spawn Codex CLI process", cause);
        }),
      );

      const [stdout = "", stderr = "", exitCode] = yield* Effect.all(
        [
          readStreamAsString(child.stdout),
          readStreamAsString(child.stderr),
          child.exitCode.pipe(
            Effect.map((value) => Number(value)),
            Effect.mapError((cause) =>
              input.createError("Failed to read Codex CLI exit code", cause),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* Effect.fail(
          input.createError(
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
          ),
        );
      }
    });

    return yield* Effect.gen(function* () {
      yield* runCodexCommand.pipe(
        Effect.scoped,
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(input.createError("Codex CLI request timed out.")),
            onSome: () => Effect.void,
          }),
        ),
      );

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError((cause) => input.createError("Failed to read Codex output file.", cause)),
        Effect.flatMap((raw) =>
          Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(raw).pipe(
            Effect.mapError((cause) =>
              input.createError("Codex returned invalid structured output.", cause),
            ),
          ),
        ),
      );
    }).pipe(Effect.ensuring(cleanup));
  });
}
