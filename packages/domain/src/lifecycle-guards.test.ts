import { describe, expect, test } from "vitest";
import {
  transitionOperation,
  transitionPreviewObserved,
  transitionProcessObserved,
  transitionProject,
  transitionRuntimeStackObserved,
  transitionWorkspaceDesired,
  transitionWorkspaceObserved,
  transitionWorkspaceServiceHealth,
  transitionWorkspaceServiceObserved,
  validatePreviewRouteInvariant,
  validateWorkspaceServiceHealthInvariant,
  validateWorkspaceServiceOwnershipInvariant,
  type LifecycleName,
  type LifecycleTransitionErrorCode,
  type RecoveryEvidence,
  type TransitionResult,
  type WorkspaceDirtyStateContext
} from "./index.js";

const recoveryEvidence = { kind: "reconciliation-result" } as const;
const absenceEvidence = { kind: "owned-runtime-resources-absent" } as const;
const cleanPrimary = {
  workspaceKind: "primary",
  isDirty: false,
  dirtyStateHandling: "none"
} as const;

function expectGuard(
  result: TransitionResult<unknown>,
  code: Exclude<LifecycleTransitionErrorCode, "INVALID_LIFECYCLE_TRANSITION">,
  lifecycle: LifecycleName,
  from: string,
  to: string
): void {
  expect(result).toEqual({
    ok: false,
    error: { kind: "guard-rejected", code, lifecycle, from, to }
  });
}

function expectInvalid(
  result: TransitionResult<unknown>,
  lifecycle: LifecycleName,
  from: string,
  to: string
): void {
  expect(result).toEqual({
    ok: false,
    error: {
      kind: "invalid-transition",
      code: "INVALID_LIFECYCLE_TRANSITION",
      lifecycle,
      from,
      to
    }
  });
}

describe("project readiness", () => {
  test("covers the guarded edge with every prerequisite combination", () => {
    expectGuard(
      transitionProject("registering", "ready"),
      "PROJECT_READINESS_REQUIRED", "project", "registering", "ready"
    );
    for (const context of [
      { activeConfigurationRevisionExists: false, nonRemovedPrimaryWorkspaceExists: true },
      { activeConfigurationRevisionExists: true, nonRemovedPrimaryWorkspaceExists: false }
    ] as const) {
      expectGuard(
        transitionProject("registering", "ready", context),
        "PROJECT_READINESS_REQUIRED", "project", "registering", "ready"
      );
    }
    expect(transitionProject("registering", "ready", {
      activeConfigurationRevisionExists: true,
      nonRemovedPrimaryWorkspaceExists: true
    })).toEqual({ ok: true, state: "ready" });
  });

  test("invalid-edge validation precedes readiness", () => {
    expectInvalid(transitionProject("ready", "ready"), "project", "ready", "ready");
  });
});

describe("operation cancellation", () => {
  test.each(["accepted", "running"] as const)(
    "covers %s -> cancelled with unsupported and supported cancellation",
    (from) => {
      expectGuard(
        transitionOperation(from, "cancelled"),
        "OPERATION_CANCELLATION_UNSUPPORTED", "operation", from, "cancelled"
      );
      expect(transitionOperation(from, "cancelled", {
        cancellationCapability: { kind: "operation-type-supports-cancellation" }
      })).toEqual({ ok: true, state: "cancelled" });
    }
  );

  test("invalid-edge validation precedes cancellation capability", () => {
    expectInvalid(
      transitionOperation("succeeded", "cancelled"),
      "operation", "succeeded", "cancelled"
    );
  });
});

