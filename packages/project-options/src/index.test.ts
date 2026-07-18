import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as packageEntry from "@devspace/project-options";
import {
  PROJECT_OPTIONS_MAX_TIMEOUT_SECONDS,
  generateProjectOptionsV1JsonSchema,
  parseProjectOptionsV1,
  projectOptionsV1JsonSchema,
  safeParseProjectOptionsV1
} from "@devspace/project-options";

const uuidV7 = "018f0f00-0000-7000-8000-000000000001";

function minimalOptions(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    developmentEnvironment: {
      source: {
        kind: "image",
        imageReference: "node:24"
      }
    }
  };
}

function completeOptions(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    namedVolumes: [
      { key: "pnpm-store", kind: "cache" },
      { key: "postgres-data", kind: "data" }
    ],
    developmentEnvironment: {
      source: {
        kind: "dockerfile",
        dockerfilePath: "Dockerfile",
        contextPath: "."
      },
      containerUser: "devspace",
      passwordlessSudo: true,
      workingDirectory: "/workspace",
      environment: {
        NODE_ENV: { kind: "literal", value: "development" },
        CI_TOKEN: { kind: "host", variable: "CI_TOKEN" },
        DATABASE_URL: { kind: "service", serviceKey: "postgres", valueKey: "connection-url" },
        API_KEY: { kind: "secret", secretId: uuidV7 },
        PREVIEW_URL: { kind: "generated", valueKey: "preview-url" }
      },
      ports: [
        { name: "web", containerPort: 3000 },
        { name: "debug", containerPort: 9229, protocol: "tcp" }
      ],
      volumes: [
        { volumeKey: "pnpm-store", mountPath: "/home/devspace/.local/share/pnpm/store" }
      ],
      setupSteps: [
        {
          executable: "pnpm",
          args: ["install", "--frozen-lockfile"],
          workingDirectory: ".",
          environment: {}
        }
      ],
      rebuildPolicy: "on-revision-change"
    },
    tasks: [
      {
        key: "test",
        displayName: "Run tests",
        command: {
          executable: "pnpm",
          args: ["test"],
          workingDirectory: ".",
          environment: {}
        },
        interactive: false,
        longRunning: false,
        timeoutSeconds: 900,
        concurrencyPolicy: "reject",
        successExitCodes: [0],
        logRetentionDays: null
      }
    ],
    services: [
      {
        key: "postgres",
        imageReference: "postgres:16",
        environment: {
          POSTGRES_DB: { kind: "literal", value: "app" }
        },
        volumes: [
          { volumeKey: "postgres-data", mountPath: "/var/lib/postgresql/data" }
        ],
        ports: [
          { name: "postgres", containerPort: 5432 }
        ],
        entrypoint: null,
        command: ["postgres"],
        workingDirectory: null,
        healthCheck: {
          kind: "http",
          portName: "postgres",
          path: "/health",
          expectedStatuses: [200, 204]
        },
        dependsOn: [],
        resources: {
          cpuMillicores: 500,
          memoryBytes: 536870912
        }
      }
    ],
    previews: [
      {
        key: "web",
        displayName: "Web preview",
        target: { kind: "workspace" },
        containerPort: 3000,
        domainBaseId: "preview-main",
        hostnamePattern: "{project}-{workspace}-{preview}-{shortId}",
        protocol: "http",
        healthPath: "/",
        healthStatuses: [200],
        startupTimeoutSeconds: 60,
        webSocketForwarding: true
      },
      {
        key: "database",
        displayName: "Database preview",
        target: { kind: "service", serviceKey: "postgres" },
        containerPort: 5432,
        domainBaseId: "preview-main",
        hostnamePattern: "{project}-{preview}",
        protocol: "http",
        healthPath: "/health",
        healthStatuses: [200],
        startupTimeoutSeconds: 90,
        webSocketForwarding: false
      }
    ],
    aiProfile: {
      providerKey: "openai",
      executableProfileKey: "codex-cli",
      fixedArgs: ["--project-dir", "."],
      credentialSecretIds: [uuidV7],
      instructionsFilePath: "AGENTS.md",
      networkDisclosureAcknowledged: true
    },
    resources: {
      cpuMillicores: 4000,
      memoryBytes: 8589934592,
      pidLimit: 2048,
      maxNamedVolumeBytes: 10737418240,
      logRetentionDays: 30,
      stoppedWorkspaceRetentionDays: 14,
      automaticStopMinutes: 120,
      maxConcurrentWorkspaces: 3
    }
  };
}

