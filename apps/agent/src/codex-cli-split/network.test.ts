import { expect, test } from "vitest";
import {
  assertCodexSplitContainerNetworks,
  assertCodexSplitNetworkInspection,
  buildCodexSplitNetworkAttachments,
  createCodexSplitNetwork
} from "./network.js";
import { DockerEngineClient, type DockerNetworkInspection } from "../docker-runtime.js";

const workspaceId = "018f0f00-0000-7000-8000-000000000003";

class NetworkEngine extends DockerEngineClient {
  readonly calls: Array<{ name: string; labels: Record<string, string>; options: unknown }> = [];
  readonly inspections = new Map<string, DockerNetworkInspection>();

  constructor() { super("/fixture/rootless.sock"); }

  override createNetwork(name: string, labels: Record<string, string>, options?: { readonly internal?: boolean; readonly attachable?: boolean }): Promise<string> {
    const id = `network-${this.calls.length + 1}`;
    this.calls.push({ name, labels: { ...labels }, options: { ...options } });
    this.inspections.set(id, {
      Id: id,
      Name: name,
      Labels: { ...labels },
      Driver: "bridge",
      Internal: options?.internal ?? false,
      Attachable: options?.attachable ?? false,
      Ingress: false,
      EnableIPv6: false,
      Options: {},
      Containers: {}
    });
    return Promise.resolve(id);
  }

  override inspectNetwork(id: string): Promise<DockerNetworkInspection> {
    const inspection = this.inspections.get(id);
    return inspection === undefined ? Promise.reject(new Error("network-missing")) : Promise.resolve(inspection);
  }
}

test("creates and binds separate execution and control-egress networks", async () => {
  const docker = new NetworkEngine();
  const network = await createCodexSplitNetwork({
    docker,
    workspaceId,
    generation: 1,
    labels: { "devspace.test": "true" }
  });

  expect(docker.calls).toHaveLength(2);
  expect(docker.calls[0]?.options).toEqual({ internal: true, attachable: false });
  expect(docker.calls[1]?.options).toEqual({ internal: false, attachable: false });
  expect(network.execution.internal).toBe(true);
  expect(network.controlEgress.internal).toBe(false);
  expect(network.execution.name).not.toBe("bridge");
  expect(network.controlEgress.name).not.toBe("bridge");
  expect(buildCodexSplitNetworkAttachments({ role: "control", network })).toHaveLength(2);
  expect(buildCodexSplitNetworkAttachments({ role: "executor", network })).toHaveLength(1);
  expect(buildCodexSplitNetworkAttachments({ role: "executor", network })[0]).toMatchObject({
    role: "execution",
    aliases: ["codex-executor", "codex-code-mode-host"]
  });
});

test("rejects role attachment drift and network inspection drift", async () => {
  const docker = new NetworkEngine();
  const network = await createCodexSplitNetwork({ docker, workspaceId, generation: 2, labels: {} });
  expect(() => assertCodexSplitContainerNetworks({
    role: "executor",
    networks: buildCodexSplitNetworkAttachments({ role: "control", network }),
    expected: network
  })).toThrow("codex-split-executor-network-policy");
  const inspection = docker.inspections.get(network.execution.id)!;
  expect(() => assertCodexSplitNetworkInspection({
    execution: { ...inspection, Internal: false },
    controlEgress: docker.inspections.get(network.controlEgress.id)!
  }, network)).toThrow("codex-split-execution-network-policy");
});
