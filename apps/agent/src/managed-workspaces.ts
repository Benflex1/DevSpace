import { readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import {
  configurationRevisionDataSchema,
  configurationRuntimePlanDataSchema,
  configurationKeySchema,
  createManagedStoreDataSchema,
  createWorkspaceDataSchema,
  gitInspectionDataSchema,
  githubSourceInspectionDataSchema,
  projectOptionsRevisionHashSchema,
  remoteRepositoryUrlSchema,
  sourceLocatorSchema,
  uuidV7Schema,
  workspaceInspectionDataSchema,
  type AgentExecutionFailure,
  type AgentSnapshotResource,
  type ConfigurationRevisionData,
  type ConfigurationRuntimePlanData,
  type CreateManagedStoreData,
  type CreateWorkspaceData,
  type GitInspectionData,
  type WorkspaceInspectionData,
  type SourceLocator
} from "@devspace/contracts";
import {
  canonicalizeProjectOptionsV1, hashProjectOptionsV1, parseProjectOptionsV1,
  canonicalizeRuntimePlanV1, hashRuntimePlanV1, parseRuntimePlanV1,
  type ProjectOptionsV1
} from "@devspace/project-options";
import * as z from "zod";
import { v7 as uuidv7 } from "uuid";
import { parseLsRemoteOutput, runBoundedProcess } from "./git-inspector.js";
import { ExternalExecutionFence, type ExternalExecutionRole } from "./external-execution.js";
import { createGithubAskpassBroker, type AskpassCapability, type GithubAskpassBroker } from "./github-askpass.js";
import type { GithubAppAuthority } from "./github-app.js";
import {
  PrivateStateCorruptionError,
  assertContained,
  comparePersistedIdentity,
  durableJsonWriter,
  establishPinnedDirectory,
  fileIdentitySchema,
  identitiesEqual,
  lstatIdentity,
  pinExistingDirectory,
  readStrictJson,
  type AtomicJsonWriter,
  type FileIdentity
} from "./private-state.js";
import { WorkspaceRuntimeError, WorkspaceRuntimeManager, verifyRuntimePlanAgainstOptions, type RuntimeOwnership } from "./workspace-runtime.js";
import { DockerEngineClient, defaultRootlessDockerSocketPath, readRuntimePolicy } from "./docker-runtime.js";
import { PreviewRuntimeError, PreviewRuntimeManager, readPreviewBaseRegistry, type PreviewGatewayProbe, type PreviewInspectionResult } from "./preview-runtime.js";
import type { PreviewGatewayAdapterContract } from "@devspace/gateway-caddy";
import type { ApprovedPreviewBaseRegistry } from "@devspace/security";

const GIT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const absolutePathSchema = z.string().refine((value) => path.isAbsolute(value), "Expected absolute path");

const revisionRecordSchema = z.strictObject({
  version: z.literal(1), data: configurationRevisionDataSchema,
  runtimePlan: configurationRuntimePlanDataSchema.shape.runtimePlan.nullable().default(null)
});
const storeOwnershipV1Schema = z.strictObject({
  version: z.literal(1), projectId: uuidV7Schema, repositoryPath: absolutePathSchema,
  identity: fileIdentitySchema, source: sourceLocatorSchema,
  git: z.strictObject({ bare: z.literal(true), originUrl: z.string().min(1), commonDirectoryPath: absolutePathSchema })
});
const storeOwnershipV2Schema = z.strictObject({
  version: z.literal(2), projectId: uuidV7Schema, repositoryPath: absolutePathSchema,
  identity: fileIdentitySchema, source: sourceLocatorSchema,
  git: z.strictObject({ bare: z.literal(true), originUrl: remoteRepositoryUrlSchema, pendingOriginUrl: remoteRepositoryUrlSchema.nullable(), commonDirectoryPath: absolutePathSchema })
});
const storeOwnershipSchema = z.union([storeOwnershipV1Schema, storeOwnershipV2Schema]);
type StoreOwnership = z.infer<typeof storeOwnershipSchema>;
const workspaceOwnershipSchema = z.strictObject({
  version: z.literal(1), projectId: uuidV7Schema, workspaceId: uuidV7Schema,
  projectSlug: configurationKeySchema,
  workspaceSlug: configurationKeySchema,
  kind: z.enum(["primary", "isolated"]), worktreePath: absolutePathSchema, identity: fileIdentitySchema,
  parentPath: absolutePathSchema, parentIdentity: fileIdentitySchema,
  store: z.strictObject({ repositoryPath: absolutePathSchema, identity: fileIdentitySchema }),
  revision: z.strictObject({ revisionId: uuidV7Schema, revisionHash: projectOptionsRevisionHashSchema }),
  branchName: z.string().min(1), baseRef: z.union([
    z.strictObject({ kind: z.literal("branch"), branchName: z.string().min(1) }),
    z.strictObject({ kind: z.literal("commit"), commit: objectIdSchema })
  ]),
  creationCommit: objectIdSchema
});
type WorkspaceOwnership = z.infer<typeof workspaceOwnershipSchema>;
const storeCreationSchema = z.strictObject({
  version: z.literal(1), resourceType: z.literal("store"), operationId: uuidV7Schema, projectId: uuidV7Schema,
  source: sourceLocatorSchema, stagingPath: absolutePathSchema, finalRepositoryPath: absolutePathSchema,
  originUrl: remoteRepositoryUrlSchema.nullable().default(null),
  stagingIdentity: fileIdentitySchema,
  repositoryIdentity: fileIdentitySchema.nullable(), phase: z.enum(["staging-created", "repository-created", "published"])
}).superRefine((record, context) => {
  if ((record.phase === "staging-created") !== (record.repositoryIdentity === null)) {
    context.addIssue({ code: "custom", message: "Store creation phase and repository identity are inconsistent." });
  }
});
const workspaceCreationSchema = z.strictObject({
  version: z.literal(1), resourceType: z.literal("workspace"), operationId: uuidV7Schema,
  request: createWorkspaceDataSchema, parentPath: absolutePathSchema, worktreePath: absolutePathSchema,
  parentIdentity: fileIdentitySchema,
  store: z.strictObject({ repositoryPath: absolutePathSchema, identity: fileIdentitySchema }),
  worktreeIdentity: fileIdentitySchema.nullable(), intendedCommit: objectIdSchema,
  gitAdministration: z.strictObject({ path: absolutePathSchema, identity: fileIdentitySchema }).nullable(),
  phase: z.enum(["parent-created", "worktree-partial", "worktree-created"])
}).superRefine((record, context) => {
  const invalid = record.phase === "parent-created"
    ? record.worktreeIdentity !== null || record.gitAdministration !== null
    : record.phase === "worktree-partial"
      ? record.worktreeIdentity === null || record.gitAdministration === null
      : record.worktreeIdentity === null || record.gitAdministration === null;
  if (invalid) context.addIssue({ code: "custom", message: "Workspace creation phase identities are inconsistent." });
});
const creationSchema = z.union([storeCreationSchema, workspaceCreationSchema]);
type CreationRecord = z.infer<typeof creationSchema>;

export class AgentExecutionError extends Error {
  constructor(readonly failure: AgentExecutionFailure) { super(failure.message); this.name = "AgentExecutionError"; }
}
export class ConfigurationValidationError extends Error {
  constructor(readonly reason: "configuration-format" | "configuration-hash" | "cross-reference") {
    super("The Project Options revision is invalid.");
    this.name = "ConfigurationValidationError";
  }
}

function executionFailure(code: AgentExecutionFailure["code"], message: string, details: Record<string, unknown>): AgentExecutionFailure {
  const retryable = ["SOURCE_UNAVAILABLE", "GITHUB_INSTALLATION_UNAVAILABLE", "GITHUB_TOKEN_LEASE_ACTIVE",
    "ROOTLESS_RUNTIME_UNAVAILABLE", "AGENT_INTERNAL_ERROR", "GATEWAY_UPDATE_FAILED"].includes(code);
  return { code, message, retryable, details } as AgentExecutionFailure;
}
function storeConflict(projectId: string): AgentExecutionError {
  return new AgentExecutionError(executionFailure("RESOURCE_STATE_CONFLICT", "The managed store path is not provably owned by DevSpace.", {
    resource: { type: "project", id: projectId }, action: "create"
  }));
}
function workspaceConflict(workspaceId: string, observedState: "lost" | "provisioning" | "stopped" = "lost"): AgentExecutionError {
  return new AgentExecutionError(executionFailure("WORKSPACE_STATE_CONFLICT", "The workspace path is not provably owned by DevSpace.", {
    workspaceId, desiredState: "stopped", observedState, action: "create"
  }));
}

function logOwnershipDeviceRebind(resourceType: "project" | "workspace", resourceId: string,
  previousDevice: string | Record<string, string>, currentDevice: string | Record<string, string>): void {
  console.info(JSON.stringify({ event: "managed-ownership-device-rebind", resourceType, resourceId, previousDevice, currentDevice }));
}

export type GitRunner = (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
interface AuthenticatedGitContext {
  readonly connectionId: string;
  readonly repositoryId: string;
  readonly token: string;
  readonly originUrl: string;
}
export function protectedGitInvocation(args: readonly string[], auth?: { readonly capability: AskpassCapability }): { args: string[]; env: NodeJS.ProcessEnv } {
  const caFile = process.env.DEVSPACE_GIT_CA_FILE;
  const caArguments = caFile === undefined ? [] : ["-c", `http.sslCAInfo=${path.resolve(caFile)}`];
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin", HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent", XDG_CACHE_HOME: "/nonexistent", LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS: "/bin/false", GIT_SSH: "/bin/false", GIT_SSH_COMMAND: "/bin/false",
    GIT_PROXY_COMMAND: "/bin/false", GIT_TRACE: "0", GIT_TRACE_PACKET: "0", GIT_TRACE_PERFORMANCE: "0",
    GIT_TRACE_SETUP: "0", GIT_TRACE_CURL: "0", GIT_CURL_VERBOSE: "0"
  };
  if (auth !== undefined) {
    environment.GIT_ASKPASS = auth.capability.helperPath;
    Object.assign(environment, auth.capability.environment);
  } else environment.GIT_ASKPASS = "/bin/false";
  return {
    args: ["-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", "-c", "credential.helper=",
      "-c", "credential.useHttpPath=true", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
      "-c", "http.followRedirects=false", "-c", "core.sshCommand=/bin/false", ...caArguments, ...args],
    env: environment
  };
}
export async function runGit(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const invocation = protectedGitInvocation(args);
  const result = await runBoundedProcess("/usr/bin/git", invocation.args, {
    timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES,
    env: invocation.env
  });
  if (result.code !== 0 || result.signal !== null) throw new Error("git-command-failed");
  return { stdout: result.stdout, stderr: result.stderr };
}

export interface ManagedWorkspaceRoots { readonly projects: string; readonly workspaces: string; readonly state: string }
export interface WorkspaceExecutionContext {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly revisionHash: string;
  readonly runtimePlanHash: string;
  readonly generation: number;
  readonly ownership: RuntimeOwnership;
  readonly options: ProjectOptionsV1;
}
export interface CreationJournalBinding {
  readonly operationId: string;
  readonly operationName: string;
  readonly request: unknown;
}

export class ManagedWorkspaces {
  private corruption: PrivateStateCorruptionError | null = null;
  private readonly guardedDirectories = new Map<string, FileIdentity>();
  private projectRoot = "";
  private workspaceRoot = "";
  private stateRoot = "";
  private executionFence: ExternalExecutionFence | null = null;
  private githubAuthority: GithubAppAuthority | null;
  private readonly askpassBroker: GithubAskpassBroker;
  private initialized = false;
  private readonly runtime: WorkspaceRuntimeManager;
  private readonly preview: PreviewRuntimeManager;

  constructor(
    private readonly roots: ManagedWorkspaceRoots,
    private readonly git: GitRunner = runGit,
    private readonly writer: AtomicJsonWriter = durableJsonWriter,
    runtime?: WorkspaceRuntimeManager,
    previewRuntime?: PreviewRuntimeManager,
    previewBaseRegistry: ApprovedPreviewBaseRegistry = readPreviewBaseRegistry(),
    previewProbe?: PreviewGatewayProbe,
    previewGateway?: PreviewGatewayAdapterContract,
    askpassBroker: GithubAskpassBroker = createGithubAskpassBroker()
  ) {
    this.githubAuthority = null;
    this.askpassBroker = askpassBroker;
    const engine = new DockerEngineClient(process.env.DEVSPACE_DOCKER_SOCKET_PATH ?? defaultRootlessDockerSocketPath());
    this.runtime = runtime ?? new WorkspaceRuntimeManager(roots.state, engine, readRuntimePolicy(), writer);
    this.preview = previewRuntime ?? new PreviewRuntimeManager(roots.state, engine, this.runtime, previewBaseRegistry, writer, previewProbe,
      uuidv7, { now: () => Date.now() }, undefined, previewGateway,
      async (projectId, workspaceId) => {
        try {
          const ownership = await this.loadWorkspaceOwnership(projectId, workspaceId);
          return { projectSlug: ownership.projectSlug, workspaceSlug: ownership.workspaceSlug };
        } catch { return null; }
      });
  }

  async resolvePreviewLease(leaseId: string): Promise<{ readonly leaseId: string; readonly hostIp: "127.0.0.1"; readonly hostPort: number } | null> {
    return await this.preview.resolvePreviewLease(leaseId);
  }

  async reconcilePreviewRoutes(): Promise<void> {
    await this.preview.reconcileRoutes();
  }

  get isHealthy(): boolean { return this.corruption === null && (this.executionFence?.isHealthy ?? true); }
  get corruptionReason(): string | null { return this.corruption?.message ?? null; }

  async initialize(): Promise<void> {
    this.corruption = null;
    this.guardedDirectories.clear();
    this.projectRoot = path.resolve(this.roots.projects);
    this.workspaceRoot = path.resolve(this.roots.workspaces);
    this.stateRoot = path.resolve(this.roots.state);
    let configuredRoots;
    try {
      configuredRoots = [
        await pinExistingDirectory(this.roots.projects),
        await pinExistingDirectory(this.roots.workspaces),
        await pinExistingDirectory(this.roots.state)
      ] as const;
    } catch (error) {
      this.corruption = error instanceof PrivateStateCorruptionError
        ? error
        : new PrivateStateCorruptionError(this.stateRoot, "managed root establishment failed");
      return;
    }
    const internalDirectories = [
      path.join(this.stateRoot, "revisions"), path.join(this.stateRoot, "ownership", "projects"),
      path.join(this.stateRoot, "ownership", "workspaces"), path.join(this.stateRoot, "ownership", "runtimes"), path.join(this.stateRoot, "creations"),
      path.join(this.stateRoot, "runtime-creations"), path.join(this.stateRoot, "executions"), path.join(this.stateRoot, "previews"),
      path.join(this.stateRoot, "preview-leases"), path.join(this.projectRoot, ".staging"),
      path.join(this.projectRoot, ".cleanup"), path.join(this.workspaceRoot, ".cleanup")
    ];
    this.guardedDirectories.set(this.projectRoot, configuredRoots[0].identity);
    this.guardedDirectories.set(this.workspaceRoot, configuredRoots[1].identity);
    this.guardedDirectories.set(this.stateRoot, configuredRoots[2].identity);
    for (const directory of internalDirectories) {
      try {
        const established = await establishPinnedDirectory(directory);
        await this.assertManagedDirectories();
        this.guardedDirectories.set(established.path, established.identity);
      } catch (error) {
        this.corruption ??= error instanceof PrivateStateCorruptionError
          ? error
          : new PrivateStateCorruptionError(directory, "managed internal directory establishment failed");
        return;
      }
    }
    this.executionFence = new ExternalExecutionFence(path.join(this.stateRoot, "executions"), this.writer);
    await this.executionFence.initialize();
    if (!this.executionFence.isHealthy) {
      this.corruption = new PrivateStateCorruptionError(path.join(this.stateRoot, "executions"),
        this.executionFence.corruptionReason ?? "external execution state is corrupt");
      return;
    }
    await this.validateStateTree(path.join(this.stateRoot, "revisions"), "revision");
    await this.validateStateTree(path.join(this.stateRoot, "ownership", "projects"), "project");
    await this.validateStateTree(path.join(this.stateRoot, "ownership", "workspaces"), "workspace");
    await this.validateStateTree(path.join(this.stateRoot, "creations"), "creation");
    try { await this.runtime.validateStateTree(); }
    catch (error) { this.corruption ??= new PrivateStateCorruptionError(path.join(this.stateRoot, "ownership", "runtimes"), error instanceof Error ? error.message : "runtime ownership state validation failed"); }
    try { await this.preview.initialize(); }
    catch (error) { this.corruption ??= new PrivateStateCorruptionError(path.join(this.stateRoot, "previews"), error instanceof Error ? error.message : "preview state validation failed"); }
    this.initialized = true;
  }

  setGithubAuthority(authority: GithubAppAuthority | null): void {
    if (this.initialized) throw new Error("github-authority-must-be-set-before-agent-start");
    this.githubAuthority = authority;
  }

  async shutdown(): Promise<void> {
    await this.askpassBroker.stop().catch(() => undefined);
    this.initialized = false;
  }

  private async validateStateTree(root: string, kind: "revision" | "project" | "workspace" | "creation"): Promise<void> {
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory() && kind === "revision") { await walk(target); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          this.corruption ??= new PrivateStateCorruptionError(target, "unexpected private-state entry");
          continue;
        }
        try {
          if (kind === "revision") {
            const record = await readStrictJson(target, revisionRecordSchema);
            if (entry.name !== `${record.data.revisionId}.json` || path.basename(path.dirname(target)) !== record.data.projectId) {
              throw new PrivateStateCorruptionError(target, "revision filename/content mismatch");
            }
          } else if (kind === "project") {
            const record = await readStrictJson(target, storeOwnershipSchema);
            if (entry.name !== `${record.projectId}.json`) throw new PrivateStateCorruptionError(target, "store filename/content mismatch");
          } else if (kind === "workspace") {
            const record = await readStrictJson(target, workspaceOwnershipSchema);
            if (entry.name !== `${record.workspaceId}.json`) throw new PrivateStateCorruptionError(target, "workspace filename/content mismatch");
          } else {
            const record = await readStrictJson(target, creationSchema);
            if (entry.name !== `${record.operationId}.json`) throw new PrivateStateCorruptionError(target, "creation filename/content mismatch");
            await this.validateCreationSemantics(record);
          }
        } catch (error) {
          this.corruption ??= error instanceof PrivateStateCorruptionError ? error : new PrivateStateCorruptionError(target, "state validation failed");
        }
      }
    };
    await walk(root);
  }

  private assertHealthy(): void {
    if (this.corruption !== null) throw this.corruption;
    if (this.executionFence !== null && !this.executionFence.isHealthy) {
      throw new PrivateStateCorruptionError(path.join(this.stateRoot, "executions"),
        this.executionFence.corruptionReason ?? "external execution state is corrupt");
    }
  }
  async awaitProjectExecutionFence(projectId: string): Promise<void> {
    await this.assertManagedDirectories();
    if (this.git !== runGit) return;
    if (this.executionFence === null) throw new PrivateStateCorruptionError(this.stateRoot, "execution fence is not initialized");
    await this.executionFence.awaitProject(uuidV7Schema.parse(projectId));
  }
  private async operationGit(operationId: string, projectId: string, role: ExternalExecutionRole,
    args: readonly string[], auth?: AuthenticatedGitContext): Promise<{ stdout: string; stderr: string }> {
    let capability: AskpassCapability | undefined;
    let executionId: string | undefined;
    if (auth !== undefined) {
      await this.ensurePrivateCredentialTransport();
      executionId = uuidv7();
      capability = this.askpassBroker.register({ ...auth, operationId, executionId, deadlineAt: new Date(Date.now() + GIT_TIMEOUT_MS) });
    }
    try {
      if (this.git !== runGit) return await this.git(args);
    if (this.executionFence === null) throw new PrivateStateCorruptionError(this.stateRoot, "execution fence is not initialized");
    const invocation = protectedGitInvocation(args, capability === undefined ? undefined : { capability });
    const result = await this.executionFence.runGit({ operationId, projectId, role, args: invocation.args,
      ...(executionId === undefined ? {} : { executionId }), timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES, env: invocation.env });
    if (result.code !== 0 || result.signal !== null) {
      if (auth !== undefined && /authentication failed|could not read Username|invalid username|HTTP 401|HTTP 403|access denied/iu.test(result.stderr)) {
        throw new Error("github-git-authentication-failed");
      }
      throw new Error("git-command-failed");
    }
    return { stdout: result.stdout, stderr: result.stderr };
    } finally {
      if (capability !== undefined) this.askpassBroker.settle(capability.capability);
    }
  }

  private githubAuthorityRequired(): GithubAppAuthority {
    if (this.githubAuthority === null) throw new AgentExecutionError(executionFailure("GITHUB_INSTALLATION_UNAVAILABLE", "The GitHub installation is unavailable.", {}));
    return this.githubAuthority;
  }

  private async ensurePrivateCredentialTransport(): Promise<void> {
    try { await this.askpassBroker.ensureStarted(); }
    catch {
      throw new AgentExecutionError(executionFailure("SOURCE_UNAVAILABLE", "The private repository credential transport is unavailable.", {}));
    }
  }

  private githubExecutionError(error: unknown): AgentExecutionError | null {
    if (error instanceof AgentExecutionError) return error;
    const message = error instanceof Error ? error.message : "";
    const mapped = message === "github-contents-permission-required"
      ? ["GITHUB_CONTENTS_PERMISSION_REQUIRED", "GitHub Contents read permission is required."] as const
      : message === "github-installation-unavailable" || message === "github-connection-not-found" || message === "github-authority-invalid"
        ? ["GITHUB_INSTALLATION_UNAVAILABLE", "The GitHub installation is unavailable."] as const
        : message === "github-repository-not-authorized"
          ? ["GITHUB_REPOSITORY_NOT_AUTHORIZED", "The selected GitHub repository is not authorized."] as const
          : message === "github-git-authentication-failed"
            ? ["GITHUB_GIT_AUTHENTICATION_FAILED", "GitHub rejected the fresh repository credential."] as const
          : message === "github-token-lease-active"
              ? ["GITHUB_TOKEN_LEASE_ACTIVE", "A previous GitHub token transaction is still being settled."] as const
              : message === "github-upstream-invalid" || message === "github-token-mint-failed" || message === "github-operation-failed"
                ? ["SOURCE_UNAVAILABLE", "The GitHub repository source is currently unavailable."] as const
              : null;
    return mapped === null ? null : new AgentExecutionError(executionFailure(mapped[0], mapped[1], {}));
  }

  private async resolveGithubRepository(source: Extract<SourceLocator, { kind: "github-app" }>) {
    try {
      return await this.githubAuthorityRequired().resolveRepository(source);
    } catch (error) {
      const mapped = this.githubExecutionError(error);
      if (mapped !== null) throw mapped;
      throw error;
    }
  }

  private async withGithubToken<T>(source: Extract<SourceLocator, { kind: "github-app" }>, operationId: string,
    operation: (token: string, repository: import("@devspace/contracts").GithubRepository) => Promise<T>): Promise<T> {
    const authority = this.githubAuthorityRequired();
    try {
      await this.ensurePrivateCredentialTransport();
      const result = await authority.withExactRepositoryToken(source, operation, operationId);
      return result.value;
    } catch (error) {
      const mapped = this.githubExecutionError(error);
      if (mapped !== null) throw mapped;
      throw error;
    }
  }

  async inspectSource(source: SourceLocator): Promise<import("@devspace/contracts").SourceInspectionData> {
    const data = sourceLocatorSchema.parse(source);
    if (data.kind !== "github-app") throw new Error("source-inspection-public-path-required");
    const operationId = uuidv7();
    const authority = this.githubAuthorityRequired();
    await this.ensurePrivateCredentialTransport();
    const result = await authority.withExactRepositoryToken(data, async (token, repository) => {
      const executionId = uuidv7();
      const capability = this.askpassBroker.register({ ...data, operationId, executionId, originUrl: repository.cleanHttpsUrl,
        token, deadlineAt: new Date(Date.now() + 15_000) });
      try {
        const invocation = protectedGitInvocation(["ls-remote", "--symref", "--", repository.cleanHttpsUrl, "HEAD"], { capability });
        const processResult = await runBoundedProcess("/usr/bin/git", invocation.args, {
          timeoutMs: 15_000, maxOutputBytes: 256 * 1024, env: invocation.env
        });
        if (processResult.signal !== null || processResult.code !== 0) {
          if (/authentication failed|could not read Username|invalid username|HTTP 401|HTTP 403|access denied/iu.test(processResult.stderr)) {
            throw new Error("github-git-authentication-failed");
          }
          throw new Error("source-unavailable");
        }
        const inspected = parseLsRemoteOutput(processResult.stdout);
        return githubSourceInspectionDataSchema.parse({ ...inspected, sourceKind: "github-app", repository, cleanupDegraded: false });
      } finally {
        this.askpassBroker.settle(capability.capability);
      }
    });
    return githubSourceInspectionDataSchema.parse({ ...result.value, cleanupDegraded: result.cleanupDegraded });
  }
  private async assertManagedDirectories(): Promise<void> {
    this.assertHealthy();
    for (const [directory, identity] of this.guardedDirectories) {
      const current = await lstatIdentity(directory);
      if (current === null || !current.stats.isDirectory() || current.stats.isSymbolicLink()
        || !identitiesEqual(current.identity, identity) || await realpath(directory) !== directory) {
        const corruption = new PrivateStateCorruptionError(directory, "managed directory was replaced");
        this.corruption ??= corruption;
        throw corruption;
      }
    }
  }
  private async readPrivate<Schema extends z.ZodType>(file: string, schema: Schema): Promise<z.infer<Schema>> {
    try { return await readStrictJson(file, schema); }
    catch (error) {
      if (error instanceof PrivateStateCorruptionError) this.corruption ??= error;
      throw error;
    }
  }
  repositoryPath(projectId: string): string {
    return assertContained(this.projectRoot || this.roots.projects, path.join(this.projectRoot || this.roots.projects, uuidV7Schema.parse(projectId), "repository.git"));
  }
  worktreePath(workspaceId: string): string {
    return assertContained(this.workspaceRoot || this.roots.workspaces, path.join(this.workspaceRoot || this.roots.workspaces, uuidV7Schema.parse(workspaceId), "source"));
  }
  private projectDirectory(projectId: string): string { return path.dirname(this.repositoryPath(projectId)); }
  private workspaceParent(workspaceId: string): string { return path.dirname(this.worktreePath(workspaceId)); }
  private storeStagingPath(projectId: string, operationId: string): string {
    return assertContained(path.join(this.projectRoot, ".staging"),
      path.join(this.projectRoot, ".staging", `${uuidV7Schema.parse(projectId)}-${uuidV7Schema.parse(operationId)}-store`));
  }
  private storeCleanupPath(operationId: string): string {
    return assertContained(path.join(this.projectRoot, ".cleanup"),
      path.join(this.projectRoot, ".cleanup", `${uuidV7Schema.parse(operationId)}-store`));
  }
  private workspaceCleanupPath(operationId: string): string {
    return assertContained(path.join(this.workspaceRoot, ".cleanup"),
      path.join(this.workspaceRoot, ".cleanup", `${uuidV7Schema.parse(operationId)}-workspace`));
  }
  private revisionPath(projectId: string, revisionId: string): string {
    return assertContained(this.stateRoot, path.join(this.stateRoot, "revisions", uuidV7Schema.parse(projectId), `${uuidV7Schema.parse(revisionId)}.json`));
  }
  private storeOwnershipPath(projectId: string): string { return path.join(this.stateRoot, "ownership", "projects", `${uuidV7Schema.parse(projectId)}.json`); }
  private workspaceOwnershipPath(workspaceId: string): string { return path.join(this.stateRoot, "ownership", "workspaces", `${uuidV7Schema.parse(workspaceId)}.json`); }
  private creationPath(operationId: string): string { return path.join(this.stateRoot, "creations", `${uuidV7Schema.parse(operationId)}.json`); }

  private creationCorruption(record: CreationRecord, reason: string): PrivateStateCorruptionError {
    return new PrivateStateCorruptionError(this.creationPath(record.operationId), reason);
  }

  private async validateCreationSemantics(record: CreationRecord): Promise<void> {
    await this.assertManagedDirectories();
    if (record.resourceType === "store") {
      const expectedStaging = this.storeStagingPath(record.projectId, record.operationId);
      const expectedRepository = this.repositoryPath(record.projectId);
      if (record.stagingPath !== expectedStaging || record.finalRepositoryPath !== expectedRepository
        || record.stagingPath === record.finalRepositoryPath) {
        throw this.creationCorruption(record, "store creation paths do not match their operation-derived locations");
      }
      assertContained(path.join(this.projectRoot, ".staging"), record.stagingPath);
      assertContained(this.projectRoot, record.finalRepositoryPath);
      const staging = await lstatIdentity(record.stagingPath);
      const finalDirectory = await lstatIdentity(path.dirname(record.finalRepositoryPath));
      const finalRepository = await lstatIdentity(record.finalRepositoryPath);
      if (record.phase === "published") {
        if (staging !== null || finalDirectory === null || !finalDirectory.stats.isDirectory()
          || finalDirectory.stats.isSymbolicLink() || !identitiesEqual(finalDirectory.identity, record.stagingIdentity)
          || finalRepository === null || !finalRepository.stats.isDirectory() || finalRepository.stats.isSymbolicLink()
          || record.repositoryIdentity === null || !identitiesEqual(finalRepository.identity, record.repositoryIdentity)) {
          throw this.creationCorruption(record, "published store creation identities are inconsistent");
        }
        return;
      }
      if (staging === null || !staging.stats.isDirectory() || staging.stats.isSymbolicLink()
        || !identitiesEqual(staging.identity, record.stagingIdentity) || finalDirectory !== null) {
        throw this.creationCorruption(record, "staged store creation identities are inconsistent");
      }
      const stagedRepository = await lstatIdentity(path.join(record.stagingPath, "repository.git"));
      if (record.phase === "repository-created") {
        if (stagedRepository === null || !stagedRepository.stats.isDirectory() || stagedRepository.stats.isSymbolicLink()
          || record.repositoryIdentity === null || !identitiesEqual(stagedRepository.identity, record.repositoryIdentity)) {
          throw this.creationCorruption(record, "initialized store creation identities are inconsistent");
        }
      } else if (stagedRepository !== null && (!stagedRepository.stats.isDirectory() || stagedRepository.stats.isSymbolicLink())) {
        throw this.creationCorruption(record, "partially initialized store is not a real directory");
      }
      return;
    }

    const expectedParent = this.workspaceParent(record.request.workspaceId);
    const expectedWorktree = this.worktreePath(record.request.workspaceId);
    if (record.parentPath !== expectedParent || record.worktreePath !== expectedWorktree
      || record.worktreePath !== path.join(record.parentPath, "source")) {
      throw this.creationCorruption(record, "workspace creation paths do not match their resource-derived locations");
    }
    assertContained(this.workspaceRoot, record.parentPath);
    assertContained(record.parentPath, record.worktreePath);
    const storeRecord = await this.readPrivate(this.storeOwnershipPath(record.request.projectId), storeOwnershipSchema);
    if (record.store.repositoryPath !== this.repositoryPath(record.request.projectId)
      || storeRecord.repositoryPath !== record.store.repositoryPath
      || !identitiesEqual(storeRecord.identity, record.store.identity)) {
      throw this.creationCorruption(record, "workspace creation store binding is inconsistent");
    }
    const [store, parent, worktree] = await Promise.all([
      lstatIdentity(record.store.repositoryPath), lstatIdentity(record.parentPath), lstatIdentity(record.worktreePath)
    ]);
    if (store === null || !store.stats.isDirectory() || store.stats.isSymbolicLink()
      || !identitiesEqual(store.identity, record.store.identity)
      || parent === null || !parent.stats.isDirectory() || parent.stats.isSymbolicLink()
      || !identitiesEqual(parent.identity, record.parentIdentity)) {
      throw this.creationCorruption(record, "workspace creation resource identities are inconsistent");
    }
    if (record.phase === "parent-created") {
      if (worktree !== null && (!worktree.stats.isDirectory() || worktree.stats.isSymbolicLink())) {
        throw this.creationCorruption(record, "partially created worktree has an unsupported type");
      }
    } else if (worktree === null || !worktree.stats.isDirectory() || worktree.stats.isSymbolicLink()
      || record.worktreeIdentity === null || !identitiesEqual(worktree.identity, record.worktreeIdentity)) {
      throw this.creationCorruption(record, "workspace worktree identity is inconsistent");
    }
    if (record.gitAdministration !== null) {
      const administrativeRoot = path.join(record.store.repositoryPath, "worktrees");
      assertContained(administrativeRoot, record.gitAdministration.path);
      const administration = await lstatIdentity(record.gitAdministration.path);
      if (administration === null || !administration.stats.isDirectory() || administration.stats.isSymbolicLink()
        || !identitiesEqual(administration.identity, record.gitAdministration.identity)) {
        throw this.creationCorruption(record, "workspace Git administration identity is inconsistent");
      }
      const gitdir = await readFile(path.join(record.gitAdministration.path, "gitdir"), "utf8");
      if (path.resolve(gitdir.trim()) !== path.join(record.worktreePath, ".git")) {
        throw this.creationCorruption(record, "workspace Git administration path is inconsistent");
      }
    }
  }

  validateRevision(data: ConfigurationRevisionData): void {
    let parsed: ReturnType<typeof parseProjectOptionsV1>;
    try { parsed = parseProjectOptionsV1(JSON.parse(data.configuration.canonicalJson)); }
    catch { throw new ConfigurationValidationError("configuration-format"); }
    if (canonicalizeProjectOptionsV1(parsed) !== data.configuration.canonicalJson) throw new ConfigurationValidationError("configuration-format");
    if (hashProjectOptionsV1(parsed) !== data.configuration.hash) throw new ConfigurationValidationError("configuration-hash");
  }

  async registerRevision(data: ConfigurationRevisionData): Promise<void> {
    await this.assertManagedDirectories();
    this.validateRevision(data);
    const file = this.revisionPath(data.projectId, data.revisionId);
    const existing = await lstatIdentity(file);
    if (existing !== null) {
      if (!existing.stats.isFile() || existing.stats.isSymbolicLink()) throw new Error("configuration-revision-path-invalid");
      const current = await this.readPrivate(file, revisionRecordSchema);
      if (JSON.stringify(current.data) !== JSON.stringify(data)) throw new Error("configuration-revision-conflict");
      return;
    }
    await this.writer.write(file, revisionRecordSchema.parse({ version: 1, data, runtimePlan: null }));
  }

  async registerRuntimePlan(input: ConfigurationRuntimePlanData): Promise<void> {
    await this.assertManagedDirectories();
    const data = configurationRuntimePlanDataSchema.parse(input);
    const file = this.revisionPath(data.projectId, data.revisionId);
    let record: z.infer<typeof revisionRecordSchema>;
    try { record = await this.readPrivate(file, revisionRecordSchema); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AgentExecutionError(executionFailure("CONFIGURATION_NOT_REGISTERED", "The configuration revision is not registered.", {
          revisionId: data.revisionId, revisionHash: data.revisionHash
        }));
      }
      throw error;
    }
    if (record.data.configuration.hash !== data.revisionHash) {
      throw new AgentExecutionError(executionFailure("CONFIGURATION_NOT_REGISTERED", "The configuration revision hash does not match.", {
        revisionId: data.revisionId, revisionHash: data.revisionHash
      }));
    }
    try {
      const parsedPlan = parseRuntimePlanV1(JSON.parse(data.runtimePlan.canonicalJson));
      if (canonicalizeRuntimePlanV1(parsedPlan) !== data.runtimePlan.canonicalJson
        || hashRuntimePlanV1(parsedPlan) !== data.runtimePlan.hash) throw new Error("runtime-plan-document-mismatch");
      verifyRuntimePlanAgainstOptions(JSON.parse(record.data.configuration.canonicalJson), data.runtimePlan.canonicalJson, data.runtimePlan.hash);
    } catch {
      throw new AgentExecutionError(executionFailure("RUNTIME_POLICY_VIOLATION", "The runtime plan does not match the registered configuration revision.", {
        policy: "runtime-plan-mismatch"
      }));
    }
    if (record.runtimePlan !== null && JSON.stringify(record.runtimePlan) !== JSON.stringify(data.runtimePlan)) {
      throw new AgentExecutionError(executionFailure("RUNTIME_POLICY_VIOLATION", "A different runtime plan is already registered.", { policy: "runtime-plan-mismatch" }));
    }
    if (record.runtimePlan === null) await this.writer.write(file, revisionRecordSchema.parse({ ...record, runtimePlan: data.runtimePlan }));
  }

  private async loadStoreOwnership(projectId: string): Promise<StoreOwnership> {
    await this.assertManagedDirectories();
    let record: StoreOwnership;
    try { record = await this.readPrivate(this.storeOwnershipPath(projectId), storeOwnershipSchema); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw storeConflict(projectId);
      throw error;
    }
    if (record.projectId !== projectId || record.repositoryPath !== this.repositoryPath(projectId)) throw storeConflict(projectId);
    const current = await lstatIdentity(record.repositoryPath);
    if (current === null || !current.stats.isDirectory() || current.stats.isSymbolicLink()) throw storeConflict(projectId);
    const identityComparison = comparePersistedIdentity(record.identity, current.identity);
    if (identityComparison === "mismatch") throw storeConflict(projectId);
    const resolved = await realpath(record.repositoryPath);
    if (resolved !== record.repositoryPath || record.git.commonDirectoryPath !== record.repositoryPath) throw storeConflict(projectId);
    let actualOrigin: string;
    try {
      if ((await this.git(["--git-dir", record.repositoryPath, "rev-parse", "--is-bare-repository"])).stdout.trim() !== "true") throw new Error("not-bare");
      actualOrigin = (await this.git(["--git-dir", record.repositoryPath, "config", "--get", "remote.origin.url"])).stdout.trim();
    } catch { throw storeConflict(projectId); }
    const expectedOrigin = record.version === 2 && record.git.pendingOriginUrl !== null ? record.git.pendingOriginUrl : record.git.originUrl;
    if (actualOrigin !== record.git.originUrl && actualOrigin !== expectedOrigin) throw storeConflict(projectId);
    if (record.version === 2 && record.git.pendingOriginUrl !== null) {
      if (actualOrigin === record.git.originUrl) {
        try {
          await this.git(["--git-dir", record.repositoryPath, "config", "remote.origin.url", record.git.pendingOriginUrl]);
          actualOrigin = (await this.git(["--git-dir", record.repositoryPath, "config", "--get", "remote.origin.url"])).stdout.trim();
        } catch {
          throw storeConflict(projectId);
        }
      }
      if (actualOrigin !== record.git.pendingOriginUrl) throw storeConflict(projectId);
      const completed = storeOwnershipV2Schema.parse({ ...record, git: { ...record.git, originUrl: record.git.pendingOriginUrl, pendingOriginUrl: null } });
      await this.writer.write(this.storeOwnershipPath(projectId), completed);
      record = completed;
    }
    if (identityComparison === "device-only-rebind") {
      await this.assertManagedDirectories();
      const rebound = storeOwnershipSchema.parse({ ...record, identity: current.identity });
      await this.writer.write(this.storeOwnershipPath(projectId), rebound);
      logOwnershipDeviceRebind("project", projectId, record.identity.device, current.identity.device);
      return rebound;
    }
    return record;
  }

  private async transitionStoreOrigin(record: StoreOwnership, projectId: string, newOrigin: string): Promise<StoreOwnership> {
    const cleanOrigin = remoteRepositoryUrlSchema.parse(newOrigin);
    if (!cleanOrigin.startsWith("https://") || cleanOrigin.includes("@") || cleanOrigin.includes("?") || cleanOrigin.includes("#")) throw storeConflict(projectId);
    if (record.git.originUrl === cleanOrigin && (record.version === 1 || record.git.pendingOriginUrl === null)) return record;
    const currentOrigin = (await this.git(["--git-dir", record.repositoryPath, "config", "--get", "remote.origin.url"])).stdout.trim();
    if (record.version === 2 && record.git.pendingOriginUrl !== null && currentOrigin !== record.git.originUrl && currentOrigin !== record.git.pendingOriginUrl) throw storeConflict(projectId);
    const pending = storeOwnershipV2Schema.parse({
      version: 2, projectId: record.projectId, repositoryPath: record.repositoryPath, identity: record.identity, source: record.source,
      git: { bare: true, originUrl: record.git.originUrl, pendingOriginUrl: cleanOrigin, commonDirectoryPath: record.git.commonDirectoryPath }
    });
    await this.writer.write(this.storeOwnershipPath(projectId), pending);
    if (currentOrigin !== cleanOrigin) {
      await this.git(["--git-dir", record.repositoryPath, "config", "remote.origin.url", cleanOrigin]);
    }
    const verifiedOrigin = (await this.git(["--git-dir", record.repositoryPath, "config", "--get", "remote.origin.url"])).stdout.trim();
    if (verifiedOrigin !== cleanOrigin) throw storeConflict(projectId);
    const completed = storeOwnershipV2Schema.parse({ ...pending, git: { ...pending.git, originUrl: cleanOrigin, pendingOriginUrl: null } });
    await this.writer.write(this.storeOwnershipPath(projectId), completed);
    return completed;
  }

  private async loadCreation(operationId: string): Promise<CreationRecord | null> {
    try {
      const record = await this.readPrivate(this.creationPath(operationId), creationSchema);
      await this.validateCreationSemantics(record);
      return record;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      const corruption = error instanceof PrivateStateCorruptionError
        ? error
        : new PrivateStateCorruptionError(this.creationPath(operationId), "creation semantic validation failed");
      this.corruption ??= corruption;
      throw corruption;
    }
  }
  private async saveCreation(record: CreationRecord): Promise<void> {
    await this.assertManagedDirectories();
    await this.validateCreationSemantics(record);
    await this.writer.write(this.creationPath(record.operationId), record);
  }
  private async removeCreation(operationId: string): Promise<void> {
    await this.assertManagedDirectories();
    await unlink(this.creationPath(operationId)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }

  async createManagedStore(input: CreateManagedStoreData, operationId: string): Promise<void> {
    await this.assertManagedDirectories();
    const data = createManagedStoreDataSchema.parse(input);
    const githubSource = data.source.kind === "github-app" ? data.source : null;
    if (githubSource !== null) await this.ensurePrivateCredentialTransport();
    let sourceOrigin: string;
    if (data.source.kind === "remote") {
      const url = new URL(data.source.url);
      if (url.protocol !== "https:" || url.search !== "" || url.username !== "" || url.password !== "") {
        throw new AgentExecutionError(executionFailure("RUNTIME_POLICY_VIOLATION", "The source is not approved.", { policy: "source-not-approved" }));
      }
      sourceOrigin = data.source.url;
    } else if (data.source.kind === "github-app") {
      const resolved = await this.resolveGithubRepository(data.source);
      if (resolved.repository.archived || resolved.repository.disabled) throw new AgentExecutionError(executionFailure("GITHUB_REPOSITORY_NOT_AUTHORIZED", "The selected GitHub repository is not available for onboarding.", {}));
      sourceOrigin = resolved.repository.cleanHttpsUrl;
    } else {
      throw new AgentExecutionError(executionFailure("RUNTIME_POLICY_VIOLATION", "The source is not approved.", { policy: "source-not-approved" }));
    }
    const finalDirectory = this.projectDirectory(data.projectId);
    const finalRepository = this.repositoryPath(data.projectId);
    const ownershipEntry = await lstatIdentity(this.storeOwnershipPath(data.projectId));
    if (ownershipEntry !== null) {
      const owned = await this.loadStoreOwnership(data.projectId);
      const sameSource = owned.source.kind === data.source.kind
        && (data.source.kind === "remote" && owned.source.kind === "remote" ? owned.source.url === data.source.url
          : data.source.kind === "github-app" && owned.source.kind === "github-app"
            ? owned.source.connectionId === data.source.connectionId && owned.source.repositoryId === data.source.repositoryId : false);
      if (!sameSource) throw storeConflict(data.projectId);
      return;
    }
    let creation = await this.loadCreation(operationId);
    if (creation !== null && (creation.resourceType !== "store" || creation.projectId !== data.projectId || JSON.stringify(creation.source) !== JSON.stringify(data.source))) throw storeConflict(data.projectId);
    if (creation === null) {
      if (await lstatIdentity(finalDirectory) !== null) throw storeConflict(data.projectId);
      const stagingPath = this.storeStagingPath(data.projectId, operationId);
      if (await lstatIdentity(stagingPath) !== null) throw storeConflict(data.projectId);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(stagingPath, { mode: 0o700 });
      const staged = await lstatIdentity(stagingPath);
      if (staged === null || !staged.stats.isDirectory()) throw storeConflict(data.projectId);
      creation = storeCreationSchema.parse({ version: 1, resourceType: "store", operationId, projectId: data.projectId,
        source: data.source, stagingPath, finalRepositoryPath: finalRepository,
        originUrl: sourceOrigin,
        stagingIdentity: staged.identity, repositoryIdentity: null, phase: "staging-created" });
      await this.saveCreation(creation);
    }
    if (creation.resourceType !== "store") throw storeConflict(data.projectId);
    const stagingNow = await lstatIdentity(creation.stagingPath);
    if (creation.phase === "repository-created" && stagingNow === null) {
      const published = await lstatIdentity(finalRepository);
      if (published === null || creation.repositoryIdentity === null || !published.stats.isDirectory()
        || !identitiesEqual(published.identity, creation.repositoryIdentity)) throw storeConflict(data.projectId);
      creation = storeCreationSchema.parse({ ...creation, phase: "published" });
      await this.saveCreation(creation);
    }
    if (creation.phase !== "published" && (stagingNow === null || !stagingNow.stats.isDirectory() || !identitiesEqual(stagingNow.identity, creation.stagingIdentity))) throw storeConflict(data.projectId);
    const stagedRepository = path.join(creation.stagingPath, "repository.git");
    if (creation.phase === "staging-created") {
      const recoveredRepository = await lstatIdentity(stagedRepository);
      if (recoveredRepository === null) {
        try {
          if (data.source.kind === "remote") {
            await this.operationGit(operationId, data.projectId, "store-clone",
              ["clone", "--bare", "--no-recurse-submodules", "--", sourceOrigin, stagedRepository]);
          } else if (githubSource !== null) {
            await this.withGithubToken(githubSource, operationId, async (token, repository) => {
              sourceOrigin = repository.cleanHttpsUrl;
              await this.operationGit(operationId, data.projectId, "store-clone",
                ["clone", "--bare", "--no-recurse-submodules", "--", repository.cleanHttpsUrl, stagedRepository],
                { connectionId: githubSource.connectionId, repositoryId: githubSource.repositoryId, token, originUrl: repository.cleanHttpsUrl });
            });
          }
        }
        catch (error) {
          await this.cleanupStoreCreation(creation);
          if (error instanceof AgentExecutionError) throw error;
          if (data.source.kind === "github-app" && error instanceof Error && error.message === "github-git-authentication-failed") {
            throw new AgentExecutionError(executionFailure("GITHUB_GIT_AUTHENTICATION_FAILED", "GitHub rejected the fresh repository credential.", {}));
          }
          throw new AgentExecutionError(executionFailure("SOURCE_UNAVAILABLE", "The repository source is currently unavailable.", {}));
        }
      } else {
        try {
          if (!recoveredRepository.stats.isDirectory()
            || (await this.git(["--git-dir", stagedRepository, "rev-parse", "--is-bare-repository"])).stdout.trim() !== "true"
            || (await this.git(["--git-dir", stagedRepository, "config", "--get", "remote.origin.url"])).stdout.trim() !== (creation.originUrl ?? sourceOrigin)) throw new Error("invalid-staged-repository");
        } catch { throw storeConflict(data.projectId); }
      }
      const repositoryIdentity = await lstatIdentity(stagedRepository);
      if (repositoryIdentity === null || !repositoryIdentity.stats.isDirectory()) throw storeConflict(data.projectId);
      const clonedOrigin = (await this.git(["--git-dir", stagedRepository, "config", "--get", "remote.origin.url"])).stdout.trim();
      creation = storeCreationSchema.parse({ ...creation, originUrl: clonedOrigin, repositoryIdentity: repositoryIdentity.identity, phase: "repository-created" });
      await this.saveCreation(creation);
    }
    if (creation.phase === "repository-created") {
      await this.validateCreationSemantics(creation);
      await this.assertManagedDirectories();
      if (await lstatIdentity(finalDirectory) !== null) throw storeConflict(data.projectId);
      await rename(creation.stagingPath, finalDirectory);
      creation = storeCreationSchema.parse({ ...creation, phase: "published" });
      await this.saveCreation(creation);
    }
    const repositoryNow = await lstatIdentity(finalRepository);
    if (repositoryNow === null || !repositoryNow.stats.isDirectory() || creation.repositoryIdentity === null || !identitiesEqual(repositoryNow.identity, creation.repositoryIdentity)) throw storeConflict(data.projectId);
    const ownership = data.source.kind === "github-app"
      ? storeOwnershipV2Schema.parse({ version: 2, projectId: data.projectId, repositoryPath: finalRepository,
        identity: repositoryNow.identity, source: data.source, git: { bare: true, originUrl: sourceOrigin, pendingOriginUrl: null, commonDirectoryPath: finalRepository } })
      : storeOwnershipV1Schema.parse({ version: 1, projectId: data.projectId, repositoryPath: finalRepository,
        identity: repositoryNow.identity, source: data.source, git: { bare: true, originUrl: sourceOrigin, commonDirectoryPath: finalRepository } });
    await this.validateCreationSemantics(creation);
    await this.assertManagedDirectories();
    await this.writer.write(this.storeOwnershipPath(data.projectId), ownership);
    await this.removeCreation(creation.operationId);
    await this.loadStoreOwnership(data.projectId);
  }

  private async cleanupStoreCreation(creation: z.infer<typeof storeCreationSchema>): Promise<void> {
    await this.validateCreationSemantics(creation);
    const current = await lstatIdentity(creation.stagingPath);
    if (current !== null && current.stats.isDirectory() && identitiesEqual(current.identity, creation.stagingIdentity)) {
      await this.quarantineAndRemove(creation.stagingPath, creation.stagingIdentity,
        this.storeCleanupPath(creation.operationId));
    }
    await this.removeCreation(creation.operationId);
  }

  private async quarantineAndRemove(source: string, identity: FileIdentity, quarantine: string): Promise<void> {
    await this.assertManagedDirectories();
    if (await lstatIdentity(quarantine) !== null) throw new PrivateStateCorruptionError(quarantine, "cleanup quarantine already exists");
    const before = await lstatIdentity(source);
    if (before === null || !before.stats.isDirectory() || before.stats.isSymbolicLink() || !identitiesEqual(before.identity, identity)) {
      throw new PrivateStateCorruptionError(source, "cleanup identity changed");
    }
    await rename(source, quarantine);
    const moved = await lstatIdentity(quarantine);
    if (moved === null || !moved.stats.isDirectory() || moved.stats.isSymbolicLink() || !identitiesEqual(moved.identity, identity)) {
      throw new PrivateStateCorruptionError(quarantine, "quarantined cleanup identity mismatch");
    }
    await rm(quarantine, { recursive: true });
  }

  async fetch(projectId: string, operationId?: string, expectedSource?: SourceLocator): Promise<void> {
    let store = await this.loadStoreOwnership(projectId);
    if (expectedSource !== undefined) {
      const sameSource = expectedSource.kind === store.source.kind
        && (expectedSource.kind === "remote" && store.source.kind === "remote" ? expectedSource.url === store.source.url
          : expectedSource.kind === "github-app" && store.source.kind === "github-app"
            ? expectedSource.connectionId === store.source.connectionId && expectedSource.repositoryId === store.source.repositoryId : false);
      if (!sameSource) throw storeConflict(projectId);
    }
    try {
      const args = ["--git-dir", store.repositoryPath, "fetch", "--no-recurse-submodules", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"];
      if (store.source.kind === "github-app") {
        const githubSource = store.source;
        const fetchOperationId = operationId ?? uuidv7();
        await this.withGithubToken(githubSource, fetchOperationId, async (token, repository) => {
          store = await this.transitionStoreOrigin(store, projectId, repository.cleanHttpsUrl);
          await this.operationGit(fetchOperationId, projectId, "project-fetch", ["--git-dir", store.repositoryPath, "fetch", "--no-recurse-submodules", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], {
            connectionId: githubSource.connectionId, repositoryId: githubSource.repositoryId, token, originUrl: repository.cleanHttpsUrl
          });
        });
      } else if (operationId === undefined) await this.git(args);
      else await this.operationGit(operationId, projectId, "project-fetch", args);
    }
    catch (error) {
      if (error instanceof AgentExecutionError) throw error;
      if (error instanceof Error && error.message === "github-git-authentication-failed") {
        throw new AgentExecutionError(executionFailure("GITHUB_GIT_AUTHENTICATION_FAILED", "GitHub rejected the fresh repository credential.", {}));
      }
      throw new AgentExecutionError(executionFailure("SOURCE_UNAVAILABLE", "The repository source is currently unavailable.", {}));
    }
    await this.loadStoreOwnership(projectId);
  }

  private async loadRevision(projectId: string, revisionId: string): Promise<ConfigurationRevisionData> {
    return (await this.loadRevisionRecord(projectId, revisionId)).data;
  }

  private async loadRevisionRecord(projectId: string, revisionId: string): Promise<z.infer<typeof revisionRecordSchema>> {
    let record;
    try { record = await this.readPrivate(this.revisionPath(projectId, revisionId), revisionRecordSchema); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AgentExecutionError(executionFailure("CONFIGURATION_NOT_REGISTERED", "The configuration revision is not registered.", { revisionId, revisionHash: "0".repeat(64) }));
      throw error;
    }
    if (record.data.projectId !== projectId || record.data.revisionId !== revisionId) throw new PrivateStateCorruptionError(this.revisionPath(projectId, revisionId), "revision identity mismatch");
    return record;
  }

  private async loadWorkspaceOwnership(projectId: string, workspaceId: string): Promise<WorkspaceOwnership> {
    await this.assertManagedDirectories();
    this.assertHealthy();
    let record: WorkspaceOwnership;
    try { record = await this.readPrivate(this.workspaceOwnershipPath(workspaceId), workspaceOwnershipSchema); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw workspaceConflict(workspaceId); throw error; }
    if (record.projectId !== projectId || record.workspaceId !== workspaceId || record.worktreePath !== this.worktreePath(workspaceId)
      || record.parentPath !== this.workspaceParent(workspaceId)) throw workspaceConflict(workspaceId);
    const store = await this.loadStoreOwnership(projectId);
    if (store.repositoryPath !== record.store.repositoryPath
      || comparePersistedIdentity(record.store.identity, store.identity) === "mismatch") throw workspaceConflict(workspaceId);
    const [parentNow, worktreeNow] = await Promise.all([lstatIdentity(record.parentPath), lstatIdentity(record.worktreePath)]);
    if (parentNow === null || !parentNow.stats.isDirectory() || parentNow.stats.isSymbolicLink()
      || worktreeNow === null || !worktreeNow.stats.isDirectory() || worktreeNow.stats.isSymbolicLink()) throw workspaceConflict(workspaceId);
    const storeIdentityComparison = comparePersistedIdentity(record.store.identity, store.identity);
    const parentIdentityComparison = comparePersistedIdentity(record.parentIdentity, parentNow.identity);
    const worktreeIdentityComparison = comparePersistedIdentity(record.identity, worktreeNow.identity);
    if (storeIdentityComparison === "mismatch" || parentIdentityComparison === "mismatch" || worktreeIdentityComparison === "mismatch") {
      throw workspaceConflict(workspaceId);
    }
    const revision = await this.loadRevisionRecord(projectId, record.revision.revisionId).catch(() => null);
    if (revision === null || revision.data.configuration.hash !== record.revision.revisionHash) throw workspaceConflict(workspaceId);
    try {
      const commonText = (await this.git(["-C", record.worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
      if (await realpath(commonText) !== store.repositoryPath) throw new Error("common-dir-mismatch");
      const branch = (await this.git(["-C", record.worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
      if (branch !== record.branchName) throw new Error("branch-mismatch");
      const registrations = await this.registeredWorktrees(store.repositoryPath);
      if (!registrations.some((entry) => entry.path === record.worktreePath && entry.branch === `refs/heads/${record.branchName}`)) {
        throw new Error("worktree-registration-mismatch");
      }
      await this.git(["-C", record.worktreePath, "cat-file", "-e", `${record.creationCommit}^{commit}`]);
    } catch { throw workspaceConflict(workspaceId); }
    if (storeIdentityComparison === "device-only-rebind" || parentIdentityComparison === "device-only-rebind"
      || worktreeIdentityComparison === "device-only-rebind") {
      await this.assertManagedDirectories();
      const rebound = workspaceOwnershipSchema.parse({ ...record,
        identity: worktreeNow.identity,
        parentIdentity: parentNow.identity,
        store: { ...record.store, identity: store.identity }
      });
      await this.writer.write(this.workspaceOwnershipPath(workspaceId), rebound);
      const previousDevice = { worktree: record.identity.device, parent: record.parentIdentity.device, store: record.store.identity.device };
      const currentDevice = { worktree: worktreeNow.identity.device, parent: parentNow.identity.device, store: store.identity.device };
      logOwnershipDeviceRebind("workspace", workspaceId, previousDevice, currentDevice);
      return rebound;
    }
    return record;
  }

  private async registeredWorktrees(repository: string): Promise<Array<{ path: string; branch: string | null }>> {
    const output = (await this.git(["--git-dir", repository, "worktree", "list", "--porcelain", "-z"])).stdout;
    return output.split("\0\0").filter((block) => block !== "").map((block) => {
      const lines = block.split("\0");
      const worktree = lines.find((line) => line.startsWith("worktree "));
      if (worktree === undefined) throw new Error("git-worktree-list-invalid");
      const branch = lines.find((line) => line.startsWith("branch "));
      return { path: worktree.slice("worktree ".length), branch: branch?.slice("branch ".length) ?? null };
    });
  }
  private async registeredWorktreePaths(repository: string): Promise<string[]> {
    return (await this.registeredWorktrees(repository)).map((record) => record.path);
  }

  private async worktreeAdministration(repository: string, worktreePath: string): Promise<{ path: string; identity: FileIdentity } | null> {
    const gitFile = path.join(worktreePath, ".git");
    const entry = await lstatIdentity(gitFile);
    if (entry === null) return null;
    if (!entry.stats.isFile() || entry.stats.isSymbolicLink()) throw new Error("worktree-git-file-invalid");
    const contents = (await readFile(gitFile, "utf8")).trim();
    if (!contents.startsWith("gitdir: ")) throw new Error("worktree-git-file-invalid");
    const administrativePath = path.resolve(contents.slice("gitdir: ".length));
    assertContained(path.join(repository, "worktrees"), administrativePath);
    const administration = await lstatIdentity(administrativePath);
    if (administration === null || !administration.stats.isDirectory() || administration.stats.isSymbolicLink()) {
      throw new Error("worktree-administration-invalid");
    }
    const registeredGitFile = (await readFile(path.join(administrativePath, "gitdir"), "utf8")).trim();
    if (path.resolve(registeredGitFile) !== gitFile) throw new Error("worktree-administration-invalid");
    return { path: administrativePath, identity: administration.identity };
  }

  async createWorkspace(input: CreateWorkspaceData, operationId: string): Promise<void> {
    this.assertHealthy();
    const data = createWorkspaceDataSchema.parse(input);
    const revision = await this.loadRevision(data.projectId, data.revision.revisionId);
    if (revision.configuration.hash !== data.revision.revisionHash) {
      throw new AgentExecutionError(executionFailure("CONFIGURATION_NOT_REGISTERED", "The configuration revision is not registered.", data.revision));
    }
    const store = await this.loadStoreOwnership(data.projectId);
    if (await lstatIdentity(this.workspaceOwnershipPath(data.workspaceId)) !== null) {
      const owned = await this.loadWorkspaceOwnership(data.projectId, data.workspaceId);
      if (owned.kind !== data.kind || JSON.stringify(owned.revision) !== JSON.stringify(data.revision)
        || owned.projectSlug !== data.projectSlug || owned.workspaceSlug !== data.workspaceSlug
        || owned.branchName !== data.branchName || JSON.stringify(owned.baseRef) !== JSON.stringify(data.baseRef)) throw workspaceConflict(data.workspaceId, "stopped");
      return;
    }
    const remoteRef = data.baseRef.kind === "branch" ? `refs/remotes/origin/${data.baseRef.branchName}^{commit}` : `${data.baseRef.commit}^{commit}`;
    let intendedCommit: string;
    try { intendedCommit = objectIdSchema.parse((await this.git(["--git-dir", store.repositoryPath, "rev-parse", "--verify", remoteRef])).stdout.trim()); }
    catch { throw workspaceConflict(data.workspaceId, "provisioning"); }
    let creation = await this.loadCreation(operationId);
    if (creation !== null && (creation.resourceType !== "workspace" || JSON.stringify(creation.request) !== JSON.stringify(data))) throw workspaceConflict(data.workspaceId);
    const parentPath = this.workspaceParent(data.workspaceId);
    const worktreePath = this.worktreePath(data.workspaceId);
    if (creation === null) {
      if (await lstatIdentity(parentPath) !== null) throw workspaceConflict(data.workspaceId);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(parentPath, { mode: 0o700 });
      const parent = await lstatIdentity(parentPath);
      if (parent === null || !parent.stats.isDirectory()) throw workspaceConflict(data.workspaceId);
      creation = workspaceCreationSchema.parse({ version: 1, resourceType: "workspace", operationId, request: data,
        parentPath, worktreePath, parentIdentity: parent.identity,
        store: { repositoryPath: store.repositoryPath, identity: store.identity },
        worktreeIdentity: null, intendedCommit, gitAdministration: null, phase: "parent-created" });
      await this.saveCreation(creation);
    }
    if (creation.resourceType !== "workspace" || creation.intendedCommit !== intendedCommit) throw workspaceConflict(data.workspaceId);
    const parentNow = await lstatIdentity(parentPath);
    if (parentNow === null || !parentNow.stats.isDirectory() || !identitiesEqual(parentNow.identity, creation.parentIdentity)) throw workspaceConflict(data.workspaceId);
    if (creation.phase === "parent-created") {
      const existingWorktree = await lstatIdentity(worktreePath);
      const registrations = await this.registeredWorktreePaths(store.repositoryPath);
      if (existingWorktree !== null || registrations.includes(worktreePath)) {
        if (existingWorktree !== null && existingWorktree.stats.isDirectory() && !existingWorktree.stats.isSymbolicLink() && registrations.includes(worktreePath)) {
          const recoveredHead = await this.git(["-C", worktreePath, "rev-parse", "--verify", "HEAD"]).then((result) => result.stdout.trim()).catch(() => "");
          const recoveredBranch = await this.git(["-C", worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"]).then((result) => result.stdout.trim()).catch(() => "");
          if (recoveredHead === intendedCommit && recoveredBranch === data.branchName) {
            const gitAdministration = await this.worktreeAdministration(store.repositoryPath, worktreePath);
            if (gitAdministration === null) throw workspaceConflict(data.workspaceId);
            creation = workspaceCreationSchema.parse({ ...creation, worktreeIdentity: existingWorktree.identity,
              gitAdministration, phase: "worktree-created" });
            await this.saveCreation(creation);
          } else { await this.cleanupWorkspaceCreation(creation, store.repositoryPath); return await this.createWorkspace(data, operationId); }
        } else { await this.cleanupWorkspaceCreation(creation, store.repositoryPath); return await this.createWorkspace(data, operationId); }
      }
    }
    if (creation.phase === "worktree-partial") {
      await this.cleanupWorkspaceCreation(creation, store.repositoryPath);
      return await this.createWorkspace(data, operationId);
    }
    if (creation.phase === "parent-created") {
      try {
        const conflictingBranch = (await this.registeredWorktrees(store.repositoryPath)).some((record) =>
          record.branch === `refs/heads/${data.branchName}` && record.path !== worktreePath);
        if (conflictingBranch) throw new Error("branch-already-registered");
        await this.operationGit(operationId, data.projectId, "workspace-branch-update",
          ["--git-dir", store.repositoryPath, "update-ref", `refs/heads/${data.branchName}`, intendedCommit]);
        await this.operationGit(operationId, data.projectId, "workspace-add",
          ["--git-dir", store.repositoryPath, "worktree", "add", "--", worktreePath, data.branchName]);
      } catch {
        const partial = await lstatIdentity(worktreePath);
        if (partial !== null && partial.stats.isDirectory() && !partial.stats.isSymbolicLink()) {
          const gitAdministration = await this.worktreeAdministration(store.repositoryPath, worktreePath).catch(() => null);
          if (gitAdministration === null) {
            throw workspaceConflict(data.workspaceId, "provisioning");
          }
          creation = workspaceCreationSchema.parse({ ...creation, worktreeIdentity: partial.identity,
            gitAdministration, phase: "worktree-partial" });
          await this.saveCreation(creation);
        }
        await this.cleanupWorkspaceCreation(creation, store.repositoryPath);
        throw workspaceConflict(data.workspaceId, "provisioning");
      }
      const worktree = await lstatIdentity(worktreePath);
      if (worktree === null || !worktree.stats.isDirectory() || worktree.stats.isSymbolicLink()) throw workspaceConflict(data.workspaceId, "provisioning");
      const head = (await this.git(["-C", worktreePath, "rev-parse", "--verify", "HEAD"])).stdout.trim();
      if (head !== intendedCommit) throw workspaceConflict(data.workspaceId, "provisioning");
      const gitAdministration = await this.worktreeAdministration(store.repositoryPath, worktreePath);
      if (gitAdministration === null) throw workspaceConflict(data.workspaceId, "provisioning");
      creation = workspaceCreationSchema.parse({ ...creation, worktreeIdentity: worktree.identity,
        gitAdministration, phase: "worktree-created" });
      await this.saveCreation(creation);
    }
    const worktreeNow = await lstatIdentity(worktreePath);
    if (worktreeNow === null || creation.worktreeIdentity === null || !identitiesEqual(worktreeNow.identity, creation.worktreeIdentity)) throw workspaceConflict(data.workspaceId);
    const ownership = workspaceOwnershipSchema.parse({
      version: 1, projectId: data.projectId, workspaceId: data.workspaceId,
      projectSlug: data.projectSlug, workspaceSlug: data.workspaceSlug, kind: data.kind,
      worktreePath, identity: worktreeNow.identity, parentPath, parentIdentity: creation.parentIdentity,
      store: { repositoryPath: store.repositoryPath, identity: store.identity }, revision: data.revision,
      branchName: data.branchName, baseRef: data.baseRef, creationCommit: intendedCommit
    });
    await this.validateCreationSemantics(creation);
    await this.assertManagedDirectories();
    await this.writer.write(this.workspaceOwnershipPath(data.workspaceId), ownership);
    await this.removeCreation(creation.operationId);
    const revalidated = await this.loadWorkspaceOwnership(data.projectId, data.workspaceId);
    const finalHead = (await this.git(["-C", revalidated.worktreePath, "rev-parse", "--verify", "HEAD"])).stdout.trim();
    if (finalHead !== intendedCommit) throw workspaceConflict(data.workspaceId);
  }

  private async cleanupWorkspaceCreation(creation: z.infer<typeof workspaceCreationSchema>, repository: string): Promise<void> {
    await this.validateCreationSemantics(creation);
    if (repository !== creation.store.repositoryPath || creation.parentPath !== this.workspaceParent(creation.request.workspaceId)
      || creation.worktreePath !== this.worktreePath(creation.request.workspaceId)) {
      throw this.creationCorruption(creation, "workspace cleanup binding is inconsistent");
    }
    const parent = await lstatIdentity(creation.parentPath);
    if (parent === null || !parent.stats.isDirectory() || !identitiesEqual(parent.identity, creation.parentIdentity)) throw workspaceConflict(creation.request.workspaceId);
    const names = await readdir(creation.parentPath);
    if (names.some((name) => name !== "source")) throw workspaceConflict(creation.request.workspaceId);
    const worktreePath = creation.worktreePath;
    const currentWorktree = await lstatIdentity(worktreePath);
    if (currentWorktree !== null) {
      if (creation.worktreeIdentity === null || !currentWorktree.stats.isDirectory() || !identitiesEqual(currentWorktree.identity, creation.worktreeIdentity)) throw workspaceConflict(creation.request.workspaceId);
      const dirty = await this.git(["-C", worktreePath, "status", "--porcelain=v1"]).then((result) => result.stdout !== "")
        .catch(() => { throw workspaceConflict(creation.request.workspaceId); });
      if (dirty) throw workspaceConflict(creation.request.workspaceId);
    }
    const registrations = await this.registeredWorktreePaths(repository);
    if (registrations.includes(worktreePath)) await this.removeExactWorktreeRegistration(
      repository, worktreePath, creation.operationId, creation.request.workspaceId, creation.gitAdministration
    );
    const after = await lstatIdentity(creation.parentPath);
    if (after === null || !identitiesEqual(after.identity, creation.parentIdentity)) throw workspaceConflict(creation.request.workspaceId);
    await this.quarantineAndRemove(creation.parentPath, creation.parentIdentity,
      this.workspaceCleanupPath(creation.operationId));
    await this.removeCreation(creation.operationId);
  }

  private async removeExactWorktreeRegistration(repository: string, worktreePath: string, operationId: string, workspaceId: string,
    expected: { path: string; identity: FileIdentity } | null): Promise<void> {
    if (expected === null) throw workspaceConflict(workspaceId);
    const administrativeRoot = path.join(repository, "worktrees");
    const entries = await readdir(administrativeRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let matched: { path: string; identity: FileIdentity } | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const administrativePath = path.join(administrativeRoot, entry.name);
      const directory = await lstatIdentity(administrativePath);
      const gitdirPath = path.join(administrativePath, "gitdir");
      const gitdirEntry = await lstatIdentity(gitdirPath);
      if (directory === null || !directory.stats.isDirectory() || directory.stats.isSymbolicLink()
        || gitdirEntry === null || !gitdirEntry.stats.isFile() || gitdirEntry.stats.isSymbolicLink()) continue;
      const registeredGitFile = (await readFile(gitdirPath, "utf8")).trim();
      if (path.resolve(registeredGitFile) !== path.join(worktreePath, ".git")) continue;
      if (matched !== null) throw workspaceConflict(workspaceId);
      matched = { path: administrativePath, identity: directory.identity };
    }
    if (matched === null) throw workspaceConflict(workspaceId);
    if (matched.path !== expected.path || !identitiesEqual(matched.identity, expected.identity)) {
      throw workspaceConflict(workspaceId);
    }
    await this.quarantineAndRemove(matched.path, matched.identity,
      path.join(administrativeRoot, `.devspace-cleanup-${operationId}`));
    if ((await this.registeredWorktreePaths(repository)).includes(worktreePath)) throw workspaceConflict(workspaceId);
  }

  async inspectGit(projectId: string, workspaceId: string | null): Promise<GitInspectionData> {
    const store = await this.loadStoreOwnership(projectId);
    const workspace = workspaceId === null ? null : await this.loadWorkspaceOwnership(projectId, workspaceId);
    const prefix = workspace === null ? ["--git-dir", store.repositoryPath] : ["-C", workspace.worktreePath];
    const branchName = (await this.git([...prefix, "symbolic-ref", "--quiet", "--short", "HEAD"]).then((result) => result.stdout.trim()).catch(() => "")) || null;
    const headCommit = (await this.git([...prefix, "rev-parse", "--verify", "HEAD"]).then((result) => result.stdout.trim()).catch(() => "")) || null;
    const dirty = workspace === null ? false : await this.git([...prefix, "status", "--porcelain=v1"]).then((result) => result.stdout !== "");
    let aheadCount = 0; let behindCount = 0;
    if (workspace !== null && branchName !== null) {
      const counts = await this.git([...prefix, "rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${branchName}`])
        .then((result) => result.stdout.trim().split(/\s+/u).map(Number)).catch(() => []);
      aheadCount = counts[0] ?? 0; behindCount = counts[1] ?? 0;
    }
    await (workspace === null ? this.loadStoreOwnership(projectId) : this.loadWorkspaceOwnership(projectId, workspaceId!));
    return gitInspectionDataSchema.parse({ projectId, workspaceId, branchName, headCommit, dirty, aheadCount, behindCount });
  }

  async inspectWorkspace(projectId: string, workspaceId: string): Promise<WorkspaceInspectionData> {
    const record = await this.loadWorkspaceOwnership(projectId, workspaceId);
    const revision = await this.loadRevisionRecord(projectId, record.revision.revisionId);
    const runtime = revision.runtimePlan === null
      ? { observedState: "absent" as const, serviceState: "absent" as const, errorCode: null, containerIdentity: null }
      : await this.runtime.inspect({ projectId, workspaceId, revisionId: record.revision.revisionId,
          revisionHash: record.revision.revisionHash, runtimePlanHash: revision.runtimePlan.hash, generation: 1 });
    const workspaceObserved = runtime.observedState === "running" ? "running"
      : runtime.observedState === "stopped" || runtime.observedState === "absent" ? "stopped"
      : runtime.observedState === "lost" ? "lost" : "failed";
    const desiredState = workspaceObserved === "running" ? "running" : "stopped";
    const runtimeDesired = runtime.observedState === "absent" ? "absent" : desiredState;
    return workspaceInspectionDataSchema.parse({
      projectId, workspaceId, kind: record.kind, revisionId: record.revision.revisionId, revisionHash: record.revision.revisionHash,
      desiredState, observedState: workspaceObserved, dirty: (await this.inspectGit(projectId, workspaceId)).dirty,
      runtimeStack: { desiredState: runtimeDesired, observedState: runtime.observedState }
    });
  }

  async runtimeStatus(): Promise<"available" | "unavailable"> { return await this.runtime.status(); }

  async executionContext(projectId: string, workspaceId: string): Promise<WorkspaceExecutionContext> {
    const workspace = await this.loadWorkspaceOwnership(projectId, workspaceId);
    const revision = await this.loadRevisionRecord(projectId, workspace.revision.revisionId);
    if (revision.runtimePlan === null) {
      throw new AgentExecutionError(executionFailure("CONFIGURATION_NOT_REGISTERED", "The runtime plan is not registered.", workspace.revision));
    }
    const association = {
      projectId, workspaceId, revisionId: workspace.revision.revisionId,
      revisionHash: workspace.revision.revisionHash, runtimePlanHash: revision.runtimePlan.hash, generation: 1
    };
    try {
      const ownership = await this.runtime.exactRunningOwnership(association);
      return { ...association, ownership, options: parseProjectOptionsV1(JSON.parse(revision.data.configuration.canonicalJson)) };
    } catch (error) {
      throw this.runtimeFailure(error, workspaceId, "start");
    }
  }

  private runtimeFailure(error: unknown, workspaceId: string, action: "start" | "stop"): AgentExecutionError {
    if (error instanceof WorkspaceRuntimeError) {
      if (error.code === "ROOTLESS_RUNTIME_UNAVAILABLE") {
        return new AgentExecutionError(executionFailure(error.code, error.message, { component: "docker" }));
      }
      if (error.code === "RUNTIME_POLICY_VIOLATION") {
        return new AgentExecutionError(executionFailure(error.code, error.message, { policy: "workspace-action-rejected" }));
      }
      return new AgentExecutionError(executionFailure(error.code, error.message, {
        workspaceId, desiredState: action === "start" ? "running" : "stopped",
        observedState: "lost", action
      }));
    }
    return new AgentExecutionError(executionFailure("AGENT_INTERNAL_ERROR", "The workspace runtime operation failed safely.", { incidentId: uuidv7() }));
  }

  async startWorkspace(projectId: string, workspaceId: string, operationId: string): Promise<void> {
    const workspace = await this.loadWorkspaceOwnership(projectId, workspaceId);
    const revision = await this.loadRevisionRecord(projectId, workspace.revision.revisionId);
    if (revision.runtimePlan === null) {
      throw new AgentExecutionError(executionFailure("CONFIGURATION_NOT_REGISTERED", "The runtime plan is not registered.", workspace.revision));
    }
    const association = { projectId, workspaceId, revisionId: workspace.revision.revisionId,
      revisionHash: workspace.revision.revisionHash, runtimePlanHash: revision.runtimePlan.hash, generation: 1 };
    let bindings;
    try {
      const options = parseProjectOptionsV1(JSON.parse(revision.data.configuration.canonicalJson));
      bindings = await this.preview.reserveWorkspaceLeases(association, options, operationId);
      await this.runtime.start(association, JSON.parse(revision.runtimePlan.canonicalJson), workspace.worktreePath, operationId, bindings);
      const ownership = await this.runtime.exactRunningOwnership(association);
      await this.preview.bindRuntimeContainer(association, ownership.developmentContainer.id, bindings);
      await this.preview.workspaceStarted(association);
    } catch (error) {
      await this.preview.releaseOperationLeases(association, operationId).catch(() => undefined);
      if (error instanceof PreviewRuntimeError) {
        const code = error.code === "ROOTLESS_RUNTIME_UNAVAILABLE" ? "ROOTLESS_RUNTIME_UNAVAILABLE"
          : error.code === "RUNTIME_POLICY_VIOLATION" ? "RUNTIME_POLICY_VIOLATION" : "WORKSPACE_STATE_CONFLICT";
        throw this.runtimeFailure(new WorkspaceRuntimeError(code, error.message), workspaceId, "start");
      }
      throw this.runtimeFailure(error, workspaceId, "start");
    }
  }

  async stopWorkspace(projectId: string, workspaceId: string): Promise<void> {
    const workspace = await this.loadWorkspaceOwnership(projectId, workspaceId);
    const revision = await this.loadRevisionRecord(projectId, workspace.revision.revisionId);
    if (revision.runtimePlan === null) throw workspaceConflict(workspaceId, "stopped");
    try {
      const association = { projectId, workspaceId, revisionId: workspace.revision.revisionId,
        revisionHash: workspace.revision.revisionHash, runtimePlanHash: revision.runtimePlan.hash, generation: 1 };
      await this.runtime.stop(association);
      await this.preview.workspaceStopped(association);
    } catch (error) { throw this.runtimeFailure(error, workspaceId, "stop"); }
  }

  private previewFailure(error: unknown, workspaceId: string, action: "activate" | "deactivate", previewId: string | null,
    previewKey: string | null, revisionId: string | null = null): AgentExecutionError {
    if (error instanceof AgentExecutionError) return error;
    if (error instanceof PreviewRuntimeError) {
      switch (error.code) {
        case "PREVIEW_NOT_DEFINED":
          if (error.details.revisionId !== undefined || revisionId !== null) {
            return new AgentExecutionError(executionFailure("PREVIEW_NOT_DEFINED", error.message, {
              revisionId: error.details.revisionId ?? revisionId!, previewKey: error.details.previewKey ?? previewKey ?? "preview"
            }));
          }
          break;
        case "RESOURCE_NOT_FOUND":
          return new AgentExecutionError(executionFailure("RESOURCE_NOT_FOUND", error.message, {
            resource: { type: previewId === null ? "workspace" : "preview", id: previewId ?? workspaceId }
          }));
        case "PREVIEW_DOMAIN_NOT_APPROVED":
          return new AgentExecutionError(executionFailure("PREVIEW_DOMAIN_NOT_APPROVED", error.message, {
            previewId: error.details.previewId ?? previewId ?? workspaceId
          }));
        case "GATEWAY_UPDATE_FAILED":
          return new AgentExecutionError(executionFailure("GATEWAY_UPDATE_FAILED", error.message, { previewId: previewId ?? workspaceId }));
        case "ROOTLESS_RUNTIME_UNAVAILABLE":
          return new AgentExecutionError(executionFailure("ROOTLESS_RUNTIME_UNAVAILABLE", error.message, { component: "docker" }));
        case "RUNTIME_POLICY_VIOLATION":
          return new AgentExecutionError(executionFailure("RUNTIME_POLICY_VIOLATION", error.message, { policy: "preview-action-rejected" }));
        case "WORKSPACE_STATE_CONFLICT":
          return new AgentExecutionError(executionFailure("WORKSPACE_STATE_CONFLICT", error.message, {
            workspaceId, desiredState: action === "activate" ? "running" : "stopped",
            observedState: "lost", action: action === "activate" ? "activate-preview" : "stop"
          }));
      }
    }
    return new AgentExecutionError(executionFailure("AGENT_INTERNAL_ERROR", "The preview operation failed safely.", { incidentId: uuidv7() }));
  }

  private previewInspectionFailure(error: unknown, workspaceId: string, previewId: string): AgentExecutionError {
    const mapped = error instanceof AgentExecutionError
      ? error
      : this.previewFailure(error, workspaceId, "activate", previewId, null);
    switch (mapped.failure.code) {
      case "PROJECT_NOT_FOUND":
      case "RESOURCE_NOT_FOUND":
      case "ROOTLESS_RUNTIME_UNAVAILABLE":
        return mapped;
      default:
        return new AgentExecutionError(executionFailure("AGENT_INTERNAL_ERROR", "The preview could not be inspected safely.", {
          incidentId: uuidv7()
        }));
    }
  }

  private async previewContext(projectId: string, workspaceId: string) {
    const workspace = await this.loadWorkspaceOwnership(projectId, workspaceId);
    const revision = await this.loadRevisionRecord(projectId, workspace.revision.revisionId);
    if (revision.runtimePlan === null) {
      throw new AgentExecutionError(executionFailure("CONFIGURATION_NOT_REGISTERED", "The runtime plan is not registered.", workspace.revision));
    }
    return {
      workspace,
      options: parseProjectOptionsV1(JSON.parse(revision.data.configuration.canonicalJson)),
      association: { projectId, workspaceId, revisionId: workspace.revision.revisionId,
        revisionHash: workspace.revision.revisionHash, runtimePlanHash: revision.runtimePlan.hash, generation: 1 }
    };
  }

  async activatePreview(input: import("@devspace/contracts").ActivatePreviewData, operationId: string): Promise<void> {
    let context;
    try { context = await this.previewContext(input.projectId, input.workspaceId); }
    catch (error) { throw this.previewFailure(error, input.workspaceId, "activate", input.previewId, input.previewKey); }
    try { await this.preview.activate(input, context.association, context.options, operationId); }
    catch (error) { throw this.previewFailure(error, input.workspaceId, "activate", input.previewId, input.previewKey, context.association.revisionId); }
  }

  async deactivatePreview(input: import("@devspace/contracts").PreviewIdentityData, operationId: string): Promise<void> {
    let context;
    try { context = await this.previewContext(input.projectId, input.workspaceId); }
    catch (error) { throw this.previewFailure(error, input.workspaceId, "deactivate", input.previewId, null); }
    if (input.revisionId !== context.association.revisionId) {
      throw this.previewFailure(new PreviewRuntimeError("WORKSPACE_STATE_CONFLICT", "The preview request has a stale configuration revision."), input.workspaceId, "deactivate", input.previewId, null, context.association.revisionId);
    }
    try { await this.preview.deactivate(input, operationId); }
    catch (error) { throw this.previewFailure(error, input.workspaceId, "deactivate", input.previewId, null); }
  }

  async inspectPreview(input: import("@devspace/contracts").PreviewIdentityData): Promise<PreviewInspectionResult> {
    let context;
    try { context = await this.previewContext(input.projectId, input.workspaceId); }
    catch (error) { throw this.previewInspectionFailure(error, input.workspaceId, input.previewId); }
    if (input.revisionId !== context.association.revisionId) {
      throw this.previewInspectionFailure(new PreviewRuntimeError("WORKSPACE_STATE_CONFLICT", "The preview request has a stale configuration revision."),
        input.workspaceId, input.previewId);
    }
    try { return await this.preview.inspect(input); }
    catch (error) { throw this.previewInspectionFailure(error, input.workspaceId, input.previewId); }
  }

  async snapshotResources(): Promise<AgentSnapshotResource[]> {
    await this.assertManagedDirectories();
    const workspaceDirectory = path.join(this.stateRoot, "ownership", "workspaces");
    const projectDirectory = path.join(this.stateRoot, "ownership", "projects");
    const workspaceRecords = await Promise.all((await readdir(workspaceDirectory)).map(async (name) =>
      await this.readPrivate(path.join(workspaceDirectory, name), workspaceOwnershipSchema)));
    const projectRecords = await Promise.all((await readdir(projectDirectory)).map(async (name) =>
      await this.readPrivate(path.join(projectDirectory, name), storeOwnershipSchema)));
    const resources: AgentSnapshotResource[] = [];
    for (const project of projectRecords) {
      const children = workspaceRecords.filter((record) => record.projectId === project.projectId);
      resources.push({ type: "project", projectId: project.projectId, gitInspections: [
        { scope: { kind: "managed-store" }, inspection: await this.inspectGit(project.projectId, null) },
        ...await Promise.all(children.map(async (record) => ({ scope: { kind: "workspace" as const, workspaceId: record.workspaceId }, inspection: await this.inspectGit(project.projectId, record.workspaceId) })))
      ] });
    }
    for (const record of workspaceRecords) {
      const observation = await this.inspectWorkspace(record.projectId, record.workspaceId);
      resources.push({ type: "workspace", observation });
      resources.push({ type: "runtime-stack", projectId: record.projectId, workspaceId: record.workspaceId, observation: observation.runtimeStack });
      resources.push({ type: "service", projectId: record.projectId, workspaceId: record.workspaceId, serviceKey: "development",
        observation: { desiredState: observation.runtimeStack.desiredState, observedState: observation.runtimeStack.observedState, health: "unknown" } });
    }
    return [...resources, ...await this.preview.snapshotResources()];
  }

  async validateCreationJournalBindings(findOperation: (operationId: string) => CreationJournalBinding | undefined): Promise<void> {
    await this.assertManagedDirectories();
    for (const name of await readdir(path.join(this.stateRoot, "creations"))) {
      const record = await this.loadCreation(path.basename(name, ".json"));
      if (record === null || name !== `${record.operationId}.json`) {
        this.corruption ??= new PrivateStateCorruptionError(path.join(this.stateRoot, "creations", name), "creation filename mismatch");
        continue;
      }
      const operation = findOperation(record.operationId);
      const expectedName = record.resourceType === "store" ? "project.managed-store.create" : "workspace.create";
      const expectedRequest = record.resourceType === "store"
        ? { projectId: record.projectId, source: record.source }
        : record.request;
      if (operation === undefined || operation.operationName !== expectedName
        || JSON.stringify(operation.request) !== JSON.stringify(expectedRequest)) {
        this.corruption ??= this.creationCorruption(record, "creation record is not bound to its durable journal operation");
      }
    }
    try { await this.runtime.validateCreationJournalBindings(findOperation); }
    catch (error) {
      this.corruption ??= new PrivateStateCorruptionError(path.join(this.stateRoot, "runtime-creations"),
        error instanceof Error ? error.message : "runtime creation journal binding validation failed");
    }
    this.assertHealthy();
  }

  validateExecutionJournalBindings(findOperation: (operationId: string) => (CreationJournalBinding & { readonly state: string }) | undefined): void {
    this.assertHealthy();
    if (this.executionFence === null) throw new PrivateStateCorruptionError(this.stateRoot, "execution fence is not initialized");
    this.executionFence.validateJournalBindings(findOperation);
  }
}