const taskExecutionFieldCombinations = [false, true].flatMap((interactive) =>
  [false, true].flatMap((longRunning) =>
    [null, 60].flatMap((timeoutSeconds) =>
      ["reject", "allow", "replace"].map((concurrencyPolicy) => ({
        interactive,
        longRunning,
        timeoutSeconds,
        concurrencyPolicy
      }))
    )
  )
);

function issueMessages(input: unknown): readonly string[] {
  const result = safeParseProjectOptionsV1(input);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => issue.message);
}

function issuePaths(input: unknown): readonly string[] {
  const result = safeParseProjectOptionsV1(input);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => issue.path.join("."));
}

function issueCodes(input: unknown): readonly string[] {
  const result = safeParseProjectOptionsV1(input);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => issue.code);
}

function schemaNode(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function schemaChild(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  return schemaNode(parent[key]);
}

function schemaArray(value: unknown): readonly unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as readonly unknown[];
}

function expectUnknownPropertyRejection(input: unknown): void {
  const result = safeParseProjectOptionsV1(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
  }
}

test("parses the smallest valid Project Options v1 document and materializes defaults", () => {
  const parsed = parseProjectOptionsV1(minimalOptions());

  expect(parsed).toMatchObject({
    schemaVersion: 1,
    namedVolumes: [],
    tasks: [],
    services: [],
    previews: [],
    aiProfile: null,
    developmentEnvironment: {
      containerUser: null,
      passwordlessSudo: false,
      workingDirectory: "/workspace",
      environment: {},
      ports: [],
      volumes: [],
      setupSteps: [],
      rebuildPolicy: "manual"
    },
    resources: {
      cpuMillicores: null,
      memoryBytes: null,
      pidLimit: null,
      maxNamedVolumeBytes: null,
      logRetentionDays: null,
      stoppedWorkspaceRetentionDays: null,
      automaticStopMinutes: null,
      maxConcurrentWorkspaces: null
    }
  });
});

test("parses a fully populated document across every runtime configuration area", () => {
  const parsed = parseProjectOptionsV1(completeOptions());

  expect(parsed.namedVolumes).toHaveLength(2);
  expect(parsed.developmentEnvironment.setupSteps).toHaveLength(1);
  expect(parsed.tasks[0]?.successExitCodes).toEqual([0]);
  expect(parsed.services[0]?.healthCheck?.kind).toBe("http");
  expect(parsed.previews).toHaveLength(2);
  expect(parsed.aiProfile?.credentialSecretIds).toEqual([uuidV7]);
  expect(parsed.resources.maxConcurrentWorkspaces).toBe(3);
});

test.each(taskExecutionFieldCombinations)(
  "accepts every structurally valid task execution-field combination",
  ({ interactive, longRunning, timeoutSeconds, concurrencyPolicy }) => {
    const input = minimalOptions() as { tasks: Array<Record<string, unknown>> };
    input.tasks = [{
      key: "task",
      displayName: "Task",
      command: { executable: "echo" },
      interactive,
      longRunning,
      timeoutSeconds,
      concurrencyPolicy
    }];

    const parsed = parseProjectOptionsV1(input);
    expect(parsed.tasks[0]).toMatchObject({
      interactive,
      longRunning,
      timeoutSeconds,
      concurrencyPolicy
    });
  }
);

test("covers the complete finite task execution-field combination space", () => {
  expect(taskExecutionFieldCombinations).toHaveLength(24);
});

