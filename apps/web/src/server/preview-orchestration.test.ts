import type { PreviewInspectionData } from "@devspace/contracts";
import { describe, expect, test } from "vitest";
import { AgentResponseError } from "./agent-client.js";
import type { PreviewView, ProjectDatabase } from "./database.js";
import { reconcileWorkspacePreviews } from "./preview-orchestration.js";

const projectId = "0190a000-0000-7000-8000-000000000010";
const workspaceId = "0190a000-0000-7000-8000-000000000011";
const revisionId = "0190a000-0000-7000-8000-000000000012";
const previewId = "0190a000-0000-7000-8000-000000000013";

function preview(overrides: Partial<PreviewView> = {}): PreviewView {
  return {
    id: previewId, workspaceId, configRevisionId: revisionId, previewKey: "web", displayName: "Web",
    targetKind: "workspace", targetKey: "workspace", hostname: "alpha-primary-web-0190a000.preview.example.com",
    containerPort: 3000, desiredState: "active", observedState: "starting", routePresent: false, runtimeGeneration: 1,
    lastObservationJson: null, lastErrorCode: null, lastErrorMessage: null, ...overrides
  };
}

function fakeDatabase(initial: PreviewView) {
  let current = initial;
  const observations: Array<{ observedState: string; routePresent: boolean; observationJson?: string | null; errorCode?: string | null; errorMessage?: string | null }> = [];
  const operations = new Map<string, { operationId: string; state: "accepted" | "succeeded"; operationName: string; resourceId: string }>();
  const context = {
    project: { id: projectId, slug: "alpha" }, workspace: { id: workspaceId, slug: "primary", observedState: "running" },
    revision: { id: revisionId, configurationJson: "{}" }
  } as ReturnType<ProjectDatabase["getRuntimeContext"]>;
  const database = {
    getRuntimeContext: () => context,
    getManagedProject: () => ({ runtime: { observedState: "running" } }),
    materializePreviews: () => [current],
    listPreviews: () => [current],
    preparePreviewMutation: ({ action }: { action: "activate" | "deactivate" }) => {
      const operationId = "0190a000-0000-7000-8000-000000000014";
      const operation = { operationId, state: "accepted" as const, operationName: `preview.${action}`, resourceId: previewId };
      operations.set(operationId, operation);
      current = { ...current, desiredState: action === "activate" ? "active" : "inactive" };
      return { operation, preview: current, projectSlug: "alpha", workspaceSlug: "primary", revisionId };
    },
    applyExecutionSnapshot: (snapshot: { operationObservations: readonly { operationId: string; state: string }[] }) => {
      for (const observation of snapshot.operationObservations) {
        const operation = operations.get(observation.operationId);
        if (operation !== undefined && observation.state === "succeeded") {
          operation.state = "succeeded";
          current = { ...current, observedState: "healthy", routePresent: true };
        }
      }
    },
    updatePreviewObservation: (input: { observedState: PreviewView["observedState"]; routePresent: boolean; observationJson?: string | null; errorCode?: string | null; errorMessage?: string | null }) => {
      observations.push(input);
      current = { ...current, observedState: input.observedState, routePresent: input.routePresent, lastObservationJson: input.observationJson ?? null,
        lastErrorCode: input.errorCode ?? null, lastErrorMessage: input.errorMessage ?? null };
      return current;
    },
    finishOperation: () => undefined
  } as unknown as ProjectDatabase;
  return { database, observations, operations };
}

const inspection = (overrides: Partial<PreviewInspectionData> = {}): PreviewInspectionData => ({
  projectId, workspaceId, previewId, previewKey: "web", desiredState: "active", observedState: "healthy", routePresent: true,
  hostname: "alpha-primary-web-0190a000.preview.example.com", ...overrides
});

