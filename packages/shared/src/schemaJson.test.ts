import { Cause, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decodeJsonResult, decodeUnknownJsonResult, formatSchemaError, fromLenientJson } from "./schemaJson";

describe("decodeJsonResult", () => {
  it("decodes valid JSON strings against the provided schema", () => {
    const decode = decodeJsonResult(Schema.Struct({ name: Schema.String, count: Schema.Number }));
    const result = decode('{"name":"jibberish","count":2}');

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) {
      throw new Error("Expected decodeJsonResult to succeed");
    }

    expect(result.value).toEqual({ name: "jibberish", count: 2 });
  });

  it("returns a schema failure result for invalid JSON payloads", () => {
    const decode = decodeJsonResult(Schema.Struct({ count: Schema.Number }));
    const result = decode('{"count":"two"}');

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) {
      throw new Error("Expected decodeJsonResult to fail");
    }

    expect(formatSchemaError(result.cause)).toContain("Expected number");
  });
});

describe("decodeUnknownJsonResult", () => {
  it("decodes unknown input when it is a valid JSON string", () => {
    const decode = decodeUnknownJsonResult(Schema.Struct({ enabled: Schema.Boolean }));
    const result = decode('{"enabled":true}');

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) {
      throw new Error("Expected decodeUnknownJsonResult to succeed");
    }

    expect(result.value).toEqual({ enabled: true });
  });
});

describe("fromLenientJson", () => {
  it("accepts comments and trailing commas", () => {
    const decode = Schema.decodeUnknownSync(
      fromLenientJson(Schema.Struct({ count: Schema.Number, label: Schema.String })),
    );

    expect(
      decode(`{
        // keep this human-editable
        "count": 2,
        "label": "jibberish",
      }`),
    ).toEqual({ count: 2, label: "jibberish" });
  });

  it("preserves comment-like text inside string literals", () => {
    const decode = Schema.decodeUnknownSync(fromLenientJson(Schema.Struct({ text: Schema.String })));

    expect(
      decode(`{
        "text": "keep // this and /* that */ literally",
      }`),
    ).toEqual({ text: "keep // this and /* that */ literally" });
  });

  it("formats schema parse errors for invalid lenient JSON", () => {
    const decode = Schema.decodeUnknownEither(fromLenientJson(Schema.Struct({ count: Schema.Number })));
    const result = decode("{ count: 1 }");

    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") {
      throw new Error("Expected invalid lenient JSON to fail");
    }

    const cause = Cause.fail(result.left);
    expect(formatSchemaError(cause)).toContain("SyntaxError");
  });
});