test("bounds task timeoutSeconds to the Agent timer-safe maximum", () => {
  const input = minimalOptions() as { tasks: Array<Record<string, unknown>> };
  input.tasks = [{ key: "task", displayName: "Task", command: { executable: "sleep" },
    timeoutSeconds: PROJECT_OPTIONS_MAX_TIMEOUT_SECONDS }];
  expect(parseProjectOptionsV1(input).tasks[0]?.timeoutSeconds).toBe(PROJECT_OPTIONS_MAX_TIMEOUT_SECONDS);

  input.tasks[0]!.timeoutSeconds = PROJECT_OPTIONS_MAX_TIMEOUT_SECONDS + 1;
  expect(safeParseProjectOptionsV1(input).success).toBe(false);
  input.tasks[0]!.timeoutSeconds = Number.MAX_SAFE_INTEGER;
  expect(safeParseProjectOptionsV1(input).success).toBe(false);
  input.tasks[0]!.timeoutSeconds = Number.MAX_VALUE;
  expect(safeParseProjectOptionsV1(input).success).toBe(false);
});

test("parses the checked-in Project Options v1 example through the public parser", () => {
  const example = JSON.parse(readFileSync(
    new URL("../../../schemas/examples/project-options-v1.example.json", import.meta.url),
    "utf8"
  )) as unknown;

  expect(safeParseProjectOptionsV1(example).success).toBe(true);
});

test("keeps general project and workspace metadata outside the runtime revision", () => {
  const input = { ...minimalOptions(), general: { name: "Not allowed" } };
  const result = safeParseProjectOptionsV1(input);

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    expect(result.error.issues.some((issue) => issue.path.length === 0)).toBe(true);
  }
});

test("rejects missing required fields and invalid discriminators or enums", () => {
  expect(issuePaths({})).toEqual(expect.arrayContaining(["schemaVersion", "developmentEnvironment"]));
  expect(issuePaths({ schemaVersion: 1 })).toContain("developmentEnvironment");
  expect(issuePaths({
    schemaVersion: 1,
    developmentEnvironment: { source: { kind: "unknown" } }
  })).toContain("developmentEnvironment.source.kind");

  const invalidProtocol = minimalOptions() as { developmentEnvironment: Record<string, unknown> };
  invalidProtocol.developmentEnvironment.ports = [
    { name: "web", containerPort: 3000, protocol: "udp" }
  ];
  expect(issuePaths(invalidProtocol)).toContain("developmentEnvironment.ports.0.protocol");
});

test("uses security policies for repository-relative paths, preview patterns, names, and UUIDv7 IDs", () => {
  const dockerfileInput = minimalOptions() as { developmentEnvironment: Record<string, unknown> };
  dockerfileInput.developmentEnvironment.source = {
    kind: "dockerfile",
    dockerfilePath: "../Dockerfile"
  };
  expect(issueMessages(dockerfileInput)).toContain("RELATIVE_PATH_TRAVERSAL_SEGMENT");

  const invalidComplete = completeOptions() as { aiProfile: Record<string, unknown> };
  invalidComplete.aiProfile.instructionsFilePath = "../AGENTS.md";
  expect(issueMessages(invalidComplete)).toContain("RELATIVE_PATH_TRAVERSAL_SEGMENT");

  const invalidPattern = completeOptions() as { previews: Array<Record<string, unknown>> };
  invalidPattern.previews[0]!.hostnamePattern = "{project}.{workspace}";
  expect(issueMessages(invalidPattern)).toContain("PREVIEW_PATTERN_MULTIPLE_LABELS");

  const invalidSecret = completeOptions() as {
    developmentEnvironment: { environment: Record<string, Record<string, unknown>> };
  };
  invalidSecret.developmentEnvironment.environment.API_KEY = {
    kind: "secret",
    secretId: "018f0f00-0000-4000-8000-000000000001"
  };
  expect(issueMessages(invalidSecret)).toContain("PROJECT_OPTIONS_INVALID_UUID_V7");
});

