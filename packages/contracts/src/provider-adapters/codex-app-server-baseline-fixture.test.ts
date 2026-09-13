import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  CODEX_BASELINE_CLI_VERSION,
  codexAppServerFixtureManifestSchema,
  codexAppServerProtocolMethods,
  type CodexAppServerPrivateLaunch
} from "./codex-app-server-baseline-fixture.js";

const fixtureRootUrl = new URL(
  "../../fixtures/codex-app-server/0.145.0/",
  import.meta.url
);

function collectMethodNames(value: unknown, methods = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectMethodNames(item, methods);
    return methods;
  }
  if (value === null || typeof value !== "object") return methods;
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  if (properties !== null && typeof properties === "object") {
    const method = (properties as Record<string, unknown>).method;
    if (method !== null && typeof method === "object") {
      const enumeration = (method as Record<string, unknown>).enum;
      if (Array.isArray(enumeration)) {
        for (const candidate of enumeration) {
          if (typeof candidate === "string") methods.add(candidate);
        }
      }
    }
  }
  for (const nested of Object.values(record)) collectMethodNames(nested, methods);
  return methods;
}

async function loadVerifiedFixtures() {
  const manifest = codexAppServerFixtureManifestSchema.parse(JSON.parse(
    await readFile(new URL("protocol-manifest.json", fixtureRootUrl), "utf8")
  ));
  const schemas = new Map<string, unknown>();
  for (const fixture of manifest.fixtures) {
    const bytes = await readFile(new URL(fixture.file, fixtureRootUrl));
    expect(bytes.byteLength, fixture.file).toBe(fixture.bytes);
    expect(createHash("sha256").update(bytes).digest("hex"), fixture.file)
      .toBe(fixture.sha256);
    schemas.set(fixture.file, JSON.parse(bytes.toString("utf8")) as unknown);
  }
  return { manifest, schemas };
}

describe("Codex app-server 0.145.0 adapter boundary", () => {
  test("hashes and parses every checked generated fixture", async () => {
    const { manifest, schemas } = await loadVerifiedFixtures();
    expect(manifest.cliVersion).toBe(CODEX_BASELINE_CLI_VERSION);
    expect([...schemas.keys()].sort()).toEqual([
      "experimental/ToolRequestUserInputParams.json",
      "stable/ClientNotification.json",
      "stable/ClientRequest.json",
      "stable/ServerNotification.json",
      "stable/ServerRequest.json"
    ]);
  });

  test("derives the exact required stable and experimental method inventory", async () => {
    const { manifest, schemas } = await loadVerifiedFixtures();
    const expected = codexAppServerProtocolMethods;
    expect(manifest.methods).toEqual(expected);

    const inventory = [
      ["stable/ClientRequest.json", expected.clientRequests],
      ["stable/ClientNotification.json", expected.clientNotifications],
      ["stable/ServerNotification.json", expected.serverNotifications],
      ["stable/ServerRequest.json", [
        ...expected.stableServerRequests,
        ...expected.experimentalServerRequests
      ]]
    ] as const;
    for (const [file, requiredMethods] of inventory) {
      const actualMethods = collectMethodNames(schemas.get(file));
      expect(requiredMethods.filter((method) => actualMethods.has(method)), file)
        .toEqual([...requiredMethods]);
    }

    const experimentalInput = schemas.get(
      "experimental/ToolRequestUserInputParams.json"
    ) as { readonly title?: unknown; readonly description?: unknown };
    expect(experimentalInput.title).toBe("ToolRequestUserInputParams");
    expect(experimentalInput.description).toMatch(/^EXPERIMENTAL\./u);
  });

  test("fixes non-TTY stdio and keeps structured input optional", async () => {
    const { manifest } = await loadVerifiedFixtures();
    expect(manifest.transport).toEqual({
      mode: "stdio-jsonl",
      tty: false,
      stdout: "protocol-only",
      stderr: "private-diagnostics"
    });
    expect(manifest.methods.experimentalServerRequests).toEqual([
      "item/tool/requestUserInput"
    ]);
  });

  test("makes every launch authority field Agent-private and fixed", () => {
    const launch: CodexAppServerPrivateLaunch = {
      executableIdentity: "deployment-profile-pinned-codex",
      cliVersion: "0.145.0",
      launchMode: "app-server-stdio",
      tty: false,
      workspaceDirectory: "/private/agent-derived/workspace",
      fixedArguments: ["app-server", "--stdio"],
      fixedEnvironment: {},
      credentialSourceHandle: "deployment-owned",
      experimentalApi: true
    };
    expect(launch.tty).toBe(false);
    expect(launch.experimentalApi).toBe(true);
  });
});
