import { describe, expect, test } from "vitest";
import {
  AGENT_EVENT_NDJSON_CONTENT_TYPE,
  agentEventNdjsonWireRules,
  agentEventSchema
} from "@devspace/contracts";

const bootId = "018f1f34-7000-7000-8000-000000000001";
const operationId = "018f1f34-7000-7000-8000-000000000002";
const event = {
  protocolVersion: 1,
  agentBootId: bootId,
  sequence: 1,
  cursor: `v1.${bootId}.1`,
  occurredAt: "2026-07-16T12:34:56.789Z",
  operationId,
  resource: null,
  type: "operation.progressed",
  payload: { message: "line one\\nline two" }
};

function committedEvents(bytes: Uint8Array): unknown[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\r")) throw new Error("CR is forbidden");
  const lines = text.split("\n");
  const terminated = lines.slice(0, -1);
  if (terminated.some((line) => line.length === 0)) throw new Error("Blank line is forbidden");
  return terminated.map((line) => agentEventSchema.parse(JSON.parse(line)));
}

describe("F10 NDJSON framing fixtures", () => {
  test("publishes the exact content type and framing metadata", () => {
    expect(AGENT_EVENT_NDJSON_CONTENT_TYPE).toBe("application/x-ndjson; charset=utf-8");
    expect(agentEventNdjsonWireRules).toMatchObject({
      json: "ordinary",
      encoding: "utf-8",
      delimiterByte: 0x0a,
      blankLinesAllowed: false,
      crlfAllowed: false,
      propertyOrderSignificant: false,
      unterminatedFinalJsonCommitted: false
    });
  });

  test("commits one complete ordinary JSON event only after LF", () => {
    const line = `${JSON.stringify(event)}\n`;
    expect(line).not.toContain("\r");
    expect(line).toContain("\\\\n");
    expect(committedEvents(new TextEncoder().encode(line))).toEqual([event]);
  });

  test("accepts insignificant single-line whitespace and property-order differences", () => {
    const reordered = {
      type: event.type,
      payload: event.payload,
      resource: event.resource,
      operationId: event.operationId,
      occurredAt: event.occurredAt,
      cursor: event.cursor,
      sequence: event.sequence,
      agentBootId: event.agentBootId,
      protocolVersion: event.protocolVersion
    };
    const line = ` ${JSON.stringify(reordered)} \n`;
    expect(committedEvents(new TextEncoder().encode(line))).toEqual([event]);
  });

  test("rejects blank lines and CRLF", () => {
    expect(() => committedEvents(new TextEncoder().encode(`${JSON.stringify(event)}\n\n`))).toThrow(
      "Blank line"
    );
    expect(() => committedEvents(new TextEncoder().encode(`${JSON.stringify(event)}\r\n`))).toThrow(
      "CR is forbidden"
    );
  });

  test("discards an unterminated final JSON text without advancing", () => {
    const committed = `${JSON.stringify(event)}\n`;
    const incomplete = JSON.stringify({ ...event, sequence: 2, cursor: `v1.${bootId}.2` });
    expect(committedEvents(new TextEncoder().encode(`${committed}${incomplete}`))).toEqual([event]);
    expect(committedEvents(new TextEncoder().encode(incomplete))).toEqual([]);
  });
});