test("enforces identifier, environment-name, mount-path, port, status, and positive-resource bounds", () => {
  const input = minimalOptions() as { developmentEnvironment: Record<string, unknown> };
  input.developmentEnvironment.environment = {
    "not-an-environment-name": { kind: "literal", value: "x" }
  };
  input.developmentEnvironment.ports = [
    { name: "web", containerPort: 0 }
  ];
  input.developmentEnvironment.volumes = [
    { volumeKey: "missing", mountPath: "/workspace/../escape" }
  ];
  input.developmentEnvironment.source = {
    kind: "image",
    imageReference: "node:24"
  };

  const messages = issueMessages(input);
  expect(messages).toContain("INVALID_CONTAINER_MOUNT_PATH");
  expect(issueCodes(input)).toContain("invalid_key");
  expect(safeParseProjectOptionsV1({
    ...minimalOptions(),
    resources: { cpuMillicores: 0 }
  }).success).toBe(false);
  expect(safeParseProjectOptionsV1({
    ...minimalOptions(),
    developmentEnvironment: {
      source: { kind: "image", imageReference: "node:24" },
      ports: [{ name: "web", containerPort: 65536 }]
    }
  }).success).toBe(false);
});

test("rejects duplicate keyed definitions, ports, and unordered scalar sets", () => {
  const input = completeOptions() as {
    namedVolumes: Array<Record<string, unknown>>;
    tasks: Array<Record<string, unknown>>;
    developmentEnvironment: { ports: Array<Record<string, unknown>> };
  };
  input.namedVolumes.push({ key: "pnpm-store", kind: "data" });
  input.tasks.push({ ...input.tasks[0]!, key: "test" });
  input.developmentEnvironment.ports.push({ name: "web", containerPort: 3000 });

  const messages = issueMessages(input);
  expect(messages).toEqual(expect.arrayContaining([
    "DUPLICATE_NAMED_VOLUME_KEY",
    "DUPLICATE_TASK_KEY",
    "DUPLICATE_PORT_NAME",
    "DUPLICATE_PORT_NUMBER"
  ]));
});

test("rejects invalid volume, service, health-check, dependency, binding, and preview references", () => {
  const input = completeOptions() as {
    developmentEnvironment: {
      volumes: Array<Record<string, unknown>>;
      environment: Record<string, Record<string, unknown>>;
    };
    services: Array<Record<string, unknown>>;
    previews: Array<Record<string, unknown>>;
  };
  input.developmentEnvironment.volumes[0]!.volumeKey = "missing-volume";
  input.developmentEnvironment.environment.DATABASE_URL!.serviceKey = "missing-service";
  const service = input.services[0]!;
  service.healthCheck = {
    kind: "tcp",
    portName: "missing-port"
  };
  service.dependsOn = [{ serviceKey: "missing-service", condition: "started" }];
  input.previews[1]!.target = { kind: "service", serviceKey: "missing-service" };

  expect(issueMessages(input)).toEqual(expect.arrayContaining([
    "UNKNOWN_VOLUME_KEY",
    "INVALID_SERVICE_CONNECTION",
    "UNKNOWN_HEALTH_CHECK_PORT",
    "UNKNOWN_SERVICE_KEY",
    "UNKNOWN_PREVIEW_SERVICE"
  ]));
});

test("rejects cyclic service dependencies", () => {
  const input = completeOptions() as { services: Array<Record<string, unknown>> };
  const postgres = input.services[0]!;
  postgres.dependsOn = [{ serviceKey: "redis", condition: "started" }];
  input.services.push({
    ...postgres,
    key: "redis",
    imageReference: "redis:7",
    ports: [],
    volumes: [],
    healthCheck: null,
    dependsOn: [{ serviceKey: "postgres", condition: "started" }]
  });

  expect(issueMessages(input)).toContain("SERVICE_DEPENDENCY_CYCLE");
});

