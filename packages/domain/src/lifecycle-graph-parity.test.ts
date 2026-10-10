import { describe, expect, test } from "vitest";
import {
  transitionAiSession,
  transitionConfigurationRevision,
  transitionOperation,
  transitionPreviewDesired,
  transitionPreviewObserved,
  transitionProcessDesired,
  transitionProcessObserved,
  transitionProject,
  transitionRuntimeStackDesired,
  transitionRuntimeStackObserved,
  transitionTaskRun,
  transitionTerminal,
  transitionWorkspaceDesired,
  transitionWorkspaceObserved,
  transitionWorkspaceServiceDesired,
  transitionWorkspaceServiceHealth,
  transitionWorkspaceServiceObserved,
  type LifecycleName,
  type TransitionResult
} from "./index.js";

type Edge<State extends string> = readonly [from: State, to: State];

interface LifecycleCase<State extends string> {
  readonly name: LifecycleName;
  readonly states: readonly State[];
  readonly edges: readonly Edge<State>[];
  readonly terminalStates: readonly State[];
  readonly transition: (from: State, to: State) => TransitionResult<State>;
}

function edgesFromRows<State extends string>(
  rows: Readonly<Record<State, readonly State[]>>
): readonly Edge<State>[] {
  return (Object.entries(rows) as [State, readonly State[]][]).flatMap(([from, targets]) =>
    targets.map((to) => [from, to] as const)
  );
}

function defineLifecycle<State extends string>(
  definition: LifecycleCase<State>
): LifecycleCase<State> {
  return definition;
}

const recoveryEvidence = { kind: "fresh-observation" } as const;
const absenceEvidence = { kind: "owned-runtime-resources-absent" } as const;
const cleanPrimary = {
  workspaceKind: "primary",
  isDirty: false,
  dirtyStateHandling: "none"
} as const;

const projectFixtureStates = ["registering", "ready", "invalid", "archived"] as const;
const projectFixture = defineLifecycle({
  name: "project",
  states: projectFixtureStates,
  edges: edgesFromRows<(typeof projectFixtureStates)[number]>({
    registering: ["ready", "invalid"], ready: ["archived"], invalid: ["registering"], archived: ["ready"]
  }),
  terminalStates: [],
  transition: (from, to) => transitionProject(from, to, {
    activeConfigurationRevisionExists: true,
    nonRemovedPrimaryWorkspaceExists: true
  })
});

const configurationRevisionFixtureStates = ["draft", "active", "rejected", "superseded"] as const;
const configurationRevisionFixture = defineLifecycle({
  name: "configuration-revision",
  states: configurationRevisionFixtureStates,
  edges: edgesFromRows<(typeof configurationRevisionFixtureStates)[number]>({
    draft: ["active", "rejected"], active: ["superseded"], rejected: [], superseded: []
  }),
  terminalStates: ["rejected", "superseded"],
  transition: transitionConfigurationRevision
});

const operationFixtureStates = ["accepted", "running", "succeeded", "failed", "cancelled"] as const;
const operationFixture = defineLifecycle({
  name: "operation",
  states: operationFixtureStates,
  edges: edgesFromRows<(typeof operationFixtureStates)[number]>({
    accepted: ["running", "succeeded", "failed", "cancelled"],
    running: ["succeeded", "failed", "cancelled"],
    succeeded: [], failed: [], cancelled: []
  }),
  terminalStates: ["succeeded", "failed", "cancelled"],
  transition: (from, to) => transitionOperation(from, to, {
    cancellationCapability: { kind: "operation-type-supports-cancellation" }
  })
});

const workspaceDesiredFixtureStates = ["stopped", "running", "archived", "removed"] as const;
const workspaceDesiredFixture = defineLifecycle({
  name: "workspace-desired",
  states: workspaceDesiredFixtureStates,
  edges: edgesFromRows<(typeof workspaceDesiredFixtureStates)[number]>({
    stopped: ["running", "archived"], running: ["stopped"], archived: ["stopped", "removed"], removed: []
  }),
  terminalStates: ["removed"],
  transition: (from, to) => transitionWorkspaceDesired(from, to, { dirtyState: cleanPrimary })
});

