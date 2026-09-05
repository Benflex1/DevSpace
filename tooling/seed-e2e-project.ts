import { readFile, writeFile } from "node:fs/promises";
import { openProjectDatabase } from "../apps/web/src/server/database.js";
import { createAgentClient } from "../apps/web/src/server/agent-client.js";
import {
  canonicalizeProjectOptionsV1, canonicalizeRuntimePlanV1, compileRuntimePlanV1,
  hashProjectOptionsV1, hashRuntimePlanV1, parseProjectOptionsV1
} from "@devspace/project-options";

const [databasePath, repositoryUrl, metadataPath, mode] = process.argv.slice(2);
if (databasePath === undefined || repositoryUrl === undefined || metadataPath === undefined) throw new Error("seed arguments are required");
const database = openProjectDatabase(databasePath);
let projectId: string;
if (mode === "configure-preview") {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { projectId?: unknown };
  if (typeof metadata.projectId !== "string") throw new Error("seed metadata does not contain a project id");
  projectId = metadata.projectId;
  const socketPath = process.env.DEVSPACE_SEED_AGENT_SOCKET;
  if (socketPath === undefined) throw new Error("DEVSPACE_SEED_AGENT_SOCKET is required for preview setup");
  await configurePreviewWorkspace(database, projectId, socketPath);
} else {
  const project = database.createProject({
    name: "Managed Fixture", slug: "managed-fixture", repositoryUrl, defaultBranch: "main", actor: "e2e@example.invalid"
  });
  projectId = project.id;
}
database.close();
await writeFile(metadataPath, `${JSON.stringify({ projectId, repositoryUrl })}\n`, { mode: 0o600 });

async function waitForOperation(databaseInput: ReturnType<typeof openProjectDatabase>, agent: ReturnType<typeof createAgentClient>, operation: ReturnType<ReturnType<typeof openProjectDatabase>["getOrCreateOperation"]>, execute: () => Promise<void>): Promise<void> {
  if (operation.state === "succeeded") return;
  if (operation.state === "failed") throw new Error(operation.errorMessage ?? "seed operation failed");
  await execute();
  const deadline = Date.now() + 120_000;
  let delay = 25;
  while (Date.now() < deadline) {
    const observation = (await agent.snapshot()).operationObservations.find((candidate) => candidate.operationId === operation.operationId);
    if (observation?.state === "succeeded") { databaseInput.finishOperation(operation.operationId, { state: "succeeded" }); return; }
    if (observation?.state === "failed") {
      databaseInput.finishOperation(operation.operationId, { state: "failed", code: observation.failure.code, message: observation.failure.message });
      throw new Error(observation.failure.message);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.ceil(delay * 1.7), 1_000);
  }
  throw new Error("seed operation did not converge");
}

async function configurePreviewWorkspace(databaseInput: ReturnType<typeof openProjectDatabase>, projectIdInput: string, socketPath: string): Promise<void> {
  const agent = createAgentClient(socketPath, { timeoutMs: 10_000, mutationReceiptTimeoutMs: 10_000, observationTimeoutMs: 10_000 });
  await agent.health();
  const options = parseProjectOptionsV1({
    schemaVersion: 1,
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" }, ports: [{ name: "web", containerPort: 3000 }] },
    previews: [{ key: "web", displayName: "Web", target: { kind: "workspace" }, containerPort: 3000, domainBaseId: "local",
      hostnamePattern: "{project}-{workspace}-{preview}-{shortId}", healthPath: "/health", healthStatuses: [200], startupTimeoutSeconds: 2,
      webSocketForwarding: true }]
  });
  const configurationJson = canonicalizeProjectOptionsV1(options);
  const configurationHash = hashProjectOptionsV1(options);
  const runtimePlan = compileRuntimePlanV1(options);
  const compiledRuntimePlanJson = canonicalizeRuntimePlanV1(runtimePlan);
  const runtimePlanHash = hashRuntimePlanV1(runtimePlan);
  const setup = databaseInput.preparePrimaryWorkspace({ projectId: projectIdInput, configurationJson, configurationHash,
    compiledRuntimePlanJson, runtimePlanHash, actor: "e2e@example.invalid" });
  if (setup.project.state === "ready") return;
  const revisionOperation = databaseInput.getOrCreateOperation({ projectId: projectIdInput, actor: "e2e@example.invalid",
    operationName: "configuration-revision.register", resourceType: "configuration-revision", resourceId: setup.revision.id });
  await waitForOperation(databaseInput, agent, revisionOperation, async () => await agent.registerRevision(revisionOperation.operationId, {
    projectId: projectIdInput, revisionId: setup.revision.id,
    configuration: { format: "devspace.project-options/v1", hash: configurationHash, canonicalJson: configurationJson }
  }));
  const planOperation = databaseInput.getOrCreateOperation({ projectId: projectIdInput, actor: "e2e@example.invalid",
    operationName: "configuration-runtime-plan.register", resourceType: "configuration-revision", resourceId: setup.revision.id });
  await waitForOperation(databaseInput, agent, planOperation, async () => await agent.registerRuntimePlan(planOperation.operationId, {
    projectId: projectIdInput, revisionId: setup.revision.id, revisionHash: configurationHash,
    runtimePlan: { format: "devspace.runtime-plan/v1", hash: runtimePlanHash, canonicalJson: compiledRuntimePlanJson }
  }));
  const storeOperation = databaseInput.getOrCreateOperation({ projectId: projectIdInput, actor: "e2e@example.invalid",
    operationName: "project.managed-store.create", resourceType: "project", resourceId: projectIdInput });
  await waitForOperation(databaseInput, agent, storeOperation, async () => await agent.createManagedStore(storeOperation.operationId, {
    projectId: projectIdInput, source: { kind: "remote", url: repositoryUrl }
  }));
  const fetchOperation = databaseInput.getOrCreateOperation({ projectId: projectIdInput, actor: "e2e@example.invalid",
    operationName: "project.setup.fetch", resourceType: "project", resourceId: projectIdInput });
  await waitForOperation(databaseInput, agent, fetchOperation, async () => await agent.fetchProject(fetchOperation.operationId, projectIdInput));
  const workspaceOperation = databaseInput.getOrCreateOperation({ projectId: projectIdInput, actor: "e2e@example.invalid",
    operationName: "workspace.create", resourceType: "workspace", resourceId: setup.workspaceId });
  await waitForOperation(databaseInput, agent, workspaceOperation, async () => await agent.createWorkspace(workspaceOperation.operationId, {
    projectId: projectIdInput, workspaceId: setup.workspaceId, projectSlug: setup.project.slug, workspaceSlug: setup.workspaceSlug, kind: "primary",
    revision: { revisionId: setup.revision.id, revisionHash: configurationHash }, branchName: "main", baseRef: { kind: "branch", branchName: "main" }
  }));
  const [git, workspace] = await Promise.all([agent.inspectGit(projectIdInput, setup.workspaceId), agent.inspectWorkspace(projectIdInput, setup.workspaceId)]);
  if (workspace.observedState !== "stopped" || workspace.runtimeStack.observedState !== "absent") throw new Error("seeded workspace is not stopped");
  databaseInput.finalizePrimaryWorkspace({ projectId: projectIdInput, revisionId: setup.revision.id, workspaceId: setup.workspaceId,
    branchName: "main", baseRef: "main", actor: "e2e@example.invalid", dirtyState: git.dirty ? "dirty" : "clean" });
}