test("requires workspace and service preview ports to be declared by their target", () => {
  const workspaceInput = minimalOptions() as { previews: Array<Record<string, unknown>> };
  workspaceInput.previews = [{
    key: "web",
    displayName: "Web",
    target: { kind: "workspace" },
    containerPort: 3000,
    domainBaseId: "preview-main",
    hostnamePattern: "{project}-{preview}"
  }];
  expect(issueMessages(workspaceInput)).toContain("UNKNOWN_PREVIEW_PORT");

  const serviceInput = completeOptions() as { previews: Array<Record<string, unknown>> };
  serviceInput.previews[1]!.containerPort = 9999;
  expect(issueMessages(serviceInput)).toContain("UNKNOWN_PREVIEW_PORT");
});

test("accepts valid preview-port references through the public parser", () => {
  expect(safeParseProjectOptionsV1(completeOptions()).success).toBe(true);
});

test("rejects unknown properties at nested levels", () => {
  const input = minimalOptions() as { developmentEnvironment: Record<string, unknown> };
  input.developmentEnvironment.forbiddenHostMount = "/etc";

  const result = safeParseProjectOptionsV1(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    expect(result.error.issues.some((issue) => issue.path.join(".") === "developmentEnvironment")).toBe(true);
  }
});

test("keeps every source, binding, health-check, and preview-target variant recursively strict", () => {
  const sourceVariants = [
    { kind: "preset", presetKey: "node", runtimeVersion: "24", unexpected: true },
    { kind: "image", imageReference: "node:24", unexpected: true },
    { kind: "dockerfile", dockerfilePath: "Dockerfile", unexpected: true }
  ];
  for (const source of sourceVariants) {
    const input = minimalOptions() as { developmentEnvironment: Record<string, unknown> };
    input.developmentEnvironment.source = source;
    expectUnknownPropertyRejection(input);
  }

  const bindingVariants = [
    { kind: "literal", value: "x", unexpected: true },
    { kind: "host", variable: "CI_TOKEN", unexpected: true },
    { kind: "secret", secretId: uuidV7, unexpected: true },
    { kind: "generated", valueKey: "preview-url", unexpected: true },
    { kind: "service", serviceKey: "postgres", valueKey: "connection-url", unexpected: true }
  ];
  for (const binding of bindingVariants) {
    const input = completeOptions() as {
      developmentEnvironment: { environment: Record<string, unknown> };
    };
    input.developmentEnvironment.environment.TEST_VALUE = binding;
    expectUnknownPropertyRejection(input);
  }

  const healthCheckVariants = [
    { kind: "http", portName: "postgres", unexpected: true },
    { kind: "tcp", portName: "postgres", unexpected: true },
    {
      kind: "command",
      command: { executable: "healthcheck", unexpected: true },
      unexpected: true
    }
  ];
  for (const healthCheck of healthCheckVariants) {
    const input = completeOptions() as { services: Array<Record<string, unknown>> };
    input.services[0]!.healthCheck = healthCheck;
    expectUnknownPropertyRejection(input);
  }

  const targetVariants = [
    { kind: "workspace", unexpected: true },
    { kind: "service", serviceKey: "postgres", unexpected: true }
  ];
  for (const target of targetVariants) {
    const input = completeOptions() as { previews: Array<Record<string, unknown>> };
    input.previews[0]!.target = target;
    expectUnknownPropertyRejection(input);
  }
});

test("rejects duplicate service and preview keys", () => {
  const input = completeOptions() as {
    services: Array<Record<string, unknown>>;
    previews: Array<Record<string, unknown>>;
  };
  input.services.push({ ...input.services[0]! });
  input.previews.push({ ...input.previews[0]! });

  expect(issueMessages(input)).toEqual(expect.arrayContaining([
    "DUPLICATE_SERVICE_KEY",
    "DUPLICATE_PREVIEW_KEY"
  ]));
});

