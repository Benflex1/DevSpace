import { expect, expectTypeOf, test } from "vitest";
import {
  projectStates,
  transitionProject,
  transitionRuntimeStackDesired,
  type ProjectState,
  type RuntimeStackDesiredState,
  type TransitionResult,
  type WorkspaceServiceDesiredState
} from "./index.js";

test("state unions derive from authoritative readonly tuples", () => {
  expectTypeOf<ProjectState>().toExtend<(typeof projectStates)[number]>();
  expectTypeOf<(typeof projectStates)[number]>().toExtend<ProjectState>();
  expectTypeOf(projectStates).toExtend<readonly ProjectState[]>();
});

test("transition results narrow by the ok discriminator", () => {
  const result: TransitionResult<ProjectState> = transitionProject("registering", "invalid");
  if (result.ok) {
    expectTypeOf(result.state).toEqualTypeOf<ProjectState>();
    expect(result.state).toBe("invalid");
  } else {
    expectTypeOf(result.error.kind).toEqualTypeOf<"invalid-transition" | "guard-rejected">();
  }
});

function _assertLifecycleSpecificStateTypes(): void {
  const stackState: RuntimeStackDesiredState = "absent";
  // @ts-expect-error runtime-stack state is not a project state
  transitionProject(stackState, "ready");
  // @ts-expect-error project state is not a runtime-stack desired state
  transitionRuntimeStackDesired("registering", "stopped");
  const serviceState: WorkspaceServiceDesiredState = "running";
  // @ts-expect-error identically spelled service state is still not a runtime-stack state
  transitionRuntimeStackDesired(serviceState, "stopped");
}

test("lifecycle-specific functions reject states from another lifecycle at compile time", () => {
  const stackState: RuntimeStackDesiredState = "absent";
  expect(stackState).toBe("absent");
});
