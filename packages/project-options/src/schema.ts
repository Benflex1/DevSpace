import * as z from "zod";
import {
  validateDockerBuildContextPath,
  validateDockerfilePath,
  validateInstructionsFilePath,
  validatePreviewHostnamePattern,
  validateWorktreeWorkingDirectoryPath,
  type ValidationResult
} from "@devspace/security";

const keyPattern = /^[a-z][a-z0-9-]*$/;
const environmentVariablePattern = /^[A-Z_][A-Z0-9_]*$/;
const canonicalUuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const containerMountPattern = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))\/(?:[^/\\\0]+(?:\/[^/\\\0]+)*)?$/;
const previewHostnamePatternPortablePattern = /^(?:[a-z0-9-]|\{(?:project|workspace|preview|shortId)\})+$/;

type ProjectOptionsValidationIssueCode =
  | "DUPLICATE_NAMED_VOLUME_KEY"
  | "DUPLICATE_TASK_KEY"
  | "DUPLICATE_SERVICE_KEY"
  | "DUPLICATE_PREVIEW_KEY"
  | "DUPLICATE_PORT_NAME"
  | "DUPLICATE_PORT_NUMBER"
  | "DUPLICATE_VOLUME_MOUNT"
  | "DUPLICATE_SERVICE_DEPENDENCY"
  | "DUPLICATE_SUCCESS_EXIT_CODE"
  | "DUPLICATE_HEALTH_STATUS"
  | "DUPLICATE_PREVIEW_HEALTH_STATUS"
  | "DUPLICATE_CREDENTIAL_SECRET_ID"
  | "UNKNOWN_VOLUME_KEY"
  | "UNKNOWN_SERVICE_KEY"
  | "SELF_SERVICE_DEPENDENCY"
  | "SERVICE_DEPENDENCY_CYCLE"
  | "UNKNOWN_HEALTH_CHECK_PORT"
  | "UNKNOWN_PREVIEW_SERVICE"
  | "UNKNOWN_PREVIEW_PORT"
  | "INVALID_SERVICE_CONNECTION"
  | "INVALID_CONTAINER_MOUNT_PATH";

type IssueContext = z.core.$RefinementCtx<unknown>;

function addIssue(
  context: IssueContext,
  code: string,
  path: readonly (string | number)[],
  details: Readonly<Record<string, unknown>> = {}
): void {
  context.addIssue({
    code: "custom",
    path: [...path],
    message: code,
    params: { code, ...details }
  });
}

function unicodeString(): z.ZodString {
  return z.string().superRefine((value, context) => {
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const nextCodeUnit = value.charCodeAt(index + 1);
        if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
          addIssue(context, "PROJECT_OPTIONS_INVALID_UNICODE", []);
        } else {
          index += 1;
        }
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        addIssue(context, "PROJECT_OPTIONS_INVALID_UNICODE", []);
      }
    }
  });
}

function text(options: { readonly min?: number; readonly max?: number } = {}): z.ZodString {
  let schema = unicodeString();
  if (options.min !== undefined) {
    schema = schema.min(options.min, { error: "PROJECT_OPTIONS_STRING_TOO_SHORT" });
  }
  if (options.max !== undefined) {
    schema = schema.max(options.max, { error: "PROJECT_OPTIONS_STRING_TOO_LONG" });
  }
  return schema;
}

const nonEmptyText = (max?: number): z.ZodString => max === undefined
  ? text({ min: 1 })
  : text({ min: 1, max });
const keySchema = text({ min: 1 }).regex(keyPattern, {
  error: "PROJECT_OPTIONS_INVALID_KEY"
});
const environmentVariableNameSchema = text({ min: 1 }).regex(
  environmentVariablePattern,
  { error: "PROJECT_OPTIONS_INVALID_ENVIRONMENT_VARIABLE_NAME" }
);
const registryKeySchema = keySchema;
const displayNameSchema = nonEmptyText();
const positiveInteger = z.number().int().positive();
const nullablePositiveInteger = positiveInteger.nullable().default(null);
const portNumberSchema = z.number().int().min(1).max(65535);
const httpStatusSchema = z.number().int().min(100).max(599);

const uuidV7Schema = text({ min: 36, max: 36 }).regex(canonicalUuidV7Pattern, {
  error: "PROJECT_OPTIONS_INVALID_UUID_V7"
});

function securityCheckedString(
  validator: (input: string) => ValidationResult<unknown>,
  baseSchema = text({ min: 1 })
): z.ZodString {
  return baseSchema.superRefine((value, context) => {
    const result = validator(value);
    if (!result.ok) {
      addIssue(context, result.error.code, [], {
        securityCategory: result.error.category,
        securityPolicy: result.error.policy,
        securityDetails: result.error.details
      });
    }
  });
}