describe("workspace dirty-state protection", () => {
  const guardedEdges = [
    {
      lifecycle: "workspace-desired",
      from: "stopped",
      to: "archived",
      run: (dirtyState?: WorkspaceDirtyStateContext) =>
        transitionWorkspaceDesired("stopped", "archived", dirtyState === undefined ? undefined : { dirtyState })
    },
    {
      lifecycle: "workspace-desired",
      from: "archived",
      to: "removed",
      run: (dirtyState?: WorkspaceDirtyStateContext) =>
        transitionWorkspaceDesired("archived", "removed", dirtyState === undefined ? undefined : { dirtyState })
    },
    {
      lifecycle: "workspace-observed",
      from: "stopped",
      to: "archived",
      run: (dirtyState?: WorkspaceDirtyStateContext) =>
        transitionWorkspaceObserved("stopped", "archived", {
          recoveryEvidence,
          ...(dirtyState === undefined ? {} : { dirtyState })
        })
    },
    {
      lifecycle: "workspace-observed",
      from: "failed",
      to: "archived",
      run: (dirtyState?: WorkspaceDirtyStateContext) =>
        transitionWorkspaceObserved("failed", "archived", {
          recoveryEvidence,
          ...(dirtyState === undefined ? {} : { dirtyState })
        })
    },
    {
      lifecycle: "workspace-observed",
      from: "lost",
      to: "archived",
      run: (dirtyState?: WorkspaceDirtyStateContext) =>
        transitionWorkspaceObserved("lost", "archived", {
          recoveryEvidence,
          ...(dirtyState === undefined ? {} : { dirtyState })
        })
    },
    {
      lifecycle: "workspace-observed",
      from: "lost",
      to: "removed",
      run: (dirtyState?: WorkspaceDirtyStateContext) =>
        transitionWorkspaceObserved("lost", "removed", {
          recoveryEvidence,
          ...(dirtyState === undefined ? {} : { dirtyState })
        })
    },
    {
      lifecycle: "workspace-observed",
      from: "archived",
      to: "removed",
      run: (dirtyState?: WorkspaceDirtyStateContext) =>
        transitionWorkspaceObserved("archived", "removed", {
          recoveryEvidence,
          ...(dirtyState === undefined ? {} : { dirtyState })
        })
    }
  ] as const;

  const contexts = [
    {
      name: "isolated clean",
      value: { workspaceKind: "isolated", isDirty: false, dirtyStateHandling: "none" },
      succeeds: true
    },
    {
      name: "isolated dirty without handling",
      value: { workspaceKind: "isolated", isDirty: true, dirtyStateHandling: "none" },
      succeeds: false
    },
    {
      name: "isolated dirty with handling",
      value: { workspaceKind: "isolated", isDirty: true, dirtyStateHandling: "selected" },
      succeeds: true
    },
    {
      name: "primary dirty",
      value: { workspaceKind: "primary", isDirty: true, dirtyStateHandling: "none" },
      succeeds: true
    }
  ] as const;

  test("the independent fixture contains exactly seven archive/remove edges", () => {
    expect(guardedEdges).toHaveLength(7);
  });

  test.each(guardedEdges)("covers $lifecycle $from -> $to", (edge) => {
    expectGuard(
      edge.run(),
      "WORKSPACE_DIRTY_STATE_CONTEXT_REQUIRED", edge.lifecycle, edge.from, edge.to
    );
    for (const context of contexts) {
      const result = edge.run(context.value);
      if (context.succeeds) {
        expect(result).toEqual({ ok: true, state: edge.to });
      } else {
        expectGuard(
          result,
          "WORKSPACE_DIRTY_HANDLING_REQUIRED", edge.lifecycle, edge.from, edge.to
        );
      }
    }
  });

  test("invalid-edge validation precedes both dirty-state guards", () => {
    expectInvalid(
      transitionWorkspaceDesired("running", "archived"),
      "workspace-desired", "running", "archived"
    );
    expectInvalid(
      transitionWorkspaceObserved("provisioning", "archived"),
      "workspace-observed", "provisioning", "archived"
    );
  });
});