const workspaceObservedFixtureStates = [
  "provisioning", "stopped", "starting", "running", "stopping", "degraded", "failed", "lost", "archived", "removed"
] as const;
const workspaceObservedFixture = defineLifecycle({
  name: "workspace-observed",
  states: workspaceObservedFixtureStates,
  edges: edgesFromRows<(typeof workspaceObservedFixtureStates)[number]>({
    provisioning: ["stopped", "failed", "lost"],
    stopped: ["starting", "archived", "lost"],
    starting: ["running", "degraded", "failed", "lost"],
    running: ["stopping", "degraded", "failed", "lost"],
    stopping: ["stopped", "failed", "lost"],
    degraded: ["running", "stopping", "failed", "lost"],
    failed: ["starting", "stopping", "archived", "lost"],
    lost: ["provisioning", "stopped", "running", "degraded", "failed", "archived", "removed"],
    archived: ["provisioning", "stopped", "removed", "lost"],
    removed: []
  }),
  terminalStates: ["removed"],
  transition: (from, to) => transitionWorkspaceObserved(from, to, {
    recoveryEvidence,
    dirtyState: cleanPrimary
  })
});

const runtimeStackDesiredFixtureStates = ["absent", "stopped", "running"] as const;
const runtimeStackDesiredFixture = defineLifecycle({
  name: "runtime-stack-desired",
  states: runtimeStackDesiredFixtureStates,
  edges: edgesFromRows<(typeof runtimeStackDesiredFixtureStates)[number]>({
    absent: ["stopped"], stopped: ["absent", "running"], running: ["stopped"]
  }),
  terminalStates: [],
  transition: transitionRuntimeStackDesired
});

const runtimeObservedFixtureStates = [
  "absent", "creating", "stopped", "starting", "running", "stopping", "degraded", "failed", "removing", "lost"
] as const;
const runtimeObservedFixtureRows = {
  absent: ["creating"],
  creating: ["stopped", "degraded", "failed", "lost"],
  stopped: ["starting", "removing", "lost"],
  starting: ["running", "degraded", "failed", "lost"],
  running: ["stopping", "degraded", "failed", "lost"],
  stopping: ["stopped", "degraded", "failed", "lost"],
  degraded: ["starting", "running", "stopping", "removing", "failed", "lost"],
  failed: ["creating", "starting", "stopping", "removing", "lost"],
  removing: ["absent", "failed", "lost"],
  lost: ["absent", "creating", "stopped", "starting", "running", "stopping", "degraded", "failed", "removing"]
} as const;
const runtimeStackObservedFixture = defineLifecycle({
  name: "runtime-stack-observed",
  states: runtimeObservedFixtureStates,
  edges: edgesFromRows<(typeof runtimeObservedFixtureStates)[number]>(runtimeObservedFixtureRows),
  terminalStates: [],
  transition: (from, to) => transitionRuntimeStackObserved(from, to, {
    recoveryEvidence,
    absenceEvidence
  })
});

const workspaceServiceDesiredFixtureStates = ["absent", "stopped", "running"] as const;
const workspaceServiceDesiredFixture = defineLifecycle({
  name: "workspace-service-desired",
  states: workspaceServiceDesiredFixtureStates,
  edges: edgesFromRows<(typeof workspaceServiceDesiredFixtureStates)[number]>({
    absent: ["stopped"], stopped: ["absent", "running"], running: ["stopped"]
  }),
  terminalStates: [],
  transition: transitionWorkspaceServiceDesired
});

const workspaceServiceObservedFixtureStates = [
  "absent", "creating", "stopped", "starting", "running", "stopping", "degraded", "failed", "removing", "lost"
] as const;
const workspaceServiceObservedFixture = defineLifecycle({
  name: "workspace-service-observed",
  states: workspaceServiceObservedFixtureStates,
  edges: edgesFromRows<(typeof workspaceServiceObservedFixtureStates)[number]>({
    absent: ["creating"],
    creating: ["stopped", "degraded", "failed", "lost"],
    stopped: ["starting", "removing", "lost"],
    starting: ["running", "degraded", "failed", "lost"],
    running: ["stopping", "degraded", "failed", "lost"],
    stopping: ["stopped", "degraded", "failed", "lost"],
    degraded: ["starting", "running", "stopping", "removing", "failed", "lost"],
    failed: ["creating", "starting", "stopping", "removing", "lost"],
    removing: ["absent", "failed", "lost"],
    lost: ["absent", "creating", "stopped", "starting", "running", "stopping", "degraded", "failed", "removing"]
  }),
  terminalStates: [],
  transition: (from, to) => transitionWorkspaceServiceObserved(from, to, {
    recoveryEvidence,
    owningStackObservedState: "running"
  })
});