test("rejects self-dependencies and dependency cycles longer than two nodes", () => {
  const selfDependency = completeOptions() as { services: Array<Record<string, unknown>> };
  selfDependency.services[0]!.dependsOn = [{ serviceKey: "postgres", condition: "started" }];
  expect(issueMessages(selfDependency)).toContain("SELF_SERVICE_DEPENDENCY");

  const baseService = completeOptions() as { services: Array<Record<string, unknown>> };
  const postgres = { ...baseService.services[0]!, dependsOn: [{ serviceKey: "redis", condition: "started" }] };
  const redis = {
    ...baseService.services[0]!,
    key: "redis",
    ports: [],
    healthCheck: null,
    dependsOn: [{ serviceKey: "worker", condition: "started" }]
  };
  const worker = {
    ...baseService.services[0]!,
    key: "worker",
    ports: [],
    healthCheck: null,
    dependsOn: [{ serviceKey: "postgres", condition: "started" }]
  };
  baseService.services = [postgres, redis, worker];

  expect(issueMessages(baseService)).toContain("SERVICE_DEPENDENCY_CYCLE");
});

test("does not resolve similar-but-different names as valid references", () => {
  const input = completeOptions() as {
    developmentEnvironment: {
      volumes: Array<Record<string, unknown>>;
      environment: Record<string, Record<string, unknown>>;
    };
    previews: Array<Record<string, unknown>>;
  };
  input.developmentEnvironment.volumes[0]!.volumeKey = "pnpm-store-extra";
  input.developmentEnvironment.environment.DATABASE_URL!.serviceKey = "postgre";
  input.previews[1]!.target = { kind: "service", serviceKey: "postgres-extra" };

  expect(issueMessages(input)).toEqual(expect.arrayContaining([
    "UNKNOWN_VOLUME_KEY",
    "INVALID_SERVICE_CONNECTION",
    "UNKNOWN_PREVIEW_SERVICE"
  ]));
});

test("enforces service-specific and workspace-specific preview port ownership", () => {
  const serviceOnlyPort = completeOptions() as { previews: Array<Record<string, unknown>> };
  serviceOnlyPort.previews[0]!.containerPort = 5432;
  expect(issueMessages(serviceOnlyPort)).toContain("UNKNOWN_PREVIEW_PORT");

  const workspaceOnlyPort = completeOptions() as { previews: Array<Record<string, unknown>> };
  workspaceOnlyPort.previews[1]!.containerPort = 3000;
  expect(issueMessages(workspaceOnlyPort)).toContain("UNKNOWN_PREVIEW_PORT");
});

test("covers Project Options security-policy edge cases through public parsing", () => {
  const windowsContext = minimalOptions() as { developmentEnvironment: Record<string, unknown> };
  windowsContext.developmentEnvironment.source = {
    kind: "dockerfile",
    dockerfilePath: "Dockerfile",
    contextPath: "C:\\workspace"
  };
  expect(issueMessages(windowsContext)).toContain("RELATIVE_PATH_WINDOWS_DRIVE");

  const currentSegment = completeOptions() as {
    tasks: Array<{ command: Record<string, unknown> }>;
  };
  currentSegment.tasks[0]!.command.workingDirectory = "./src";
  expect(issueMessages(currentSegment)).toContain("RELATIVE_PATH_CURRENT_SEGMENT");

  const hostname = completeOptions() as { previews: Array<Record<string, unknown>> };
  hostname.previews[0]!.hostnamePattern = "{project}-{project}";
  expect(issueMessages(hostname)).toContain("PREVIEW_PATTERN_REPEATED_PLACEHOLDER");
});

test("materializes defaults when an optional nested parent configuration is omitted", () => {
  const parsed = parseProjectOptionsV1({
    schemaVersion: 1,
    developmentEnvironment: {
      source: { kind: "image", imageReference: "redis:7" }
    },
    services: [{ key: "redis", imageReference: "redis:7" }]
  });

  expect(parsed.services[0]).toMatchObject({
    environment: {},
    volumes: [],
    ports: [],
    entrypoint: null,
    command: null,
    workingDirectory: null,
    healthCheck: null,
    dependsOn: [],
    resources: { cpuMillicores: null, memoryBytes: null }
  });
});

