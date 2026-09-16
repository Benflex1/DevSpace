import type { CodexProjectExecutorBinding } from "./project-executor.js";
import type { CodexSplitNetworkBinding } from "./network.js";

export type CodexSplitTransportSecurity =
  | "protocol-authenticated"
  | "private-network-only"
  | "unproven";

export interface CodexSplitTransportCredential {
  readonly delivery: "control-only-file" | "control-only-environment";
  readonly target: string;
  readonly fingerprint: string;
}

export interface CodexSplitTransportBinding {
  readonly endpointUrl: string;
  readonly endpointHost: "codex-executor";
  readonly endpointPort: number;
  readonly security: CodexSplitTransportSecurity;
  readonly authenticationEvidence: "verified" | "absent" | "not-tested";
  readonly credential: CodexSplitTransportCredential | null;
  readonly workspaceId: string;
  readonly generation: number;
  readonly executionNetworkId: string;
}

function validPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

export function classifyCodexSplitTransport(input: {
  readonly protocolAuthenticationVerified: boolean;
  readonly privateNetworkIsolationVerified: boolean;
  readonly admittedVersion: string;
}): CodexSplitTransportSecurity {
  if (input.admittedVersion !== "0.153.4") return "unproven";
  if (input.protocolAuthenticationVerified && input.privateNetworkIsolationVerified) return "protocol-authenticated";
  if (!input.protocolAuthenticationVerified && input.privateNetworkIsolationVerified) return "private-network-only";
  return "unproven";
}

export function createCodexSplitTransportBinding(input: {
  readonly executor: CodexProjectExecutorBinding;
  readonly network: CodexSplitNetworkBinding;
  readonly protocolAuthenticationVerified: boolean;
  readonly privateNetworkIsolationVerified: boolean;
  readonly admittedVersion: string;
  readonly credential?: CodexSplitTransportCredential | null;
}): CodexSplitTransportBinding {
  const policy = input.executor.policy;
  if (input.executor.endpointHost !== "codex-executor" || !validPort(input.executor.endpointPort)
    || policy.workspaceId !== input.network.execution.workspaceId || policy.generation !== input.network.execution.generation
    || policy.executionNetwork.id !== input.network.execution.id || input.executor.controlEgressAttached) {
    throw new Error("codex-split-transport-identity");
  }
  const security = classifyCodexSplitTransport(input);
  const authenticationEvidence = input.protocolAuthenticationVerified
    ? "verified" as const
    : input.privateNetworkIsolationVerified ? "absent" as const : "not-tested" as const;
  if (security === "protocol-authenticated" && input.credential == null) {
    throw new Error("codex-split-transport-credential-missing");
  }
  const binding: CodexSplitTransportBinding = {
    endpointUrl: `ws://codex-executor:${input.executor.endpointPort}`,
    endpointHost: "codex-executor",
    endpointPort: input.executor.endpointPort,
    security,
    authenticationEvidence,
    credential: input.credential ?? null,
    workspaceId: input.network.execution.workspaceId,
    generation: input.network.execution.generation,
    executionNetworkId: input.network.execution.id
  };
  assertCodexSplitTransportBinding({ transport: binding, network: input.network, executor: input.executor });
  return binding;
}

export function assertCodexSplitTransportBinding(input: {
  readonly transport: CodexSplitTransportBinding;
  readonly network: CodexSplitNetworkBinding;
  readonly executor: CodexProjectExecutorBinding;
}): void {
  const { transport, network, executor } = input;
  const expectedUrl = `ws://codex-executor:${executor.endpointPort}`;
  let parsed: URL;
  try { parsed = new URL(transport.endpointUrl); } catch { throw new Error("codex-split-transport-endpoint"); }
  if (transport.endpointHost !== "codex-executor" || transport.endpointUrl !== expectedUrl
    || parsed.protocol !== "ws:" || parsed.hostname !== "codex-executor" || parsed.port !== String(executor.endpointPort)
    || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== ""
    || !validPort(transport.endpointPort) || transport.endpointPort !== executor.endpointPort
    || transport.workspaceId !== network.execution.workspaceId || transport.generation !== network.execution.generation
    || transport.executionNetworkId !== network.execution.id || executor.controlEgressAttached
    || executor.policy.networkAttachments.length !== 1 || executor.policy.networkAttachments[0]?.role !== "execution") {
    throw new Error("codex-split-transport-network");
  }
  if (transport.credential !== null
    && (!/^(?:sha256:)?[0-9a-f]{64}$/u.test(transport.credential.fingerprint)
      || !/^[A-Za-z_][A-Za-z0-9_]*$|^\/[A-Za-z0-9._/-]+$/u.test(transport.credential.target))) {
    throw new Error("codex-split-transport-credential");
  }
  if (transport.security === "protocol-authenticated" && transport.authenticationEvidence !== "verified") {
    throw new Error("codex-split-transport-authentication");
  }
  if (transport.security === "private-network-only" && transport.authenticationEvidence !== "absent") {
    throw new Error("codex-split-transport-authentication");
  }
  if (transport.security === "unproven" && transport.authenticationEvidence !== "not-tested") {
    throw new Error("codex-split-transport-authentication");
  }
}
