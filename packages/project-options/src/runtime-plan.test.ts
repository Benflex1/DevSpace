import { describe, expect, test } from "vitest";
import {
  RuntimePlanCompilationError, canonicalizeRuntimePlanV1, compileRuntimePlanV1, hashRuntimePlanV1
} from "./index.js";

const simple = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  developmentEnvironment: {
    source: { kind: "image", imageReference: "node:24-bookworm" },
    environment: { ZED: { kind: "literal", value: "last" }, ALPHA: { kind: "literal", value: "first" } },
    ports: [{ name: "web", containerPort: 3000 }]
  },
  ...overrides
});

describe("runtime-plan v1", () => {
  test("deterministically compiles and domain-hashes the current image path", () => {
    const plan = compileRuntimePlanV1(simple());
    expect(plan.format).toBe("devspace.runtime-plan/v1");
    expect(plan.developmentContainer.source.imageReference).toBe("node:24-bookworm");
    expect(canonicalizeRuntimePlanV1(plan)).toBe(canonicalizeRuntimePlanV1(JSON.parse(JSON.stringify(plan))));
    expect(hashRuntimePlanV1(plan)).toMatch(/^sha256-jcs-v1:[0-9a-f]{64}$/u);
  });

  test("retains only declared workspace ports in the executable runtime plan", () => {
    const plan = compileRuntimePlanV1({
      ...simple(),
      developmentEnvironment: {
        ...simple().developmentEnvironment,
        ports: [
          { name: "web", containerPort: 3000 },
          { name: "metrics", containerPort: 9090 }
        ]
      },
      previews: [{
        key: "web", displayName: "Web", target: { kind: "workspace" }, containerPort: 3000,
        domainBaseId: "preview-main", hostnamePattern: "{project}-{preview}"
      }]
    });
    expect(plan.developmentContainer.ports.map((port) => port.containerPort)).toEqual([9090, 3000]);
    expect(plan.developmentContainer.ports).not.toContainEqual(expect.objectContaining({ containerPort: 8080 }));
  });

  test.each([
    ["source-preset", { developmentEnvironment: { source: { kind: "preset", presetKey: "node", runtimeVersion: "24" } } }],
    ["source-dockerfile", { developmentEnvironment: { source: { kind: "dockerfile", dockerfilePath: "Dockerfile" } } }],
    ["supporting-services", { services: [{ key: "db", imageReference: "postgres:18" }] }],
    ["setup-steps", { developmentEnvironment: { source: { kind: "image", imageReference: "node:24" }, setupSteps: [{ executable: "npm" }] } }],
    ["unresolved-environment-binding", { developmentEnvironment: { source: { kind: "image", imageReference: "node:24" }, environment: { TOKEN: { kind: "host", variable: "TOKEN" } } } }]
  ] as const)("rejects unsupported %s configurations", (reason, input) => {
    expect(() => compileRuntimePlanV1(simple(input as Record<string, unknown>))).toThrowError(
      expect.objectContaining<Partial<RuntimePlanCompilationError>>({ reason })
    );
  });
});
