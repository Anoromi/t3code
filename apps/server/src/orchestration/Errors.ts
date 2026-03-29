import { SchemaIssue, Schema } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export class OrchestrationCommandJsonParseError extends Schema.TaggedErrorClass<OrchestrationCommandJsonParseError>()(
  "OrchestrationCommandJsonParseError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Invalid orchestration command JSON: ${this.detail}`;
  }
}

export class OrchestrationCommandDecodeError extends Schema.TaggedErrorClass<OrchestrationCommandDecodeError>()(
  "OrchestrationCommandDecodeError",
  {
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Invalid orchestration command payload: ${this.issue}`;
  }
}

export class OrchestrationCommandInvariantError extends Schema.TaggedErrorClass<OrchestrationCommandInvariantError>()(
  "OrchestrationCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Orchestration command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class OrchestrationCommandPreviouslyRejectedError extends Schema.TaggedErrorClass<OrchestrationCommandPreviouslyRejectedError>()(
  "OrchestrationCommandPreviouslyRejectedError",
  {
    commandId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Command previously rejected (${this.commandId}): ${this.detail}`;
  }
}

export class OrchestrationProjectorDecodeError extends Schema.TaggedErrorClass<OrchestrationProjectorDecodeError>()(
  "OrchestrationProjectorDecodeError",
  {
    eventType: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Projector decode failed for ${this.eventType}: ${this.issue}`;
  }
}

export class OrchestrationListenerCallbackError extends Schema.TaggedErrorClass<OrchestrationListenerCallbackError>()(
  "OrchestrationListenerCallbackError",
  {
    listener: Schema.Literals(["read-model", "domain-event"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Orchestration ${this.listener} listener failed: ${this.detail}`;
  }
}

export class WorktreeTitleGenerationError extends Schema.TaggedErrorClass<WorktreeTitleGenerationError>()(
  "WorktreeTitleGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Worktree title generation failed in ${this.operation}: ${this.detail}`;
  }
}

export type OrchestrationDispatchError =
  | ProjectionRepositoryError
  | OrchestrationCommandInvariantError
  | OrchestrationCommandPreviouslyRejectedError
  | OrchestrationProjectorDecodeError
  | OrchestrationListenerCallbackError;

export type OrchestrationEngineError =
  | OrchestrationDispatchError
  | OrchestrationCommandJsonParseError
  | OrchestrationCommandDecodeError;

function formatSchemaIssueOrCause(error: unknown, fallback: string): string {
  const formatIssue = SchemaIssue.makeFormatterDefault() as (issue: unknown) => string;
  if (
    typeof error === "object" &&
    error !== null &&
    "issue" in error &&
    error.issue !== undefined &&
    error.issue !== null
  ) {
    return formatIssue(error.issue);
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}

export function toOrchestrationCommandDecodeError(error: unknown) {
  return new OrchestrationCommandDecodeError({
    issue: formatSchemaIssueOrCause(error, "Failed to decode orchestration command payload."),
    cause: error,
  });
}

export function toProjectorDecodeError(eventType: string) {
  return (error: unknown): OrchestrationProjectorDecodeError =>
    new OrchestrationProjectorDecodeError({
      eventType,
      issue: formatSchemaIssueOrCause(
        error,
        `Failed to decode projector payload for ${eventType}.`,
      ),
      cause: error,
    });
}

export function toOrchestrationJsonParseError(cause: unknown) {
  return new OrchestrationCommandJsonParseError({
    detail: `Failed to parse orchestration command JSON`,
    cause,
  });
}

export function toListenerCallbackError(listener: "read-model" | "domain-event") {
  return (cause: unknown): OrchestrationListenerCallbackError =>
    new OrchestrationListenerCallbackError({
      listener,
      detail: `Failed to invoke orchestration ${listener} listener`,
      cause,
    });
}
