import { describe, expect, test } from "vitest";
import { classifyCodexSplitTransport, createCodexSplitTransportBinding } from "./transport.js";
import type { CodexProjectExecutorBinding } from "./project-executor.js";
import type { CodexSplitNetworkBinding } from "./network.js";

const network: CodexSplitNetworkBinding = {
  execution: {
    role: "execution", workspaceId: "018f0f00-0000-7000-8000-000000000002", generation: 1,
    id: "execution-id", name: "execution-network", controlAlias: "codex-control", executorAlias: "codex-executor",
    internal: true, defaultRoute: false, publishedPorts: []
  },
  controlEgress: {
    role: "control-egress", workspaceId: "018f0f00-0000-7000-8000-000000000002", generation: 1,
    id: "egress-id", name: "egress-network", controlAlias: "codex-control", executorAttached: false,
    internal: false, defaultRoute: true, publishedPorts: [], defaultBridgeUsed: false
  }
};

const executor = {
  endpointHost: "codex-executor" as const, endpointPort: 4545, controlEgressAttached: false as const,
  policy: {
    workspaceId: network.execution.workspaceId, generation: network.execution.generation,
    executionNetwork: network.execution,
    networkAttachments: [{ name: network.execution.name, aliases: ["codex-executor"], role: "execution" as const, defaultRoute: false as const }]
  }
} as unknown as CodexProjectExecutorBinding;

describe("Codex split transport classification", () => {
  test("requires protocol authentication for the authenticated result", () => {
    expect(classifyCodexSplitTransport({
      protocolAuthenticationVerified: true, privateNetworkIsolationVerified: true, admittedVersion: "0.153.4"
    })).toBe("protocol-authenticated");
  });

  test("classifies an unauthenticated admitted listener as private-network-only", () => {
    expect(classifyCodexSplitTransport({
      protocolAuthenticationVerified: false, privateNetworkIsolationVerified: true, admittedVersion: "0.153.4"
    })).toBe("private-network-only");
  });

  test("keeps missing or non-admitted evidence unproven", () => {
    expect(classifyCodexSplitTransport({
      protocolAuthenticationVerified: false, privateNetworkIsolationVerified: false, admittedVersion: "0.153.4"
    })).toBe("unproven");
    expect(classifyCodexSplitTransport({
      protocolAuthenticationVerified: true, privateNetworkIsolationVerified: true, admittedVersion: "0.153.5"
    })).toBe("unproven");
  });

  test("binds only the execution-network endpoint and requires a credential for authenticated transport", () => {
    expect(createCodexSplitTransportBinding({
      executor, network, admittedVersion: "0.153.4", protocolAuthenticationVerified: false,
      privateNetworkIsolationVerified: true
    })).toMatchObject({
      endpointUrl: "ws://codex-executor:4545", security: "private-network-only", credential: null,
      executionNetworkId: network.execution.id
    });
    expect(() => createCodexSplitTransportBinding({
      executor, network, admittedVersion: "0.153.4", protocolAuthenticationVerified: true,
      privateNetworkIsolationVerified: true
    })).toThrow("codex-split-transport-credential-missing");
  });
});
