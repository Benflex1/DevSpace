import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  canonicalizeProjectOptionsV1,
  canonicalizeProjectOptionsV1Bytes,
  hashProjectOptionsV1
} from "@devspace/project-options";

function minimalOptions(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    developmentEnvironment: {
      source: { kind: "image", imageReference: "node:24" }
    }
  };
}

interface GoldenFixture {
  readonly input: unknown;
  readonly canonicalText: string;
  readonly revisionHash: string;
}

const goldenFixture = JSON.parse(readFileSync(
  new URL("../fixtures/project-options-v1-golden.json", import.meta.url),
  "utf8"
)) as GoldenFixture;

function unorderedOptions(): Record<string, unknown> {
  return {
    ...minimalOptions(),
    namedVolumes: [
      { key: "z-data", kind: "data" },
      { key: "m-data", kind: "data" },
      { key: "a-cache", kind: "cache" }
    ],
    developmentEnvironment: {
      source: { kind: "image", imageReference: "node:24" },
      ports: [
        { name: "z-port", containerPort: 4000 },
        { name: "a-port", containerPort: 3000 }
      ],
      volumes: [
        { volumeKey: "z-data", mountPath: "/z" },
        { volumeKey: "a-cache", mountPath: "/a" }
      ]
    },
    tasks: [
      {
        key: "z-task",
        displayName: "Z task",
        command: { executable: "echo" },
        successExitCodes: [2, 0, 1]
      },
      { key: "a-task", displayName: "A task", command: { executable: "true" } }
    ],
    services: [
      {
        key: "z-service",
        imageReference: "example/z:1",
        ports: [
          { name: "z", containerPort: 9000 },
          { name: "a", containerPort: 8000 }
        ],
        volumes: [
          { volumeKey: "z-data", mountPath: "/data" },
          { volumeKey: "m-data", mountPath: "/cache" }
        ],
        healthCheck: { kind: "http", portName: "z", expectedStatuses: [204, 200] },
        dependsOn: [
          { serviceKey: "m-service", condition: "healthy" },
          { serviceKey: "a-service", condition: "started" }
        ]
      },
      { key: "m-service", imageReference: "example/m:1" },
      { key: "a-service", imageReference: "example/a:1" }
    ],
    previews: [
      {
        key: "z-preview",
        displayName: "Z preview",
        target: { kind: "workspace" },
        containerPort: 4000,
        domainBaseId: "preview-main",
        hostnamePattern: "{project}-{preview}",
        healthStatuses: [204, 200]
      },
      {
        key: "a-preview",
        displayName: "A preview",
        target: { kind: "workspace" },
        containerPort: 3000,
        domainBaseId: "preview-main",
        hostnamePattern: "{project}-{preview}"
      }
    ],
    aiProfile: {
      providerKey: "provider",
      executableProfileKey: "profile",
      credentialSecretIds: [
        "018f0f00-0000-7000-8000-000000000002",
        "018f0f00-0000-7000-8000-000000000001"
      ],
      networkDisclosureAcknowledged: true
    }
  };
}

function reverseUnorderedCollections(input: Record<string, unknown>): Record<string, unknown> {
  const developmentEnvironment = input.developmentEnvironment as Record<string, unknown>;
  const tasks = input.tasks as Array<Record<string, unknown>>;
  const services = input.services as Array<Record<string, unknown>>;
  const previews = input.previews as Array<Record<string, unknown>>;
  return {
    ...input,
    namedVolumes: [...(input.namedVolumes as unknown[])].reverse(),
    developmentEnvironment: {
      ...developmentEnvironment,
      ports: [...(developmentEnvironment.ports as unknown[])].reverse(),
      volumes: [...(developmentEnvironment.volumes as unknown[])].reverse()
    },
    tasks: [...tasks].reverse().map((task) => ({
      ...task,
      successExitCodes: task.successExitCodes === undefined
        ? undefined
        : [...(task.successExitCodes as unknown[])].reverse()
    })),
    services: [...services].reverse().map((service) => ({
      ...service,
      ports: service.ports === undefined ? undefined : [...(service.ports as unknown[])].reverse(),
      volumes: service.volumes === undefined
        ? undefined
        : [...(service.volumes as unknown[])].reverse(),
      dependsOn: service.dependsOn === undefined
        ? undefined
        : [...(service.dependsOn as unknown[])].reverse(),
      healthCheck: service.healthCheck === undefined
        ? undefined
        : {
            ...(service.healthCheck as Record<string, unknown>),
            expectedStatuses: [...(
              (service.healthCheck as Record<string, unknown>).expectedStatuses as unknown[]
            )].reverse()
          }
    })),
    previews: [...previews].reverse().map((preview) => ({
      ...preview,
      healthStatuses: preview.healthStatuses === undefined
        ? undefined
        : [...(preview.healthStatuses as unknown[])].reverse()
    })),
    aiProfile: input.aiProfile === undefined
      ? undefined
      : {
          ...(input.aiProfile as Record<string, unknown>),
          credentialSecretIds: [
            ...((input.aiProfile as Record<string, unknown>).credentialSecretIds as unknown[])
          ].reverse()
        }
  };
}