const dockerfilePathSchema = securityCheckedString(validateDockerfilePath);
const dockerBuildContextPathSchema = securityCheckedString(validateDockerBuildContextPath);
const worktreeWorkingDirectoryPathSchema = securityCheckedString(
  validateWorktreeWorkingDirectoryPath
);
const instructionsFilePathSchema = securityCheckedString(validateInstructionsFilePath);
const previewHostnamePatternSchema = securityCheckedString(
  validatePreviewHostnamePattern,
  text({ min: 1 }).regex(previewHostnamePatternPortablePattern, {
    error: "PROJECT_OPTIONS_INVALID_HOSTNAME_PATTERN_STRUCTURE"
  })
);

const containerMountPathSchema = text({ min: 1 }).regex(containerMountPattern, {
  error: "INVALID_CONTAINER_MOUNT_PATH"
});

const environmentBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("literal"),
    value: text()
  }),
  z.strictObject({
    kind: z.literal("host"),
    variable: environmentVariableNameSchema
  }),
  z.strictObject({
    kind: z.literal("secret"),
    secretId: uuidV7Schema
  }),
  z.strictObject({
    kind: z.literal("generated"),
    valueKey: registryKeySchema
  }),
  z.strictObject({
    kind: z.literal("service"),
    serviceKey: keySchema,
    valueKey: registryKeySchema
  })
]);

const environmentMapSchema = z.record(environmentVariableNameSchema, environmentBindingSchema);

const commandSchema = z.strictObject({
  executable: nonEmptyText(),
  args: z.array(text()).default([]),
  workingDirectory: worktreeWorkingDirectoryPathSchema.default("."),
  environment: environmentMapSchema.default({})
});

const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("preset"),
    presetKey: registryKeySchema,
    runtimeVersion: nonEmptyText()
  }),
  z.strictObject({
    kind: z.literal("image"),
    imageReference: nonEmptyText()
  }),
  z.strictObject({
    kind: z.literal("dockerfile"),
    dockerfilePath: dockerfilePathSchema,
    contextPath: dockerBuildContextPathSchema.default(".")
  })
]);

const namedVolumeSchema = z.strictObject({
  key: keySchema,
  kind: z.enum(["cache", "data"])
});

const portSchema = z.strictObject({
  name: keySchema,
  containerPort: portNumberSchema,
  protocol: z.literal("tcp").default("tcp")
});

const volumeMountSchema = z.strictObject({
  volumeKey: keySchema,
  mountPath: containerMountPathSchema
});

const developmentEnvironmentSchema = z.strictObject({
  source: sourceSchema,
  containerUser: nonEmptyText().nullable().default(null),
  passwordlessSudo: z.boolean().default(false),
  workingDirectory: z.literal("/workspace").default("/workspace"),
  environment: environmentMapSchema.default({}),
  ports: z.array(portSchema).default([]),
  volumes: z.array(volumeMountSchema).default([]),
  setupSteps: z.array(commandSchema).default([]),
  rebuildPolicy: z.enum(["manual", "on-revision-change"]).default("manual")
});

const taskSchema = z.strictObject({
  key: keySchema,
  displayName: displayNameSchema,
  command: commandSchema,
  interactive: z.boolean().default(false),
  longRunning: z.boolean().default(false),
  timeoutSeconds: positiveInteger.nullable().default(null),
  concurrencyPolicy: z.enum(["reject", "allow", "replace"]).default("reject"),
  successExitCodes: z.array(z.number().int())
    .meta({ uniqueItems: true })
    .default([0]),
  logRetentionDays: positiveInteger.nullable().default(null)
});

const serviceHealthCheckSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("http"),
    portName: keySchema,
    path: text({ min: 1 }).regex(/^\//, { error: "PROJECT_OPTIONS_INVALID_HEALTH_PATH" }).default("/"),
    expectedStatuses: z.array(httpStatusSchema)
      .meta({ uniqueItems: true })
      .default([200])
  }),
  z.strictObject({
    kind: z.literal("tcp"),
    portName: keySchema
  }),
  z.strictObject({
    kind: z.literal("command"),
    command: commandSchema
  })
]);

const serviceDependencySchema = z.strictObject({
  serviceKey: keySchema,
  condition: z.enum(["started", "healthy"])
});

const serviceResourcesSchema = z.strictObject({
  cpuMillicores: nullablePositiveInteger,
  memoryBytes: nullablePositiveInteger
}).default({ cpuMillicores: null, memoryBytes: null });