const serviceHealthFixtureStates = ["unknown", "starting", "healthy", "unhealthy"] as const;
const serviceHealthFixture = defineLifecycle({
  name: "workspace-service-health",
  states: serviceHealthFixtureStates,
  edges: edgesFromRows<(typeof serviceHealthFixtureStates)[number]>({
    unknown: ["starting", "healthy", "unhealthy"],
    starting: ["healthy", "unhealthy", "unknown"],
    healthy: ["unhealthy", "unknown"],
    unhealthy: ["healthy", "unknown"]
  }),
  terminalStates: [],
  transition: (from, to) => transitionWorkspaceServiceHealth(from, to, {
    serviceObservedState: "running"
  })
});

const processDesiredFixtureStates = ["running", "stopped"] as const;
const processDesiredFixture = defineLifecycle({
  name: "process-desired",
  states: processDesiredFixtureStates,
  edges: edgesFromRows<(typeof processDesiredFixtureStates)[number]>({
    running: ["stopped"], stopped: ["running"]
  }),
  terminalStates: [],
  transition: transitionProcessDesired
});

const processObservedFixtureStates = [
  "queued", "starting", "running", "stopping", "exited", "failed", "killed", "lost"
] as const;
const processObservedFixture = defineLifecycle({
  name: "process-observed",
  states: processObservedFixtureStates,
  edges: edgesFromRows<(typeof processObservedFixtureStates)[number]>({
    queued: ["starting", "killed", "failed"],
    starting: ["running", "stopping", "failed", "killed", "lost"],
    running: ["stopping", "exited", "failed", "lost"],
    stopping: ["exited", "killed", "failed", "lost"],
    exited: [], failed: [], killed: [],
    lost: ["exited", "killed", "failed"]
  }),
  terminalStates: ["exited", "failed", "killed"],
  transition: (from, to) => transitionProcessObserved(from, to, { recoveryEvidence })
});

const terminalFixtureStates = ["creating", "active", "disconnected", "closing", "closed", "failed", "lost"] as const;
const terminalFixture = defineLifecycle({
  name: "terminal",
  states: terminalFixtureStates,
  edges: edgesFromRows<(typeof terminalFixtureStates)[number]>({
    creating: ["active", "failed", "lost"],
    active: ["disconnected", "closing", "failed", "lost"],
    disconnected: ["active", "closing", "failed", "lost"],
    closing: ["closed", "failed", "lost"],
    closed: [], failed: [], lost: []
  }),
  terminalStates: ["closed", "failed", "lost"],
  transition: transitionTerminal
});

const previewDesiredFixtureStates = ["inactive", "active"] as const;
const previewDesiredFixture = defineLifecycle({
  name: "preview-desired",
  states: previewDesiredFixtureStates,
  edges: edgesFromRows<(typeof previewDesiredFixtureStates)[number]>({
    inactive: ["active"], active: ["inactive"]
  }),
  terminalStates: [],
  transition: transitionPreviewDesired
});

const previewObservedFixtureStates = [
  "inactive", "starting", "healthy", "unhealthy", "stopping", "failed", "lost"
] as const;
const previewObservedFixture = defineLifecycle({
  name: "preview-observed",
  states: previewObservedFixtureStates,
  edges: edgesFromRows<(typeof previewObservedFixtureStates)[number]>({
    inactive: ["starting"],
    starting: ["healthy", "unhealthy", "failed", "lost"],
    healthy: ["unhealthy", "stopping", "lost"],
    unhealthy: ["starting", "stopping", "failed", "lost"],
    stopping: ["inactive", "failed", "lost"],
    failed: ["starting", "inactive"],
    lost: ["starting", "inactive"]
  }),
  terminalStates: [],
  transition: (from, to) => transitionPreviewObserved(from, to, {
    recoveryEvidence,
    routePresence: { routePresent: false }
  })
});