test("has a fixed canonical minimal document and fixed domain-separated SHA-256 hash", () => {
  expect(goldenFixture.input).toEqual(minimalOptions());
  expect(canonicalizeProjectOptionsV1(goldenFixture.input)).toBe(goldenFixture.canonicalText);
  expect(canonicalizeProjectOptionsV1Bytes(goldenFixture.input)).toEqual(
    new TextEncoder().encode(goldenFixture.canonicalText)
  );
  expect(hashProjectOptionsV1(goldenFixture.input)).toBe(goldenFixture.revisionHash);
});

test("normalizes source property order, omitted defaults, and explicit defaults identically", () => {
  const omitted = minimalOptions();
  const explicit = {
    developmentEnvironment: {
      rebuildPolicy: "manual",
      setupSteps: [],
      volumes: [],
      ports: [],
      environment: {},
      workingDirectory: "/workspace",
      passwordlessSudo: false,
      containerUser: null,
      source: { imageReference: "node:24", kind: "image" }
    },
    resources: {
      maxConcurrentWorkspaces: null,
      automaticStopMinutes: null,
      stoppedWorkspaceRetentionDays: null,
      logRetentionDays: null,
      maxNamedVolumeBytes: null,
      pidLimit: null,
      memoryBytes: null,
      cpuMillicores: null
    },
    aiProfile: null,
    previews: [],
    services: [],
    tasks: [],
    namedVolumes: [],
    schemaVersion: 1
  };

  expect(canonicalizeProjectOptionsV1(explicit)).toBe(canonicalizeProjectOptionsV1(omitted));
  expect(hashProjectOptionsV1(explicit)).toBe(hashProjectOptionsV1(omitted));
});

test("canonical output reparses to the same canonical revision", () => {
  const canonical = canonicalizeProjectOptionsV1(unorderedOptions());
  const reparsed = JSON.parse(canonical) as unknown;

  expect(canonicalizeProjectOptionsV1(reparsed)).toBe(canonical);
  expect(hashProjectOptionsV1(reparsed)).toBe(hashProjectOptionsV1(unorderedOptions()));
});

test("sorts every declared unordered collection without mutating the caller", () => {
  const first = unorderedOptions();
  const second = reverseUnorderedCollections(first);
  const before = JSON.stringify(first);

  expect(canonicalizeProjectOptionsV1(first)).toBe(canonicalizeProjectOptionsV1(second));
  expect(hashProjectOptionsV1(first)).toBe(hashProjectOptionsV1(second));
  expect(JSON.stringify(first)).toBe(before);
});

test("sorts service ports independently of other collection normalization", () => {
  const first = unorderedOptions();
  const second = structuredClone(first);
  const service = (second.services as Array<Record<string, unknown>>)
    .find((candidate) => candidate.key === "z-service")!;
  service.ports = [...(service.ports as unknown[])].reverse();

  expect(canonicalizeProjectOptionsV1(second)).toBe(canonicalizeProjectOptionsV1(first));
  expect(hashProjectOptionsV1(second)).toBe(hashProjectOptionsV1(first));
});

test("sorts service mounts independently of other collection normalization", () => {
  const first = unorderedOptions();
  const second = structuredClone(first);
  const service = (second.services as Array<Record<string, unknown>>)
    .find((candidate) => candidate.key === "z-service")!;
  service.volumes = [...(service.volumes as unknown[])].reverse();

  expect(canonicalizeProjectOptionsV1(second)).toBe(canonicalizeProjectOptionsV1(first));
  expect(hashProjectOptionsV1(second)).toBe(hashProjectOptionsV1(first));
});

test("sorts AI credential secret IDs independently of other collection normalization", () => {
  const first = unorderedOptions();
  const second = structuredClone(first);
  const aiProfile = second.aiProfile as Record<string, unknown>;
  aiProfile.credentialSecretIds = [...(aiProfile.credentialSecretIds as unknown[])].reverse();

  expect(canonicalizeProjectOptionsV1(second)).toBe(canonicalizeProjectOptionsV1(first));
  expect(hashProjectOptionsV1(second)).toBe(hashProjectOptionsV1(first));
});

test("preserves ordered arrays and changes the hash for meaningful semantic changes", () => {
  const first = minimalOptions();
  first.developmentEnvironment = {
    source: { kind: "image", imageReference: "node:24" },
    setupSteps: [
      { executable: "printf", args: ["first", "second"] },
      { executable: "printf", args: ["third"] }
    ]
  };
  const reversedSteps = structuredClone(first);
  const environment = reversedSteps.developmentEnvironment as Record<string, unknown>;
  environment.setupSteps = [...(environment.setupSteps as unknown[])].reverse();
  const reversedArguments = structuredClone(first);
  const commands = (reversedArguments.developmentEnvironment as Record<string, unknown>)
    .setupSteps as Array<Record<string, unknown>>;
  commands[0]!.args = [...(commands[0]!.args as unknown[])].reverse();

  expect(hashProjectOptionsV1(reversedSteps)).not.toBe(hashProjectOptionsV1(first));
  expect(hashProjectOptionsV1(reversedArguments)).not.toBe(hashProjectOptionsV1(first));
  const changedImage = {
    ...minimalOptions(),
    developmentEnvironment: { source: { kind: "image", imageReference: "node:25" } }
  };
  expect(canonicalizeProjectOptionsV1Bytes(changedImage)).not.toEqual(
    canonicalizeProjectOptionsV1Bytes(minimalOptions())
  );
  expect(hashProjectOptionsV1(changedImage)).not.toBe(hashProjectOptionsV1(minimalOptions()));
});