const serviceSchema = z.strictObject({
  key: keySchema,
  imageReference: nonEmptyText(),
  environment: environmentMapSchema.default({}),
  volumes: z.array(volumeMountSchema).default([]),
  ports: z.array(portSchema).default([]),
  entrypoint: z.array(text())
    .min(1)
    .nullable()
    .default(null),
  command: z.array(text())
    .nullable()
    .default(null),
  workingDirectory: text({ min: 1 }).nullable().default(null),
  healthCheck: serviceHealthCheckSchema.nullable().default(null),
  dependsOn: z.array(serviceDependencySchema).default([]),
  resources: serviceResourcesSchema
});

const previewTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workspace") }),
  z.strictObject({ kind: z.literal("service"), serviceKey: keySchema })
]);

const previewSchema = z.strictObject({
  key: keySchema,
  displayName: displayNameSchema,
  target: previewTargetSchema,
  containerPort: portNumberSchema,
  domainBaseId: registryKeySchema,
  hostnamePattern: previewHostnamePatternSchema,
  protocol: z.literal("http").default("http"),
  healthPath: text({ min: 1 }).regex(/^\//, { error: "PROJECT_OPTIONS_INVALID_HEALTH_PATH" })
    .default("/"),
  healthStatuses: z.array(httpStatusSchema)
    .meta({ uniqueItems: true })
    .default([200]),
  startupTimeoutSeconds: positiveInteger.default(60),
  webSocketForwarding: z.boolean().default(true)
});

const aiProfileSchema = z.strictObject({
  providerKey: registryKeySchema,
  executableProfileKey: registryKeySchema,
  fixedArgs: z.array(text()).default([]),
  credentialSecretIds: z.array(uuidV7Schema)
    .meta({ uniqueItems: true })
    .default([]),
  instructionsFilePath: instructionsFilePathSchema.nullable().default(null),
  networkDisclosureAcknowledged: z.boolean().default(false)
});

const resourcesSchema = z.strictObject({
  cpuMillicores: nullablePositiveInteger,
  memoryBytes: nullablePositiveInteger,
  pidLimit: nullablePositiveInteger,
  maxNamedVolumeBytes: nullablePositiveInteger,
  logRetentionDays: nullablePositiveInteger,
  stoppedWorkspaceRetentionDays: nullablePositiveInteger,
  automaticStopMinutes: nullablePositiveInteger,
  maxConcurrentWorkspaces: nullablePositiveInteger
}).default({
  cpuMillicores: null,
  memoryBytes: null,
  pidLimit: null,
  maxNamedVolumeBytes: null,
  logRetentionDays: null,
  stoppedWorkspaceRetentionDays: null,
  automaticStopMinutes: null,
  maxConcurrentWorkspaces: null
});

const projectOptionsV1DocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  namedVolumes: z.array(namedVolumeSchema).default([]),
  developmentEnvironment: developmentEnvironmentSchema,
  tasks: z.array(taskSchema).default([]),
  services: z.array(serviceSchema).default([]),
  previews: z.array(previewSchema).default([]),
  aiProfile: aiProfileSchema.nullable().default(null),
  resources: resourcesSchema
});

type ProjectOptionsV1Document = z.output<typeof projectOptionsV1DocumentSchema>;

function addDuplicateIssues<T>(
  values: readonly T[],
  valueOf: (value: T) => string | number,
  path: readonly (string | number)[],
  field: string | undefined,
  code: ProjectOptionsValidationIssueCode,
  context: IssueContext
): void {
  const firstIndexByValue = new Map<string | number, number>();
  for (const [index, value] of values.entries()) {
    const selectedValue = valueOf(value);
    const firstIndex = firstIndexByValue.get(selectedValue);
    if (firstIndex !== undefined) {
      const issuePath = field === undefined ? [...path, index] : [...path, index, field];
      addIssue(context, code, issuePath, { firstIndex, value: selectedValue });
    } else {
      firstIndexByValue.set(selectedValue, index);
    }
  }
}

function validatePortCollection(
  ports: readonly z.output<typeof portSchema>[],
  path: readonly (string | number)[],
  context: IssueContext
): void {
  addDuplicateIssues(ports, (port) => port.name, path, "name", "DUPLICATE_PORT_NAME", context);
  addDuplicateIssues(
    ports,
    (port) => port.containerPort,
    path,
    "containerPort",
    "DUPLICATE_PORT_NUMBER",
    context
  );
}