const aiSessionFixtureStates = [
  "creating", "active", "waiting_for_input", "interrupted", "stopped", "failed", "lost"
] as const;
const aiSessionFixture = defineLifecycle({
  name: "ai-session",
  states: aiSessionFixtureStates,
  edges: edgesFromRows<(typeof aiSessionFixtureStates)[number]>({
    creating: ["active", "stopped", "failed", "lost"],
    active: ["waiting_for_input", "interrupted", "stopped", "failed", "lost"],
    waiting_for_input: ["active", "interrupted", "stopped", "failed", "lost"],
    interrupted: ["active", "stopped", "failed", "lost"],
    stopped: [], failed: [], lost: []
  }),
  terminalStates: ["stopped", "failed", "lost"],
  transition: transitionAiSession
});

const taskRunFixtureStates = [
  "queued", "starting", "running", "passed", "failed", "cancelled", "timed_out", "lost"
] as const;
const taskRunFixture = defineLifecycle({
  name: "task-run",
  states: taskRunFixtureStates,
  edges: edgesFromRows<(typeof taskRunFixtureStates)[number]>({
    queued: ["starting", "cancelled"],
    starting: ["running", "failed", "cancelled", "lost"],
    running: ["passed", "failed", "cancelled", "timed_out", "lost"],
    passed: [], failed: [], cancelled: [], timed_out: [], lost: []
  }),
  terminalStates: ["passed", "failed", "cancelled", "timed_out", "lost"],
  transition: transitionTaskRun
});

const lifecycleFixtures = [
  projectFixture,
  configurationRevisionFixture,
  operationFixture,
  workspaceDesiredFixture,
  workspaceObservedFixture,
  runtimeStackDesiredFixture,
  runtimeStackObservedFixture,
  workspaceServiceDesiredFixture,
  workspaceServiceObservedFixture,
  serviceHealthFixture,
  processDesiredFixture,
  processObservedFixture,
  terminalFixture,
  previewDesiredFixture,
  previewObservedFixture,
  aiSessionFixture,
  taskRunFixture
] as const;

function verifyLifecycle<State extends string>(definition: LifecycleCase<State>): void {
  describe(definition.name, () => {
    const edgeKeys = new Set(definition.edges.map(([from, to]) => `${from}->${to}`));
    const orderedPairs = definition.states.flatMap((from) =>
      definition.states.map((to) => [from, to] as const)
    );
    const rejectedPairs = orderedPairs.filter(([from, to]) => !edgeKeys.has(`${from}->${to}`));

    test("fixture has unique states and edges, valid endpoints, terminal states, and no self-edges", () => {
      expect(new Set(definition.states).size).toBe(definition.states.length);
      expect(edgeKeys.size).toBe(definition.edges.length);
      for (const [from, to] of definition.edges) {
        expect(definition.states).toContain(from);
        expect(definition.states).toContain(to);
        expect(from).not.toBe(to);
      }
      const derivedTerminalStates = definition.states.filter((state) =>
        definition.edges.every(([from]) => from !== state)
      );
      expect(derivedTerminalStates).toEqual(definition.terminalStates);
    });

    test.each(definition.edges)("accepts specification edge %s -> %s", (from, to) => {
      expect(definition.transition(from, to)).toEqual({ ok: true, state: to });
    });

    test.each(rejectedPairs)("rejects unlisted pair %s -> %s", (from, to) => {
      expect(definition.transition(from, to)).toEqual({
        ok: false,
        error: {
          kind: "invalid-transition",
          code: "INVALID_LIFECYCLE_TRANSITION",
          lifecycle: definition.name,
          from,
          to
        }
      });
    });
  });
}

for (const fixture of lifecycleFixtures) {
  verifyLifecycle(fixture as LifecycleCase<string>);
}

test("independent specification fixtures cover all 17 lifecycles", () => {
  expect(lifecycleFixtures).toHaveLength(17);
});