describe("lost recovery", () => {
  function recoveryCases<State extends string>(
    lifecycle: LifecycleName,
    targets: readonly State[],
    run: (to: State, evidence?: RecoveryEvidence) => TransitionResult<unknown>
  ): readonly {
    readonly lifecycle: LifecycleName;
    readonly from: "lost";
    readonly to: State;
    readonly run: (evidence?: RecoveryEvidence) => TransitionResult<unknown>;
  }[] {
    return targets.map((to) => ({
      lifecycle,
      from: "lost" as const,
      to,
      run: (evidence?: RecoveryEvidence) => run(to, evidence)
    }));
  }

  const workspaceTargets = ["provisioning", "stopped", "running", "degraded", "failed", "archived", "removed"] as const;
  const stackTargets = ["absent", "creating", "stopped", "starting", "running", "stopping", "degraded", "failed", "removing"] as const;
  const processTargets = ["exited", "killed", "failed"] as const;
  const previewTargets = ["starting", "inactive"] as const;
  const outgoingCases = [
    ...recoveryCases("workspace-observed", workspaceTargets, (to, evidence) =>
      transitionWorkspaceObserved("lost", to, {
        ...(evidence === undefined ? {} : { recoveryEvidence: evidence }),
        dirtyState: cleanPrimary
      })
    ),
    ...recoveryCases("runtime-stack-observed", stackTargets, (to, evidence) =>
      transitionRuntimeStackObserved("lost", to, {
        ...(evidence === undefined ? {} : { recoveryEvidence: evidence }),
        absenceEvidence
      })
    ),
    ...recoveryCases("workspace-service-observed", stackTargets, (to, evidence) =>
      transitionWorkspaceServiceObserved(
        "lost",
        to,
        evidence === undefined ? undefined : { recoveryEvidence: evidence }
      )
    ),
    ...recoveryCases("process-observed", processTargets, (to, evidence) =>
      transitionProcessObserved(
        "lost",
        to,
        evidence === undefined ? undefined : { recoveryEvidence: evidence }
      )
    ),
    ...recoveryCases("preview-observed", previewTargets, (to, evidence) =>
      transitionPreviewObserved("lost", to, {
        ...(evidence === undefined ? {} : { recoveryEvidence: evidence }),
        routePresence: { routePresent: false }
      })
    )
  ] as const;

  test("the independent fixture contains every one of the 30 outgoing lost edges", () => {
    expect(outgoingCases).toHaveLength(30);
  });

  test.each(outgoingCases)("covers $lifecycle lost -> $to", (edge) => {
    expectGuard(
      edge.run(),
      "RECOVERY_EVIDENCE_REQUIRED", edge.lifecycle, "lost", edge.to
    );
    expect(edge.run(recoveryEvidence)).toEqual({ ok: true, state: edge.to });
  });

  test("invalid outgoing targets are rejected before recovery guards", () => {
    expectInvalid(
      transitionWorkspaceObserved("lost", "starting"),
      "workspace-observed", "lost", "starting"
    );
    expectInvalid(
      transitionRuntimeStackObserved("lost", "lost"),
      "runtime-stack-observed", "lost", "lost"
    );
    expectInvalid(
      transitionWorkspaceServiceObserved("lost", "lost"),
      "workspace-service-observed", "lost", "lost"
    );
    expectInvalid(
      transitionProcessObserved("lost", "running"),
      "process-observed", "lost", "running"
    );
    expectInvalid(
      transitionPreviewObserved("lost", "healthy"),
      "preview-observed", "lost", "healthy"
    );
  });

  test("every transition entering lost succeeds without recovery evidence", () => {
    for (const from of ["provisioning", "stopped", "starting", "running", "stopping", "degraded", "failed", "archived"] as const) {
      expect(transitionWorkspaceObserved(from, "lost")).toEqual({ ok: true, state: "lost" });
    }
    for (const from of ["creating", "stopped", "starting", "running", "stopping", "degraded", "failed", "removing"] as const) {
      expect(transitionRuntimeStackObserved(from, "lost")).toEqual({ ok: true, state: "lost" });
      expect(transitionWorkspaceServiceObserved(from, "lost")).toEqual({ ok: true, state: "lost" });
    }
    for (const from of ["starting", "running", "stopping"] as const) {
      expect(transitionProcessObserved(from, "lost")).toEqual({ ok: true, state: "lost" });
    }
    for (const from of ["starting", "healthy", "unhealthy", "stopping"] as const) {
      expect(transitionPreviewObserved(from, "lost", {
        routePresence: { routePresent: false }
      })).toEqual({ ok: true, state: "lost" });
    }
  });
});