function validateVolumeMounts(
  mounts: readonly z.output<typeof volumeMountSchema>[],
  path: readonly (string | number)[],
  namedVolumeKeys: ReadonlySet<string>,
  context: IssueContext
): void {
  addDuplicateIssues(
    mounts,
    (mount) => `${mount.volumeKey}\u0000${mount.mountPath}`,
    path,
    undefined,
    "DUPLICATE_VOLUME_MOUNT",
    context
  );
  for (const [index, mount] of mounts.entries()) {
    if (!namedVolumeKeys.has(mount.volumeKey)) {
      addIssue(context, "UNKNOWN_VOLUME_KEY", [...path, index, "volumeKey"], {
        volumeKey: mount.volumeKey
      });
    }
  }
}

function validateEnvironmentBindings(
  environment: Readonly<Record<string, z.output<typeof environmentBindingSchema>>>,
  path: readonly (string | number)[],
  serviceKeys: ReadonlySet<string>,
  context: IssueContext
): void {
  for (const [variableName, binding] of Object.entries(environment)) {
    if (binding.kind === "service" && !serviceKeys.has(binding.serviceKey)) {
      addIssue(context, "INVALID_SERVICE_CONNECTION", [...path, variableName, "serviceKey"], {
        serviceKey: binding.serviceKey,
        variableName
      });
    }
  }
}

