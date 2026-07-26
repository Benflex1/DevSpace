import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  CODEX_APP_SERVER_CLI_VERSION,
  CODEX_APP_SERVER_SCHEMA_SHA256,
  codexAppServerFixtureManifestSchema,
  codexAppServerProtocolMethods,
  type CodexAppServerPrivateLaunch
} from "./codex-app-server-v0-145.js";

const manifestUrl = new URL(
  "../../fixtures/codex-app-server/0.145.0/protocol-manifest.json",
  import.meta.url
);

describe("Codex app-server 0.145.0 adapter boundary", () => {
  test("pins the stable-default generated schema evidence and exact method inventory", async () => {
    const manifest = codexAppServerFixtureManifestSchema.parse(
      JSON.parse(await readFile(manifestUrl, "utf8"))
    );
    expect(manifest.cliVersion).toBe(CODEX_APP_SERVER_CLI_VERSION);
    expect(manifest.aggregateV2Schema.sha256).toBe(CODEX_APP_SERVER_SCHEMA_SHA256);
    expect(manifest.methods).toEqual(codexAppServerProtocolMethods);
    expect(manifest.generatorExperimentalFlag).toBe(false);
  });

  test("fixes non-TTY stdio and keeps structured input optional", async () => {
    const manifest = codexAppServerFixtureManifestSchema.parse(
      JSON.parse(await readFile(manifestUrl, "utf8"))
    );
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
      experimentalApi: false
    };
    expect(launch.tty).toBe(false);
    expect(launch.experimentalApi).toBe(false);
  });
});
