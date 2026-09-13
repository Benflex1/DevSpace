import { describe, expect, test } from "vitest";
import {
  CODEX_COMPATIBILITY_POLICY_VERSION,
  CODEX_MINIMUM_SUPPORTED_VERSION,
  CODEX_SEMANTIC_ADAPTER_VERSION,
  codexAppServerFixtureManifestSchema,
  codexAppServerProtocolMethods,
  codexCompatibilityDiagnostics,
  mapCodexDiagnosticToPublicAvailability
} from "./codex-app-server.js";

describe("version-independent Codex app-server contracts", () => {
  test("accepts a newer compatible fixture manifest without a release allowlist", () => {
    const manifest = codexAppServerFixtureManifestSchema.parse({
      baselineVersion: CODEX_MINIMUM_SUPPORTED_VERSION,
      cliVersion: "0.153.4",
      versionOutput: "codex-cli 0.153.4",
      generatedAt: "2026-09-13",
      stableGenerationCommand: "codex app-server generate-json-schema --out <directory>",
      experimentalGenerationCommand: "codex app-server generate-json-schema --experimental --out <directory>",
      transport: {
        mode: "stdio-jsonl",
        tty: false,
        stdout: "protocol-only",
        stderr: "private-diagnostics"
      },
      officialSource: "https://github.com/openai/codex",
      upstreamLicense: "Apache-2.0",
      fixtures: [{
        scope: "stable-default",
        file: "stable/ClientRequest.json",
        bytes: 1,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000"
      }],
      methods: codexAppServerProtocolMethods
    });

    expect(manifest.cliVersion).toBe("0.153.4");
    expect(CODEX_SEMANTIC_ADAPTER_VERSION).toBe("codex-app-server-family-v1");
    expect(CODEX_COMPATIBILITY_POLICY_VERSION).toBe("codex-compatibility-v1");
  });

  test("keeps the complete compatibility diagnostic set private and maps it to safe public codes", () => {
    expect(codexCompatibilityDiagnostics).toEqual(expect.arrayContaining([
      "CODEX_EXECUTABLE_MISSING",
      "CODEX_EXECUTABLE_INTEGRITY_CHANGED",
      "CODEX_UNRECOGNIZED_EXECUTION_FORM",
      "CODEX_VERSION_UNREADABLE",
      "CODEX_VERSION_BELOW_MINIMUM",
      "CODEX_PROBE_RUNTIME_UNAVAILABLE",
      "CODEX_SCHEMA_DISCOVERY_FAILED",
      "CODEX_PROTOCOL_INCOMPATIBLE",
      "CODEX_APPROVAL_PROTOCOL_UNAVAILABLE",
      "CODEX_REQUIRED_CAPABILITY_UNAVAILABLE",
      "CODEX_INITIALIZE_NEGOTIATION_FAILED",
      "CODEX_UNKNOWN_BLOCKING_REQUEST",
      "CODEX_PROFILE_CHANGED",
      "CODEX_DISCOVERY_CACHE_INVALID"
    ]));
    expect(mapCodexDiagnosticToPublicAvailability("CODEX_VERSION_BELOW_MINIMUM"))
      .toBe("VERSION_MISMATCH");
    expect(mapCodexDiagnosticToPublicAvailability("CODEX_UNKNOWN_BLOCKING_REQUEST"))
      .toBeNull();
  });

});