function validateProjectOptionsCrossReferences(
  document: ProjectOptionsV1Document,
  context: IssueContext
): void {
  addDuplicateIssues(
    document.namedVolumes,
    (volume) => volume.key,
    ["namedVolumes"],
    "key",
    "DUPLICATE_NAMED_VOLUME_KEY",
    context
  );
  addDuplicateIssues(
    document.tasks,
    (task) => task.key,
    ["tasks"],
    "key",
    "DUPLICATE_TASK_KEY",
    context
  );
  addDuplicateIssues(
    document.services,
    (service) => service.key,
    ["services"],
    "key",
    "DUPLICATE_SERVICE_KEY",
    context
  );
  addDuplicateIssues(
    document.previews,
    (preview) => preview.key,
    ["previews"],
    "key",
    "DUPLICATE_PREVIEW_KEY",
    context
  );

  const namedVolumeKeys = new Set(document.namedVolumes.map((volume) => volume.key));
  const serviceKeys = new Set(document.services.map((service) => service.key));

  validatePortCollection(document.developmentEnvironment.ports, ["developmentEnvironment", "ports"], context);
  validateVolumeMounts(
    document.developmentEnvironment.volumes,
    ["developmentEnvironment", "volumes"],
    namedVolumeKeys,
    context
  );
  validateEnvironmentBindings(
    document.developmentEnvironment.environment,
    ["developmentEnvironment", "environment"],
    serviceKeys,
    context
  );
  for (const [index, command] of document.developmentEnvironment.setupSteps.entries()) {
    validateEnvironmentBindings(
      command.environment,
      ["developmentEnvironment", "setupSteps", index, "environment"],
      serviceKeys,
      context
    );
  }
  for (const [index, task] of document.tasks.entries()) {
    validateEnvironmentBindings(task.command.environment, ["tasks", index, "command", "environment"], serviceKeys, context);
    addDuplicateIssues(
      task.successExitCodes,
      (exitCode) => exitCode,
      ["tasks", index, "successExitCodes"],
      undefined,
      "DUPLICATE_SUCCESS_EXIT_CODE",
      context
    );
  }

  const serviceIndexByKey = new Map(document.services.map((service, index) => [service.key, index]));
  for (const [serviceIndex, service] of document.services.entries()) {
    const servicePath = ["services", serviceIndex] as const;
    validateEnvironmentBindings(service.environment, [...servicePath, "environment"], serviceKeys, context);
    validateVolumeMounts(service.volumes, [...servicePath, "volumes"], namedVolumeKeys, context);
    validatePortCollection(service.ports, [...servicePath, "ports"], context);
    addDuplicateIssues(
      service.dependsOn,
      (dependency) => dependency.serviceKey,
      [...servicePath, "dependsOn"],
      "serviceKey",
      "DUPLICATE_SERVICE_DEPENDENCY",
      context
    );
    for (const [dependencyIndex, dependency] of service.dependsOn.entries()) {
      const dependencyPath = [...servicePath, "dependsOn", dependencyIndex, "serviceKey"];
      if (!serviceKeys.has(dependency.serviceKey)) {
        addIssue(context, "UNKNOWN_SERVICE_KEY", dependencyPath, { serviceKey: dependency.serviceKey });
      } else if (dependency.serviceKey === service.key) {
        addIssue(context, "SELF_SERVICE_DEPENDENCY", dependencyPath, { serviceKey: dependency.serviceKey });
      }
    }

    const servicePortNames = new Set(service.ports.map((port) => port.name));
    if (service.healthCheck !== null
      && (service.healthCheck.kind === "http" || service.healthCheck.kind === "tcp")
      && !servicePortNames.has(service.healthCheck.portName)) {
      addIssue(context, "UNKNOWN_HEALTH_CHECK_PORT", [...servicePath, "healthCheck", "portName"], {
        portName: service.healthCheck.portName
      });
    }
    if (service.healthCheck?.kind === "http") {
      addDuplicateIssues(
        service.healthCheck.expectedStatuses,
        (status) => status,
        [...servicePath, "healthCheck", "expectedStatuses"],
        undefined,
        "DUPLICATE_HEALTH_STATUS",
        context
      );
    }
    if (service.healthCheck?.kind === "command") {
      validateEnvironmentBindings(
        service.healthCheck.command.environment,
        [...servicePath, "healthCheck", "command", "environment"],
        serviceKeys,
        context
      );
    }
  }

  const dependencyState = new Map<string, "visiting" | "visited">();
  const cycleKeys = new Set<string>();
  function visitService(serviceKey: string, stack: readonly string[]): void {
    const state = dependencyState.get(serviceKey);
    if (state === "visiting") {
      const cycleStart = stack.indexOf(serviceKey);
      for (const cycleKey of stack.slice(cycleStart === -1 ? 0 : cycleStart)) {
        cycleKeys.add(cycleKey);
      }
      return;
    }
    if (state === "visited") {
      return;
    }
    dependencyState.set(serviceKey, "visiting");
    const service = document.services[serviceIndexByKey.get(serviceKey) ?? -1];
    if (service !== undefined) {
      for (const dependency of service.dependsOn) {
        if (serviceKeys.has(dependency.serviceKey)) {
          visitService(dependency.serviceKey, [...stack, serviceKey]);
        }
      }
    }
    dependencyState.set(serviceKey, "visited");
  }
  for (const service of document.services) {
    visitService(service.key, []);
  }
  for (const cycleKey of cycleKeys) {
    const serviceIndex = serviceIndexByKey.get(cycleKey);
    if (serviceIndex !== undefined) {
      addIssue(context, "SERVICE_DEPENDENCY_CYCLE", ["services", serviceIndex, "dependsOn"], {
        serviceKey: cycleKey
      });
    }
  }

  const developmentPorts = new Set(document.developmentEnvironment.ports.map((port) => port.containerPort));
  for (const [previewIndex, preview] of document.previews.entries()) {
    const previewPath = ["previews", previewIndex] as const;
    if (preview.target.kind === "workspace") {
      if (!developmentPorts.has(preview.containerPort)) {
        addIssue(context, "UNKNOWN_PREVIEW_PORT", [...previewPath, "containerPort"], {
          target: "workspace",
          containerPort: preview.containerPort
        });
      }
    } else {
      const serviceIndex = serviceIndexByKey.get(preview.target.serviceKey);
      if (serviceIndex === undefined) {
        addIssue(context, "UNKNOWN_PREVIEW_SERVICE", [...previewPath, "target", "serviceKey"], {
          serviceKey: preview.target.serviceKey
        });
      } else {
        const servicePorts = new Set(document.services[serviceIndex]?.ports.map((port) => port.containerPort));
        if (!servicePorts.has(preview.containerPort)) {
          addIssue(context, "UNKNOWN_PREVIEW_PORT", [...previewPath, "containerPort"], {
            target: preview.target.serviceKey,
            containerPort: preview.containerPort
          });
        }
      }
    }
    addDuplicateIssues(
      preview.healthStatuses,
      (status) => status,
      [...previewPath, "healthStatuses"],
      undefined,
      "DUPLICATE_PREVIEW_HEALTH_STATUS",
      context
    );
  }
  if (document.aiProfile !== null) {
    addDuplicateIssues(
      document.aiProfile.credentialSecretIds,
      (secretId) => secretId,
      ["aiProfile", "credentialSecretIds"],
      undefined,
      "DUPLICATE_CREDENTIAL_SECRET_ID",
      context
    );
  }
}

export const projectOptionsV1Schema = projectOptionsV1DocumentSchema.superRefine(
  validateProjectOptionsCrossReferences
);

export type ProjectOptionsV1 = z.output<typeof projectOptionsV1Schema>;
export type ProjectOptionsV1Input = z.input<typeof projectOptionsV1Schema>;