function orderedSequenceOptions(): Record<string, unknown> {
  return {
    ...minimalOptions(),
    services: [{
      key: "app",
      imageReference: "example/app:1",
      entrypoint: ["/bin/sh", "-c"],
      command: ["serve", "--port", "3000"]
    }],
    aiProfile: {
      providerKey: "provider",
      executableProfileKey: "profile",
      fixedArgs: ["--project-dir", "."],
      networkDisclosureAcknowledged: true
    }
  };
}

test("preserves service entrypoint order", () => {
  const first = orderedSequenceOptions();
  const changed = structuredClone(first);
  const service = (changed.services as Array<Record<string, unknown>>)[0]!;
  service.entrypoint = [...(service.entrypoint as unknown[])].reverse();

  expect(canonicalizeProjectOptionsV1(changed)).not.toBe(canonicalizeProjectOptionsV1(first));
  expect(hashProjectOptionsV1(changed)).not.toBe(hashProjectOptionsV1(first));
});

test("preserves service command order", () => {
  const first = orderedSequenceOptions();
  const changed = structuredClone(first);
  const service = (changed.services as Array<Record<string, unknown>>)[0]!;
  service.command = [...(service.command as unknown[])].reverse();

  expect(canonicalizeProjectOptionsV1(changed)).not.toBe(canonicalizeProjectOptionsV1(first));
  expect(hashProjectOptionsV1(changed)).not.toBe(hashProjectOptionsV1(first));
});

test("preserves AI fixed-argument order", () => {
  const first = orderedSequenceOptions();
  const changed = structuredClone(first);
  const aiProfile = changed.aiProfile as Record<string, unknown>;
  aiProfile.fixedArgs = [...(aiProfile.fixedArgs as unknown[])].reverse();

  expect(canonicalizeProjectOptionsV1(changed)).not.toBe(canonicalizeProjectOptionsV1(first));
  expect(hashProjectOptionsV1(changed)).not.toBe(hashProjectOptionsV1(first));
});

test("uses code-unit lexical ordering rather than locale-aware ordering", () => {
  const options = {
    ...minimalOptions(),
    namedVolumes: [{ key: "a-volume", kind: "data" }],
    developmentEnvironment: {
      source: { kind: "image", imageReference: "node:24" },
      volumes: [
        { volumeKey: "a-volume", mountPath: "/a" },
        { volumeKey: "a-volume", mountPath: "/A" }
      ]
    }
  };
  const canonical = canonicalizeProjectOptionsV1(options);

  expect(canonical.indexOf('"mountPath":"/A"')).toBeLessThan(
    canonical.indexOf('"mountPath":"/a"')
  );
});

test("uses the exact version prefix, lowercase hex, and unambiguous zero-byte domain frame", () => {
  const canonicalBytes = canonicalizeProjectOptionsV1Bytes(minimalOptions());
  const rawDigest = createHash("sha256").update(canonicalBytes).digest("hex");
  const framedDigest = createHash("sha256")
    .update("devspace/project-options-revision/v1", "utf8")
    .update(Uint8Array.of(0))
    .update(canonicalBytes)
    .digest("hex");
  const revisionHash = hashProjectOptionsV1(minimalOptions());

  expect(revisionHash).toMatch(/^sha256-jcs-v1:[0-9a-f]{64}$/);
  expect(revisionHash).toBe(`sha256-jcs-v1:${framedDigest}`);
  expect(framedDigest).not.toBe(rawDigest);
});

test("rejects general/workspace/database metadata instead of allowing it into revision bytes", () => {
  for (const excluded of [
    { general: { name: "Project" } },
    { workspaceDisplayName: "Primary" },
    { revisionId: "018f0f00-0000-7000-8000-000000000001" },
    { createdAt: "2026-07-15T00:00:00.000Z" }
  ]) {
    expect(() => hashProjectOptionsV1({ ...minimalOptions(), ...excluded })).toThrow();
  }
});

test("rejects invalid input through the authoritative Project Options parser", () => {
  expect(() => hashProjectOptionsV1({
    ...minimalOptions(),
    developmentEnvironment: { source: { kind: "image", imageReference: "node:24" } },
    tasks: [{ key: "invalid", displayName: "Invalid", command: { executable: "echo" }, extra: true }]
  })).toThrowError(expect.objectContaining({ name: "ZodError" }));
});
