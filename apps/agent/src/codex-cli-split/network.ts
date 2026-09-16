import { uuidV7Schema } from "@devspace/contracts";
import {
  DockerEngineClient,
  type DockerCodexSplitControlEgressAttachment,
  type DockerCodexSplitExecutionAttachment,
  type DockerCodexSplitNetworkAttachment,
  type DockerNetworkInspection
} from "../docker-runtime.js";

export interface CodexSplitExecutionNetworkBinding {
  readonly role: "execution";
  readonly workspaceId: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly controlAlias: "codex-control";
  readonly executorAlias: "codex-executor";
  readonly internal: true;
  readonly defaultRoute: false;
  readonly publishedPorts: readonly [];
}

export interface CodexSplitControlEgressNetworkBinding {
  readonly role: "control-egress";
  readonly workspaceId: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly controlAlias: "codex-control";
  readonly executorAttached: false;
  readonly internal: false;
  readonly defaultRoute: true;
  readonly publishedPorts: readonly [];
  readonly defaultBridgeUsed: false;
}

export interface CodexSplitNetworkBinding {
  readonly execution: CodexSplitExecutionNetworkBinding;
  readonly controlEgress: CodexSplitControlEgressNetworkBinding;
}

function networkSuffix(workspaceId: string, generation: number): string {
  const parsed = uuidV7Schema.parse(workspaceId);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("codex-split-generation-invalid");
  return `${parsed.replaceAll("-", "")}-g${generation}`;
}

export function buildCodexSplitExecutionNetworkName(workspaceId: string, generation: number): string {
  return `devspace-codex-${networkSuffix(workspaceId, generation)}-execution`;
}

export function buildCodexSplitControlEgressNetworkName(workspaceId: string, generation: number): string {
  return `devspace-codex-${networkSuffix(workspaceId, generation)}-control-egress`;
}

function expectedLabels(input: Readonly<Record<string, string>>, role: "execution" | "control-egress", workspaceId: string, generation: number): Record<string, string> {
  return {
    ...input,
    "devspace.managed": "true",
    "devspace.codex-split": "true",
    "devspace.workspace-id": workspaceId,
    "devspace.runtime-generation": String(generation),
    "devspace.resource-role": role
  };
}

function assertNetworkBasics(inspection: DockerNetworkInspection, expected: {
  readonly id: string;
  readonly name: string;
  readonly role: "execution" | "control-egress";
  readonly internal: boolean;
  readonly workspaceId: string;
  readonly generation: number;
}): void {
  if (inspection.Id !== expected.id || inspection.Name !== expected.name || inspection.Name === "bridge"
    || inspection.Driver !== "bridge" || inspection.Internal !== expected.internal
    || inspection.Attachable !== false || inspection.Ingress !== false || inspection.EnableIPv6 !== false
    || JSON.stringify(inspection.Options ?? {}) !== "{}"
    || inspection.Labels["devspace.managed"] !== "true"
    || inspection.Labels["devspace.codex-split"] !== "true"
    || inspection.Labels["devspace.workspace-id"] !== expected.workspaceId
    || inspection.Labels["devspace.runtime-generation"] !== String(expected.generation)
    || inspection.Labels["devspace.resource-role"] !== expected.role) {
    throw new Error(`codex-split-${expected.role}-network-policy`);
  }
  if (Object.values(inspection.Containers ?? {}).some((entry) => entry.Name === undefined)) {
    throw new Error(`codex-split-${expected.role}-network-members-invalid`);
  }
}

