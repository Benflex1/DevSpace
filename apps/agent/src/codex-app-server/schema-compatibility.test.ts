import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  loadCodexSchemaBundle,
  type CodexSchemaBundle
} from "./schema-bundle.js";
import {
  evaluateCodexCompatibility,
  schemaSatisfiesPredicate,
  type SchemaPredicate
} from "./schema-compatibility.js";

const fixtureRoot = new URL(
  "../../../../packages/contracts/fixtures/codex-app-server/0.145.0/",
  import.meta.url
);

async function loadBaselineBundle(): Promise<CodexSchemaBundle> {
  const files = [
    "stable/ClientRequest.json",
    "stable/ClientNotification.json",
    "stable/ServerNotification.json",
    "stable/ServerRequest.json",
    "experimental/ToolRequestUserInputParams.json"
  ];
  const entries = await Promise.all(files.map(async (file) => [
    file,
    await readFile(new URL(file, fixtureRoot))
  ] as const));
  return loadCodexSchemaBundle(new Map(entries));
}

function schemaBundle(files: Record<string, unknown>): CodexSchemaBundle {
  return loadCodexSchemaBundle(new Map(Object.entries(files).map(([name, value]) => [
    name,
    Buffer.from(JSON.stringify(value))
  ])));
}

describe("Codex structural compatibility evaluator", () => {
  test("admits the exact 0.145 baseline with required approvals", async () => {
    const result = evaluateCodexCompatibility(await loadBaselineBundle());

    expect(result.transport).toBe("compatible");
    expect(result.features.basicSession.state).toBe("supported");
    expect(result.features.approvals.state).toBe("supported");
    expect(result.features.structuredInput.state).toBe("supported");
    expect(result.capabilities.approvals).toBe(true);
  });

  test("tolerates additive object fields and enum members while preserving required predicates", () => {
    const objectPredicate: SchemaPredicate = {
      kind: "object",
      required: { required: { kind: "type", types: ["string"] } },
      optional: { optional: { kind: "type", types: ["string"] } },
      additionalProperties: "tolerate"
    };
    expect(schemaSatisfiesPredicate({
      type: "object",
      required: ["required"],
      properties: {
        required: { type: "string" },
        newOptional: { type: "string" }
      },
      additionalProperties: true
    }, objectPredicate)).toBe(true);

    const enumPredicate: SchemaPredicate = {
      kind: "enum",
      requiredValues: ["known"],
      allowAdditionalValues: true
    };
    expect(schemaSatisfiesPredicate({
      type: "string",
      enum: ["known", "newer"]
    }, enumPredicate)).toBe(true);
  });

  test("rejects unresolved external references and reference cycles", () => {
    expect(() => schemaBundle({
      "stable/ClientRequest.json": {
        type: "object",
        properties: { value: { $ref: "https://provider.invalid/schema.json" } }
      }
    })).toThrow("external-reference");

    expect(() => schemaBundle({
      "stable/ClientRequest.json": {
        type: "object",
        definitions: { Loop: { $ref: "#/definitions/Loop" } },
        properties: { value: { $ref: "#/definitions/Loop" } }
      }
    })).toThrow("reference-cycle");
  });

  test("fails the writable profile when approval semantics are missing", () => {
    const result = evaluateCodexCompatibility(schemaBundle({
      "stable/ClientRequest.json": {
        oneOf: [{
          type: "object",
          properties: { method: { enum: ["initialize", "thread/start", "turn/start"] } }
        }]
      },
      "stable/ClientNotification.json": {
        type: "object",
        properties: { method: { enum: ["initialized"] } }
      },
      "stable/ServerNotification.json": {
        type: "object",
        properties: { method: { enum: ["thread/started", "turn/started", "item/agentMessage/delta", "turn/completed"] } }
      },
      "stable/ServerRequest.json": {
        type: "object",
        properties: { method: { enum: [] } }
      }
    }));

    expect(result.features.approvals.state).toBe("incompatible");
    expect(result.diagnostic).toBe("CODEX_APPROVAL_PROTOCOL_UNAVAILABLE");
    expect(result.capabilities.approvals).toBe(false);
  });

  test("fingerprints bounded canonical schema evidence", async () => {
    const bundle = await loadBaselineBundle();
    expect(bundle.stableFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(bundle.experimentalFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(bundle.byteLength).toBeGreaterThan(0);
    expect(createHash("sha256").update(JSON.stringify([...bundle.stable])).digest("hex"))
      .not.toBe(bundle.stableFingerprint);
  });
});
