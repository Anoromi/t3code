import { Schema } from "effect";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.js";

export const DesktopDaemonStatus = Schema.Literals(["starting", "ready"]);
export type DesktopDaemonStatus = typeof DesktopDaemonStatus.Type;

export const DesktopDaemonRecord = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("desktop"),
  instanceId: TrimmedNonEmptyString,
  pid: PositiveInt,
  startedAt: IsoDateTime,
  baseDir: TrimmedNonEmptyString,
  stateDir: TrimmedNonEmptyString,
  wsUrl: TrimmedNonEmptyString,
  authToken: TrimmedNonEmptyString,
  controlEndpoint: TrimmedNonEmptyString,
  status: DesktopDaemonStatus,
});
export type DesktopDaemonRecord = typeof DesktopDaemonRecord.Type;

export const DesktopDaemonControlRequest = Schema.Struct({
  type: Schema.Literal("focus"),
});
export type DesktopDaemonControlRequest = typeof DesktopDaemonControlRequest.Type;

export const DesktopDaemonControlResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: TrimmedNonEmptyString,
  }),
]);
export type DesktopDaemonControlResponse = typeof DesktopDaemonControlResponse.Type;