export async function createCodexSplitNetwork(input: {
  readonly docker: DockerEngineClient;
  readonly workspaceId: string;
  readonly generation: number;
  readonly labels: Readonly<Record<string, string>>;
}): Promise<CodexSplitNetworkBinding> {
  const workspaceId = uuidV7Schema.parse(input.workspaceId);
  const executionName = buildCodexSplitExecutionNetworkName(workspaceId, input.generation);
  const controlEgressName = buildCodexSplitControlEgressNetworkName(workspaceId, input.generation);
  const executionLabels = expectedLabels(input.labels, "execution", workspaceId, input.generation);
  const egressLabels = expectedLabels(input.labels, "control-egress", workspaceId, input.generation);
  let executionId: string | null = null;
  let egressId: string | null = null;
  try {
    executionId = await input.docker.createNetwork(executionName, executionLabels, { internal: true, attachable: false });
    egressId = await input.docker.createNetwork(controlEgressName, egressLabels, { internal: false, attachable: false });
    const binding: CodexSplitNetworkBinding = {
      execution: {
        role: "execution", workspaceId, generation: input.generation, id: executionId, name: executionName,
        controlAlias: "codex-control", executorAlias: "codex-executor", internal: true, defaultRoute: false, publishedPorts: []
      },
      controlEgress: {
        role: "control-egress", workspaceId, generation: input.generation, id: egressId, name: controlEgressName,
        controlAlias: "codex-control", executorAttached: false, internal: false, defaultRoute: true,
        publishedPorts: [], defaultBridgeUsed: false
      }
    };
    const [execution, controlEgress] = await Promise.all([
      input.docker.inspectNetwork(executionId), input.docker.inspectNetwork(egressId)
    ]);
    assertCodexSplitNetworkInspection({ execution, controlEgress }, binding);
    return binding;
  } catch (error) {
    if (egressId !== null) await input.docker.removeNetwork(egressId).catch(() => undefined);
    if (executionId !== null) await input.docker.removeNetwork(executionId).catch(() => undefined);
    throw error;
  }
}

export function assertCodexSplitNetworkInspection(
  inspections: { readonly execution: DockerNetworkInspection; readonly controlEgress: DockerNetworkInspection },
  expected: CodexSplitNetworkBinding
): void {
  assertNetworkBasics(inspections.execution, {
    id: expected.execution.id, name: expected.execution.name, role: "execution", internal: true,
    workspaceId: expected.execution.workspaceId, generation: expected.execution.generation
  });
  assertNetworkBasics(inspections.controlEgress, {
    id: expected.controlEgress.id, name: expected.controlEgress.name, role: "control-egress", internal: false,
    workspaceId: expected.controlEgress.workspaceId, generation: expected.controlEgress.generation
  });
  if (inspections.execution.Labels["devspace.resource-role"] !== "execution"
    || inspections.controlEgress.Labels["devspace.resource-role"] !== "control-egress"
    || inspections.execution.Name === inspections.controlEgress.Name
    || inspections.controlEgress.Name === "bridge") {
    throw new Error("codex-split-network-role-policy");
  }
}

function attachment(role: "execution" | "control-egress", name: string, aliases: readonly string[], defaultRoute: boolean): DockerCodexSplitNetworkAttachment {
  return { name, aliases, role, defaultRoute };
}

export function buildCodexSplitNetworkAttachments(input: {
  readonly role: "control";
  readonly network: CodexSplitNetworkBinding;
}): readonly [DockerCodexSplitExecutionAttachment, DockerCodexSplitControlEgressAttachment];
export function buildCodexSplitNetworkAttachments(input: {
  readonly role: "executor";
  readonly network: CodexSplitNetworkBinding;
}): readonly [DockerCodexSplitExecutionAttachment];
export function buildCodexSplitNetworkAttachments(input: {
  readonly role: "control" | "executor";
  readonly network: CodexSplitNetworkBinding;
}): readonly DockerCodexSplitNetworkAttachment[] {
  const executionAlias = input.role === "control" ? "codex-control" : "codex-executor";
  const execution = attachment("execution", input.network.execution.name, [executionAlias], false) as DockerCodexSplitExecutionAttachment;
  if (input.role === "executor") return [execution];
  const egress = attachment("control-egress", input.network.controlEgress.name, ["codex-control"], true) as DockerCodexSplitControlEgressAttachment;
  return [execution, egress];
}

export function assertCodexSplitContainerNetworks(input: {
  readonly role: "control" | "executor";
  readonly networks: readonly DockerCodexSplitNetworkAttachment[];
  readonly expected: CodexSplitNetworkBinding;
}): void {
  const expected: readonly DockerCodexSplitNetworkAttachment[] = input.role === "control"
    ? buildCodexSplitNetworkAttachments({ role: "control", network: input.expected })
    : buildCodexSplitNetworkAttachments({ role: "executor", network: input.expected });
  if (input.networks.length !== expected.length || input.networks.some((network, index) => {
    const wanted = expected[index];
    return wanted === undefined || network.name !== wanted.name || network.role !== wanted.role
      || network.defaultRoute !== wanted.defaultRoute || JSON.stringify(network.aliases) !== JSON.stringify(wanted.aliases);
  })) {
    throw new Error(`codex-split-${input.role}-network-policy`);
  }
  if (input.role === "executor" && input.networks.some((network) => network.role === "control-egress")) {
    throw new Error("codex-split-executor-network-policy");
  }
}