describe("runtime-stack absence", () => {
  test("covers removing -> absent with and without absence evidence", () => {
    expectGuard(
      transitionRuntimeStackObserved("removing", "absent"),
      "RUNTIME_STACK_ABSENCE_UNCONFIRMED", "runtime-stack-observed", "removing", "absent"
    );
    expect(transitionRuntimeStackObserved("removing", "absent", { absenceEvidence })).toEqual({
      ok: true,
      state: "absent"
    });
  });

  test("lost -> absent requires recovery first and absence second", () => {
    expectGuard(
      transitionRuntimeStackObserved("lost", "absent"),
      "RECOVERY_EVIDENCE_REQUIRED", "runtime-stack-observed", "lost", "absent"
    );
    expectGuard(
      transitionRuntimeStackObserved("lost", "absent", { recoveryEvidence }),
      "RUNTIME_STACK_ABSENCE_UNCONFIRMED", "runtime-stack-observed", "lost", "absent"
    );
    expectGuard(
      transitionRuntimeStackObserved("lost", "absent", { absenceEvidence }),
      "RECOVERY_EVIDENCE_REQUIRED", "runtime-stack-observed", "lost", "absent"
    );
    expect(transitionRuntimeStackObserved("lost", "absent", {
      recoveryEvidence,
      absenceEvidence
    })).toEqual({ ok: true, state: "absent" });
  });

  test("invalid-edge validation precedes absence guards", () => {
    expectInvalid(
      transitionRuntimeStackObserved("stopped", "absent"),
      "runtime-stack-observed", "stopped", "absent"
    );
  });
});

describe("workspace-service ownership", () => {
  const runningEdges = ["starting", "degraded", "lost"] as const;

  test.each(runningEdges)("covers %s -> running", (from) => {
    const context = from === "lost" ? { recoveryEvidence } : undefined;
    expect(transitionWorkspaceServiceObserved(from, "running", context)).toEqual({
      ok: true,
      state: "running"
    });
    expectGuard(
      transitionWorkspaceServiceObserved(from, "running", {
        ...context,
        owningStackObservedState: "absent"
      }),
      "WORKSPACE_SERVICE_OWNER_STACK_ABSENT", "workspace-service-observed", from, "running"
    );
    expect(transitionWorkspaceServiceObserved(from, "running", {
      ...context,
      owningStackObservedState: "running"
    })).toEqual({ ok: true, state: "running" });
  });

  test("validates existing running and non-running service observations", () => {
    expectGuard(
      validateWorkspaceServiceOwnershipInvariant("running", "absent"),
      "WORKSPACE_SERVICE_OWNER_STACK_ABSENT",
      "workspace-service-observed", "running", "running"
    );
    expect(validateWorkspaceServiceOwnershipInvariant("running", "stopped")).toEqual({
      ok: true,
      state: "running"
    });
    for (const state of ["absent", "creating", "stopped", "starting", "stopping", "degraded", "failed", "removing", "lost"] as const) {
      expect(validateWorkspaceServiceOwnershipInvariant(state, "absent")).toEqual({
        ok: true,
        state
      });
    }
  });

  test.each(["absent", "creating", "stopped", "running", "stopping", "failed", "removing"] as const)(
    "invalid %s -> running validation precedes ownership",
    (from) => {
      expectInvalid(
        transitionWorkspaceServiceObserved(from, "running", {
          owningStackObservedState: "absent"
        }),
        "workspace-service-observed", from, "running"
      );
    }
  );
});

