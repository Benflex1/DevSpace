import { describe, expect, test } from "vitest";
import {
  agentApiV1EndpointByOperation,
  extractDevSpaceProtocolHeaders
} from "@devspace/contracts";

const id = "018f1f34-7abc-7def-8abc-0123456789ab";
const id2 = "018f1f34-7abc-7def-9abc-0123456789ac";
const timestamp = "2026-07-15T12:34:56.789Z";
const ordinaryHeaders = [
  ["Host", "agent.internal"],
  ["Content-Type", "application/json; charset=utf-8"],
  ["Accept", "application/json"],
  ["traceparent", "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"],
  ["CF-Ray", "abc123-AMS"]
] as const;
const commonHeaders = [
  ["x-devspace-protocol-version", "1"],
  ["X-DEVSPACE-REQUEST-ID", id],
  ["X-DevSpace-Sent-At", timestamp]
] as const;

function projection(headers: readonly (readonly [string, string])[]) {
  const result = extractDevSpaceProtocolHeaders(headers);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected valid DevSpace header projection");
  return result.headers;
}

describe("DevSpace protocol-header projection", () => {
  test("ignores ordinary HTTP headers and validates a mutation operation ID", () => {
    const headers = projection([...ordinaryHeaders, ...commonHeaders, ["x-devspace-operation-id", id2]]);
    expect(agentApiV1EndpointByOperation["workspace.start"].headersSchema.safeParse(headers).success).toBe(true);
  });

  test("ignores ordinary headers for a read", () => {
    const headers = projection([...ordinaryHeaders, ...commonHeaders]);
    expect(agentApiV1EndpointByOperation["agent.health.get"].headersSchema.safeParse(headers).success).toBe(true);
  });

  test("ignores standard WebSocket upgrade headers", () => {
    const headers = projection([
      ...ordinaryHeaders,
      ["Connection", "Upgrade"],
      ["Upgrade", "websocket"],
      ["Sec-WebSocket-Version", "13"],
      ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
      ["Sec-WebSocket-Protocol", "devspace.terminal.v1"],
      ...commonHeaders
    ]);
    expect(agentApiV1EndpointByOperation["terminal.stream"].headersSchema.safeParse(headers).success).toBe(true);
  });

  test("rejects unknown DevSpace-owned headers", () => {
    expect(extractDevSpaceProtocolHeaders([
      ...commonHeaders, ["X-DevSpace-Request-Hash", "forbidden"]
    ])).toEqual({
      ok: false,
      error: { code: "UNKNOWN_DEVSPACE_HEADER", header: "X-DevSpace-Request-Hash" }
    });
  });

  test("rejects missing and prohibited operation IDs by endpoint classification", () => {
    const withoutOperation = projection(commonHeaders);
    expect(agentApiV1EndpointByOperation["workspace.start"].headersSchema.safeParse(withoutOperation).success).toBe(false);
    const withOperation = projection([...commonHeaders, ["X-DevSpace-Operation-Id", id2]]);
    expect(agentApiV1EndpointByOperation["agent.health.get"].headersSchema.safeParse(withOperation).success).toBe(false);
  });

  test("rejects duplicate and ambiguous operation-ID values case-insensitively", () => {
    expect(extractDevSpaceProtocolHeaders([
      ...commonHeaders,
      ["X-DevSpace-Operation-Id", id],
      ["x-devspace-operation-id", id2]
    ])).toEqual({
      ok: false,
      error: { code: "DUPLICATE_DEVSPACE_HEADER", header: "X-DevSpace-Operation-Id" }
    });
    expect(extractDevSpaceProtocolHeaders({
      "X-DevSpace-Operation-Id": [id, id2]
    })).toEqual({
      ok: false,
      error: { code: "DUPLICATE_DEVSPACE_HEADER", header: "X-DevSpace-Operation-Id" }
    });
  });
});