test("generates a deterministic JSON Schema 2020-12 artifact from the public Zod source", () => {
  const generated = generateProjectOptionsV1JsonSchema();

  expect(generated).toEqual(projectOptionsV1JsonSchema);
  expect(generated.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  expect(generated.$id).toBe("https://devspace.local/schemas/project-options-v1.schema.json");
  expect(generated.title).toBe("DevSpace Project Options v1");
  expect(generated.additionalProperties).toBe(false);
  expect(generated.properties).toHaveProperty("developmentEnvironment");
  expect(generated.properties).not.toHaveProperty("general");
  expect(generated.properties).not.toHaveProperty("workspaceDefaults");
  expect(JSON.stringify(generated)).toBe(JSON.stringify(generateProjectOptionsV1JsonSchema()));

  const root = schemaNode(generated);
  const developmentEnvironment = schemaChild(schemaChild(root, "properties"), "developmentEnvironment");
  expect(developmentEnvironment.additionalProperties).toBe(false);
  const developmentProperties = schemaChild(developmentEnvironment, "properties");
  const volumeItems = schemaChild(schemaChild(developmentProperties, "volumes"), "items");
  const mountPath = schemaChild(schemaChild(volumeItems, "properties"), "mountPath");
  const previewItems = schemaChild(schemaChild(schemaChild(root, "properties"), "previews"), "items");
  const hostnamePattern = schemaChild(schemaChild(previewItems, "properties"), "hostnamePattern");
  const sourceVariants = schemaArray(schemaChild(schemaChild(developmentProperties, "source"), "oneOf"));
  for (const sourceVariant of sourceVariants) {
    expect(schemaNode(sourceVariant).additionalProperties).toBe(false);
  }

  expect(mountPath.pattern).toContain("\\.{1,2}");
  expect(hostnamePattern.pattern).toContain("project");
  expect(schemaChild(schemaChild(schemaNode(sourceVariants[0]), "properties"), "presetKey").pattern)
    .toBe("^[a-z][a-z0-9-]*$");
  expect(schemaChild(schemaChild(developmentProperties, "environment"), "propertyNames").pattern)
    .toBe("^[A-Z_][A-Z0-9_]*$");
  expect(schemaChild(schemaChild(developmentProperties, "ports"), "items").type).toBe("object");
  expect(schemaChild(
    schemaChild(schemaChild(schemaChild(developmentProperties, "ports"), "items"), "properties"),
    "containerPort"
  )).toMatchObject({ minimum: 1, maximum: 65535 });
  const taskItems = schemaChild(schemaChild(schemaChild(root, "properties"), "tasks"), "items");
  const timeoutSchema = schemaChild(schemaChild(taskItems, "properties"), "timeoutSeconds");
  expect(schemaNode(schemaArray(timeoutSchema.anyOf)[0])).toMatchObject({
    exclusiveMinimum: 0, maximum: PROJECT_OPTIONS_MAX_TIMEOUT_SECONDS
  });
  expect(schemaChild(schemaChild(schemaNode(sourceVariants[2]), "properties"), "dockerfilePath").pattern).toBeUndefined();
});

test("loads all validation behavior through the package-root import without requiring dist output", () => {
  expect(safeParseProjectOptionsV1(minimalOptions()).success).toBe(true);
});

test("keeps the package-root API focused on Project Options contracts", () => {
  expect("projectOptionsValidationIssueCodes" in packageEntry).toBe(false);
  expect(typeof packageEntry.canonicalizeProjectOptionsV1).toBe("function");
  expect(typeof packageEntry.canonicalizeProjectOptionsV1Bytes).toBe("function");
  expect(typeof packageEntry.hashProjectOptionsV1).toBe("function");
  expect("canonicalizeJson" in packageEntry).toBe(false);
  expect("canonicalizeJsonBytes" in packageEntry).toBe(false);
  expect("JsonPrimitive" in packageEntry).toBe(false);
  expect("JsonValue" in packageEntry).toBe(false);
});