describe("workspace-service health", () => {
  const allEdges = [
    ["unknown", "starting"], ["unknown", "healthy"], ["unknown", "unhealthy"],
    ["starting", "healthy"], ["starting", "unhealthy"], ["starting", "unknown"],
    ["healthy", "unhealthy"], ["healthy", "unknown"],
    ["unhealthy", "healthy"], ["unhealthy", "unknown"]
  ] as const;

  test("the independent fixture contains all ten health edges", () => {
    expect(allEdges).toHaveLength(10);
  });

  test.each(allEdges.filter(([, to]) => to !== "unknown"))(
    "covers %s -> %s with running and non-running service context",
    (from, to) => {
      expect(transitionWorkspaceServiceHealth(from, to, {
        serviceObservedState: "running"
      })).toEqual({ ok: true, state: to });
      expectGuard(
        transitionWorkspaceServiceHealth(from, to),
        "SERVICE_HEALTH_REQUIRES_RUNNING_SERVICE", "workspace-service-health", from, to
      );
      expectGuard(
        transitionWorkspaceServiceHealth(from, to, { serviceObservedState: "stopped" }),
        "SERVICE_HEALTH_REQUIRES_RUNNING_SERVICE", "workspace-service-health", from, to
      );
    }
  );

  test.each(allEdges.filter(([, to]) => to === "unknown"))(
    "allows %s -> unknown while the service is not running",
    (from, to) => {
      expect(transitionWorkspaceServiceHealth(from, to, {
        serviceObservedState: "stopped"
      })).toEqual({ ok: true, state: to });
    }
  );

  test("validates existing invalid and valid health/service combinations", () => {
    expectGuard(
      validateWorkspaceServiceHealthInvariant("healthy", "stopped"),
      "SERVICE_HEALTH_REQUIRES_RUNNING_SERVICE",
      "workspace-service-health", "healthy", "healthy"
    );
    expect(validateWorkspaceServiceHealthInvariant("unknown", "stopped")).toEqual({
      ok: true,
      state: "unknown"
    });
  });

  test.each([
    ["unknown", "unknown"],
    ["starting", "starting"],
    ["healthy", "starting"],
    ["healthy", "healthy"],
    ["unhealthy", "starting"],
    ["unhealthy", "unhealthy"]
  ] as const)("invalid %s -> %s validation precedes health guards", (from, to) => {
    expectInvalid(
      transitionWorkspaceServiceHealth(from, to, { serviceObservedState: "stopped" }),
      "workspace-service-health", from, to
    );
  });
});

describe("preview routes", () => {
  const guardedEdges = [
    ["starting", "failed"], ["starting", "lost"], ["healthy", "lost"],
    ["unhealthy", "failed"], ["unhealthy", "lost"],
    ["stopping", "inactive"], ["stopping", "failed"], ["stopping", "lost"],
    ["failed", "inactive"], ["lost", "inactive"]
  ] as const;

  test("the independent fixture contains all ten route-guarded edges", () => {
    expect(guardedEdges).toHaveLength(10);
  });

  test.each(guardedEdges)("covers %s -> %s with route absent and present", (from, to) => {
    const context = from === "lost" ? { recoveryEvidence } : undefined;
    expectGuard(
      transitionPreviewObserved(from, to, context),
      "PREVIEW_ROUTE_PRESENCE_REQUIRED", "preview-observed", from, to
    );
    expect(transitionPreviewObserved(from, to, {
      ...context,
      routePresence: { routePresent: false }
    })).toEqual({ ok: true, state: to });
    expectGuard(
      transitionPreviewObserved(from, to, {
        ...context,
        routePresence: { routePresent: true }
      }),
      "PREVIEW_ROUTE_STATE_CONFLICT", "preview-observed", from, to
    );
  });

  test("separates lost recovery evidence from route conflict", () => {
    expectGuard(
      transitionPreviewObserved("lost", "inactive", {
        routePresence: { routePresent: true }
      }),
      "RECOVERY_EVIDENCE_REQUIRED", "preview-observed", "lost", "inactive"
    );
    expectGuard(
      transitionPreviewObserved("lost", "inactive", {
        recoveryEvidence,
        routePresence: { routePresent: true }
      }),
      "PREVIEW_ROUTE_STATE_CONFLICT", "preview-observed", "lost", "inactive"
    );
  });

  test("validates existing guarded and unrelated states", () => {
    for (const state of ["inactive", "failed", "lost"] as const) {
      expectGuard(
        validatePreviewRouteInvariant(state, { routePresent: true }),
        "PREVIEW_ROUTE_STATE_CONFLICT", "preview-observed", state, state
      );
    }
    for (const state of ["starting", "healthy", "unhealthy", "stopping"] as const) {
      expect(validatePreviewRouteInvariant(state, { routePresent: true })).toEqual({
        ok: true,
        state
      });
    }
  });

  test.each([
    ["inactive", "inactive"], ["inactive", "failed"], ["inactive", "lost"],
    ["starting", "inactive"],
    ["healthy", "inactive"], ["healthy", "failed"],
    ["unhealthy", "inactive"],
    ["failed", "failed"], ["failed", "lost"],
    ["lost", "failed"], ["lost", "lost"]
  ] as const)("invalid %s -> %s validation precedes route guards", (from, to) => {
    expectInvalid(
      transitionPreviewObserved(from, to, { routePresence: { routePresent: true } }),
      "preview-observed", from, to
    );
  });
});