describe("Web preview orchestration", () => {
  test("sends only persisted activation identity and reconciles the route observation", async () => {
    const fixture = fakeDatabase(preview());
    let activation: Record<string, unknown> | undefined;
    const agent = {
      activatePreview: (_operationId: string, input: Record<string, unknown>) => { activation = input; return Promise.resolve({ operationId: _operationId }); },
      deactivatePreview: () => Promise.resolve({ operationId: "0190a000-0000-7000-8000-000000000014" }),
      inspectPreview: () => Promise.resolve(inspection()),
      snapshot: () => Promise.resolve({ operationObservations: [{ operationId: "0190a000-0000-7000-8000-000000000014", state: "succeeded" }] })
    };
    await reconcileWorkspacePreviews(projectId, "actor", "running", { database: fixture.database, agent: agent as never, observationTimeoutMs: 20 });
    expect(activation).toEqual({ projectId, workspaceId, revisionId, previewId, previewKey: "web",
      hostname: "alpha-primary-web-0190a000.preview.example.com", projectSlug: "alpha", workspaceSlug: "primary" });
    expect(fixture.observations.at(-1)).toMatchObject({ observedState: "healthy", routePresent: true });
    expect(fixture.database.listPreviews(projectId, workspaceId)[0]).toMatchObject({ routePresent: true });
  });

  test("retains service configuration as an explicit unsupported runtime policy", async () => {
    const fixture = fakeDatabase(preview({ targetKind: "service", targetKey: "api" }));
    let activated = false;
    const agent = {
      activatePreview: () => { activated = true; return Promise.resolve({ operationId: "0190a000-0000-7000-8000-000000000014" }); },
      deactivatePreview: () => Promise.resolve({ operationId: "0190a000-0000-7000-8000-000000000014" }),
      inspectPreview: () => Promise.resolve(inspection()), snapshot: () => Promise.resolve({ operationObservations: [] })
    };
    await reconcileWorkspacePreviews(projectId, "actor", "running", { database: fixture.database, agent: agent as never, observationTimeoutMs: 20 });
    expect(activated).toBe(false);
    expect(fixture.observations.at(-1)).toMatchObject({ observedState: "failed", routePresent: false });
  });

  test("does not claim a route is gone when Agent deactivation fails", async () => {
    const fixture = fakeDatabase(preview({ observedState: "healthy", routePresent: true }));
    const agent = {
      activatePreview: () => Promise.resolve({ operationId: "0190a000-0000-7000-8000-000000000014" }),
      deactivatePreview: () => Promise.reject(new AgentResponseError("GATEWAY_UPDATE_FAILED", "route removal failed")),
      inspectPreview: () => Promise.resolve(inspection()), snapshot: () => Promise.resolve({ operationObservations: [] })
    };
    await reconcileWorkspacePreviews(projectId, "actor", "stopped", { database: fixture.database, agent: agent as never, observationTimeoutMs: 20 });
    expect(fixture.observations.at(-1)).toMatchObject({ observedState: "failed", routePresent: true });
  });

  test("marks a previously Ready preview lost when ordinary Agent observation cannot find it", async () => {
    const fixture = fakeDatabase(preview({ observedState: "healthy", routePresent: true }));
    const agent = {
      activatePreview: () => Promise.resolve({ operationId: "0190a000-0000-7000-8000-000000000014" }),
      deactivatePreview: () => Promise.resolve({ operationId: "0190a000-0000-7000-8000-000000000014" }),
      inspectPreview: () => Promise.reject(new AgentResponseError("RESOURCE_NOT_FOUND", "preview state missing")),
      snapshot: () => Promise.reject(new Error("must not snapshot"))
    };
    await reconcileWorkspacePreviews(projectId, "actor", "observe", { database: fixture.database, agent: agent as never });
    expect(fixture.database.listPreviews(projectId, workspaceId)[0]).toMatchObject({
      observedState: "lost", routePresent: false, lastErrorCode: "RESOURCE_NOT_FOUND",
      lastErrorMessage: "The Agent no longer has the exact preview state."
    });
  });

  test("lets a later exact observation clear a route retained after operation failure", async () => {
    const fixture = fakeDatabase(preview({ observedState: "healthy", routePresent: true }));
    const agent = {
      activatePreview: () => Promise.resolve({ operationId: "0190a000-0000-7000-8000-000000000014" }),
      deactivatePreview: () => Promise.reject(new AgentResponseError("GATEWAY_UPDATE_FAILED", "route removal failed")),
      inspectPreview: () => Promise.resolve(inspection({ desiredState: "inactive", observedState: "inactive", routePresent: false })),
      snapshot: () => Promise.resolve({ operationObservations: [] })
    };
    await reconcileWorkspacePreviews(projectId, "actor", "stopped", { database: fixture.database, agent: agent as never });
    expect(fixture.database.listPreviews(projectId, workspaceId)[0]).toMatchObject({ observedState: "failed", routePresent: true });
    await reconcileWorkspacePreviews(projectId, "actor", "observe", { database: fixture.database, agent: agent as never });
    expect(fixture.database.listPreviews(projectId, workspaceId)[0]).toMatchObject({ observedState: "inactive", routePresent: false });
  });
});
