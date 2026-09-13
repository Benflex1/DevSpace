import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  codexAppServerFixtureManifestSchema,
} from "@devspace/contracts";
import { loadCodexSchemaBundle } from "./schema-bundle.js";
import type { CodexSchemaBundle } from "./types.js";
import {
  evaluateCodexCompatibility,
  schemaSatisfiesPredicate,
  type SchemaPredicate
} from "./schema-compatibility.js";

const fixtureFiles = [
  "stable/ClientRequest.json",
  "stable/ClientNotification.json",
  "stable/ServerRequest.json",
  "stable/ServerNotification.json",
  "experimental/ToolRequestUserInputParams.json"
] as const;

async function loadFixture(version: "0.145.0" | "0.153.4"): Promise<{
  readonly manifest: ReturnType<typeof codexAppServerFixtureManifestSchema.parse>;
  readonly bundle: CodexSchemaBundle;
}> {
  const root = new URL(`../../../../packages/contracts/fixtures/codex-app-server/${version}/`, import.meta.url);
  const manifest = codexAppServerFixtureManifestSchema.parse(JSON.parse(
    await readFile(new URL("protocol-manifest.json", root), "utf8")
  ));
  const entries = await Promise.all(fixtureFiles.map(async (file) => {
    const fixture = manifest.fixtures.find((candidate) => candidate.file === file);
    if (fixture === undefined) throw new Error(`fixture-missing:${version}:${file}`);
    const bytes = await readFile(new URL(file, root));
    expect(bytes.byteLength, `${version}:${file}`).toBe(fixture.bytes);
    expect(createHash("sha256").update(bytes).digest("hex"), `${version}:${file}`).toBe(fixture.sha256);
    return [file, bytes] as const;
  }));
  return { manifest, bundle: loadCodexSchemaBundle(new Map(entries)) };
}

function bundle(files: Record<string, unknown>): CodexSchemaBundle {
  return loadCodexSchemaBundle(new Map(Object.entries(files).map(([file, value]) => [
    file,
    Buffer.from(JSON.stringify(value))
  ])));
}

describe("Codex compatibility fixture matrix", () => {
  test("admits the 0.145 baseline and the captured newer 0.153.4 fixture", async () => {
    for (const version of ["0.145.0", "0.153.4"] as const) {
      const result = evaluateCodexCompatibility((await loadFixture(version)).bundle);
      expect(result.transport, version).toBe("compatible");
      expect(result.features.basicSession, version).toMatchObject({ state: "supported" });
      expect(result.features.approvals, version).toMatchObject({ state: "supported" });
    }
  });

  test("records the newer fixture as compatibility evidence rather than an executable allowlist", async () => {
    const { manifest } = await loadFixture("0.153.4");
    expect(manifest.cliVersion).toBe("0.153.4");
    expect(manifest.cliBinarySha256).toBeUndefined();
    expect(manifest.baselineVersion).toBe("0.145.0");
  });

  test("tolerates additive object properties and enum members", () => {
    const objectPredicate: SchemaPredicate = {
      kind: "object",
      required: { required: { kind: "type", types: ["string"] } },
      optional: { optional: { kind: "type", types: ["string"] } },
      additionalProperties: "tolerate"
    };
    expect(schemaSatisfiesPredicate({
      type: "object",
      required: ["required"],
      properties: { required: { type: "string" }, additive: { type: "number" } },
      additionalProperties: true
    }, objectPredicate)).toBe(true);
    expect(schemaSatisfiesPredicate({ type: "string", enum: ["known", "newer"] }, {
      kind: "enum", requiredValues: ["known"], allowAdditionalValues: true
    })).toBe(true);
  });

  test("fails closed when a required basic-session method is absent", () => {
    const result = evaluateCodexCompatibility(bundle({
      "stable/ClientRequest.json": {
        oneOf: [{ type: "object", properties: { method: { enum: ["initialize", "thread/start"] } } }]
      },
      "stable/ClientNotification.json": {
        type: "object", properties: { method: { enum: ["initialized"] } }
      },
      "stable/ServerNotification.json": {
        type: "object", properties: { method: { enum: ["thread/started", "turn/started", "item/agentMessage/delta", "turn/completed"] } }
      },
      "stable/ServerRequest.json": {
        type: "object", properties: { method: { enum: ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "serverRequest/resolved"] } }
      }
    }));
    expect(result.transport).toBe("incompatible");
    expect(result.diagnostic).toBe("CODEX_PROTOCOL_INCOMPATIBLE");
    expect(result.capabilities.approvals).toBe(false);
  });

  test("degrades structured input when its experimental schema is absent", async () => {
    const loaded = await loadFixture("0.145.0");
    const files = new Map<string, Uint8Array>();
    for (const [file, schema] of loaded.bundle.stable) files.set(file, Buffer.from(JSON.stringify(schema)));
    const result = evaluateCodexCompatibility(loadCodexSchemaBundle(files));
    expect(result.transport).toBe("compatible");
    expect(result.features.basicSession.state).toBe("supported");
    expect(result.features.approvals.state).toBe("supported");
    expect(result.features.structuredInput.state).toBe("missing");
    expect(result.capabilities.structuredInput).toBe(false);
  });

  test("rejects malformed, unresolved, and cyclic schema evidence", () => {
    expect(() => bundle({
      "stable/ClientRequest.json": { type: "object", properties: { value: { $ref: "https://provider.invalid/schema.json" } } }
    })).toThrow("external-reference");
    expect(() => bundle({
      "stable/ClientRequest.json": {
        type: "object", definitions: { Loop: { $ref: "#/definitions/Loop" } },
        properties: { value: { $ref: "#/definitions/Loop" } }
      }
    })).toThrow("reference-cycle");
  });
});
