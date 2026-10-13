import BetterSqlite3 from "better-sqlite3";
import {
  AI_INTERACTION_JSON_MAX_BYTES,
  AI_SESSION_EVENT_HISTORY_MAX_BYTES,
  AI_SESSION_EVENT_HISTORY_MAX_EVENTS,
  AI_SESSION_HISTORY_MAX_TURNS,
  AI_SESSION_INTERACTION_HISTORY_MAX_BYTES,
  AI_SESSION_INTERACTION_HISTORY_MAX_ROWS,
  AI_SESSION_OUTPUT_MAX_BYTES,
  AI_SESSION_RESPONSE_MAX_BYTES,
  AI_TURN_OUTPUT_MAX_BYTES,
  normalizeRetainedHistory,
  decodeUtf8Prefix,
  parseBoundedJson,
  serializedBytes,
  truncateUtf8,
  utf8ByteLength
} from "./ai-history.js";
import {
  AI_USER_CONTENT_MAX_BYTES,
  TERMINAL_POST_EXIT_REPLAY_RETENTION_MS,
  aiChangedFilesSummarySchema,
  canonicalAiEventSchema,
  classifyAiEventAppend,
  githubRepositorySchema,
  utcTimestampMsSchema,
  aiTurnContentSchema,
  type GithubRepository,
  type SourceLocator,
  type AgentSnapshotData,
  type NativeHarnessLifecycleState,
  type CanonicalAiEvent,
  type WorkspaceInspectionData,
  revisionIdentitySchema,
  type RevisionIdentity
} from "@devspace/contracts";
import { mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import pathModule from "node:path";
import {
  auditEvents, migrateDatabase, operations, processes, projectConfigRevisions, projects, runtimeStacks, taskRuns, terminalSessions,
  previews, workspaceServices, workspaces, aiSessions, aiTurns, aiEvents,
  githubConnectionAttempts, githubConnections, githubConnectionSetupAttempts, projectGithubSources,
  harnessDefinitions,
  type NewPreview, type Operation, type Preview, type Project, type ProjectConfigRevision, type ProjectGithubSource
} from "@devspace/database";
import { and, desc, eq, isNull, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { parseProjectOptionsV1 } from "@devspace/project-options";
import { persistedFailureMessage } from "./failure-policy.js";
import { materializePreviews as materializePreviewRows } from "./preview-persistence.js";

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly repositoryUrl: string;
  readonly defaultBranch: string;
  readonly state: "registering" | "ready" | "invalid" | "archived";
  readonly createdAt: string;
}

export interface ProjectSummaryView extends ProjectView {
  readonly primaryWorkspace: null | { readonly name: string; readonly observedState: string };
  readonly runtime: null | { readonly observedState: string };
}

export interface ManagedProjectView extends ProjectView {
  readonly activeRevision: null | { readonly id: string; readonly number: number; readonly hash: string };
  readonly primaryWorkspace: null | {
    readonly id: string; readonly name: string; readonly branchName: string;
    readonly desiredState: string; readonly observedState: string; readonly dirtyState: string;
  };
  readonly runtime: null | {
    readonly id: string; readonly desiredState: string; readonly observedState: string;
    readonly generation: number; readonly errorMessage: string | null; readonly serviceObservedState: string | null;
  };
  readonly tasks: readonly { readonly key: string; readonly displayName: string }[];
  readonly taskRuns: readonly { readonly id: string; readonly taskKey: string; readonly processId: string | null;
    readonly state: string; readonly processState: string | null; readonly exitCode: number | null }[];
  readonly terminals: readonly { readonly id: string; readonly processId: string; readonly title: string; readonly state: string }[];
  readonly previews: readonly PreviewView[];
}

export interface PreviewView {
  readonly id: string;
  readonly workspaceId: string;
  readonly configRevisionId: string;
  readonly previewKey: string;
  readonly displayName: string;
  readonly targetKind: "workspace" | "service";
  readonly targetKey: string;
  readonly hostname: string;
  readonly containerPort: number;
  readonly desiredState: string;
  readonly observedState: string;
  readonly routePresent: boolean;
  readonly runtimeGeneration: number | null;
  readonly lastObservationJson: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly slug: string;
  readonly repositoryUrl: string;
  readonly defaultBranch: string;
  readonly actor: string;
  readonly githubSource?: {
    readonly connectionId: string;
    readonly repository: GithubRepository;
    readonly verifiedAt: string;
    readonly metadataUpdatedAt: string;
  };
}

export interface ProjectGithubSourceView {
  readonly projectId: string;
  readonly connectionId: string;
  readonly repositoryId: string;
  readonly ownerLogin: string;
  readonly name: string;
  readonly fullName: string;
  readonly cleanHttpsUrl: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly disabled: boolean;
  readonly verifiedAt: string;
  readonly metadataUpdatedAt: string;
  readonly rowVersion: number;
}

export class DuplicateProjectSlugError extends Error {
  constructor() { super("A project with this slug already exists."); this.name = "DuplicateProjectSlugError"; }
}
export class ProjectSetupConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectSetupConflictError"; }
}

const terminalNamespaceStates = new Set(["creating", "active", "disconnected"]);
const terminalProcessFinalStates = new Set(["exited", "failed", "killed", "lost"]);
const terminalDisplayNumberPattern = /^Terminal ([1-9][0-9]*)$/u;
const terminalRetirementGracePeriodMs = 30_000;

type TerminalNamespaceRow = { readonly id: string; readonly title: string; readonly state: string };

function terminalDisplayNumber(title: string): number | undefined {
  const match = terminalDisplayNumberPattern.exec(title);
  return match === null ? undefined : Number(match[1]);
}

function terminalTitleAssignments(rows: readonly TerminalNamespaceRow[]): Map<string, string> {
  const assignments = new Map<string, string>();
  const reserved = new Set<number>();
  const unnumbered: TerminalNamespaceRow[] = [];
  for (const row of rows) {
    if (!terminalNamespaceStates.has(row.state)) continue;
    const number = terminalDisplayNumber(row.title);
    if (number === undefined || reserved.has(number)) unnumbered.push(row);
    else {
      reserved.add(number);
      assignments.set(row.id, row.title);
    }
  }
  let next = 1;
  for (const row of unnumbered) {
    while (reserved.has(next)) next += 1;
    const title = `Terminal ${next}`;
    reserved.add(next);
    assignments.set(row.id, title);
    next += 1;
  }
  return assignments;
}

function nextTerminalTitle(rows: readonly TerminalNamespaceRow[]): string {
  const assignments = terminalTitleAssignments(rows);
  const reserved = new Set<number>();
  for (const title of assignments.values()) {
    const number = terminalDisplayNumber(title);
    if (number !== undefined) reserved.add(number);
  }
  let next = 1;
  while (reserved.has(next)) next += 1;
  return `Terminal ${next}`;
}

function toView(project: Project): ProjectView {
  return {
    id: project.id, name: project.name, slug: project.slug, repositoryUrl: project.repositoryUrl,
    defaultBranch: project.defaultBranch, state: project.state, createdAt: project.createdAt
  };
}

function toGithubSourceView(source: ProjectGithubSource): ProjectGithubSourceView {
  return {
    projectId: source.projectId,
    connectionId: source.connectionId,
    repositoryId: source.repositoryId,
    ownerLogin: source.ownerLogin,
    name: source.name,
    fullName: source.fullName,
    cleanHttpsUrl: source.cleanHttpsUrl,
    defaultBranch: source.defaultBranch,
    private: source.isPrivate,
    archived: source.isArchived,
    disabled: source.isDisabled,
    verifiedAt: source.verifiedAt,
    metadataUpdatedAt: source.metadataUpdatedAt,
    rowVersion: source.rowVersion
  };
}

function toPreviewView(preview: Preview): PreviewView {
  return {
    id: preview.id,
    workspaceId: preview.workspaceId,
    configRevisionId: preview.configRevisionId,
    previewKey: preview.previewKey,
    displayName: preview.displayName,
    targetKind: preview.targetKind,
    targetKey: preview.targetKey,
    hostname: preview.hostname,
    containerPort: preview.containerPort,
    desiredState: preview.desiredState,
    observedState: preview.observedState,
    routePresent: preview.routePresent,
    runtimeGeneration: preview.runtimeGeneration,
    lastObservationJson: preview.lastObservationJson,
    lastErrorCode: preview.lastErrorCode,
    lastErrorMessage: preview.lastErrorCode === null ? null : persistedFailureMessage(preview.lastErrorCode)
  };
}

export function openProjectDatabase(path: string, options: {
  now?: () => Date;
  createId?: () => string;
  beforeAuditInsert?: () => void;
} = {}) {
  if (path !== ":memory:") mkdirSync(pathModule.dirname(pathModule.resolve(path)), { recursive: true, mode: 0o700 });
  const client = new BetterSqlite3(path);
  migrateDatabase(client);
  client.pragma("foreign_keys = ON");
  const db = drizzle({ client });
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? uuidv7;
  const pendingConfigurationApply = (projectId: string, workspaceId?: string) => {
    const clauses = [eq(operations.projectId, projectId), eq(operations.operationName, "configuration.apply"),
      or(eq(operations.state, "accepted"), eq(operations.state, "running"))];
    if (workspaceId !== undefined) clauses.push(eq(operations.workspaceId, workspaceId));
    return db.select().from(operations).where(and(...clauses))
      .orderBy(desc(operations.createdAt), desc(operations.operationId)).get();
  };
  const assertNoPendingConfigurationApply = (projectId: string, workspaceId?: string): void => {
    if (pendingConfigurationApply(projectId, workspaceId) !== undefined) {
      throw new ProjectSetupConflictError("Project Options Apply is in progress for this workspace.");
    }
  };
  const projectOptionsDraftBaseRevision = (revisionId: string): string | null => {
    const audit = db.select({ metadataJson: auditEvents.metadataJson }).from(auditEvents).where(and(
      eq(auditEvents.eventType, "project.options.draft_saved"), eq(auditEvents.resourceType, "configuration-revision"),
      eq(auditEvents.resourceId, revisionId)
    )).orderBy(desc(auditEvents.sequence)).get();
    if (audit === undefined) return null;
    try {
      const metadata: unknown = JSON.parse(audit.metadataJson);
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
      const expectedRevisionId = (metadata as Record<string, unknown>)["expectedRevisionId"];
      return typeof expectedRevisionId === "string" ? expectedRevisionId : null;
    } catch { return null; }
  };
  const terminalizeInterruptedProjectPushes = (): void => {
    const timestamp = now().toISOString();
    const active = db.select().from(operations).where(and(
      eq(operations.operationName, "project.push"),
      or(eq(operations.state, "accepted"), eq(operations.state, "running"))
    )).all();
    for (const operation of active) {
      let phase: unknown = "submitted";
      try {
        phase = operation.progressJson === null ? "submitted" : (JSON.parse(operation.progressJson) as { phase?: unknown }).phase;
      } catch {
        // A malformed active push record is conservatively treated as an
        // interrupted submission; its durable intent is still retained.
      }
      if (operation.state !== "running" && phase === "prepared") continue;
      db.update(operations).set({ state: "failed", finishedAt: timestamp,
        errorCode: "GITHUB_PUSH_OUTCOME_UNCERTAIN",
        errorMessage: "The push outcome is uncertain after Web interruption. Inspect the remote branch before explicitly retrying."
      }).where(and(eq(operations.operationId, operation.operationId), or(
        eq(operations.state, "accepted"), eq(operations.state, "running")
      ))).run();
    }
  };
  terminalizeInterruptedProjectPushes();
  const pruneExpiredLostTerminalSessions = (): void => {
    const retirementCutoff = new Date(now().valueOf() - terminalRetirementGracePeriodMs).toISOString();
    const expired = db.select({ id: terminalSessions.id, processId: terminalSessions.processId })
      .from(terminalSessions)
      .where(and(eq(terminalSessions.state, "lost"), lte(terminalSessions.closedAt, retirementCutoff)))
      .all();
    for (const terminal of expired) {
      db.delete(terminalSessions).where(and(
        eq(terminalSessions.id, terminal.id), eq(terminalSessions.state, "lost"), lte(terminalSessions.closedAt, retirementCutoff)
      )).run();
      db.delete(processes).where(and(eq(processes.id, terminal.processId), eq(processes.kind, "terminal"))).run();
    }
  };
  const retireLostTerminalResources = (workspaceId: string): void => {
    const lostTerminals = db.select({ id: terminalSessions.id, processId: terminalSessions.processId })
      .from(terminalSessions)
      .where(and(eq(terminalSessions.workspaceId, workspaceId), eq(terminalSessions.state, "lost")))
      .all();
    for (const terminal of lostTerminals) {
      db.delete(terminalSessions).where(and(
        eq(terminalSessions.id, terminal.id), eq(terminalSessions.workspaceId, workspaceId), eq(terminalSessions.state, "lost")
      )).run();
      db.delete(processes).where(and(
        eq(processes.id, terminal.processId), eq(processes.workspaceId, workspaceId), eq(processes.kind, "terminal")
      )).run();
    }
  };
  const readManagedProject = (project: Project): ManagedProjectView => {
    pruneExpiredLostTerminalSessions();
    const revision = project.activeConfigRevisionId === null ? undefined
      : db.select().from(projectConfigRevisions).where(eq(projectConfigRevisions.id, project.activeConfigRevisionId)).get();
    const workspace = project.primaryWorkspaceId === null ? undefined
      : db.select().from(workspaces).where(eq(workspaces.id, project.primaryWorkspaceId)).get();
    const runtime = workspace === undefined ? undefined
      : db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, workspace.id)).get();
    const development = runtime === undefined ? undefined : db.select().from(workspaceServices).where(and(
      eq(workspaceServices.runtimeStackId, runtime.id), eq(workspaceServices.kind, "development")
    )).get();
    const projectOptions = revision === undefined ? null : parseProjectOptionsV1(JSON.parse(revision.configurationJson));
    const recentRuns = workspace === undefined ? [] : db.select().from(taskRuns).where(eq(taskRuns.workspaceId, workspace.id))
      .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(20).all();
    const terminalRows = workspace === undefined ? [] : db.select().from(terminalSessions).where(eq(terminalSessions.workspaceId, workspace.id))
      .orderBy(desc(terminalSessions.createdAt), desc(terminalSessions.id)).all();
    const terminalTitles = terminalTitleAssignments(terminalRows);
    for (const terminal of terminalRows) {
      const title = terminalTitles.get(terminal.id);
      if (title !== undefined && title !== terminal.title) {
        db.update(terminalSessions).set({ title }).where(eq(terminalSessions.id, terminal.id)).run();
      }
    }
    const previewRows = workspace === undefined || revision === undefined ? [] : db.select().from(previews)
      .where(and(eq(previews.workspaceId, workspace.id), eq(previews.configRevisionId, revision.id)))
      .orderBy(previews.previewKey, previews.id).all();
    return {
      ...toView(project),
      activeRevision: revision === undefined ? null : { id: revision.id, number: revision.revisionNumber, hash: revision.configurationHash },
      primaryWorkspace: workspace === undefined ? null : {
        id: workspace.id, name: workspace.name, branchName: workspace.branchName,
        desiredState: workspace.desiredState, observedState: workspace.observedState, dirtyState: workspace.dirtyState
      },
      runtime: runtime === undefined ? null : { id: runtime.id, desiredState: runtime.desiredState,
        observedState: runtime.observedState, generation: runtime.runtimeGeneration,
        errorMessage: runtime.lastErrorCode === null ? null : persistedFailureMessage(runtime.lastErrorCode),
        serviceObservedState: development?.observedState ?? null },
      tasks: projectOptions?.tasks.map((task) => ({ key: task.key, displayName: task.displayName })) ?? [],
      taskRuns: recentRuns.map((run) => { const process = run.processId === null ? undefined
        : db.select().from(processes).where(eq(processes.id, run.processId)).get();
        return { id: run.id, taskKey: run.taskKey, processId: run.processId, state: run.state,
          processState: process?.observedState ?? null, exitCode: run.exitCode }; }),
      terminals: terminalRows.map((terminal) => ({ id: terminal.id, processId: terminal.processId,
        title: terminalTitles.get(terminal.id) ?? terminal.title, state: terminal.state })),
      previews: previewRows.map(toPreviewView)
    };
  };
  const assertAiWorkspace = (projectId: string, workspaceId: string) => {
    assertNoPendingConfigurationApply(projectId, workspaceId);
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (project === undefined || project.state !== "ready" || project.primaryWorkspaceId === null || project.activeConfigRevisionId === null) {
      throw new ProjectSetupConflictError("The AI session is no longer available.");
    }
    const workspace = db.select().from(workspaces).where(and(
      eq(workspaces.id, workspaceId), eq(workspaces.projectId, projectId), eq(workspaces.id, project.primaryWorkspaceId)
    )).get();
    const revision = db.select().from(projectConfigRevisions).where(and(
      eq(projectConfigRevisions.id, project.activeConfigRevisionId), eq(projectConfigRevisions.projectId, projectId)
    )).get();
    if (workspace === undefined || workspace.kind !== "primary" || revision === undefined || workspace.configRevisionId !== revision.id) {
      throw new ProjectSetupConflictError("The AI session is no longer available.");
    }
    return { project, workspace, revision };
  };
  type RawAiTurnRow = {
    id: string;
    state: string;
    contentJson: string | null;
    outputBytes: number;
    outputPrefix: Buffer | null;
    outputTruncated: number;
    changedFilesJson: string | null;
    failureJson: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
  };
  type RawAiEventRow = { eventJson: string | null; eventBytes: number; sequence: number };
  type RawAiInteractionRow = {
    id: string;
    turnId: string | null;
    kind: string;
    state: string;
    requestJson: string | null;
    requestBytes: number;
    responseJson: string | null;
    responseBytes: number;
    createdAt: string;
    updatedAt: string;
  };
  const readAiInteractionRows = (sessionId: string) => {
    const candidates = client.prepare(`
      select id as id, turn_id as turnId, kind as kind, state as state,
        case when length(cast(request_json as blob)) <= ? then request_json else null end as requestJson,
        length(cast(request_json as blob)) as requestBytes,
        case when response_json is null or length(cast(response_json as blob)) <= ? then response_json else null end as responseJson,
        coalesce(length(cast(response_json as blob)), 0) as responseBytes,
        created_at as createdAt, updated_at as updatedAt
      from ai_interaction_requests where session_id = ?
      order by created_at desc, id desc limit ?
    `).all(AI_INTERACTION_JSON_MAX_BYTES, AI_INTERACTION_JSON_MAX_BYTES, sessionId,
      AI_SESSION_INTERACTION_HISTORY_MAX_ROWS + 1) as RawAiInteractionRow[];
    let truncated = candidates.length > AI_SESSION_INTERACTION_HISTORY_MAX_ROWS;
    let bytes = 0;
    const selected: Array<Record<string, unknown>> = [];
    for (const row of candidates.slice(0, AI_SESSION_INTERACTION_HISTORY_MAX_ROWS)) {
      const rowBytes = row.requestBytes + row.responseBytes;
      if (row.requestJson === null || (row.responseBytes > 0 && row.responseJson === null)
        || bytes + rowBytes > AI_SESSION_INTERACTION_HISTORY_MAX_BYTES) {
        truncated = true;
        continue;
      }
      const request = parseBoundedJson(row.requestJson, AI_INTERACTION_JSON_MAX_BYTES);
      const response = row.responseJson === null ? null : parseBoundedJson(row.responseJson, AI_INTERACTION_JSON_MAX_BYTES);
      if (request === null || (row.responseJson !== null && response === null)) {
        truncated = true;
        continue;
      }
      selected.push({ id: row.id, turnId: row.turnId, kind: row.kind, state: row.state, request, response,
        createdAt: row.createdAt, updatedAt: row.updatedAt });
      bytes += rowBytes;
    }
    return { rows: selected.reverse(), truncated };
  };
  const readAiSessionView = (projectId: string, workspaceId: string, sessionId: string) => {
    assertAiWorkspace(projectId, workspaceId);
    const session = db.select().from(aiSessions).where(and(
      eq(aiSessions.id, sessionId), eq(aiSessions.workspaceId, workspaceId), eq(aiSessions.providerKey, "codex")
    )).get();
    if (session === undefined) return null;
    const rawTurns = client.prepare(`
      select id as id, state as state,
        case when length(cast(content_json as blob)) <= ? then content_json else null end as contentJson,
        length(cast(output_text as blob)) as outputBytes,
        substr(cast(output_text as blob), 1, ?) as outputPrefix,
        output_truncated as outputTruncated,
        case when length(cast(changed_files_json as blob)) <= ? then changed_files_json else null end as changedFilesJson,
        case when failure_json is null or length(cast(failure_json as blob)) <= ? then failure_json else null end as failureJson,
        created_at as createdAt, updated_at as updatedAt, completed_at as completedAt
      from ai_turns where session_id = ?
      order by created_at desc, id desc limit ?
    `).all(AI_USER_CONTENT_MAX_BYTES, AI_TURN_OUTPUT_MAX_BYTES + 4, AI_INTERACTION_JSON_MAX_BYTES,
      AI_INTERACTION_JSON_MAX_BYTES, session.id, AI_SESSION_HISTORY_MAX_TURNS + 1) as RawAiTurnRow[];
    let responseTruncated = rawTurns.length > AI_SESSION_HISTORY_MAX_TURNS;
    const turnViews = rawTurns.slice(0, AI_SESSION_HISTORY_MAX_TURNS).map((row) => {
      const content = parseBoundedJson(row.contentJson, AI_USER_CONTENT_MAX_BYTES);
      const parsedContent = aiTurnContentSchema.safeParse(content);
      const output = decodeUtf8Prefix(row.outputPrefix ?? Buffer.alloc(0), AI_TURN_OUTPUT_MAX_BYTES);
      const changedFiles = aiChangedFilesSummarySchema.safeParse(parseBoundedJson(row.changedFilesJson, AI_INTERACTION_JSON_MAX_BYTES));
      const failure = row.failureJson === null ? null : parseBoundedJson(row.failureJson, AI_INTERACTION_JSON_MAX_BYTES);
      if (!parsedContent.success || !changedFiles.success || row.outputBytes > AI_TURN_OUTPUT_MAX_BYTES
        || output.truncated || row.outputTruncated !== 0 || row.contentJson === null || row.changedFilesJson === null
        || (row.failureJson !== null && failure === null)) responseTruncated = true;
      return {
        id: row.id,
        state: row.state,
        content: parsedContent.success ? parsedContent.data : { kind: "text" as const, text: "" },
        outputText: output.value,
        outputTruncated: row.outputTruncated !== 0 || row.outputBytes > AI_TURN_OUTPUT_MAX_BYTES || output.truncated,
        changedFiles: changedFiles.success ? changedFiles.data : { files: [], truncated: true },
        failure,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt
      };
    }).reverse();
    const rawEvents = client.prepare(`
      select sequence as sequence,
        case when length(cast(event_json as blob)) <= ? then event_json else null end as eventJson,
        length(cast(event_json as blob)) as eventBytes
      from ai_events where session_id = ? and sequence >= ? order by sequence desc limit ?
    `).all(AI_SESSION_EVENT_HISTORY_MAX_BYTES, session.id, session.historyStartSequence,
      AI_SESSION_EVENT_HISTORY_MAX_EVENTS + 1) as RawAiEventRow[];
    const eventViews: CanonicalAiEvent[] = [];
    for (const row of rawEvents.slice(0, AI_SESSION_EVENT_HISTORY_MAX_EVENTS)) {
      const event = row.eventJson === null ? null : canonicalAiEventSchema.safeParse(parseBoundedJson(row.eventJson, AI_SESSION_EVENT_HISTORY_MAX_BYTES));
      if (event !== null && event.success) eventViews.push(event.data);
      else responseTruncated = true;
      if (row.eventBytes > AI_SESSION_EVENT_HISTORY_MAX_BYTES) responseTruncated = true;
    }
    const interactions = readAiInteractionRows(session.id);
    responseTruncated ||= interactions.truncated;
    const sessionView = {
      id: session.id, projectId, workspaceId: session.workspaceId, title: session.title, state: session.state,
      profileId: session.profileKey, profileRevision: session.profileRevision, revisionId: session.revisionId,
      runtimePlanHash: session.runtimePlanHash, runtimeGeneration: session.runtimeGeneration, processGeneration: session.processGeneration,
      lastSequence: session.lastSequence, historyStartSequence: session.historyStartSequence,
      historyTruncated: session.historyTruncated || responseTruncated,
      interactionsTruncated: session.interactionHistoryTruncated || interactions.truncated,
      failureCode: session.failureCode, createdAt: session.createdAt, updatedAt: session.updatedAt
    };
    const retainedTurns: typeof turnViews = [];
    const retainedEvents: CanonicalAiEvent[] = [];
    const responseInteractions = interactions.rows;
    let retainedTurnContentBytes = 0;
    const turnResponseBaseBytes = serializedBytes({ session: sessionView, turns: [], interactions: responseInteractions, events: retainedEvents });
    for (const turn of [...turnViews].reverse()) {
      const turnBytes = serializedBytes(turn);
      const separatorBytes = retainedTurns.length === 0 ? 0 : 1;
      if (turnResponseBaseBytes + retainedTurnContentBytes + turnBytes + separatorBytes <= AI_SESSION_RESPONSE_MAX_BYTES) {
        retainedTurns.unshift(turn);
        retainedTurnContentBytes += turnBytes + separatorBytes;
      }
      else { responseTruncated = true; break; }
    }
    const eventResponseBaseBytes = serializedBytes({ session: sessionView, turns: retainedTurns, interactions: responseInteractions, events: [] });
    let retainedEventContentBytes = 0;
    const eventBySequence = new Map(eventViews.map((event) => [event.sequence, event]));
    for (const row of rawEvents.slice(0, AI_SESSION_EVENT_HISTORY_MAX_EVENTS)) {
      const parsed = eventBySequence.get(row.sequence);
      if (parsed === undefined) continue;
      const eventBytes = serializedBytes(parsed);
      const separatorBytes = retainedEvents.length === 0 ? 0 : 1;
      if (eventResponseBaseBytes + retainedEventContentBytes + eventBytes + separatorBytes <= AI_SESSION_RESPONSE_MAX_BYTES) {
        retainedEvents.unshift(parsed);
        retainedEventContentBytes += eventBytes + separatorBytes;
      }
      else { responseTruncated = true; break; }
    }
    const finalSession = { ...sessionView, historyTruncated: sessionView.historyTruncated || responseTruncated };
    const normalized = normalizeRetainedHistory({ session: finalSession, events: retainedEvents });
    return { session: normalized.session, turns: retainedTurns, interactions: responseInteractions, events: normalized.events };
  };
  const listAiSessionSummaries = (projectId: string, workspaceId: string) => {
    assertAiWorkspace(projectId, workspaceId);
    return db.select({ id: aiSessions.id, workspaceId: aiSessions.workspaceId, title: aiSessions.title, state: aiSessions.state,
      lastSequence: aiSessions.lastSequence, historyStartSequence: aiSessions.historyStartSequence,
      historyTruncated: aiSessions.historyTruncated, createdAt: aiSessions.createdAt, updatedAt: aiSessions.updatedAt })
      .from(aiSessions).where(and(eq(aiSessions.workspaceId, workspaceId), eq(aiSessions.providerKey, "codex")))
      .orderBy(desc(aiSessions.createdAt), desc(aiSessions.id)).limit(AI_SESSION_HISTORY_MAX_TURNS).all();
  };
  const readAiTurnIdentity = (projectId: string, workspaceId: string, sessionId: string, turnId: string) => {
    assertAiWorkspace(projectId, workspaceId);
    const row = client.prepare(
      "select id, session_id as sessionId, state from ai_turns where id = ? and session_id = ?"
    ).get(turnId, sessionId) as { id: string; sessionId: string; state: string } | undefined;
    return row === undefined ? null : row;
  };
  const pruneAiTurns = (sessionId: string): boolean => {
    const oldTurns = client.prepare(`
      select id from ai_turns where session_id = ?
      order by created_at desc, id desc limit -1 offset ?
    `).all(sessionId, AI_SESSION_HISTORY_MAX_TURNS) as Array<{ id: string }>;
    for (const turn of oldTurns) {
      client.prepare("delete from ai_events where turn_id = ?").run(turn.id);
      client.prepare("delete from ai_turns where id = ? and session_id = ?").run(turn.id, sessionId);
    }
    return oldTurns.length > 0;
  };
  const compactAiOutputs = (sessionId: string): void => {
    const turns = client.prepare(`
      select id, length(cast(output_text as blob)) as outputBytes, output_truncated as outputTruncated
      from ai_turns where session_id = ? order by created_at desc, id desc
    `).all(sessionId) as Array<{ id: string; outputBytes: number; outputTruncated: number }>;
    let remaining = AI_SESSION_OUTPUT_MAX_BYTES;
    for (const turn of turns) {
      const allowed = Math.min(AI_TURN_OUTPUT_MAX_BYTES, remaining);
      const prefix = allowed === 0 ? Buffer.alloc(0) : ((client.prepare(`
        select substr(cast(output_text as blob), 1, ?) as outputPrefix
        from ai_turns where id = ? and session_id = ?
      `).get(allowed + 4, turn.id, sessionId) as { outputPrefix: Buffer | null } | undefined)?.outputPrefix ?? Buffer.alloc(0));
      const output = decodeUtf8Prefix(prefix, allowed);
      const truncated = turn.outputTruncated !== 0 || turn.outputBytes > allowed || output.truncated;
      if (allowed === 0 || turn.outputBytes > allowed || truncated) {
        client.prepare("update ai_turns set output_text = ?, output_truncated = ? where id = ? and session_id = ?")
          .run(output.value, truncated ? 1 : 0, turn.id, sessionId);
      }
      remaining -= utf8ByteLength(output.value);
    }
  };
  const compactAiInteractions = (sessionId: string): boolean => {
    const candidates = client.prepare(`
      select id, length(cast(request_json as blob)) + coalesce(length(cast(response_json as blob)), 0) as rowBytes
      from ai_interaction_requests where session_id = ?
      order by created_at desc, id desc limit ?
    `).all(sessionId, AI_SESSION_INTERACTION_HISTORY_MAX_ROWS + 1) as Array<{ id: string; rowBytes: number }>;
    let bytes = 0;
    const keep: string[] = [];
    for (const row of candidates) {
      if (keep.length >= AI_SESSION_INTERACTION_HISTORY_MAX_ROWS
        || row.rowBytes > AI_INTERACTION_JSON_MAX_BYTES * 2
        || bytes + row.rowBytes > AI_SESSION_INTERACTION_HISTORY_MAX_BYTES) continue;
      keep.push(row.id);
      bytes += row.rowBytes;
    }
    const placeholders = keep.map(() => "?").join(", ");
    const result = keep.length === 0
      ? client.prepare("delete from ai_interaction_requests where session_id = ?").run(sessionId)
      : client.prepare(`delete from ai_interaction_requests where session_id = ? and id not in (${placeholders})`)
        .run(sessionId, ...keep);
    return candidates.length > keep.length || result.changes > 0;
  };
  const compactAiEvents = (sessionId: string, lastSequence: number, currentHistoryStartSequence: number, alreadyTruncated: boolean): {
    readonly historyStartSequence: number;
    readonly historyTruncated: boolean;
  } => {
    const total = client.prepare(`
      select count(*) as count, coalesce(sum(length(cast(event_json as blob))), 0) as bytes,
        coalesce(min(sequence), 0) as minimumSequence, coalesce(max(sequence), 0) as maximumSequence
      from ai_events where session_id = ? and sequence >= ?
    `).get(sessionId, currentHistoryStartSequence) as { count: number; bytes: number; minimumSequence: number; maximumSequence: number };
    const contiguous = total.count === 0 || total.maximumSequence - total.minimumSequence + 1 === total.count;
    if (total.count <= AI_SESSION_EVENT_HISTORY_MAX_EVENTS && total.bytes <= AI_SESSION_EVENT_HISTORY_MAX_BYTES
      && contiguous && (total.count === 0 || total.minimumSequence === currentHistoryStartSequence)) {
      return { historyStartSequence: currentHistoryStartSequence, historyTruncated: alreadyTruncated };
    }
    const candidates = client.prepare(`
      select sequence, length(cast(event_json as blob)) as eventBytes
      from ai_events where session_id = ? and sequence >= ? order by sequence desc limit ?
    `).all(sessionId, currentHistoryStartSequence,
      AI_SESSION_EVENT_HISTORY_MAX_EVENTS) as Array<{ sequence: number; eventBytes: number }>;
    let bytes = 0;
    let retained = 0;
    let historyStartSequence = lastSequence + 1;
    let expectedSequence = lastSequence;
    for (const row of candidates) {
      if (row.sequence !== expectedSequence) break;
      if (retained >= AI_SESSION_EVENT_HISTORY_MAX_EVENTS || row.eventBytes > AI_SESSION_EVENT_HISTORY_MAX_BYTES
        || bytes + row.eventBytes > AI_SESSION_EVENT_HISTORY_MAX_BYTES) break;
      bytes += row.eventBytes;
      retained += 1;
      historyStartSequence = row.sequence;
      expectedSequence -= 1;
    }
    if (retained === 0) {
      client.prepare(`
        delete from ai_events
        where session_id = ?
          and not (
            event_type = 'turn.accepted'
            and exists (
              select 1 from ai_turns
              where ai_turns.id = ai_events.turn_id
                and ai_turns.session_id = ai_events.session_id
                and ai_turns.state in ('accepted', 'running')
            )
          )
      `).run(sessionId);
    } else {
      client.prepare(`
        delete from ai_events
        where session_id = ? and sequence < ?
          and not (
            event_type = 'turn.accepted'
            and exists (
              select 1 from ai_turns
              where ai_turns.id = ai_events.turn_id
                and ai_turns.session_id = ai_events.session_id
                and ai_turns.state in ('accepted', 'running')
            )
          )
      `).run(sessionId, historyStartSequence);
    }
    return {
      historyStartSequence,
      historyTruncated: alreadyTruncated || total.count > retained || total.bytes > bytes
    };
  };
  const ensureAiTurnAcceptedRow = (input: {
    projectId: string; workspaceId: string; sessionId: string; turnId: string;
    processGeneration: number; content: unknown;
  }) => {
    assertAiWorkspace(input.projectId, input.workspaceId);
    const session = db.select().from(aiSessions).where(and(
      eq(aiSessions.id, input.sessionId),
      eq(aiSessions.workspaceId, input.workspaceId),
      eq(aiSessions.providerKey, "codex")
    )).get();
    if (session === undefined || session.processGeneration !== input.processGeneration) {
      throw new ProjectSetupConflictError("The exact AI session generation does not own this turn.");
    }
    const content = aiTurnContentSchema.parse(input.content);
    const canonicalContent = JSON.stringify(content);
    const existingById = db.select().from(aiTurns).where(eq(aiTurns.id, input.turnId)).get();
    if (existingById !== undefined) {
      if (existingById.sessionId !== input.sessionId || existingById.contentJson !== canonicalContent) {
        throw new ProjectSetupConflictError("The AI turn identity or canonical content conflicts with retained history.");
      }
      return existingById;
    }
    if (session.state !== "active") {
      throw new ProjectSetupConflictError("The exact active AI session generation is not accepting this turn.");
    }
    const activeTurn = db.select({ id: aiTurns.id }).from(aiTurns).where(and(
      eq(aiTurns.sessionId, input.sessionId), or(eq(aiTurns.state, "accepted"), eq(aiTurns.state, "running"),
        eq(aiTurns.state, "waiting-for-approval"), eq(aiTurns.state, "waiting-for-input"))
    )).get();
    if (activeTurn !== undefined) throw new ProjectSetupConflictError("The AI session already has an active turn.");
    const timestamp = now().toISOString();
    const turn = {
      id: input.turnId, sessionId: input.sessionId, state: "accepted" as const, contentJson: canonicalContent,
      outputText: "", outputTruncated: false, changedFilesJson: JSON.stringify({ files: [], truncated: false }), failureJson: null,
      createdAt: timestamp, updatedAt: timestamp, completedAt: null
    };
    db.insert(aiTurns).values(turn).run();
    return turn;
  };
  const canonicalTurnContext = (event: CanonicalAiEvent) => {
    if (event.turnId === null || event.eventType === "turn.accepted") return null;
    const turn = db.select().from(aiTurns).where(and(
      eq(aiTurns.id, event.turnId),
      eq(aiTurns.sessionId, event.sessionId)
    )).get();
    if (turn === undefined) {
      throw new ProjectSetupConflictError("The canonical AI turn does not exist.");
    }
    const acceptedRow = client.prepare(`
      select event_json as eventJson
      from ai_events
      where session_id = ? and turn_id = ? and event_type = 'turn.accepted'
      order by sequence asc
      limit 1
    `).get(event.sessionId, event.turnId) as { eventJson: string } | undefined;
    if (acceptedRow === undefined) {
      throw new ProjectSetupConflictError("The canonical AI turn acceptance does not exist.");
    }
    const accepted = canonicalAiEventSchema.parse(JSON.parse(acceptedRow.eventJson));
    if (accepted.eventType !== "turn.accepted"
      || accepted.turnId !== event.turnId
      || accepted.processGeneration !== event.processGeneration
      || turn.contentJson !== JSON.stringify(accepted.payload.content)) {
      throw new ProjectSetupConflictError("The canonical AI turn acceptance conflicts with this event.");
    }
    const prior = (client.prepare(`
      select event_json as eventJson
      from ai_events
      where session_id = ? and turn_id = ?
      order by sequence asc
    `).all(event.sessionId, event.turnId) as Array<{ eventJson: string }>)
      .map((row) => canonicalAiEventSchema.parse(JSON.parse(row.eventJson)));
    return { turn, prior };
  };
  const assertLegalTurnProgression = (
    event: Exclude<CanonicalAiEvent, { eventType: "turn.accepted" }>,
    context: NonNullable<ReturnType<typeof canonicalTurnContext>>
  ): void => {
    const types = context.prior.map((candidate) => candidate.eventType);
    const has = (eventType: CanonicalAiEvent["eventType"]) => types.includes(eventType);
    const hasTerminal = has("turn.failed") || has("turn.lost") || has("turn.quiesced");
    if (hasTerminal) throw new ProjectSetupConflictError("The canonical AI turn is already terminal.");
    const active = context.turn.state === "accepted" || context.turn.state === "running"
      || context.turn.state === "waiting-for-approval" || context.turn.state === "waiting-for-input";
    const providerCompleted = context.prior.find((candidate) => candidate.eventType === "turn.provider-completed");
    if (event.eventType === "turn.started") {
      if (!active || has("turn.started") || has("turn.interrupted") || providerCompleted !== undefined) {
        throw new ProjectSetupConflictError("The AI turn cannot start from its canonical state.");
      }
      return;
    }
    if (event.eventType === "turn.output.delta" || event.eventType === "turn.output.completed"
      || event.eventType === "turn.activity.started" || event.eventType === "turn.approval.requested"
      || event.eventType === "turn.input.requested" || event.eventType === "turn.interrupt.requested") {
      if (!active || has("turn.interrupted") || providerCompleted !== undefined) {
        throw new ProjectSetupConflictError("The AI turn cannot emit live activity after terminalization.");
      }
      return;
    }
    if (event.eventType === "turn.activity.completed") {
      const matchingStart = context.prior.some((candidate) => candidate.eventType === "turn.activity.started"
        && candidate.payload.activityId === event.payload.activityId);
      if (!active || !matchingStart || has("turn.interrupted") || providerCompleted !== undefined) {
        throw new ProjectSetupConflictError("The AI activity completion has no active canonical owner.");
      }
      return;
    }
    if (event.eventType === "turn.approval.responded" || event.eventType === "turn.input.responded") {
      const requestedType = event.eventType === "turn.approval.responded" ? "turn.approval.requested" : "turn.input.requested";
      const matchingRequest = context.prior.some((candidate) => candidate.eventType === requestedType
        && candidate.payload.requestId === event.payload.requestId);
      if (!active || !matchingRequest || has("turn.interrupted") || providerCompleted !== undefined) {
        throw new ProjectSetupConflictError("The AI interaction response has no active canonical request.");
      }
      return;
    }
    if (event.eventType === "turn.interaction.expired") {
      const matchingRequest = context.prior.some((candidate) =>
        (candidate.eventType === "turn.approval.requested" || candidate.eventType === "turn.input.requested")
        && candidate.payload.requestId === event.payload.requestId
      );
      if (!active || !matchingRequest || has("turn.interrupted") || providerCompleted !== undefined) {
        throw new ProjectSetupConflictError("The canonical AI interaction retirement has no active canonical request.");
      }
      return;
    }
    if (event.eventType === "turn.interrupted") {
      if (!active || has("turn.interrupted") || providerCompleted !== undefined) {
        throw new ProjectSetupConflictError("The AI turn interruption conflicts with retained history.");
      }
      return;
    }
    if (event.eventType === "turn.provider-completed") {
      if (providerCompleted !== undefined
        || (event.payload.outcome === "interrupted") !== has("turn.interrupted")) {
        throw new ProjectSetupConflictError("The provider outcome conflicts with retained turn history.");
      }
      return;
    }
    if (event.eventType === "turn.files.changed") {
      if (providerCompleted === undefined || has("turn.files.changed")) {
        throw new ProjectSetupConflictError("Changed files are not the next canonical terminal stage.");
      }
      return;
    }
    if (event.eventType === "turn.quiesced") {
      if (providerCompleted === undefined || !has("turn.files.changed")
        || providerCompleted.payload.outcome !== event.payload.outcome) {
        throw new ProjectSetupConflictError("Turn quiescence conflicts with the canonical provider outcome.");
      }
      return;
    }
    if (event.eventType === "turn.lost") {
      return;
    }
    if (event.eventType === "turn.failed") {
      if (!active || has("turn.interrupted") || providerCompleted !== undefined || has("turn.files.changed")) {
        throw new ProjectSetupConflictError("The terminal AI turn event conflicts with retained history.");
      }
    }
  };
  const projectAiInteractionEvent = (event: CanonicalAiEvent, timestamp: string): void => {
    if (event.eventType === "turn.approval.requested" || event.eventType === "turn.input.requested") {
      const requestId = event.payload.requestId;
      const kind = event.eventType === "turn.approval.requested" ? "approval" : "input";
      const requestJson = JSON.stringify(event.payload);
      const existing = client.prepare(`
        select session_id as sessionId, turn_id as turnId, kind, state, request_json as requestJson
        from ai_interaction_requests where id = ?
      `).get(requestId) as { sessionId: string; turnId: string | null; kind: string; state: string; requestJson: string } | undefined;
      if (existing !== undefined) {
        if (existing.sessionId !== event.sessionId || existing.turnId !== event.turnId || existing.kind !== kind
          || existing.state !== "pending" || existing.requestJson !== requestJson) {
          throw new ProjectSetupConflictError("The canonical AI interaction request identity conflicts with retained state.");
        }
        return;
      }
      client.prepare(`
        insert into ai_interaction_requests
          (id, session_id, turn_id, kind, state, request_json, response_json, created_at, updated_at)
        values (?, ?, ?, ?, 'pending', ?, null, ?, ?)
      `).run(requestId, event.sessionId, event.turnId, kind, requestJson, timestamp, timestamp);
      return;
    }
    if (event.eventType === "turn.interaction.expired") {
      const existing = client.prepare(`
        select session_id as sessionId, turn_id as turnId, state
        from ai_interaction_requests where id = ?
      `).get(event.payload.requestId) as { sessionId: string; turnId: string | null; state: string } | undefined;
      if (existing === undefined || existing.sessionId !== event.sessionId || existing.turnId !== event.turnId || existing.state !== "pending") {
        throw new ProjectSetupConflictError("The canonical AI interaction retirement has no exact pending request.");
      }
      const result = client.prepare(`
        update ai_interaction_requests
        set state = 'expired', updated_at = ?
        where id = ? and session_id = ? and turn_id = ? and state = 'pending'
      `).run(timestamp, event.payload.requestId, event.sessionId, event.turnId);
      if (result.changes !== 1) throw new ProjectSetupConflictError("The canonical AI interaction retirement changed concurrently.");
      return;
    }
    if (event.eventType !== "turn.approval.responded" && event.eventType !== "turn.input.responded") return;
    const requestId = event.payload.requestId;
    const expectedKind = event.eventType === "turn.approval.responded" ? "approval" : "input";
    const response = event.eventType === "turn.approval.responded"
      ? { decision: event.payload.decision }
      : { answers: event.payload.answers };
    const existing = client.prepare(`
      select session_id as sessionId, turn_id as turnId, kind, state
      from ai_interaction_requests where id = ?
    `).get(requestId) as { sessionId: string; turnId: string | null; kind: string; state: string } | undefined;
    if (existing === undefined || existing.sessionId !== event.sessionId || existing.turnId !== event.turnId
      || existing.kind !== expectedKind || existing.state !== "pending") {
      throw new ProjectSetupConflictError("The canonical AI interaction response has no exact pending request.");
    }
    const result = client.prepare(`
      update ai_interaction_requests
      set state = 'responded', response_json = ?, updated_at = ?
      where id = ? and session_id = ? and turn_id = ? and kind = ? and state = 'pending'
    `).run(JSON.stringify(response), timestamp, requestId, event.sessionId, event.turnId, expectedKind);
    if (result.changes !== 1) throw new ProjectSetupConflictError("The canonical AI interaction response changed concurrently.");
  };
  const retireAiInteractions = (input: {
    readonly sessionId: string;
    readonly turnId?: string | null;
    readonly state: "cancelled" | "expired" | "lost";
    readonly timestamp: string;
  }): void => {
    if (input.turnId === undefined) {
      client.prepare(`
        update ai_interaction_requests set state = ?, updated_at = ?
        where session_id = ? and state = 'pending'
      `).run(input.state, input.timestamp, input.sessionId);
      return;
    }
    client.prepare(`
      update ai_interaction_requests set state = ?, updated_at = ?
      where session_id = ? and turn_id = ? and state = 'pending'
    `).run(input.state, input.timestamp, input.sessionId, input.turnId);
  };
  const getOwnedGithubConnection = (actor: string, connectionId: string) => db.select({
    connection: githubConnections,
    attempt: githubConnectionAttempts
  }).from(githubConnections).innerJoin(githubConnectionAttempts,
    eq(githubConnectionAttempts.connectionId, githubConnections.connectionId)
  ).where(and(
    eq(githubConnections.connectionId, connectionId),
    eq(githubConnectionAttempts.createdBy, actor),
    eq(githubConnectionAttempts.status, "connected")
  )).get();
  const githubConnectionView = (connection: typeof githubConnections.$inferSelect) => ({
    ...connection,
    permissions: JSON.parse(connection.permissionsJson) as Record<string, "read" | "write">
  });
  return {
    close: () => client.close(),
    listProjects: (): ProjectView[] => db.select().from(projects).orderBy(desc(projects.createdAt)).all().map(toView),
    listProjectSummaries(): ProjectSummaryView[] {
      return db.select().from(projects).orderBy(desc(projects.createdAt)).all().map((project) => {
        const workspace = project.primaryWorkspaceId === null ? undefined
          : db.select().from(workspaces).where(eq(workspaces.id, project.primaryWorkspaceId)).get();
        const runtime = workspace === undefined ? undefined
          : db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, workspace.id)).get();
        return { ...toView(project), primaryWorkspace: workspace === undefined ? null
          : { name: workspace.name, observedState: workspace.observedState },
        runtime: runtime === undefined ? null : { observedState: runtime.observedState } };
      });
    },
    listManagedProjects(): ManagedProjectView[] {
      return db.select().from(projects).orderBy(desc(projects.createdAt)).all().map(readManagedProject);
    },
    getManagedProject(projectId: string): ManagedProjectView | undefined {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      return project === undefined ? undefined : readManagedProject(project);
    },
    getProjectOptionsState(projectId: string) {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (project === undefined || project.state !== "ready" || project.primaryWorkspaceId === null
        || project.activeConfigRevisionId === null) throw new ProjectSetupConflictError("A ready primary workspace is required.");
      const workspace = db.select().from(workspaces).where(and(eq(workspaces.id, project.primaryWorkspaceId),
        eq(workspaces.projectId, project.id))).get();
      const activeRevision = db.select().from(projectConfigRevisions).where(and(
        eq(projectConfigRevisions.id, project.activeConfigRevisionId), eq(projectConfigRevisions.projectId, project.id)
      )).get();
      if (workspace === undefined || workspace.kind !== "primary" || activeRevision === undefined) {
        throw new ProjectSetupConflictError("The primary workspace configuration is inconsistent.");
      }
      const drafts = db.select().from(projectConfigRevisions).where(and(
        eq(projectConfigRevisions.projectId, projectId), eq(projectConfigRevisions.state, "draft")
      )).orderBy(desc(projectConfigRevisions.revisionNumber)).all()
        .filter((draft) => projectOptionsDraftBaseRevision(draft.id) === activeRevision.id);
      return { project, workspace, activeRevision, drafts, pendingApply: pendingConfigurationApply(projectId, workspace.id) ?? null };
    },
    getPendingProjectOptionsApply(projectId: string) {
      const operation = pendingConfigurationApply(projectId);
      if (operation === undefined) return null;
      let progress: unknown;
      try { progress = JSON.parse(operation.progressJson ?? "null"); }
      catch { throw new ProjectSetupConflictError("The pending Project Options Apply record is malformed."); }
      if (progress === null || typeof progress !== "object" || Array.isArray(progress)) {
        throw new ProjectSetupConflictError("The pending Project Options Apply record is incomplete.");
      }
      const fields = progress as Record<string, unknown>;
      const expectedRevision = revisionIdentitySchema.safeParse(fields["expectedRevision"]);
      const candidateRevision = revisionIdentitySchema.safeParse(fields["candidateRevision"]);
      const rawPreviewIds = fields["previewIds"];
      if (!expectedRevision.success || !candidateRevision.success || rawPreviewIds === null
        || typeof rawPreviewIds !== "object" || Array.isArray(rawPreviewIds)) {
        throw new ProjectSetupConflictError("The pending Project Options Apply record is incomplete.");
      }
      const previewIds: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawPreviewIds)) {
        if (typeof value !== "string") throw new ProjectSetupConflictError("The pending Project Options Apply preview identity is invalid.");
        previewIds[key] = value;
      }
      const rawPhase = fields["phase"];
      if (rawPhase !== "reserved" && rawPhase !== "adoption-submitted") {
        throw new ProjectSetupConflictError("The pending Project Options Apply phase is invalid.");
      }
      const phase: "reserved" | "adoption-submitted" = rawPhase;
      return { operation, expectedRevision: expectedRevision.data, candidateRevision: candidateRevision.data, previewIds, phase };
    },
    getCompletedProjectOptionsApply(projectId: string, candidateRevisionId: string): Operation | null {
      return db.select().from(operations).where(and(eq(operations.projectId, projectId),
        eq(operations.operationName, "configuration.apply"), eq(operations.resourceId, candidateRevisionId),
        eq(operations.state, "succeeded"))).orderBy(desc(operations.finishedAt), desc(operations.operationId)).get() ?? null;
    },
    getProjectGithubSource(projectId: string): ProjectGithubSourceView | null {
      const source = db.select().from(projectGithubSources).where(eq(projectGithubSources.projectId, projectId)).get();
      return source === undefined ? null : toGithubSourceView(source);
    },
    getProjectSourceLocator(projectId: string, actor?: string): SourceLocator | null {
      const project = db.select({ id: projects.id, repositoryUrl: projects.repositoryUrl }).from(projects)
        .where(eq(projects.id, projectId)).get();
      if (project === undefined) return null;
      const source = db.select().from(projectGithubSources).where(eq(projectGithubSources.projectId, projectId)).get();
      return source === undefined
        ? { kind: "remote", url: project.repositoryUrl }
        : (() => {
            if (actor !== undefined) {
              const owned = getOwnedGithubConnection(actor, source.connectionId);
              if (owned === undefined || owned.connection.status === "failed") {
                throw new ProjectSetupConflictError("The GitHub connection is not owned by this actor.");
              }
            }
            return { kind: "github-app", connectionId: source.connectionId, repositoryId: source.repositoryId } as const;
          })();
    },
    refreshProjectGithubSource(input: {
      projectId: string; actor: string; connectionId: string; repository: GithubRepository;
      verifiedAt: string; metadataUpdatedAt: string;
    }): ProjectGithubSourceView {
      return client.transaction(() => {
        const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
        const source = db.select().from(projectGithubSources).where(eq(projectGithubSources.projectId, input.projectId)).get();
        if (project === undefined || source === undefined || source.connectionId !== input.connectionId
          || source.repositoryId !== input.repository.repositoryId) {
          throw new ProjectSetupConflictError("The retained GitHub source identity no longer matches the project.");
        }
        const owned = getOwnedGithubConnection(input.actor, source.connectionId);
        if (owned === undefined || owned.connection.status === "failed") {
          throw new ProjectSetupConflictError("The GitHub connection is not owned by this actor.");
        }
        const repository = githubRepositorySchema.parse(input.repository);
        const verifiedAt = utcTimestampMsSchema.parse(input.verifiedAt);
        const metadataUpdatedAt = utcTimestampMsSchema.parse(input.metadataUpdatedAt);
        const updatedAt = now().toISOString();
        db.update(projects).set({ repositoryUrl: repository.cleanHttpsUrl, updatedAt, rowVersion: project.rowVersion + 1 })
          .where(eq(projects.id, input.projectId)).run();
        const updated = db.update(projectGithubSources).set({
          ownerLogin: repository.ownerLogin, name: repository.name, fullName: repository.fullName,
          cleanHttpsUrl: repository.cleanHttpsUrl, defaultBranch: repository.defaultBranch,
          isPrivate: repository.private, isArchived: repository.archived, isDisabled: repository.disabled,
          verifiedAt, metadataUpdatedAt, rowVersion: source.rowVersion + 1
        }).where(and(eq(projectGithubSources.projectId, input.projectId), eq(projectGithubSources.rowVersion, source.rowVersion))).run();
        if (updated.changes !== 1) throw new ProjectSetupConflictError("The retained GitHub source metadata changed concurrently.");
        const refreshed = db.select().from(projectGithubSources).where(eq(projectGithubSources.projectId, input.projectId)).get();
        if (refreshed === undefined) throw new ProjectSetupConflictError("The refreshed GitHub source metadata could not be retained.");
        return toGithubSourceView(refreshed);
      }).immediate();
    },
    assertGithubConnectionOwned(actor: string, connectionId: string): void {
      const owned = getOwnedGithubConnection(actor, connectionId);
      if (owned === undefined || owned.connection.status === "failed") throw new ProjectSetupConflictError("The GitHub connection is not owned by this actor.");
    },
    listPreviews(projectId: string, workspaceId: string): PreviewView[] {
      const workspace = db.select({ id: workspaces.id, configRevisionId: workspaces.configRevisionId }).from(workspaces).where(and(
        eq(workspaces.id, workspaceId), eq(workspaces.projectId, projectId)
      )).get();
      if (workspace === undefined) return [];
      const project = db.select({ activeConfigRevisionId: projects.activeConfigRevisionId }).from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.primaryWorkspaceId, workspaceId))).get();
      const revisionId = project?.activeConfigRevisionId;
      if (revisionId === null || revisionId === undefined || revisionId !== workspace.configRevisionId) return [];
      return db.select().from(previews).where(and(eq(previews.workspaceId, workspace.id), eq(previews.configRevisionId, revisionId)))
        .orderBy(previews.previewKey, previews.id).all().map(toPreviewView);
    },
    preparePreviewMutation(input: {
      projectId: string;
      workspaceId: string;
      previewId: string;
      actor: string;
      action: "activate" | "deactivate";
    }): { operation: Operation; preview: PreviewView; projectSlug: string; workspaceSlug: string; revisionId: string } {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        if (context.workspace.id !== input.workspaceId) {
          throw new ProjectSetupConflictError("Preview mutation has a stale workspace identity.");
        }
        const preview = db.select().from(previews).where(and(
          eq(previews.id, input.previewId), eq(previews.workspaceId, input.workspaceId),
          eq(previews.configRevisionId, context.revision.id)
        )).get();
        if (preview === undefined) throw new ProjectSetupConflictError("The preview is not owned by the active workspace revision.");
        const operationName = `preview.${input.action}`;
        const latestPreviewOperation = db.select().from(operations).where(and(
          eq(operations.projectId, input.projectId), eq(operations.workspaceId, input.workspaceId),
          or(eq(operations.operationName, "preview.activate"), eq(operations.operationName, "preview.deactivate")),
          eq(operations.resourceType, "preview"), eq(operations.resourceId, input.previewId)
        )).orderBy(desc(operations.createdAt), desc(operations.operationId)).all()
          .find((candidate) => candidate.state === "accepted" || candidate.state === "running" || candidate.state === "succeeded");
        if (latestPreviewOperation !== undefined && latestPreviewOperation.operationName !== operationName
          && (latestPreviewOperation.state === "accepted" || latestPreviewOperation.state === "running")) {
          throw new ProjectSetupConflictError("Another preview action is still in progress.");
        }
        const retained = latestPreviewOperation?.operationName === operationName ? latestPreviewOperation : undefined;
        const operation = retained ?? {
          operationId: createId(), projectId: input.projectId, workspaceId: input.workspaceId, actor: input.actor,
          operationName, resourceType: "preview", resourceId: input.previewId, state: "accepted" as const,
          progressJson: null, errorCode: null, errorMessage: null, createdAt: now().toISOString(), startedAt: null, finishedAt: null
        } satisfies Operation;
        if (retained === undefined) db.insert(operations).values(operation).run();
        db.update(previews).set({
          desiredState: input.action === "activate" ? "active" : "inactive",
          operationId: operation.operationId,
          updatedAt: now().toISOString()
        }).where(eq(previews.id, input.previewId)).run();
        const updated = db.select().from(previews).where(eq(previews.id, input.previewId)).get();
        if (updated === undefined) throw new ProjectSetupConflictError("The preview mutation intent was not retained.");
        return { operation, preview: toPreviewView(updated), projectSlug: context.project.slug,
          workspaceSlug: context.workspace.slug, revisionId: context.revision.id };
      }).immediate();
    },
    materializePreviews(input: {
      projectId: string;
      workspaceId: string;
      revisionId: string;
      previewBaseRegistry: Parameters<typeof materializePreviewRows>[0]["previewBaseRegistry"];
      now?: string;
    }): PreviewView[] {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        if (context.workspace.id !== input.workspaceId || context.revision.id !== input.revisionId) {
          throw new ProjectSetupConflictError("Preview materialization has a stale workspace or configuration revision.");
        }
        const options = parseProjectOptionsV1(JSON.parse(context.revision.configurationJson));
        const existing = db.select().from(previews).where(and(eq(previews.workspaceId, input.workspaceId),
          eq(previews.configRevisionId, input.revisionId))).all();
        const existingByKey = new Map(existing.map((preview) => [preview.previewKey, preview]));
        const ids: Record<string, string> = {};
        for (const preview of options.previews) ids[preview.key] = existingByKey.get(preview.key)?.id ?? createId();
        const runtime = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        const serviceIds = runtime === undefined ? {} : Object.fromEntries(
          db.select({ id: workspaceServices.id, key: workspaceServices.serviceKey }).from(workspaceServices)
            .where(eq(workspaceServices.runtimeStackId, runtime.id)).all().map((service) => [service.key, service.id])
        );
        const timestamp = input.now ?? now().toISOString();
        const rows = materializePreviewRows({
          projectId: context.project.id,
          projectSlug: context.project.slug,
          workspaceId: context.workspace.id,
          workspaceSlug: context.workspace.slug,
          configRevisionId: context.revision.id,
          previews: options.previews,
          ids,
          serviceIds,
          previewBaseRegistry: input.previewBaseRegistry,
          now: timestamp
        });
        for (const row of rows) {
          const retained = existingByKey.get(row.previewKey);
          if (retained !== undefined) {
            if (retained.configRevisionId !== row.configRevisionId || retained.hostname !== row.hostname) {
              throw new ProjectSetupConflictError("A retained preview belongs to a different immutable configuration revision.");
            }
            continue;
          }
          db.insert(previews).values(row).run();
        }
        return db.select().from(previews).where(and(eq(previews.workspaceId, input.workspaceId),
          eq(previews.configRevisionId, input.revisionId)))
          .orderBy(previews.previewKey, previews.id).all().map(toPreviewView);
      }).immediate();
    },
    updatePreviewObservation(input: {
      projectId: string;
      workspaceId: string;
      previewId: string;
      revisionId: string;
      observedState: Preview["observedState"];
      routePresent: boolean;
      routeRevision?: number | null;
      runtimeGeneration?: number | null;
      observationJson?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      operationId?: string | null;
  }): PreviewView {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        if (context.workspace.id !== input.workspaceId || context.revision.id !== input.revisionId) {
          throw new ProjectSetupConflictError("Preview observation has a stale workspace or configuration revision.");
        }
        if (input.observationJson !== undefined && input.observationJson !== null
          && input.observationJson.length > 4096) throw new ProjectSetupConflictError("Preview observation is too large.");
        const preview = db.select().from(previews).where(and(
          eq(previews.id, input.previewId), eq(previews.workspaceId, input.workspaceId),
          eq(previews.configRevisionId, input.revisionId)
        )).get();
        if (preview === undefined) throw new ProjectSetupConflictError("The preview identity is not owned by this workspace revision.");
        if (input.operationId !== undefined && input.operationId !== null) {
          const operation = db.select().from(operations).where(eq(operations.operationId, input.operationId)).get();
          if (operation === undefined || operation.projectId !== input.projectId
            || operation.workspaceId !== input.workspaceId || operation.resourceId !== input.previewId) {
            throw new ProjectSetupConflictError("Preview operation identity does not match its workspace resource.");
          }
        }
        db.update(previews).set({
          observedState: input.observedState,
          routePresent: input.routePresent,
          routeRevision: input.routeRevision === undefined ? preview.routeRevision : input.routeRevision,
          runtimeGeneration: input.runtimeGeneration === undefined ? preview.runtimeGeneration : input.runtimeGeneration,
          lastObservationJson: input.observationJson === undefined ? preview.lastObservationJson : input.observationJson,
          lastErrorCode: input.errorCode === undefined ? preview.lastErrorCode : input.errorCode,
          lastErrorMessage: input.errorMessage === undefined ? preview.lastErrorMessage : input.errorMessage?.slice(0, 512) ?? null,
          operationId: input.operationId === undefined ? preview.operationId : input.operationId,
          updatedAt: now().toISOString()
        }).where(eq(previews.id, input.previewId)).run();
        const updated = db.select().from(previews).where(eq(previews.id, input.previewId)).get();
        if (updated === undefined) throw new ProjectSetupConflictError("The preview observation was not retained.");
        return toPreviewView(updated);
      }).immediate();
    },
    createProject(input: CreateProjectInput): ProjectView {
      const projectId = createId();
      const auditId = createId();
      const timestamp = now().toISOString();
      const row = {
        id: projectId,
        name: input.name,
        slug: input.slug,
        repositoryUrl: input.repositoryUrl,
        repositoryStorePath: `/srv/devspace/projects/${projectId}/repository.git`,
        defaultBranch: input.defaultBranch,
        automaticFetchPolicy: "manual" as const,
        state: "registering" as const,
        activeConfigRevisionId: null,
        primaryWorkspaceId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        rowVersion: 1
      };
      try {
        client.transaction(() => {
          if (input.githubSource !== undefined) {
            const owned = getOwnedGithubConnection(input.actor, input.githubSource.connectionId);
            if (owned === undefined || owned.connection.status === "failed") {
              throw new ProjectSetupConflictError("The GitHub connection is not owned by this actor.");
            }
            const repository = input.githubSource.repository;
            if (input.repositoryUrl !== repository.cleanHttpsUrl
              || repository.fullName !== `${repository.ownerLogin}/${repository.name}`
              || repository.cleanHttpsUrl !== `https://github.com/${repository.fullName}.git`) {
              throw new ProjectSetupConflictError("The retained GitHub repository metadata is not canonical.");
            }
          }
          db.insert(projects).values(row).run();
          if (input.githubSource !== undefined) {
            const repository = input.githubSource.repository;
            db.insert(projectGithubSources).values({
              projectId,
              connectionId: input.githubSource.connectionId,
              repositoryId: repository.repositoryId,
              ownerLogin: repository.ownerLogin,
              name: repository.name,
              fullName: repository.fullName,
              cleanHttpsUrl: repository.cleanHttpsUrl,
              defaultBranch: repository.defaultBranch,
              isPrivate: repository.private,
              isArchived: repository.archived,
              isDisabled: repository.disabled,
              verifiedAt: input.githubSource.verifiedAt,
              metadataUpdatedAt: input.githubSource.metadataUpdatedAt,
              rowVersion: 1
            }).run();
          }
          const last = db.select({ sequence: auditEvents.sequence }).from(auditEvents)
            .orderBy(desc(auditEvents.sequence)).limit(1).get();
          options.beforeAuditInsert?.();
          db.insert(auditEvents).values({
            id: auditId,
            sequence: (last?.sequence ?? -1) + 1,
            actor: input.actor,
            eventType: "project.registered",
            resourceType: "project",
            resourceId: projectId,
            operationId: null,
            metadataJson: JSON.stringify(input.githubSource === undefined
              ? { sourceKind: "remote" }
              : { sourceKind: "github-app", connectionId: input.githubSource.connectionId, repositoryId: input.githubSource.repository.repositoryId }),
            createdAt: timestamp
          }).run();
        }).immediate();
      } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
          && error instanceof Error && error.message.includes("projects.slug")) {
          throw new DuplicateProjectSlugError();
        }
        throw error;
      }
      return toView(row);
    },
    preparePrimaryWorkspace(input: {
      projectId: string; configurationJson: string; configurationHash: string;
      compiledRuntimePlanJson: string; runtimePlanHash: string; actor: string;
    }): { project: Project; revision: ProjectConfigRevision; workspaceId: string; workspaceSlug: string } {
      return client.transaction(() => {
        const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
        if (project === undefined) throw new ProjectSetupConflictError("The project no longer exists.");
        if (project.state === "ready" && project.activeConfigRevisionId !== null && project.primaryWorkspaceId !== null) {
          const revision = db.select().from(projectConfigRevisions).where(eq(projectConfigRevisions.id, project.activeConfigRevisionId)).get();
          if (revision === undefined) throw new ProjectSetupConflictError("The ready project is missing its active revision.");
          const workspace = db.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, project.primaryWorkspaceId)).get();
          if (workspace === undefined) throw new ProjectSetupConflictError("The ready project is missing its primary workspace.");
          return { project, revision, workspaceId: project.primaryWorkspaceId, workspaceSlug: workspace.slug };
        }
        if (project.state !== "registering") throw new ProjectSetupConflictError("This project cannot be set up from its current state.");
        let revision = db.select().from(projectConfigRevisions).where(and(
          eq(projectConfigRevisions.projectId, project.id), eq(projectConfigRevisions.state, "draft")
        )).get();
        if (revision !== undefined && (revision.configurationHash !== input.configurationHash || revision.configurationJson !== input.configurationJson)) {
          throw new ProjectSetupConflictError("Workspace setup is already in progress with different Project Options.");
        }
        if (revision === undefined) {
          const createdAt = now().toISOString();
          revision = {
            id: createId(), projectId: project.id, revisionNumber: 1, schemaVersion: 1,
            configurationJson: input.configurationJson, configurationHash: input.configurationHash,
            compiledRuntimePlanJson: input.compiledRuntimePlanJson, runtimePlanHash: input.runtimePlanHash, source: "user", state: "draft",
            createdBy: input.actor, createdAt, activatedAt: null, supersededAt: null
          };
          db.insert(projectConfigRevisions).values(revision).run();
        }
        let workspaceOperation = db.select().from(operations).where(and(
          eq(operations.projectId, project.id), eq(operations.operationName, "workspace.create")
        )).orderBy(desc(operations.createdAt), desc(operations.operationId)).get();
        if (workspaceOperation === undefined) {
          const createdAt = now().toISOString();
          workspaceOperation = {
            operationId: createId(), projectId: project.id, workspaceId: null, actor: input.actor,
            operationName: "workspace.create", resourceType: "workspace", resourceId: createId(),
            state: "accepted", progressJson: null, errorCode: null, errorMessage: null,
            createdAt, startedAt: null, finishedAt: null
          };
          db.insert(operations).values(workspaceOperation).run();
        }
        return { project, revision, workspaceId: workspaceOperation.resourceId, workspaceSlug: "primary" };
      }).immediate();
    },
    getOrCreateOperation(input: {
      projectId: string; actor: string; operationName: string; resourceType: string; resourceId: string;
    }): Operation {
      return client.transaction(() => {
        const existing = db.select().from(operations).where(and(
          eq(operations.projectId, input.projectId), eq(operations.operationName, input.operationName)
        )).orderBy(desc(operations.createdAt), desc(operations.operationId)).get();
        if (existing !== undefined && existing.state !== "failed") {
          if (existing.resourceId !== input.resourceId || existing.resourceType !== input.resourceType) {
            throw new ProjectSetupConflictError("The retained setup operation has incompatible resource ownership.");
          }
          return existing;
        }
        const timestamp = now().toISOString();
        const operation: Operation = {
          operationId: createId(), projectId: input.projectId, workspaceId: null, actor: input.actor,
          operationName: input.operationName, resourceType: input.resourceType, resourceId: input.resourceId,
          state: "accepted", progressJson: null, errorCode: null, errorMessage: null,
          createdAt: timestamp, startedAt: null, finishedAt: null
        };
        db.insert(operations).values(operation).run();
        return operation;
      }).immediate();
    },
    getOrCreateRevisionOperation(input: {
      projectId: string; actor: string;
      operationName: "configuration-revision.register" | "configuration-runtime-plan.register";
      revisionId: string;
    }): Operation {
      return client.transaction(() => {
        const existing = db.select().from(operations).where(and(
          eq(operations.projectId, input.projectId), eq(operations.operationName, input.operationName),
          eq(operations.resourceType, "configuration-revision"), eq(operations.resourceId, input.revisionId)
        )).orderBy(desc(operations.createdAt), desc(operations.operationId)).get();
        if (existing !== undefined && existing.state !== "failed") return existing;
        const timestamp = now().toISOString();
        const operation: Operation = {
          operationId: createId(), projectId: input.projectId, workspaceId: null, actor: input.actor,
          operationName: input.operationName, resourceType: "configuration-revision", resourceId: input.revisionId,
          state: "accepted", progressJson: null, errorCode: null, errorMessage: null,
          createdAt: timestamp, startedAt: null, finishedAt: null
        };
        db.insert(operations).values(operation).run();
        return operation;
      }).immediate();
    },
    createProjectOptionsDraft(input: {
      projectId: string; workspaceId: string; expectedRevision: RevisionIdentity;
      revisionId: string; configurationJson: string; configurationHash: string;
      compiledRuntimePlanJson: string; runtimePlanHash: string; actor: string;
    }): ProjectConfigRevision {
      return client.transaction(() => {
        const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
        const workspace = db.select().from(workspaces).where(and(eq(workspaces.id, input.workspaceId),
          eq(workspaces.projectId, input.projectId))).get();
        const active = project?.activeConfigRevisionId === null || project?.activeConfigRevisionId === undefined ? undefined
          : db.select().from(projectConfigRevisions).where(and(eq(projectConfigRevisions.id, project.activeConfigRevisionId),
            eq(projectConfigRevisions.projectId, input.projectId))).get();
        if (project?.state !== "ready" || project.primaryWorkspaceId !== input.workspaceId || workspace?.kind !== "primary"
          || active === undefined || workspace.configRevisionId !== active.id
          || active.id !== input.expectedRevision.revisionId || active.configurationHash !== input.expectedRevision.revisionHash) {
          throw new ProjectSetupConflictError("The active Project Options revision changed. Reload the current settings before saving.");
        }
        assertNoPendingConfigurationApply(input.projectId, input.workspaceId);
        const sameDrafts = db.select().from(projectConfigRevisions).where(and(eq(projectConfigRevisions.projectId, input.projectId),
          eq(projectConfigRevisions.state, "draft"), eq(projectConfigRevisions.configurationHash, input.configurationHash),
          eq(projectConfigRevisions.configurationJson, input.configurationJson))).orderBy(desc(projectConfigRevisions.revisionNumber)).all();
        const sameDraft = sameDrafts.find((draft) => projectOptionsDraftBaseRevision(draft.id) === active.id);
        if (sameDraft !== undefined) return sameDraft;
        const latest = db.select().from(projectConfigRevisions).where(eq(projectConfigRevisions.projectId, input.projectId))
          .orderBy(desc(projectConfigRevisions.revisionNumber)).get();
        const createdAt = now().toISOString();
        const revision: ProjectConfigRevision = {
          id: input.revisionId, projectId: input.projectId, revisionNumber: (latest?.revisionNumber ?? 0) + 1,
          schemaVersion: 1, configurationJson: input.configurationJson, configurationHash: input.configurationHash,
          compiledRuntimePlanJson: input.compiledRuntimePlanJson, runtimePlanHash: input.runtimePlanHash,
          source: "user", state: "draft", createdBy: input.actor, createdAt, activatedAt: null, supersededAt: null
        };
        db.insert(projectConfigRevisions).values(revision).run();
        const last = db.select({ sequence: auditEvents.sequence }).from(auditEvents).orderBy(desc(auditEvents.sequence)).limit(1).get();
        options.beforeAuditInsert?.();
        db.insert(auditEvents).values({ id: createId(), sequence: (last?.sequence ?? -1) + 1, actor: input.actor,
          eventType: "project.options.draft_saved", resourceType: "configuration-revision", resourceId: revision.id,
          operationId: null, metadataJson: JSON.stringify({ expectedRevisionId: active.id, revisionNumber: revision.revisionNumber }),
          createdAt }).run();
        return revision;
      }).immediate();
    },
    reserveProjectOptionsApply(input: {
      projectId: string; workspaceId: string; actor: string; expectedRevision: RevisionIdentity;
      candidateRevision: RevisionIdentity; previewIds: Readonly<Record<string, string>>;
    }): { operation: Operation; expectedRevision: RevisionIdentity; candidateRevision: RevisionIdentity; previewIds: Record<string, string> } {
      return client.transaction(() => {
        const existing = pendingConfigurationApply(input.projectId, input.workspaceId);
        if (existing !== undefined) {
          const pending = this.getPendingProjectOptionsApply(input.projectId);
          if (pending === null || pending.operation.operationId !== existing.operationId
            || pending.expectedRevision.revisionId !== input.expectedRevision.revisionId
            || pending.expectedRevision.revisionHash !== input.expectedRevision.revisionHash
            || pending.candidateRevision.revisionId !== input.candidateRevision.revisionId
            || pending.candidateRevision.revisionHash !== input.candidateRevision.revisionHash) {
            throw new ProjectSetupConflictError("Another Project Options Apply is already in progress.");
          }
          return pending;
        }
        const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
        const workspace = db.select().from(workspaces).where(and(eq(workspaces.id, input.workspaceId),
          eq(workspaces.projectId, input.projectId))).get();
        const active = project?.activeConfigRevisionId === null || project?.activeConfigRevisionId === undefined ? undefined
          : db.select().from(projectConfigRevisions).where(and(eq(projectConfigRevisions.id, project.activeConfigRevisionId),
            eq(projectConfigRevisions.projectId, input.projectId))).get();
        const candidate = db.select().from(projectConfigRevisions).where(and(eq(projectConfigRevisions.id, input.candidateRevision.revisionId),
          eq(projectConfigRevisions.projectId, input.projectId))).get();
        if (project?.state !== "ready" || project.primaryWorkspaceId !== input.workspaceId || workspace?.kind !== "primary"
          || active === undefined || active.id !== input.expectedRevision.revisionId
          || active.configurationHash !== input.expectedRevision.revisionHash || workspace.configRevisionId !== active.id) {
          throw new ProjectSetupConflictError("The active Project Options revision changed. Reload settings before applying.");
        }
        if (candidate === undefined || candidate.state !== "draft" || candidate.configurationHash !== input.candidateRevision.revisionHash
          || candidate.compiledRuntimePlanJson === null || candidate.runtimePlanHash === null) {
          throw new ProjectSetupConflictError("The candidate Project Options revision is not a complete saved draft.");
        }
        if (projectOptionsDraftBaseRevision(candidate.id) !== active.id) {
          throw new ProjectSetupConflictError("This draft was saved against an older active revision. Save it again against the current settings before applying.");
        }
        const activeWorkspaceOperation = db.select().from(operations).where(and(eq(operations.projectId, input.projectId),
          eq(operations.workspaceId, input.workspaceId), or(eq(operations.state, "accepted"), eq(operations.state, "running"))))
          .orderBy(desc(operations.createdAt), desc(operations.operationId)).all().find((operation) => operation.operationName !== "configuration.apply");
        if (activeWorkspaceOperation !== undefined) throw new ProjectSetupConflictError("A workspace operation is still in progress.");
        const busyProcess = db.select().from(processes).where(eq(processes.workspaceId, input.workspaceId)).all().find((process) =>
          ["queued", "starting", "running", "stopping"].includes(process.observedState)
          || (process.observedState === "lost" && process.kind !== "ai"));
        if (busyProcess !== undefined) throw new ProjectSetupConflictError("A task, terminal, or unproven process is still active in this workspace.");
        const busyTask = db.select().from(taskRuns).where(eq(taskRuns.workspaceId, input.workspaceId)).all()
          .find((task) => ["queued", "starting", "running"].includes(task.state));
        if (busyTask !== undefined) throw new ProjectSetupConflictError("A configured task is still active in this workspace.");
        const busyTerminal = db.select().from(terminalSessions).where(eq(terminalSessions.workspaceId, input.workspaceId)).all()
          .find((terminal) => ["creating", "active", "disconnected", "closing"].includes(terminal.state));
        if (busyTerminal !== undefined) throw new ProjectSetupConflictError("A terminal session is still active in this workspace.");
        const activeAi = db.select().from(aiSessions).where(eq(aiSessions.workspaceId, input.workspaceId)).all()
          .find((session) => ["creating", "active", "waiting_for_input"].includes(session.state));
        if (activeAi !== undefined) throw new ProjectSetupConflictError("An AI session is still active in this workspace.");
        const activeTurn = db.select().from(aiTurns).innerJoin(aiSessions, eq(aiTurns.sessionId, aiSessions.id))
          .where(and(eq(aiSessions.workspaceId, input.workspaceId), or(eq(aiTurns.state, "accepted"), eq(aiTurns.state, "starting"),
            eq(aiTurns.state, "running"), eq(aiTurns.state, "waiting-for-approval"), eq(aiTurns.state, "waiting-for-input"),
            eq(aiTurns.state, "interrupting")))).get();
        if (activeTurn !== undefined) throw new ProjectSetupConflictError("An AI turn is still in progress in this workspace.");

        const previewIds = { ...input.previewIds };
        const timestamp = now().toISOString();
        const operation: Operation = { operationId: createId(), projectId: input.projectId, workspaceId: input.workspaceId,
          actor: input.actor, operationName: "configuration.apply", resourceType: "configuration-revision",
          resourceId: candidate.id, state: "accepted", progressJson: JSON.stringify({ expectedRevision: input.expectedRevision,
            candidateRevision: input.candidateRevision, previewIds, phase: "reserved" }), errorCode: null, errorMessage: null,
          createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run();
        return { operation, expectedRevision: input.expectedRevision, candidateRevision: input.candidateRevision, previewIds };
      }).immediate();
    },
    markProjectOptionsApplyRunning(operationId: string): void {
      const timestamp = now().toISOString();
      db.update(operations).set({ state: "running", startedAt: timestamp }).where(and(
        eq(operations.operationId, operationId), eq(operations.operationName, "configuration.apply"), eq(operations.state, "accepted")
      )).run();
    },
    markProjectOptionsAdoptionSubmitted(operationId: string): void {
      client.transaction(() => {
        const operation = db.select().from(operations).where(and(eq(operations.operationId, operationId),
          eq(operations.operationName, "configuration.apply"))).get();
        if (operation === undefined || (operation.state !== "accepted" && operation.state !== "running")) {
          throw new ProjectSetupConflictError("The Project Options Apply reservation is no longer active.");
        }
        let progress: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(operation.progressJson ?? "{}");
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-progress");
          progress = parsed as Record<string, unknown>;
        } catch { throw new ProjectSetupConflictError("The Project Options Apply reservation is malformed."); }
        if (progress["phase"] === "adoption-submitted") return;
        if (progress["phase"] !== "reserved") throw new ProjectSetupConflictError("The Project Options Apply phase is invalid.");
        db.update(operations).set({ progressJson: JSON.stringify({ ...progress, phase: "adoption-submitted" }) })
          .where(eq(operations.operationId, operationId)).run();
      }).immediate();
    },
    failProjectOptionsApply(operationId: string, expectedPhase: "reserved" | "adoption-submitted",
      outcome: { code: string; message: string }): boolean {
      return client.transaction(() => {
        const operation = db.select().from(operations).where(and(eq(operations.operationId, operationId),
          eq(operations.operationName, "configuration.apply"))).get();
        if (operation === undefined || (operation.state !== "accepted" && operation.state !== "running")) return false;
        const pending = this.getPendingProjectOptionsApply(operation.projectId);
        if (pending?.operation.operationId !== operationId || pending.phase !== expectedPhase) return false;
        const timestamp = now().toISOString();
        db.update(operations).set({ state: "failed", finishedAt: timestamp, errorCode: outcome.code,
          errorMessage: outcome.message.slice(0, 512) }).where(eq(operations.operationId, operationId)).run();
        const last = db.select({ sequence: auditEvents.sequence }).from(auditEvents).orderBy(desc(auditEvents.sequence)).limit(1).get();
        db.insert(auditEvents).values({ id: createId(), sequence: (last?.sequence ?? -1) + 1, actor: operation.actor,
          eventType: "project.options.apply_failed", resourceType: "configuration-revision", resourceId: operation.resourceId,
          operationId, metadataJson: JSON.stringify({ code: outcome.code }), createdAt: timestamp }).run();
        return true;
      }).immediate();
    },
    activateProjectOptionsRevision(input: {
      operationId: string; projectId: string; workspaceId: string; expectedRevision: RevisionIdentity;
      candidateRevision: RevisionIdentity; imageReference: string; previewRows: readonly NewPreview[];
    }): ProjectConfigRevision {
      return client.transaction(() => {
        const operation = db.select().from(operations).where(and(eq(operations.operationId, input.operationId),
          eq(operations.operationName, "configuration.apply"), eq(operations.projectId, input.projectId),
          eq(operations.workspaceId, input.workspaceId))).get();
        if (operation?.state === "succeeded") {
          const activated = db.select().from(projectConfigRevisions).where(eq(projectConfigRevisions.id, input.candidateRevision.revisionId)).get();
          if (activated?.state === "active") return activated;
        }
        if (operation === undefined || (operation.state !== "accepted" && operation.state !== "running")
          || operation.resourceId !== input.candidateRevision.revisionId) {
          throw new ProjectSetupConflictError("The Project Options Apply operation is no longer active.");
        }
        const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
        const workspace = db.select().from(workspaces).where(and(eq(workspaces.id, input.workspaceId),
          eq(workspaces.projectId, input.projectId))).get();
        const oldRevision = db.select().from(projectConfigRevisions).where(and(eq(projectConfigRevisions.id, input.expectedRevision.revisionId),
          eq(projectConfigRevisions.projectId, input.projectId))).get();
        const candidate = db.select().from(projectConfigRevisions).where(and(eq(projectConfigRevisions.id, input.candidateRevision.revisionId),
          eq(projectConfigRevisions.projectId, input.projectId))).get();
        if (project?.activeConfigRevisionId !== input.expectedRevision.revisionId || project.state !== "ready"
          || workspace?.configRevisionId !== input.expectedRevision.revisionId || workspace.id !== input.workspaceId
          || oldRevision?.configurationHash !== input.expectedRevision.revisionHash || candidate?.state !== "draft"
          || candidate.configurationHash !== input.candidateRevision.revisionHash || candidate.runtimePlanHash === null
          || candidate.compiledRuntimePlanJson === null) {
          throw new ProjectSetupConflictError("The active Project Options revision changed before activation.");
        }
        const pending = this.getPendingProjectOptionsApply(input.projectId);
        if (pending?.operation.operationId !== input.operationId) throw new ProjectSetupConflictError("The Project Options Apply reservation changed before activation.");
        const timestamp = now().toISOString();
        db.update(previews).set({ desiredState: "inactive", observedState: "inactive", routePresent: false,
          deactivatedAt: timestamp, updatedAt: timestamp }).where(and(eq(previews.workspaceId, input.workspaceId),
          eq(previews.configRevisionId, input.expectedRevision.revisionId))).run();
        for (const row of input.previewRows) {
          if (row.workspaceId !== input.workspaceId || row.configRevisionId !== candidate.id) {
            throw new ProjectSetupConflictError("A candidate preview row does not match the revision being activated.");
          }
          const existing = db.select().from(previews).where(eq(previews.id, row.id)).get();
          if (existing === undefined) db.insert(previews).values(row).run();
          else if (existing.workspaceId !== row.workspaceId || existing.configRevisionId !== row.configRevisionId
            || existing.previewKey !== row.previewKey || existing.hostname !== row.hostname) {
            throw new ProjectSetupConflictError("A candidate preview identity conflicts with retained history.");
          }
        }
        db.update(projectConfigRevisions).set({ state: "superseded", supersededAt: timestamp })
          .where(and(eq(projectConfigRevisions.id, oldRevision.id), eq(projectConfigRevisions.state, "active"))).run();
        db.update(projectConfigRevisions).set({ state: "active", activatedAt: timestamp, supersededAt: null })
          .where(and(eq(projectConfigRevisions.id, candidate.id), eq(projectConfigRevisions.state, "draft"))).run();
        const projectUpdate = db.update(projects).set({ activeConfigRevisionId: candidate.id, updatedAt: timestamp,
          rowVersion: project.rowVersion + 1 }).where(and(eq(projects.id, input.projectId),
          eq(projects.activeConfigRevisionId, input.expectedRevision.revisionId))).run();
        const workspaceUpdate = db.update(workspaces).set({ configRevisionId: candidate.id, desiredState: "stopped",
          observedState: "stopped", updatedAt: timestamp, rowVersion: workspace.rowVersion + 1 }).where(and(
          eq(workspaces.id, input.workspaceId), eq(workspaces.configRevisionId, input.expectedRevision.revisionId))).run();
        if (projectUpdate.changes !== 1 || workspaceUpdate.changes !== 1) {
          throw new ProjectSetupConflictError("The active Project Options revision changed concurrently.");
        }
        const stack = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        if (stack !== undefined) {
          db.update(runtimeStacks).set({ runtimePlanHash: candidate.runtimePlanHash, desiredState: "absent", observedState: "absent",
            updatedAt: timestamp, lastObservedAt: timestamp, lastErrorCode: null, lastErrorMessage: null }).where(eq(runtimeStacks.id, stack.id)).run();
          const development = db.select().from(workspaceServices).where(and(eq(workspaceServices.runtimeStackId, stack.id),
            eq(workspaceServices.kind, "development"))).get();
          if (development === undefined) throw new ProjectSetupConflictError("The development runtime service record is missing.");
          db.update(workspaceServices).set({ containerId: null, imageReference: input.imageReference, imageDigest: null,
            desiredState: "absent", observedState: "absent", healthState: "unknown", startedAt: null,
            stoppedAt: timestamp, lastObservedAt: timestamp }).where(eq(workspaceServices.id, development.id)).run();
        }
        const last = db.select({ sequence: auditEvents.sequence }).from(auditEvents).orderBy(desc(auditEvents.sequence)).limit(1).get();
        options.beforeAuditInsert?.();
        db.insert(auditEvents).values({ id: createId(), sequence: (last?.sequence ?? -1) + 1, actor: operation.actor,
          eventType: "project.options.activated", resourceType: "configuration-revision", resourceId: candidate.id,
          operationId: input.operationId, metadataJson: JSON.stringify({ previousRevisionId: oldRevision.id,
            previousRevisionHash: oldRevision.configurationHash, revisionHash: candidate.configurationHash }), createdAt: timestamp }).run();
        db.update(operations).set({ state: "succeeded", finishedAt: timestamp, errorCode: null, errorMessage: null })
          .where(and(eq(operations.operationId, input.operationId), or(eq(operations.state, "accepted"), eq(operations.state, "running")))).run();
        return { ...candidate, state: "active" as const, activatedAt: timestamp, supersededAt: null };
      }).immediate();
    },
    getOrCreateProjectFetchOperation(input: { projectId: string; actor: string }): Operation {
      return client.transaction(() => {
        const project = db.select({ id: projects.id, state: projects.state }).from(projects)
          .where(eq(projects.id, input.projectId)).get();
        if (project === undefined) throw new ProjectSetupConflictError("The project was not found.");
        if (project.state !== "ready") throw new ProjectSetupConflictError("A ready project is required to fetch the repository.");
        const existing = db.select().from(operations).where(and(
          eq(operations.projectId, input.projectId), eq(operations.operationName, "project.fetch")
        )).orderBy(desc(operations.createdAt), desc(operations.operationId)).get();
        if (existing !== undefined && (existing.state === "accepted" || existing.state === "running")) return existing;
        const createdAt = now().toISOString();
        const operation: Operation = {
          operationId: createId(), projectId: input.projectId, workspaceId: null, actor: input.actor,
          operationName: "project.fetch", resourceType: "project", resourceId: input.projectId,
          state: "accepted", progressJson: null, errorCode: null, errorMessage: null,
          createdAt, startedAt: null, finishedAt: null
        };
        db.insert(operations).values(operation).run();
        return operation;
      }).immediate();
    },
    prepareProjectPushOperation(input: {
      projectId: string; workspaceId: string; actor: string; progressJson: string;
    }): Operation {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        if (context.workspace.id !== input.workspaceId || context.workspace.kind !== "primary") {
          throw new ProjectSetupConflictError("A managed primary workspace is required to push.");
        }
        const active = db.select().from(operations).where(and(
          eq(operations.projectId, input.projectId), eq(operations.workspaceId, input.workspaceId),
          eq(operations.operationName, "project.push")
        )).orderBy(desc(operations.createdAt), desc(operations.operationId)).all()
          .find((candidate) => candidate.state === "accepted" || candidate.state === "running");
        const createdAt = now().toISOString();
        if (active?.state === "running") throw new ProjectSetupConflictError("A push is already in progress.");
        if (active !== undefined) {
          let prepared = false;
          try {
            const parsed: unknown = JSON.parse(active.progressJson ?? "{}");
            prepared = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
              && "phase" in parsed && (parsed as { readonly phase?: unknown }).phase === "prepared";
          } catch { /* terminalize conservatively on restart */ }
          if (!prepared) throw new ProjectSetupConflictError("A push is already in progress.");
          db.update(operations).set({ state: "failed", finishedAt: createdAt,
            errorCode: "GITHUB_PUSH_INTENT_STALE", errorMessage: "A newer push preparation superseded this intent."
          }).where(and(eq(operations.operationId, active.operationId), eq(operations.state, "accepted"))).run();
        }
        const operation: Operation = {
          operationId: createId(), projectId: input.projectId, workspaceId: input.workspaceId, actor: input.actor,
          operationName: "project.push", resourceType: "workspace", resourceId: input.workspaceId,
          state: "accepted", progressJson: input.progressJson, errorCode: null, errorMessage: null,
          createdAt, startedAt: null, finishedAt: null
        };
        db.insert(operations).values(operation).run();
        return operation;
      }).immediate();
    },
    getProjectPushOperation(input: { operationId: string; projectId: string; actor: string }): Operation | undefined {
      return db.select().from(operations).where(and(
        eq(operations.operationId, input.operationId), eq(operations.projectId, input.projectId),
        eq(operations.operationName, "project.push"), eq(operations.actor, input.actor)
      )).get();
    },
    getLatestProjectPushOperation(input: { projectId: string; actor: string }): Operation | undefined {
      return db.select().from(operations).where(and(
        eq(operations.projectId, input.projectId), eq(operations.operationName, "project.push"),
        eq(operations.actor, input.actor)
      )).orderBy(desc(operations.createdAt), desc(operations.operationId)).get();
    },
    claimProjectPushOperation(input: {
      operationId: string; projectId: string; workspaceId: string; actor: string;
      expectedProgressJson: string; progressJson: string;
    }): Operation {
      return client.transaction(() => {
        const operation = db.select().from(operations).where(and(
          eq(operations.operationId, input.operationId), eq(operations.projectId, input.projectId),
          eq(operations.workspaceId, input.workspaceId), eq(operations.operationName, "project.push"),
          eq(operations.resourceType, "workspace"), eq(operations.resourceId, input.workspaceId),
          eq(operations.actor, input.actor)
        )).get();
        if (operation === undefined) throw new ProjectSetupConflictError("The push intent was not found.");
        if ((operation.state !== "accepted" && operation.state !== "running")
          || operation.progressJson !== input.expectedProgressJson) {
          throw new ProjectSetupConflictError("The push intent is no longer available for confirmation.");
        }
        const timestamp = now().toISOString();
        const updated = db.update(operations).set({ state: "running", startedAt: operation.startedAt ?? timestamp,
          progressJson: input.progressJson
        }).where(and(eq(operations.operationId, input.operationId), eq(operations.state, operation.state),
          eq(operations.progressJson, input.expectedProgressJson))).run();
        if (updated.changes !== 1) throw new ProjectSetupConflictError("The push intent changed concurrently.");
        const claimed = db.select().from(operations).where(eq(operations.operationId, input.operationId)).get();
        if (claimed === undefined) throw new ProjectSetupConflictError("The push intent could not be claimed.");
        return claimed;
      }).immediate();
    },
    finishOperation(operationId: string, outcome: { state: "succeeded" } | { state: "failed"; code: string; message: string }): void {
      const timestamp = now().toISOString();
      db.update(operations).set({
        state: outcome.state, finishedAt: timestamp,
        errorCode: outcome.state === "failed" ? outcome.code : null,
        errorMessage: outcome.state === "failed" ? outcome.message : null
      }).where(and(eq(operations.operationId, operationId), or(
        eq(operations.state, "accepted"), eq(operations.state, "running")
      ))).run();
    },
    getRuntimeContext(projectId: string) {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (project === undefined || project.state !== "ready" || project.primaryWorkspaceId === null || project.activeConfigRevisionId === null) {
        throw new ProjectSetupConflictError("A ready primary workspace is required.");
      }
      assertNoPendingConfigurationApply(projectId, project.primaryWorkspaceId);
      const workspace = db.select().from(workspaces).where(and(eq(workspaces.id, project.primaryWorkspaceId), eq(workspaces.projectId, project.id))).get();
      const revision = db.select().from(projectConfigRevisions).where(and(
        eq(projectConfigRevisions.id, project.activeConfigRevisionId), eq(projectConfigRevisions.projectId, project.id)
      )).get();
      if (workspace === undefined || workspace.kind !== "primary" || revision === undefined || workspace.configRevisionId !== revision.id) {
        throw new ProjectSetupConflictError("The primary workspace configuration is inconsistent.");
      }
      return { project, workspace, revision };
    },
    getAiSession(projectId: string, workspaceId: string, sessionId: string) {
      return readAiSessionView(projectId, workspaceId, sessionId);
    },
    listAiSessions(projectId: string, workspaceId: string) {
      return listAiSessionSummaries(projectId, workspaceId);
    },
    getAiTurn(projectId: string, workspaceId: string, sessionId: string, turnId: string) {
      return readAiTurnIdentity(projectId, workspaceId, sessionId, turnId);
    },
    retireAiInteraction(input: {
      projectId: string; workspaceId: string; sessionId: string; turnId: string; requestId: string;
      state: "lost";
    }): boolean {
      return client.transaction(() => {
        assertAiWorkspace(input.projectId, input.workspaceId);
        const session = db.select({ id: aiSessions.id, workspaceId: aiSessions.workspaceId }).from(aiSessions).where(and(
          eq(aiSessions.id, input.sessionId), eq(aiSessions.workspaceId, input.workspaceId), eq(aiSessions.providerKey, "codex")
        )).get();
        if (session === undefined) throw new ProjectSetupConflictError("The AI session is no longer available.");
        const result = client.prepare(`
          update ai_interaction_requests
          set state = ?, updated_at = ?
          where id = ? and session_id = ? and turn_id = ? and state = 'pending'
        `).run(input.state, now().toISOString(), input.requestId, input.sessionId, input.turnId);
        return result.changes === 1;
      }).immediate();
    },
    createAiSession(input: { projectId: string; workspaceId: string; profileId: string; profileRevision: string; title?: string }) {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        if (context.workspace.id !== input.workspaceId) throw new ProjectSetupConflictError("The AI session workspace is not owned by this project.");
        const existing = db.select().from(aiSessions).where(and(
          eq(aiSessions.workspaceId, input.workspaceId), eq(aiSessions.providerKey, "codex"),
          or(eq(aiSessions.state, "creating"), eq(aiSessions.state, "active"),
            eq(aiSessions.state, "waiting_for_input"), eq(aiSessions.state, "interrupted"))
        ))
          .orderBy(desc(aiSessions.createdAt), desc(aiSessions.id)).get();
        if (existing !== undefined) return existing;
        if (input.profileId !== "codex" || context.revision.runtimePlanHash === null) throw new ProjectSetupConflictError("AI is not configured for this workspace.");
        const timestamp = now().toISOString();
        const runtime = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        const session = {
          id: createId(), workspaceId: input.workspaceId, terminalSessionId: null, processId: null, providerKey: "codex", profileKey: input.profileId,
          profileRevision: input.profileRevision, revisionId: context.revision.id, runtimePlanHash: context.revision.runtimePlanHash,
          runtimeGeneration: Math.max(1, runtime?.runtimeGeneration ?? 1), processGeneration: 1, lastSequence: 0,
          historyStartSequence: 1, historyTruncated: false, interactionHistoryTruncated: false, failureCode: null, failureJson: null,
          externalSessionId: null, title: input.title?.trim().slice(0, 128) || "Codex session", state: "creating" as const,
          createdAt: timestamp, updatedAt: timestamp, lastActivityAt: null, stoppedAt: null
        };
        db.insert(aiSessions).values(session).run(); return session;
      }).immediate();
    },
    createInitialAiSession(input: { projectId: string; workspaceId: string; profileId: string; profileRevision: string; title?: string }) {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        if (context.workspace.id !== input.workspaceId) throw new ProjectSetupConflictError("The AI session workspace is not owned by this project.");
        const existing = db.select().from(aiSessions).where(and(
          eq(aiSessions.workspaceId, input.workspaceId), eq(aiSessions.providerKey, "codex"),
          or(eq(aiSessions.state, "creating"), eq(aiSessions.state, "active"),
            eq(aiSessions.state, "waiting_for_input"), eq(aiSessions.state, "interrupted"))
        ))
          .orderBy(desc(aiSessions.createdAt), desc(aiSessions.id)).get();
        if (existing !== undefined) {
          const sameProfile = existing.profileKey === input.profileId && existing.profileRevision === input.profileRevision;
          return {
            session: existing,
            created: false as const,
            kind: sameProfile ? "reused-current-profile" as const : "blocked-by-live-profile" as const
          };
        }
        if (input.profileId !== "codex" || context.revision.runtimePlanHash === null) throw new ProjectSetupConflictError("AI is not configured for this workspace.");
        const timestamp = now().toISOString();
        const runtime = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        const session = {
          id: createId(), workspaceId: input.workspaceId, terminalSessionId: null, processId: null, providerKey: "codex", profileKey: input.profileId,
          profileRevision: input.profileRevision, revisionId: context.revision.id, runtimePlanHash: context.revision.runtimePlanHash,
          runtimeGeneration: Math.max(1, runtime?.runtimeGeneration ?? 1), processGeneration: 1, lastSequence: 0,
          historyStartSequence: 1, historyTruncated: false, interactionHistoryTruncated: false, failureCode: null, failureJson: null,
          externalSessionId: null, title: input.title?.trim().slice(0, 128) || "Codex session", state: "creating" as const,
          createdAt: timestamp, updatedAt: timestamp, lastActivityAt: null, stoppedAt: null
        };
        db.insert(aiSessions).values(session).run();
        return { session, created: true as const, kind: "created" as const };
      }).immediate();
    },
    listHarnessDefinitions() {
      return db.select().from(harnessDefinitions).orderBy(desc(harnessDefinitions.updatedAt), desc(harnessDefinitions.id)).all();
    },
    saveHarnessDefinition(input: {
      id: string; displayName: string; launchJson: string; resumeJson: string | null; environmentJson: string;
    }) {
      const timestamp = now().toISOString();
      const existing = db.select().from(harnessDefinitions).where(eq(harnessDefinitions.id, input.id)).get();
      if (existing === undefined) {
        db.insert(harnessDefinitions).values({
          id: input.id, displayName: input.displayName, origin: "custom",
          launchJson: input.launchJson, resumeJson: input.resumeJson, environmentJson: input.environmentJson,
          createdAt: timestamp, updatedAt: timestamp
        }).run();
      } else {
        db.update(harnessDefinitions).set({
          displayName: input.displayName, launchJson: input.launchJson, resumeJson: input.resumeJson,
          environmentJson: input.environmentJson, updatedAt: timestamp
        }).where(eq(harnessDefinitions.id, input.id)).run();
      }
    },
    createNativeHarnessSession(input: { projectId: string; workspaceId: string; harnessId: string; title?: string }) {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        if (context.workspace.id !== input.workspaceId) throw new ProjectSetupConflictError("The AI session workspace is not owned by this project.");
        const live = db.select().from(aiSessions).where(and(
          eq(aiSessions.workspaceId, input.workspaceId),
          or(eq(aiSessions.state, "creating"), eq(aiSessions.state, "active"),
            eq(aiSessions.state, "waiting_for_input"), eq(aiSessions.state, "interrupted"))
        )).get();
        if (live !== undefined && !(live.runtimeKind === "native-pty" && live.state === "creating" && live.harnessId === input.harnessId)) {
          throw new ProjectSetupConflictError("A live AI session already exists in this workspace.");
        }
        if (live !== undefined) return live;
        const timestamp = now().toISOString();
        const runtime = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        const session = {
          id: createId(), workspaceId: input.workspaceId, terminalSessionId: null, processId: null,
          providerKey: input.harnessId, profileKey: input.harnessId,
          profileRevision: `sha256-ai-profile-v1:${"0".repeat(64)}`,
          revisionId: context.revision.id, runtimePlanHash: context.revision.runtimePlanHash ?? `sha256-jcs-v1:${"0".repeat(64)}`,
          runtimeGeneration: Math.max(1, runtime?.runtimeGeneration ?? 1), processGeneration: 1, lastSequence: 0,
          historyStartSequence: 1, historyTruncated: false, interactionHistoryTruncated: false, failureCode: null, failureJson: null,
          externalSessionId: null, runtimeKind: "native-pty" as const, harnessId: input.harnessId,
          title: input.title?.trim().slice(0, 128) || `${input.harnessId} session`, state: "creating" as const,
          createdAt: timestamp, updatedAt: timestamp, lastActivityAt: null, stoppedAt: null
        };
        db.insert(aiSessions).values(session).run();
        return session;
      }).immediate();
    },
    listNativeHarnessSessions(workspaceId: string) {
      return db.select().from(aiSessions).where(and(
        eq(aiSessions.workspaceId, workspaceId), eq(aiSessions.runtimeKind, "native-pty")
      )).orderBy(desc(aiSessions.updatedAt)).all();
    },
    reconcileNativeHarnessObservation(input: {
      sessionId: string;
      expectedGeneration: number;
      agentState: NativeHarnessLifecycleState;
    }) {
      return client.transaction(() => {
        const session = db.select().from(aiSessions).where(eq(aiSessions.id, input.sessionId)).get();
        if (session === undefined) return { status: "missing" as const, session: null };
        if (session.runtimeKind !== "native-pty") return { status: "not-native" as const, session };
        if (session.processGeneration !== input.expectedGeneration) {
          return { status: "generation-mismatch" as const, session };
        }

        const nativeState = input.agentState === "live" ? null : input.agentState;
        if (nativeState !== null && (session.state === "active" || session.state === "creating")) {
          const timestamp = now().toISOString();
          db.update(aiSessions).set({ state: nativeState, updatedAt: timestamp, stoppedAt: timestamp })
            .where(and(
              eq(aiSessions.id, input.sessionId),
              eq(aiSessions.runtimeKind, "native-pty"),
              eq(aiSessions.processGeneration, input.expectedGeneration),
              or(eq(aiSessions.state, "active"), eq(aiSessions.state, "creating"))
            )).run();
        }

        if (nativeState !== null && session.terminalSessionId !== null) {
          const terminalState = nativeState === "stopped" ? "closed" : "lost";
          const terminal = db.select().from(terminalSessions).where(and(
            eq(terminalSessions.id, session.terminalSessionId), eq(terminalSessions.workspaceId, session.workspaceId)
          )).get();
          if (terminal !== undefined && (!(["closed", "failed", "lost"].includes(terminal.state)) || terminal.state === terminalState)) {
            const timestamp = now().toISOString();
            db.update(terminalSessions).set({
              state: terminalState,
              lastActivityAt: timestamp,
              closedAt: terminalState === "lost" ? terminal.closedAt ?? timestamp : timestamp
            }).where(and(
              eq(terminalSessions.id, session.terminalSessionId), eq(terminalSessions.workspaceId, session.workspaceId)
            )).run();
          }
        }

        const reconciled = db.select().from(aiSessions).where(eq(aiSessions.id, input.sessionId)).get();
        return { status: "matched" as const, session: reconciled ?? session };
      }).immediate();
    },
    prepareHarnessTerminal(projectId: string): { workspaceId: string; terminalId: string } {
      return client.transaction(() => {
        pruneExpiredLostTerminalSessions();
        const context = this.getRuntimeContext(projectId);
        if (context.workspace.observedState !== "running") throw new ProjectSetupConflictError("The workspace runtime must be running.");
        const stack = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, context.workspace.id)).get();
        const service = stack === undefined ? undefined : db.select().from(workspaceServices).where(and(
          eq(workspaceServices.runtimeStackId, stack.id), eq(workspaceServices.kind, "development"))).get();
        if (stack?.observedState !== "running" || service?.observedState !== "running") {
          throw new ProjectSetupConflictError("The exact development container is not running.");
        }
        const terminalId = createId();
        const timestamp = now().toISOString();
        db.insert(processes).values({ id: terminalId, workspaceId: context.workspace.id, serviceId: service.id,
          kind: "terminal", definitionKey: null, desiredState: "running", observedState: "queued", exitCode: null,
          startedAt: null, finishedAt: null, lastObservedAt: null }).run();
        db.insert(terminalSessions).values({ id: terminalId, workspaceId: context.workspace.id, processId: terminalId,
          title: "AI harness", shellProfileKey: "agent-default-sh", state: "creating", createdAt: timestamp,
          lastActivityAt: null, closedAt: null }).run();
        return { workspaceId: context.workspace.id, terminalId };
      }).immediate();
    },
    reopenNativeHarnessCreating(sessionId: string) {
      db.update(aiSessions).set({ state: "creating", updatedAt: now().toISOString() }).where(eq(aiSessions.id, sessionId)).run();
    },
    failNativeHarnessSession(sessionId: string) {
      const timestamp = now().toISOString();
      db.update(aiSessions).set({ state: "failed", updatedAt: timestamp, stoppedAt: timestamp })
        .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.runtimeKind, "native-pty"), eq(aiSessions.state, "creating"))).run();
    },
    claimHarnessResumeGeneration(sessionId: string, expectedGeneration: number): number {
      return client.transaction(() => {
        const session = db.select().from(aiSessions).where(eq(aiSessions.id, sessionId)).get();
        if (session === undefined || session.runtimeKind !== "native-pty") {
          throw new ProjectSetupConflictError("The native harness session is not available.");
        }
        const workspace = db.select({ projectId: workspaces.projectId }).from(workspaces)
          .where(eq(workspaces.id, session.workspaceId)).get();
        if (workspace === undefined) throw new ProjectSetupConflictError("The native harness workspace is not available.");
        assertNoPendingConfigurationApply(workspace.projectId, session.workspaceId);
        if (session.processGeneration !== expectedGeneration) {
          throw new ProjectSetupConflictError("The harness resume generation is stale.");
        }
        if (session.state === "active" || session.state === "creating") {
          throw new ProjectSetupConflictError("The native harness session is still live.");
        }
        const next = expectedGeneration + 1;
        const updated = db.update(aiSessions).set({
          processGeneration: next, state: "creating", updatedAt: now().toISOString()
        }).where(and(eq(aiSessions.id, sessionId), eq(aiSessions.processGeneration, expectedGeneration))).run();
        if (updated.changes !== 1) throw new ProjectSetupConflictError("The harness resume generation is stale.");
        return next;
      }).immediate();
    },
    bindNativeHarnessTerminal(input: { sessionId: string; terminalId: string; processId: string }) {
      const timestamp = now().toISOString();
      db.update(aiSessions).set({
        terminalSessionId: input.terminalId, processId: input.processId, state: "active", updatedAt: timestamp, lastActivityAt: timestamp
      }).where(eq(aiSessions.id, input.sessionId)).run();
      db.update(terminalSessions).set({ state: "active", lastActivityAt: timestamp }).where(eq(terminalSessions.id, input.terminalId)).run();
    },
    assignHarnessTerminal(input: { sessionId: string; terminalId: string; processId: string }) {
      db.update(aiSessions).set({
        terminalSessionId: input.terminalId, processId: input.processId, updatedAt: now().toISOString()
      }).where(eq(aiSessions.id, input.sessionId)).run();
    },
    activateNativeHarnessSession(sessionId: string) {
      const timestamp = now().toISOString();
      const session = db.select({ terminalSessionId: aiSessions.terminalSessionId }).from(aiSessions).where(eq(aiSessions.id, sessionId)).get();
      db.update(aiSessions).set({ state: "active", updatedAt: timestamp, lastActivityAt: timestamp })
        .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.state, "creating"))).run();
      if (session?.terminalSessionId !== null && session?.terminalSessionId !== undefined) {
        db.update(terminalSessions).set({ state: "active", lastActivityAt: timestamp })
          .where(eq(terminalSessions.id, session.terminalSessionId)).run();
      }
    },
    completeNativeHarnessAdmission(sessionId: string) {
      const timestamp = now().toISOString();
      const session = db.select({ terminalSessionId: aiSessions.terminalSessionId }).from(aiSessions).where(eq(aiSessions.id, sessionId)).get();
      db.update(aiSessions).set({ state: "stopped", updatedAt: timestamp, stoppedAt: timestamp })
        .where(and(eq(aiSessions.id, sessionId), or(eq(aiSessions.state, "creating"), eq(aiSessions.state, "active")))).run();
      if (session?.terminalSessionId !== null && session?.terminalSessionId !== undefined) {
        db.update(terminalSessions).set({ state: "closed", closedAt: timestamp })
          .where(eq(terminalSessions.id, session.terminalSessionId)).run();
      }
    },
    rollbackHarnessResume(input: { sessionId: string; expectedGeneration: number; restoreState: "stopped" | "lost" }) {
      const timestamp = now().toISOString();
      const result = db.update(aiSessions).set({
        processGeneration: input.expectedGeneration - 1,
        state: input.restoreState,
        terminalSessionId: null,
        processId: null,
        updatedAt: timestamp
      }).where(and(
        eq(aiSessions.id, input.sessionId),
        eq(aiSessions.state, "creating"),
        eq(aiSessions.processGeneration, input.expectedGeneration)
      )).run();
      if (result.changes !== 1) throw new ProjectSetupConflictError("The harness resume could not be rolled back.");
    },
    prepareInitialAiSessionRetry(input: {
      projectId: string;
      workspaceId: string;
      sessionId: string;
      profileId: string;
      profileRevision: string;
      revisionId: string;
      runtimePlanHash: string;
      runtimeGeneration: number;
      expectedUpdatedAt: string;
      synchronizedEmpty: true;
    }) {
      return client.transaction(() => {
        if (input.synchronizedEmpty !== true) {
          throw new ProjectSetupConflictError("An exact synchronized-empty Agent history is required.");
        }
        const context = this.getRuntimeContext(input.projectId);
        const runtime = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        const session = db.select().from(aiSessions).where(and(
          eq(aiSessions.id, input.sessionId),
          eq(aiSessions.workspaceId, input.workspaceId)
        )).get();
        const counts = client.prepare(`
          select
            (select count(*) from ai_events where session_id = ?) as events,
            (select count(*) from ai_turns where session_id = ?) as turns,
            (select count(*) from ai_interaction_requests where session_id = ?) as interactions
        `).get(input.sessionId, input.sessionId, input.sessionId) as {
          events: number;
          turns: number;
          interactions: number;
        };
        if (context.workspace.id !== input.workspaceId || session === undefined
          || session.state !== "creating" || session.lastSequence !== 0 || session.processGeneration !== 1
          || session.updatedAt !== input.expectedUpdatedAt
          || session.profileKey !== input.profileId || session.profileRevision !== input.profileRevision
          || session.revisionId !== input.revisionId || session.runtimePlanHash !== input.runtimePlanHash
          || session.runtimeGeneration !== input.runtimeGeneration
          || context.revision.id !== input.revisionId || context.revision.runtimePlanHash !== input.runtimePlanHash
          || runtime === undefined || runtime.runtimeGeneration !== input.runtimeGeneration
          || counts.events !== 0 || counts.turns !== 0 || counts.interactions !== 0) {
          throw new ProjectSetupConflictError("The initial AI session cannot be retried under this exact binding.");
        }
        const timestamp = new Date(Math.max(now().valueOf(), Date.parse(session.updatedAt) + 1)).toISOString();
        const result = db.update(aiSessions).set({ updatedAt: timestamp }).where(and(
          eq(aiSessions.id, input.sessionId),
          eq(aiSessions.workspaceId, input.workspaceId),
          eq(aiSessions.state, "creating"),
          eq(aiSessions.lastSequence, 0),
          eq(aiSessions.processGeneration, 1),
          eq(aiSessions.updatedAt, input.expectedUpdatedAt)
        )).run();
        if (result.changes !== 1) {
          throw new ProjectSetupConflictError("The initial AI session retry claim changed concurrently.");
        }
        return { ...session, updatedAt: timestamp };
      }).immediate();
    },
    prepareAiSessionRestart(input: { projectId: string; workspaceId: string; sessionId: string; profileId: string; profileRevision: string }) {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        const session = db.select().from(aiSessions).where(and(
          eq(aiSessions.id, input.sessionId), eq(aiSessions.workspaceId, input.workspaceId)
        )).get();
        const runtime = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        if (session?.state === "stopped" && !session.historyTruncated && session.historyStartSequence === 1) {
          const timestamp = now().toISOString();
          client.prepare(`
            update ai_turns
            set state = 'failed', failure_json = ?, completed_at = ?, updated_at = ?
            where session_id = ? and state in ('accepted', 'running')
              and not exists (
                select 1 from ai_events
                where ai_events.session_id = ai_turns.session_id
                  and ai_events.turn_id = ai_turns.id
                  and ai_events.event_type = 'turn.accepted'
              )
          `).run(JSON.stringify({
            code: "AI_SESSION_STATE_CONFLICT",
            category: "state-conflict",
            incidentId: null
          }), timestamp, timestamp, input.sessionId);
        }
        const activeTurn = db.select({ id: aiTurns.id }).from(aiTurns).where(and(
          eq(aiTurns.sessionId, input.sessionId), or(eq(aiTurns.state, "accepted"), eq(aiTurns.state, "running"),
            eq(aiTurns.state, "waiting-for-approval"), eq(aiTurns.state, "waiting-for-input"))
        )).get();
        if (context.workspace.id !== input.workspaceId || session === undefined || session.state !== "stopped"
          || activeTurn !== undefined
          || input.profileId !== "codex" || session.profileKey !== input.profileId || session.profileRevision !== input.profileRevision
          || session.revisionId !== context.revision.id || context.revision.runtimePlanHash === null
          || session.runtimePlanHash !== context.revision.runtimePlanHash
          || runtime === undefined || session.runtimeGeneration !== runtime.runtimeGeneration
          || session.processGeneration === Number.MAX_SAFE_INTEGER) {
          throw new ProjectSetupConflictError("The stopped AI session can no longer be restarted in this workspace.");
        }
        const timestamp = new Date(Math.max(now().valueOf(), Date.parse(session.updatedAt) + 1)).toISOString();
        const result = db.update(aiSessions).set({ state: "creating", updatedAt: timestamp }).where(and(
          eq(aiSessions.id, session.id), eq(aiSessions.workspaceId, input.workspaceId), eq(aiSessions.state, "stopped"),
          eq(aiSessions.updatedAt, session.updatedAt), eq(aiSessions.lastSequence, session.lastSequence),
          eq(aiSessions.processGeneration, session.processGeneration)
        )).run();
        if (result.changes !== 1) throw new ProjectSetupConflictError("The stopped AI session state changed before restart.");
        return { ...session, state: "creating" as const, updatedAt: timestamp };
      }).immediate();
    },
    rollbackAiSessionRestart(input: {
      projectId: string; workspaceId: string; sessionId: string; expectedUpdatedAt: string;
      expectedLastSequence: number; expectedProcessGeneration: number;
    }): boolean {
      return client.transaction(() => {
        const workspace = db.select({ projectId: workspaces.projectId }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).get();
        if (workspace?.projectId !== input.projectId) return false;
        const timestamp = new Date(Math.max(now().valueOf(), Date.parse(input.expectedUpdatedAt) + 1)).toISOString();
        const result = db.update(aiSessions).set({ state: "stopped", updatedAt: timestamp }).where(and(
          eq(aiSessions.id, input.sessionId), eq(aiSessions.workspaceId, input.workspaceId), eq(aiSessions.state, "creating"),
          eq(aiSessions.updatedAt, input.expectedUpdatedAt), eq(aiSessions.lastSequence, input.expectedLastSequence),
          eq(aiSessions.processGeneration, input.expectedProcessGeneration)
        )).run();
        return result.changes === 1;
      }).immediate();
    },
    createAiTurn(input: { projectId: string; workspaceId: string; sessionId: string; turnId: string; content: unknown }) {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        const session = db.select().from(aiSessions).where(and(eq(aiSessions.id, input.sessionId), eq(aiSessions.workspaceId, input.workspaceId))).get();
        if (context.workspace.id !== input.workspaceId || session === undefined) throw new ProjectSetupConflictError("The AI session identity is not owned by this workspace.");
        if (session.state !== "active") throw new ProjectSetupConflictError("The AI session is not accepting turns.");
        const existing = db.select().from(aiTurns).where(and(eq(aiTurns.id, input.turnId), eq(aiTurns.sessionId, input.sessionId))).get();
        if (existing !== undefined) return existing;
        const activeTurn = db.select({ id: aiTurns.id }).from(aiTurns).where(and(
          eq(aiTurns.sessionId, input.sessionId), or(eq(aiTurns.state, "accepted"), eq(aiTurns.state, "running"),
            eq(aiTurns.state, "waiting-for-approval"), eq(aiTurns.state, "waiting-for-input"))
        )).get();
        if (activeTurn !== undefined) throw new ProjectSetupConflictError("The AI session already has an active turn.");
        const timestamp = now().toISOString();
        const content = aiTurnContentSchema.parse(input.content);
        const turn = { id: input.turnId, sessionId: input.sessionId, state: "accepted" as const, contentJson: JSON.stringify(content), outputText: "",
          outputTruncated: false, changedFilesJson: JSON.stringify({ files: [], truncated: false }), failureJson: null,
          createdAt: timestamp, updatedAt: timestamp, completedAt: null };
        db.insert(aiTurns).values(turn).run(); return turn;
      }).immediate();
    },
    ensureAiTurnAccepted(input: {
      projectId: string; workspaceId: string; sessionId: string; turnId: string;
      processGeneration: number; content: unknown;
    }) {
      return client.transaction(() => ensureAiTurnAcceptedRow(input)).immediate();
    },
    commitAiEvent(input: { projectId: string; workspaceId: string; event: CanonicalAiEvent }): "appended" | "duplicate" {
      return client.transaction(() => {
        const event = canonicalAiEventSchema.parse(input.event);
        if (event.eventType === "session.started"
          && event.payload.processGeneration !== event.processGeneration) {
          throw new ProjectSetupConflictError("The started AI provider generation is inconsistent.");
        }
        const context = this.getRuntimeContext(input.projectId);
        const session = db.select().from(aiSessions).where(and(eq(aiSessions.id, event.sessionId), eq(aiSessions.workspaceId, input.workspaceId))).get();
        if (context.workspace.id !== input.workspaceId || session === undefined) throw new ProjectSetupConflictError("The AI event identity is not owned by this workspace.");
        const turnContext = canonicalTurnContext(event);
        const existingAtSequence = db.select().from(aiEvents).where(and(eq(aiEvents.sessionId, event.sessionId), eq(aiEvents.sequence, event.sequence))).get();
        const existingById = db.select().from(aiEvents).where(eq(aiEvents.eventId, event.eventId)).get();
        const parseExisting = (row: typeof existingAtSequence) => row === undefined ? null : canonicalAiEventSchema.parse(JSON.parse(row.eventJson));
        const decision = classifyAiEventAppend({ durableThroughSequence: session.lastSequence, existingAtSequence: parseExisting(existingAtSequence), existingByEventId: parseExisting(existingById), incoming: event });
        if (decision.kind === "exact-duplicate") {
          if (event.eventType === "turn.accepted") {
            ensureAiTurnAcceptedRow({
              projectId: input.projectId, workspaceId: input.workspaceId, sessionId: event.sessionId,
              turnId: event.turnId, processGeneration: event.processGeneration, content: event.payload.content
            });
          }
          return "duplicate";
        }
        if (decision.kind !== "append") throw new ProjectSetupConflictError(decision.kind === "gap" ? "The AI event stream has a sequence gap." : "The AI event stream has a conflicting sequence.");
        if (turnContext !== null && event.eventType !== "turn.accepted") {
          assertLegalTurnProgression(event, turnContext);
        }
        const previousEvent = session.lastSequence === 0 ? undefined : db.select().from(aiEvents).where(and(
          eq(aiEvents.sessionId, event.sessionId), eq(aiEvents.sequence, session.lastSequence)
        )).get();
        let processGeneration = session.processGeneration;
        if (event.eventType === "session.started") {
          const initial = session.lastSequence === 0 && session.state === "creating";
          const restarting = session.state === "creating" && previousEvent?.eventType === "session.stopped";
          if (!initial && !restarting) throw new ProjectSetupConflictError("The AI provider generation cannot start from this session state.");
          const expected = initial ? 1 : session.processGeneration === Number.MAX_SAFE_INTEGER ? null : session.processGeneration + 1;
          if (expected === null || event.processGeneration !== expected) {
            throw new ProjectSetupConflictError("The AI provider generation is not the exact next generation.");
          }
          processGeneration = expected;
        } else {
          if (event.processGeneration !== session.processGeneration) {
            throw new ProjectSetupConflictError("The AI event provider generation does not match the current session generation.");
          }
          if (session.state === "stopped" || session.state === "lost"
            || (session.state === "creating" && previousEvent?.eventType !== "session.started")
            || (session.state === "creating" && event.eventType !== "session.ready"
              && event.eventType !== "session.stopping" && event.eventType !== "session.lost")) {
            throw new ProjectSetupConflictError("The AI event is not valid for the current session state.");
          }
        }
        if (event.eventType === "turn.accepted") {
          ensureAiTurnAcceptedRow({
            projectId: input.projectId, workspaceId: input.workspaceId, sessionId: event.sessionId,
            turnId: event.turnId, processGeneration: event.processGeneration, content: event.payload.content
          });
        }
        const timestamp = now().toISOString();
        const deletedTurns = pruneAiTurns(event.sessionId);
        const outputBounds = client.prepare(`
          select coalesce(sum(min(length(cast(output_text as blob)), ?)), 0) as bytes,
            coalesce(max(length(cast(output_text as blob))), 0) as maxBytes
          from ai_turns where session_id = ?
        `).get(AI_TURN_OUTPUT_MAX_BYTES, event.sessionId) as { bytes: number; maxBytes: number };
        if (outputBounds.bytes > AI_SESSION_OUTPUT_MAX_BYTES || outputBounds.maxBytes > AI_TURN_OUTPUT_MAX_BYTES) {
          compactAiOutputs(event.sessionId);
        }
        projectAiInteractionEvent(event, timestamp);
        if (event.eventType === "turn.interrupted") retireAiInteractions({
          sessionId: event.sessionId, turnId: event.turnId, state: "cancelled", timestamp
        });
        else if (event.eventType === "turn.failed" || event.eventType === "turn.lost") retireAiInteractions({
          sessionId: event.sessionId, turnId: event.turnId, state: "lost", timestamp
        });
        else if (event.eventType === "turn.quiesced") retireAiInteractions({
          sessionId: event.sessionId, turnId: event.turnId, state: "expired", timestamp
        });
        else if (event.eventType === "session.stopped") retireAiInteractions({
          sessionId: event.sessionId, state: "cancelled", timestamp
        });
        else if (event.eventType === "session.lost") retireAiInteractions({
          sessionId: event.sessionId, state: "lost", timestamp
        });
        const interactionsCompacted = compactAiInteractions(event.sessionId);
        db.insert(aiEvents).values({ eventId: event.eventId, sessionId: event.sessionId, turnId: event.turnId, sequence: event.sequence,
          eventType: event.eventType, eventJson: JSON.stringify(event), observedAt: event.observedAt }).run();
        const sessionState = event.eventType === "session.stopped" ? "stopped" : event.eventType === "session.lost" ? "lost"
          : event.eventType === "session.started" ? "creating" : "active";
        let outputTruncated = false;
        if (event.turnId !== null) {
          const turn = db.select({
            id: aiTurns.id,
            state: aiTurns.state,
            outputTruncated: aiTurns.outputTruncated,
            changedFilesJson: aiTurns.changedFilesJson,
            failureJson: aiTurns.failureJson,
            completedAt: aiTurns.completedAt
          }).from(aiTurns).where(and(eq(aiTurns.id, event.turnId), eq(aiTurns.sessionId, event.sessionId))).get();
          if (turn !== undefined) {
            let state = turn.state; let outputText: string | undefined; let outputWasTruncated = turn.outputTruncated;
            let changedFilesJson = turn.changedFilesJson; let failureJson = turn.failureJson; let completedAt = turn.completedAt;
            if (event.eventType === "turn.started") state = "running";
            if (event.eventType === "turn.approval.requested") state = "waiting-for-approval";
            if (event.eventType === "turn.input.requested") state = "waiting-for-input";
            if (event.eventType === "turn.approval.responded" || event.eventType === "turn.input.responded") state = "running";
            if (event.eventType === "turn.interaction.expired") state = "running";
            if (event.eventType === "turn.output.delta") {
              const current = client.prepare(`
                select length(cast(output_text as blob)) as outputBytes,
                  substr(cast(output_text as blob), 1, ?) as outputPrefix
                from ai_turns where id = ? and session_id = ?
              `).get(AI_TURN_OUTPUT_MAX_BYTES + 4, turn.id, event.sessionId) as { outputBytes: number; outputPrefix: Buffer | null };
              const currentOutput = decodeUtf8Prefix(current.outputPrefix ?? Buffer.alloc(0), AI_TURN_OUTPUT_MAX_BYTES);
              const totalOutput = client.prepare(`
                select coalesce(sum(min(length(cast(output_text as blob)), ?)), 0) as bytes
                from ai_turns where session_id = ?
              `).get(AI_TURN_OUTPUT_MAX_BYTES, event.sessionId) as { bytes: number };
              const currentBytes = utf8ByteLength(currentOutput.value);
              const otherOutputBytes = Math.max(0, totalOutput.bytes - Math.min(current.outputBytes, AI_TURN_OUTPUT_MAX_BYTES));
              const available = Math.max(0, Math.min(
                AI_TURN_OUTPUT_MAX_BYTES - currentBytes,
                AI_SESSION_OUTPUT_MAX_BYTES - otherOutputBytes - currentBytes
              ));
              const delta = truncateUtf8(event.payload.text, available);
              outputText = truncateUtf8(`${currentOutput.value}${delta.value}`, AI_TURN_OUTPUT_MAX_BYTES).value;
              outputWasTruncated = turn.outputTruncated || current.outputBytes > AI_TURN_OUTPUT_MAX_BYTES
                || currentOutput.truncated || delta.truncated || utf8ByteLength(delta.value) < utf8ByteLength(event.payload.text);
              outputTruncated = outputWasTruncated;
            }
            if (event.eventType === "turn.files.changed") { changedFilesJson = JSON.stringify(event.payload); }
            if (event.eventType === "turn.failed") { state = "failed"; failureJson = JSON.stringify(event.payload.failure); completedAt = timestamp; }
            if (event.eventType === "turn.lost") {
              state = "failed";
              failureJson = JSON.stringify({
                code: "AI_SESSION_STATE_CONFLICT",
                category: "state-conflict",
                incidentId: null
              });
              completedAt = timestamp;
            }
            if (event.eventType === "turn.interrupted") { state = "interrupted"; completedAt = timestamp; }
            if (event.eventType === "turn.quiesced") { state = event.payload.outcome === "completed" ? "completed" : event.payload.outcome === "interrupted" ? "interrupted" : "failed"; completedAt = timestamp; }
            db.update(aiTurns).set({ state, ...(outputText === undefined ? {} : { outputText }), outputTruncated: outputWasTruncated, changedFilesJson, failureJson,
              completedAt, updatedAt: timestamp }).where(and(eq(aiTurns.id, turn.id), eq(aiTurns.sessionId, event.sessionId))).run();
          }
        }
        const compacted = compactAiEvents(event.sessionId, event.sequence, session.historyStartSequence,
          session.historyTruncated || deletedTurns || outputTruncated);
        db.update(aiSessions).set({ state: sessionState, processGeneration, lastSequence: event.sequence, historyStartSequence: compacted.historyStartSequence,
          historyTruncated: compacted.historyTruncated, interactionHistoryTruncated: session.interactionHistoryTruncated || interactionsCompacted,
          updatedAt: timestamp, lastActivityAt: timestamp,
          stoppedAt: event.eventType === "session.stopped" ? timestamp
            : event.eventType === "session.started" ? null : session.stoppedAt }).where(eq(aiSessions.id, event.sessionId)).run();
        return "appended";
      }).immediate();
    },
    storeRuntimePlanPair(input: { projectId: string; revisionId: string; canonicalJson: string; hash: string }): void {
      client.transaction(() => {
        const revision = db.select().from(projectConfigRevisions).where(and(
          eq(projectConfigRevisions.id, input.revisionId), eq(projectConfigRevisions.projectId, input.projectId)
        )).get();
        if (revision === undefined) throw new ProjectSetupConflictError("The configuration revision no longer exists.");
        if (revision.compiledRuntimePlanJson !== null || revision.runtimePlanHash !== null) {
          if (revision.compiledRuntimePlanJson !== input.canonicalJson || revision.runtimePlanHash !== input.hash) {
            throw new ProjectSetupConflictError("The retained runtime plan does not match deterministic compilation.");
          }
          return;
        }
        db.update(projectConfigRevisions).set({ compiledRuntimePlanJson: input.canonicalJson, runtimePlanHash: input.hash })
          .where(and(eq(projectConfigRevisions.id, input.revisionId), isNull(projectConfigRevisions.compiledRuntimePlanJson))).run();
      }).immediate();
    },
    prepareRuntimeMutation(input: {
      projectId: string; workspaceId: string; actor: string; action: "start" | "stop";
      runtimePlanHash: string; imageReference: string;
    }): Operation {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        if (context.workspace.id !== input.workspaceId || context.workspace.observedState === "provisioning") {
          throw new ProjectSetupConflictError("The primary workspace is not ready for a runtime action.");
        }
        const active = db.select().from(operations).where(and(eq(operations.projectId, input.projectId),
          eq(operations.workspaceId, input.workspaceId))).orderBy(desc(operations.createdAt), desc(operations.operationId)).all()
          .find((candidate) => (candidate.operationName === "workspace.start" || candidate.operationName === "workspace.stop")
            && (candidate.state === "accepted" || candidate.state === "running"));
        if (active !== undefined) {
          if (active.operationName === `workspace.${input.action}`) return active;
          throw new ProjectSetupConflictError("Another runtime action is still in progress.");
        }
        if (input.action === "stop") retireLostTerminalResources(input.workspaceId);
        let stack = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        const target = input.action === "start" ? "running" as const : "stopped" as const;
        if (stack === undefined && input.action === "stop") throw new ProjectSetupConflictError("No development runtime exists to stop.");
        const timestamp = now().toISOString();
        if (stack === undefined) {
          stack = { id: createId(), workspaceId: input.workspaceId, runtimeNamespace: `workspace-runtime:${input.workspaceId}`,
            runtimePlanHash: input.runtimePlanHash, desiredState: "running", observedState: "absent", runtimeGeneration: 1,
            createdAt: timestamp, updatedAt: timestamp, lastObservedAt: null, lastErrorCode: null, lastErrorMessage: null };
          db.insert(runtimeStacks).values(stack).run();
          db.insert(workspaceServices).values({ id: createId(), runtimeStackId: stack.id, serviceKey: "development", kind: "development",
            containerId: null, imageReference: input.imageReference, imageDigest: null, desiredState: "running", observedState: "absent",
            healthState: "unknown", startedAt: null, stoppedAt: null, lastObservedAt: null }).run();
        } else {
          if (stack.runtimePlanHash !== input.runtimePlanHash || stack.runtimeGeneration !== 1) {
            throw new ProjectSetupConflictError("The retained runtime stack belongs to another plan or generation.");
          }
          db.update(runtimeStacks).set({ desiredState: target, updatedAt: timestamp, lastErrorCode: null, lastErrorMessage: null })
            .where(eq(runtimeStacks.id, stack.id)).run();
          db.update(workspaceServices).set({ desiredState: target }).where(eq(workspaceServices.runtimeStackId, stack.id)).run();
        }
        db.update(workspaces).set({ desiredState: target, updatedAt: timestamp, rowVersion: context.workspace.rowVersion + 1 })
          .where(eq(workspaces.id, input.workspaceId)).run();
        const operation: Operation = { operationId: createId(), projectId: input.projectId, workspaceId: input.workspaceId,
          actor: input.actor, operationName: `workspace.${input.action}`, resourceType: "workspace", resourceId: input.workspaceId,
          state: "accepted", progressJson: null, errorCode: null, errorMessage: null,
          createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run();
        return operation;
      }).immediate();
    },
    finishRuntimeMutation(input: { operationId: string; projectId: string; workspaceId: string;
      outcome: { state: "succeeded"; workspaceObserved: WorkspaceInspectionData["observedState"];
        runtimeObserved: WorkspaceInspectionData["runtimeStack"]["observedState"] }
        | { state: "failed"; code: string; message: string } }): void {
      client.transaction(() => {
        const timestamp = now().toISOString();
        const operation = db.select({ operationName: operations.operationName, projectId: operations.projectId,
          workspaceId: operations.workspaceId }).from(operations)
          .where(eq(operations.operationId, input.operationId)).get();
        const stack = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, input.workspaceId)).get();
        if (stack === undefined) throw new ProjectSetupConflictError("The runtime stack no longer exists.");
        if (input.outcome.state === "succeeded") {
          db.update(runtimeStacks).set({ observedState: input.outcome.runtimeObserved, lastObservedAt: timestamp,
            updatedAt: timestamp, lastErrorCode: null, lastErrorMessage: null }).where(eq(runtimeStacks.id, stack.id)).run();
          db.update(workspaces).set({ observedState: input.outcome.workspaceObserved, updatedAt: timestamp })
            .where(eq(workspaces.id, input.workspaceId)).run();
          db.update(workspaceServices).set({ observedState: input.outcome.runtimeObserved, healthState: "unknown", lastObservedAt: timestamp,
            startedAt: input.outcome.runtimeObserved === "running" ? timestamp : null,
            stoppedAt: input.outcome.runtimeObserved === "stopped" ? timestamp : null }).where(eq(workspaceServices.runtimeStackId, stack.id)).run();
          if (operation?.operationName === "workspace.stop" && operation.projectId === input.projectId
            && operation.workspaceId === input.workspaceId && input.outcome.workspaceObserved === "stopped"
            && input.outcome.runtimeObserved === "stopped") {
            db.update(terminalSessions).set({ state: "lost", closedAt: timestamp }).where(and(
              eq(terminalSessions.workspaceId, input.workspaceId),
              or(eq(terminalSessions.state, "creating"), eq(terminalSessions.state, "active"),
                eq(terminalSessions.state, "disconnected"), eq(terminalSessions.state, "closing"))
            )).run();
            retireLostTerminalResources(input.workspaceId);
          }
        } else {
          db.update(runtimeStacks).set({ updatedAt: timestamp, lastObservedAt: timestamp, lastErrorCode: input.outcome.code,
            lastErrorMessage: input.outcome.message.slice(0, 512) }).where(eq(runtimeStacks.id, stack.id)).run();
        }
        this.finishOperation(input.operationId, input.outcome.state === "succeeded" ? { state: "succeeded" }
          : { state: "failed", code: input.outcome.code, message: input.outcome.message.slice(0, 512) });
      }).immediate();
    },
    prepareTerminalCreate(projectId: string, actor: string): { operation: Operation; workspaceId: string; terminalId: string } {
      return client.transaction(() => {
        pruneExpiredLostTerminalSessions();
        const context = this.getRuntimeContext(projectId);
        if (context.workspace.observedState !== "running") throw new ProjectSetupConflictError("The workspace runtime must be running.");
        const stack = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, context.workspace.id)).get();
        const service = stack === undefined ? undefined : db.select().from(workspaceServices).where(and(
          eq(workspaceServices.runtimeStackId, stack.id), eq(workspaceServices.kind, "development"))).get();
        if (stack?.observedState !== "running" || service?.observedState !== "running") {
          throw new ProjectSetupConflictError("The exact development container is not running.");
        }
        const terminalId = createId();
        const timestamp = now().toISOString();
        db.insert(processes).values({ id: terminalId, workspaceId: context.workspace.id, serviceId: service.id,
          kind: "terminal", definitionKey: null, desiredState: "running", observedState: "queued", exitCode: null,
          startedAt: null, finishedAt: null, lastObservedAt: null }).run();
        const terminalRows = db.select({ id: terminalSessions.id, title: terminalSessions.title, state: terminalSessions.state })
          .from(terminalSessions).where(eq(terminalSessions.workspaceId, context.workspace.id))
          .orderBy(desc(terminalSessions.createdAt), desc(terminalSessions.id)).all();
        const liveTerminalRows = terminalRows.filter((terminal) => terminalNamespaceStates.has(terminal.state));
        const assignments = terminalTitleAssignments(liveTerminalRows);
        for (const terminal of liveTerminalRows) {
          const title = assignments.get(terminal.id);
          if (title !== undefined && title !== terminal.title) {
            db.update(terminalSessions).set({ title }).where(eq(terminalSessions.id, terminal.id)).run();
          }
        }
        db.insert(terminalSessions).values({ id: terminalId, workspaceId: context.workspace.id, processId: terminalId,
          title: nextTerminalTitle(liveTerminalRows), shellProfileKey: "agent-default-sh", state: "creating", createdAt: timestamp,
          lastActivityAt: null, closedAt: null }).run();
        const operation: Operation = { operationId: createId(), projectId, workspaceId: context.workspace.id, actor,
          operationName: "terminal.create", resourceType: "terminal", resourceId: terminalId, state: "accepted",
          progressJson: null, errorCode: null, errorMessage: null, createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run();
        return { operation, workspaceId: context.workspace.id, terminalId };
      }).immediate();
    },
    failTerminalCreate(input: { operationId: string; terminalId: string; code: string; message: string }): void {
      client.transaction(() => {
        const timestamp = now().toISOString();
        this.finishOperation(input.operationId, { state: "failed", code: input.code, message: input.message.slice(0, 512) });
        db.update(terminalSessions).set({ state: "failed", closedAt: timestamp })
          .where(and(eq(terminalSessions.id, input.terminalId), eq(terminalSessions.state, "creating"))).run();
        db.update(processes).set({ observedState: "failed", finishedAt: timestamp, lastObservedAt: timestamp })
          .where(and(eq(processes.id, input.terminalId), eq(processes.observedState, "queued"))).run();
      }).immediate();
    },
    prepareTerminalClose(projectId: string, terminalId: string, actor: string): { operation: Operation; workspaceId: string } {
      return client.transaction(() => {
        const context = this.getRuntimeContext(projectId);
        const terminal = db.select().from(terminalSessions).where(and(eq(terminalSessions.id, terminalId),
          eq(terminalSessions.workspaceId, context.workspace.id))).get();
        if (terminal === undefined) throw new ProjectSetupConflictError("The terminal was not found.");
        const retained = db.select().from(operations).where(and(eq(operations.resourceId, terminalId), eq(operations.operationName, "terminal.close")))
          .orderBy(desc(operations.createdAt)).get();
        if (retained !== undefined && (retained.state === "accepted" || retained.state === "running")) {
          return { operation: retained, workspaceId: context.workspace.id };
        }
        if (!["active", "disconnected"].includes(terminal.state)) {
          throw new ProjectSetupConflictError("The terminal is no longer attachable.");
        }
        const timestamp = now().toISOString();
        db.update(terminalSessions).set({ state: "closing" }).where(eq(terminalSessions.id, terminalId)).run();
        db.update(processes).set({ desiredState: "stopped" }).where(eq(processes.id, terminal.processId)).run();
        const operation: Operation = { operationId: createId(), projectId, workspaceId: context.workspace.id, actor,
          operationName: "terminal.close", resourceType: "terminal", resourceId: terminalId, state: "accepted",
          progressJson: null, errorCode: null, errorMessage: null, createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run();
        return { operation, workspaceId: context.workspace.id };
      }).immediate();
    },
    prepareTaskStart(projectId: string, taskKey: string, actor: string): { operation: Operation; workspaceId: string; taskRunId: string; processId: string } {
      return client.transaction(() => {
        const context = this.getRuntimeContext(projectId);
        if (context.workspace.observedState !== "running") throw new ProjectSetupConflictError("The workspace runtime must be running.");
        const options = parseProjectOptionsV1(JSON.parse(context.revision.configurationJson));
        const task = options.tasks.find((candidate) => candidate.key === taskKey);
        if (task === undefined) throw new ProjectSetupConflictError("The configured task was not found.");
        const stack = db.select().from(runtimeStacks).where(eq(runtimeStacks.workspaceId, context.workspace.id)).get();
        const service = stack === undefined ? undefined : db.select().from(workspaceServices).where(and(
          eq(workspaceServices.runtimeStackId, stack.id), eq(workspaceServices.kind, "development"))).get();
        if (stack?.observedState !== "running" || service?.observedState !== "running") throw new ProjectSetupConflictError("The exact development container is not running.");
        const activeRuns = db.select().from(taskRuns).where(and(eq(taskRuns.workspaceId, context.workspace.id), eq(taskRuns.taskKey, taskKey))).all()
          .filter((run) => ["queued", "starting", "running"].includes(run.state));
        if (task.concurrencyPolicy === "reject" && activeRuns.length > 0) throw new ProjectSetupConflictError("This task already has an active run.");
        const staleRuns = db.select().from(taskRuns).where(eq(taskRuns.workspaceId, context.workspace.id)).all()
          .filter((run) => ["passed", "failed", "cancelled", "timed_out", "lost"].includes(run.state))
          .sort((left, right) => (right.finishedAt ?? right.id).localeCompare(left.finishedAt ?? left.id)).slice(99);
        for (const stale of staleRuns) {
          db.delete(taskRuns).where(eq(taskRuns.id, stale.id)).run();
          if (stale.processId !== null) db.delete(processes).where(eq(processes.id, stale.processId)).run();
        }
        const taskRunId = createId(); const processId = createId(); const timestamp = now().toISOString();
        db.insert(processes).values({ id: processId, workspaceId: context.workspace.id, serviceId: service.id,
          kind: "task", definitionKey: taskKey, desiredState: "running", observedState: "queued", exitCode: null,
          startedAt: null, finishedAt: null, lastObservedAt: null }).run();
        db.insert(taskRuns).values({ id: taskRunId, workspaceId: context.workspace.id, taskKey, processId,
          configRevisionId: context.revision.id, state: "queued", exitCode: null, startedAt: null, finishedAt: null,
          summaryJson: null }).run();
        const operation: Operation = { operationId: createId(), projectId, workspaceId: context.workspace.id, actor,
          operationName: "task.start", resourceType: "task-run", resourceId: taskRunId, state: "accepted",
          progressJson: null, errorCode: null, errorMessage: null, createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run();
        return { operation, workspaceId: context.workspace.id, taskRunId, processId };
      }).immediate();
    },
    prepareProcessStop(projectId: string, processId: string, actor: string): { operation: Operation; workspaceId: string } {
      return client.transaction(() => {
        const context = this.getRuntimeContext(projectId);
        const process = db.select().from(processes).where(and(eq(processes.id, processId), eq(processes.workspaceId, context.workspace.id))).get();
        if (process === undefined || process.kind !== "task") throw new ProjectSetupConflictError("The task process was not found.");
        const retained = db.select().from(operations).where(and(eq(operations.resourceId, processId), eq(operations.operationName, "process.stop")))
          .orderBy(desc(operations.createdAt)).get();
        if (retained !== undefined && (retained.state === "accepted" || retained.state === "running")) return { operation: retained, workspaceId: context.workspace.id };
        const timestamp = now().toISOString();
        db.update(processes).set({ desiredState: "stopped" }).where(eq(processes.id, processId)).run();
        const operation: Operation = { operationId: createId(), projectId, workspaceId: context.workspace.id, actor,
          operationName: "process.stop", resourceType: "process", resourceId: processId, state: "accepted",
          progressJson: null, errorCode: null, errorMessage: null, createdAt: timestamp, startedAt: null, finishedAt: null };
        db.insert(operations).values(operation).run(); return { operation, workspaceId: context.workspace.id };
      }).immediate();
    },
    applyExecutionSnapshot(snapshot: AgentSnapshotData): void {
      client.transaction(() => {
        pruneExpiredLostTerminalSessions();
        const timestamp = now().toISOString();
        const currentPreviewForOperation = (operation: Operation): Preview | undefined => {
          if (operation.workspaceId === null) return undefined;
          const project = db.select({ activeConfigRevisionId: projects.activeConfigRevisionId }).from(projects).where(and(
            eq(projects.id, operation.projectId), eq(projects.primaryWorkspaceId, operation.workspaceId), eq(projects.state, "ready")
          )).get();
          if (project?.activeConfigRevisionId === null || project?.activeConfigRevisionId === undefined) return undefined;
          return db.select().from(previews).where(and(
            eq(previews.id, operation.resourceId), eq(previews.workspaceId, operation.workspaceId),
            eq(previews.configRevisionId, project.activeConfigRevisionId)
          )).get();
        };
        for (const operation of snapshot.operationObservations) {
          const local = db.select().from(operations).where(eq(operations.operationId, operation.operationId)).get();
          if (local === undefined || !["task.start", "process.stop", "terminal.create", "terminal.close", "preview.activate", "preview.deactivate", "project.push"].includes(local.operationName)) continue;
          if (local.operationName === "project.push" && ["succeeded", "failed", "cancelled"].includes(local.state)) continue;
          if (operation.state === "succeeded") this.finishOperation(local.operationId, { state: "succeeded" });
          else if (operation.state === "failed") {
            const message = persistedFailureMessage(operation.failure.code);
            this.finishOperation(local.operationId, { state: "failed",
              code: operation.failure.code, message });
            if (local.operationName === "preview.activate" || local.operationName === "preview.deactivate") {
              const preview = currentPreviewForOperation(local);
              if (preview !== undefined) db.update(previews).set({ observedState: "failed", routePresent: preview.routePresent,
                  lastErrorCode: operation.failure.code, lastErrorMessage: message,
                  operationId: local.operationId, updatedAt: timestamp
                }).where(eq(previews.id, preview.id)).run();
            } else if (local.operationName === "terminal.create") {
              const terminal = db.select({ state: terminalSessions.state }).from(terminalSessions)
                .where(eq(terminalSessions.id, local.resourceId)).get();
              if (terminal?.state === "creating") {
                db.update(terminalSessions).set({ state: "failed", closedAt: timestamp })
                  .where(and(eq(terminalSessions.id, local.resourceId), eq(terminalSessions.state, "creating"))).run();
                const process = db.select({ observedState: processes.observedState }).from(processes)
                  .where(eq(processes.id, local.resourceId)).get();
                if (process !== undefined && !terminalProcessFinalStates.has(process.observedState)) {
                  db.update(processes).set({ observedState: "failed", finishedAt: timestamp, lastObservedAt: timestamp })
                    .where(and(eq(processes.id, local.resourceId), eq(processes.observedState, process.observedState))).run();
                }
              }
            } else if (local.operationName === "task.start") {
              const run = db.select().from(taskRuns).where(eq(taskRuns.id, local.resourceId)).get();
              db.update(taskRuns).set({ state: "failed", finishedAt: timestamp }).where(eq(taskRuns.id, local.resourceId)).run();
              if (run?.processId !== null && run?.processId !== undefined) {
                db.update(processes).set({ observedState: "failed", finishedAt: timestamp, lastObservedAt: timestamp })
                  .where(eq(processes.id, run.processId)).run();
              }
            } else if (local.operationName === "process.stop") {
              db.update(processes).set({ desiredState: "running" }).where(eq(processes.id, local.resourceId)).run();
            } else if (local.operationName === "terminal.close") {
              const terminal = db.select({ state: terminalSessions.state }).from(terminalSessions)
                .where(eq(terminalSessions.id, local.resourceId)).get();
              if (terminal !== undefined && ["active", "disconnected"].includes(terminal.state)) {
                db.update(terminalSessions).set({ state: "disconnected" }).where(eq(terminalSessions.id, local.resourceId)).run();
                db.update(processes).set({ desiredState: "running" }).where(eq(processes.id, local.resourceId)).run();
              }
            }
          }
          else db.update(operations).set({ state: operation.state, startedAt: operation.state === "running" ? timestamp : local.startedAt })
            .where(eq(operations.operationId, local.operationId)).run();
          if (operation.state === "succeeded" && (local.operationName === "preview.activate" || local.operationName === "preview.deactivate")) {
            const preview = currentPreviewForOperation(local);
            if (preview !== undefined) db.update(previews).set({ desiredState: local.operationName === "preview.activate" ? "active" : "inactive", operationId: local.operationId,
                updatedAt: timestamp }).where(eq(previews.id, preview.id)).run();
          }
        }
        for (const resource of snapshot.resources) {
          if (resource.type === "process") {
            const observed = resource.observation;
            const current = db.select({ observedState: processes.observedState }).from(processes).where(and(
              eq(processes.id, observed.processId), eq(processes.workspaceId, observed.workspaceId)
            )).get();
            if (current === undefined) continue;
            if (terminalProcessFinalStates.has(current.observedState) && current.observedState !== observed.observedState) continue;
            db.update(processes).set({ desiredState: observed.desiredState, observedState: observed.observedState,
              exitCode: observed.exitCode, startedAt: observed.startedAt, finishedAt: observed.finishedAt, lastObservedAt: timestamp })
              .where(and(eq(processes.id, observed.processId), eq(processes.workspaceId, observed.workspaceId))).run();
          } else if (resource.type === "terminal") {
            const terminal = db.select().from(terminalSessions).where(and(
              eq(terminalSessions.id, resource.identity.terminalId), eq(terminalSessions.workspaceId, resource.identity.workspaceId)
            )).get();
            if (terminal === undefined || (["closed", "failed", "lost"].includes(terminal.state) && terminal.state !== resource.state)) continue;
            db.update(terminalSessions).set({ state: resource.state, lastActivityAt: timestamp,
              closedAt: resource.state === "lost"
                ? terminal.closedAt ?? timestamp
                : ["closed", "failed"].includes(resource.state) ? timestamp : null })
              .where(and(eq(terminalSessions.id, terminal.id), eq(terminalSessions.workspaceId, terminal.workspaceId))).run();
            const nativeState = resource.state === "lost" ? "lost"
              : resource.state === "closed" || resource.state === "failed" ? "stopped" : null;
            if (nativeState !== null) {
              db.update(aiSessions).set({
                state: nativeState, updatedAt: timestamp,
                stoppedAt: nativeState === "stopped" || nativeState === "lost" ? timestamp : null
              }).where(and(
                eq(aiSessions.terminalSessionId, terminal.id),
                eq(aiSessions.runtimeKind, "native-pty"),
                or(eq(aiSessions.state, "active"), eq(aiSessions.state, "creating"))
              )).run();
            }
          } else if (resource.type === "preview") {
            const observed = resource.observation;
            const project = db.select().from(projects).where(and(
              eq(projects.id, observed.projectId), eq(projects.primaryWorkspaceId, observed.workspaceId), eq(projects.state, "ready")
            )).get();
            const revision = project?.activeConfigRevisionId === null || project?.activeConfigRevisionId === undefined ? undefined
              : db.select().from(projectConfigRevisions).where(and(
                eq(projectConfigRevisions.id, project.activeConfigRevisionId), eq(projectConfigRevisions.projectId, observed.projectId)
              )).get();
            const preview = db.select().from(previews).where(and(
              eq(previews.id, observed.previewId), eq(previews.workspaceId, observed.workspaceId),
              eq(previews.configRevisionId, revision?.id ?? ""), eq(previews.hostname, observed.hostname)
            )).get();
            if (preview !== undefined) {
              db.update(previews).set({ observedState: observed.observedState, routePresent: observed.routePresent,
                routeRevision: observed.routePresent ? preview.routeRevision ?? 1 : null,
                lastObservationJson: JSON.stringify(observed),
                lastErrorCode: observed.observedState === "healthy" ? null : preview.lastErrorCode,
                lastErrorMessage: observed.observedState === "healthy" ? null : preview.lastErrorMessage,
                updatedAt: timestamp
              }).where(eq(previews.id, preview.id)).run();
            }
          }
        }
        const allRuns = db.select().from(taskRuns).all();
        for (const run of allRuns) {
          if (run.processId === null) continue;
          const process = db.select().from(processes).where(eq(processes.id, run.processId)).get();
          if (process === undefined) continue;
          const revision = db.select().from(projectConfigRevisions).where(eq(projectConfigRevisions.id, run.configRevisionId)).get();
          const task = revision === undefined ? undefined : parseProjectOptionsV1(JSON.parse(revision.configurationJson)).tasks.find((item) => item.key === run.taskKey);
          let state: typeof run.state;
          if (["queued", "starting", "running"].includes(process.observedState)) state = process.observedState === "queued" ? "queued" : process.observedState === "starting" ? "starting" : "running";
          else if (process.observedState === "lost") state = "lost";
          else if (process.desiredState === "stopped" || process.observedState === "killed") {
            const timedOut = task?.timeoutSeconds !== null && task?.timeoutSeconds !== undefined && process.startedAt !== null
              && now().valueOf() >= new Date(process.startedAt).valueOf() + task.timeoutSeconds * 1_000;
            state = timedOut ? "timed_out" : "cancelled";
          } else state = process.exitCode !== null && task?.successExitCodes.includes(process.exitCode) ? "passed" : "failed";
          db.update(taskRuns).set({ state, exitCode: process.exitCode, startedAt: process.startedAt,
            finishedAt: process.finishedAt }).where(eq(taskRuns.id, run.id)).run();
        }
        pruneExpiredLostTerminalSessions();
      }).immediate();
    },
    authorizeTerminal(projectId: string, workspaceId: string, terminalId: string): boolean {
      const project = db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.primaryWorkspaceId, workspaceId))).get();
      if (project === undefined || project.state !== "ready") return false;
      const terminal = db.select().from(terminalSessions).where(and(eq(terminalSessions.id, terminalId), eq(terminalSessions.workspaceId, workspaceId))).get();
      if (terminal === undefined) return false;
      if (["active", "disconnected"].includes(terminal.state)) return true;
      if (terminal.state !== "closed" || terminal.closedAt === null) return false;
      const closedAt = Date.parse(terminal.closedAt);
      const currentTime = now().valueOf();
      return Number.isFinite(closedAt) && closedAt <= currentTime
        && currentTime - closedAt < TERMINAL_POST_EXIT_REPLAY_RETENTION_MS;
    },
    finalizePrimaryWorkspace(input: {
      projectId: string; revisionId: string; workspaceId: string; branchName: string; baseRef: string; actor: string;
      dirtyState: "clean" | "dirty";
    }): ManagedProjectView {
      client.transaction(() => {
        const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
        if (project === undefined) throw new ProjectSetupConflictError("The project no longer exists.");
        if (project.state === "ready") return;
        const required = ["configuration-revision.register", "configuration-runtime-plan.register", "project.managed-store.create", "project.setup.fetch", "workspace.create"];
        const completed = db.select().from(operations).where(eq(operations.projectId, project.id)).all();
        if (required.some((name) => !completed.some((operation) => operation.operationName === name && operation.state === "succeeded"))) {
          throw new ProjectSetupConflictError("Workspace setup operations have not all succeeded.");
        }
        const timestamp = now().toISOString();
        db.insert(workspaces).values({
          id: input.workspaceId, projectId: project.id, configRevisionId: input.revisionId,
          kind: "primary", name: "Primary", slug: "primary", branchName: input.branchName,
          baseRef: input.baseRef, worktreePath: `/srv/devspace/workspaces/${input.workspaceId}/source`,
          desiredState: "stopped", observedState: "stopped", dirtyState: input.dirtyState,
          createdAt: timestamp, updatedAt: timestamp, archivedAt: null, removedAt: null, rowVersion: 1
        }).run();
        db.update(projectConfigRevisions).set({ state: "active", activatedAt: timestamp })
          .where(and(eq(projectConfigRevisions.id, input.revisionId), eq(projectConfigRevisions.state, "draft"))).run();
        db.update(projects).set({
          activeConfigRevisionId: input.revisionId, primaryWorkspaceId: input.workspaceId,
          state: "ready", updatedAt: timestamp, rowVersion: project.rowVersion + 1
        }).where(and(eq(projects.id, project.id), eq(projects.state, "registering"))).run();
        const last = db.select({ sequence: auditEvents.sequence }).from(auditEvents).orderBy(desc(auditEvents.sequence)).limit(1).get();
        const workspaceOperation = completed.find((operation) => operation.operationName === "workspace.create");
        db.insert(auditEvents).values({
          id: createId(), sequence: (last?.sequence ?? -1) + 1, actor: input.actor,
          eventType: "workspace.primary.created", resourceType: "workspace", resourceId: input.workspaceId,
          operationId: workspaceOperation?.operationId ?? null, metadataJson: JSON.stringify({ desiredState: "stopped", runtimeStack: "absent" }),
          createdAt: timestamp
        }).run();
      }).immediate();
      const result = this.listManagedProjects().find((project) => project.id === input.projectId);
      if (result === undefined) throw new ProjectSetupConflictError("The finalized project could not be read.");
      return result;
    },
    createGithubConnectionAttempt(input: { actor: string; stateHash: string; expiresAt: string; connectionId?: string }) {
      return client.transaction(() => {
        const timestamp = now().toISOString();
        if (input.connectionId !== undefined) {
          const owned = getOwnedGithubConnection(input.actor, input.connectionId);
          if (owned === undefined) throw new ProjectSetupConflictError("The GitHub connection is not owned by this actor.");
          const pending = db.select().from(githubConnectionSetupAttempts).where(and(
            eq(githubConnectionSetupAttempts.connectionId, input.connectionId),
            eq(githubConnectionSetupAttempts.createdBy, input.actor),
            eq(githubConnectionSetupAttempts.status, "pending")
          )).orderBy(desc(githubConnectionSetupAttempts.createdAt)).get();
          if (pending !== undefined && owned.connection.lifecycleGeneration === pending.targetGeneration
            && owned.connection.lifecycleState === "reconnect-pending") {
            const updated = db.update(githubConnectionSetupAttempts).set({ stateHash: input.stateHash,
              expiresAt: input.expiresAt, updatedAt: timestamp, rowVersion: pending.rowVersion + 1
            }).where(and(eq(githubConnectionSetupAttempts.attemptId, pending.attemptId),
              eq(githubConnectionSetupAttempts.rowVersion, pending.rowVersion))).run();
            if (updated.changes !== 1) throw new ProjectSetupConflictError("The GitHub reconnect attempt changed concurrently.");
            return { ...pending, stateHash: input.stateHash, expiresAt: input.expiresAt, updatedAt: timestamp,
              rowVersion: pending.rowVersion + 1, lifecycleGeneration: pending.targetGeneration, reauthorization: true as const };
          }
          if (pending !== undefined) {
            db.update(githubConnectionSetupAttempts).set({ status: "failed", failureClassification: "stale-generation",
              updatedAt: timestamp, rowVersion: pending.rowVersion + 1 }).where(and(
              eq(githubConnectionSetupAttempts.attemptId, pending.attemptId),
              eq(githubConnectionSetupAttempts.status, "pending"), eq(githubConnectionSetupAttempts.rowVersion, pending.rowVersion)
            )).run();
          }
          const generation = owned.connection.lifecycleGeneration + 1;
          const updated = db.update(githubConnections).set({
            lifecycleGeneration: generation, lifecycleState: "reconnect-pending", cleanupState: "pending",
            lastAuthorityFailureCode: null, lastAuthorityCheckedAt: null,
            updatedAt: timestamp, rowVersion: owned.connection.rowVersion + 1
          }).where(and(eq(githubConnections.connectionId, input.connectionId),
            eq(githubConnections.lifecycleGeneration, owned.connection.lifecycleGeneration),
            eq(githubConnections.rowVersion, owned.connection.rowVersion))).run();
          if (updated.changes !== 1) throw new ProjectSetupConflictError("The GitHub connection changed concurrently.");
          const attempt = {
            attemptId: createId(), connectionId: input.connectionId, stateHash: input.stateHash, status: "pending" as const,
            targetGeneration: generation, expiresAt: input.expiresAt, claimedInstallationId: null,
            createdBy: input.actor, createdAt: timestamp, updatedAt: timestamp, failureClassification: null, rowVersion: 1
          };
          db.insert(githubConnectionSetupAttempts).values(attempt).run();
          return { ...attempt, lifecycleGeneration: generation, reauthorization: true as const };
        }
        const attempt = { connectionId: createId(), stateHash: input.stateHash, status: "pending" as const,
          expiresAt: input.expiresAt, claimedInstallationId: null, createdBy: input.actor,
          createdAt: timestamp, updatedAt: timestamp, failureClassification: null, rowVersion: 1 };
        db.insert(githubConnectionAttempts).values(attempt).run();
        return { ...attempt, lifecycleGeneration: 1, reauthorization: false as const };
      }).immediate();
    },
    claimGithubConnectionAttempt(input: { actor: string; stateHash: string; installationId: string }) {
      return client.transaction(() => {
        const setup = db.select().from(githubConnectionSetupAttempts).where(eq(githubConnectionSetupAttempts.stateHash, input.stateHash)).get();
        if (setup !== undefined) {
          const anchor = db.select().from(githubConnectionAttempts).where(eq(githubConnectionAttempts.connectionId, setup.connectionId)).get();
          if (anchor === undefined || anchor.createdBy !== input.actor) throw new Error("GITHUB_STATE_INVALID");
          if (!timingSafeEqual(Buffer.from(setup.stateHash, "hex"), Buffer.from(input.stateHash, "hex"))) throw new Error("GITHUB_STATE_INVALID");
          if (Date.parse(setup.expiresAt) <= now().valueOf()) throw new Error("GITHUB_STATE_EXPIRED");
          if (setup.status === "failed") throw new Error("GITHUB_STATE_CONSUMED");
          if (setup.status === "claimed" || setup.status === "connected") {
            if (setup.claimedInstallationId !== input.installationId) throw new Error("GITHUB_INSTALLATION_CONFLICT");
            return setup;
          }
          const updatedAt = now().toISOString();
          const result = db.update(githubConnectionSetupAttempts).set({ status: "claimed", claimedInstallationId: input.installationId,
            updatedAt, rowVersion: setup.rowVersion + 1 }).where(and(
            eq(githubConnectionSetupAttempts.attemptId, setup.attemptId), eq(githubConnectionSetupAttempts.status, "pending"),
            eq(githubConnectionSetupAttempts.rowVersion, setup.rowVersion))).run();
          if (result.changes !== 1) throw new Error("GITHUB_STATE_CONCURRENT");
          return { ...setup, status: "claimed" as const, claimedInstallationId: input.installationId, updatedAt, rowVersion: setup.rowVersion + 1 };
        }
        const attempt = db.select().from(githubConnectionAttempts).where(eq(githubConnectionAttempts.stateHash, input.stateHash)).get();
        if (attempt === undefined || attempt.createdBy !== input.actor) throw new Error("GITHUB_STATE_INVALID");
        if (!timingSafeEqual(Buffer.from(attempt.stateHash, "hex"), Buffer.from(input.stateHash, "hex"))) throw new Error("GITHUB_STATE_INVALID");
        if (Date.parse(attempt.expiresAt) <= now().valueOf()) throw new Error("GITHUB_STATE_EXPIRED");
        if (attempt.status === "failed") throw new Error("GITHUB_STATE_CONSUMED");
        if (attempt.status === "claimed" || attempt.status === "connected") {
          if (attempt.claimedInstallationId !== input.installationId) throw new Error("GITHUB_INSTALLATION_CONFLICT");
          return attempt;
        }
        const updatedAt = now().toISOString();
        const result = db.update(githubConnectionAttempts).set({ status: "claimed", claimedInstallationId: input.installationId,
          updatedAt, rowVersion: attempt.rowVersion + 1 }).where(and(
            eq(githubConnectionAttempts.connectionId, attempt.connectionId), eq(githubConnectionAttempts.status, "pending"),
            eq(githubConnectionAttempts.rowVersion, attempt.rowVersion))).run();
        if (result.changes !== 1) throw new Error("GITHUB_STATE_CONCURRENT");
        return { ...attempt, status: "claimed" as const, claimedInstallationId: input.installationId, updatedAt, rowVersion: attempt.rowVersion + 1 };
      }).immediate();
    },
    connectGithubInstallation(input: {
      actor: string; connectionId: string; installationId: string; accountId: string; accountType: "User" | "Organization";
      accountLogin: string; repositorySelection: "all" | "selected"; permissions: Record<string, "read" | "write">;
      status: "connected" | "degraded"; verifiedAt: string; lifecycleGeneration?: number; attemptId?: string;
    }) {
      return client.transaction(() => {
        const setup = input.attemptId === undefined ? undefined
          : db.select().from(githubConnectionSetupAttempts).where(and(
            eq(githubConnectionSetupAttempts.attemptId, input.attemptId),
            eq(githubConnectionSetupAttempts.connectionId, input.connectionId)
          )).get();
        const attempt = db.select().from(githubConnectionAttempts).where(eq(githubConnectionAttempts.connectionId, input.connectionId)).get();
        if (attempt === undefined || attempt.createdBy !== input.actor
          || (setup === undefined && (attempt.claimedInstallationId !== input.installationId
            || (attempt.status !== "claimed" && attempt.status !== "connected")))) throw new Error("GITHUB_ATTEMPT_NOT_CLAIMED");
        if (setup !== undefined && (setup.createdBy !== input.actor || setup.claimedInstallationId !== input.installationId
          || (setup.status !== "claimed" && setup.status !== "connected"))) throw new Error("GITHUB_ATTEMPT_NOT_CLAIMED");
        const timestamp = now().toISOString();
        const existing = db.select().from(githubConnections).where(eq(githubConnections.connectionId, input.connectionId)).get();
        const lifecycleGeneration = input.lifecycleGeneration ?? setup?.targetGeneration ?? existing?.lifecycleGeneration ?? 1;
        if (existing !== undefined && setup === undefined
          && (existing.lifecycleGeneration !== 1 || existing.lifecycleState !== "enabled")) throw new Error("GITHUB_GENERATION_STALE");
        if (existing !== undefined && (existing.lifecycleGeneration !== lifecycleGeneration
          || (setup !== undefined && existing.lifecycleState !== "reconnect-pending"))) throw new Error("GITHUB_GENERATION_STALE");
        const value = { connectionId: input.connectionId, installationId: input.installationId, accountId: input.accountId,
          accountType: input.accountType, accountLogin: input.accountLogin, repositorySelection: input.repositorySelection,
          permissionsJson: JSON.stringify(input.permissions), status: input.status, lifecycleGeneration,
          lifecycleState: "enabled" as const, cleanupState: "settled" as const, lastAuthorityFailureCode: null,
          lastAuthorityCheckedAt: input.verifiedAt, verifiedAt: input.verifiedAt,
          createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, rowVersion: (existing?.rowVersion ?? 0) + 1 };
        db.insert(githubConnections).values(value).onConflictDoUpdate({ target: githubConnections.connectionId,
          set: { installationId: value.installationId, accountId: value.accountId, accountType: value.accountType,
            accountLogin: value.accountLogin, repositorySelection: value.repositorySelection, permissionsJson: value.permissionsJson,
            status: value.status, lifecycleGeneration: value.lifecycleGeneration, lifecycleState: value.lifecycleState,
            cleanupState: value.cleanupState, lastAuthorityFailureCode: value.lastAuthorityFailureCode,
            lastAuthorityCheckedAt: value.lastAuthorityCheckedAt, verifiedAt: value.verifiedAt, updatedAt: value.updatedAt,
            rowVersion: value.rowVersion } }).run();
        if (setup !== undefined && setup.status !== "connected") db.update(githubConnectionSetupAttempts).set({ status: "connected", updatedAt: timestamp,
          rowVersion: setup.rowVersion + 1 }).where(and(eq(githubConnectionSetupAttempts.attemptId, setup.attemptId),
            eq(githubConnectionSetupAttempts.rowVersion, setup.rowVersion))).run();
        if (setup === undefined && attempt.status !== "connected") db.update(githubConnectionAttempts).set({ status: "connected", updatedAt: timestamp,
          rowVersion: attempt.rowVersion + 1 }).where(and(eq(githubConnectionAttempts.connectionId, attempt.connectionId),
            eq(githubConnectionAttempts.rowVersion, attempt.rowVersion))).run();
        return { ...value, permissions: input.permissions };
      }).immediate();
    },
    getGithubConnectionState(actor: string) {
      const attempts = db.select().from(githubConnectionAttempts).where(eq(githubConnectionAttempts.createdBy, actor))
        .orderBy(desc(githubConnectionAttempts.createdAt)).all();
      const retained = attempts.map((attempt) => ({ attempt, connection: db.select().from(githubConnections)
        .where(eq(githubConnections.connectionId, attempt.connectionId)).get() })).find((candidate) => candidate.connection !== undefined);
      const pendingReconnect = db.select().from(githubConnectionSetupAttempts)
        .where(and(eq(githubConnectionSetupAttempts.createdBy, actor), eq(githubConnectionSetupAttempts.status, "pending")))
        .orderBy(desc(githubConnectionSetupAttempts.createdAt)).get();
      const pendingInitial = attempts.find((candidate) => candidate.status === "pending"
        && db.select({ connectionId: githubConnections.connectionId }).from(githubConnections)
          .where(eq(githubConnections.connectionId, candidate.connectionId)).get() === undefined);
      const pendingAttempt = pendingReconnect === undefined ? pendingInitial
        : pendingInitial === undefined || pendingReconnect.createdAt >= pendingInitial.createdAt ? pendingReconnect : pendingInitial;
      const attempt = retained?.attempt ?? pendingAttempt ?? attempts[0];
      const connection = retained?.connection ?? (attempt === undefined ? undefined : db.select().from(githubConnections)
        .where(eq(githubConnections.connectionId, attempt.connectionId)).get());
      if (attempt === undefined && pendingAttempt === undefined) return null;
      return {
        attempt: attempt ?? pendingAttempt,
        connection: connection === undefined ? null : githubConnectionView(connection),
        pendingAttempt: pendingAttempt ?? null
      };
    },
    getGithubAuthorityContext(actor: string, connectionId: string) {
      const owned = getOwnedGithubConnection(actor, connectionId);
      if (owned === undefined) throw new ProjectSetupConflictError("The GitHub connection is not owned by this actor.");
      return {
        connectionId, lifecycleGeneration: owned.connection.lifecycleGeneration,
        lifecycleState: owned.connection.lifecycleState, cleanupState: owned.connection.cleanupState,
        admitted: owned.connection.lifecycleState === "enabled",
        refreshable: ["installation-removed", "installation-suspended", "permission-required", "repository-access-unavailable", "transient-error"].includes(owned.connection.lifecycleState)
      };
    },
    beginGithubDisconnect(input: { actor: string; connectionId: string }) {
      return client.transaction(() => {
        const owned = getOwnedGithubConnection(input.actor, input.connectionId);
        if (owned === undefined) throw new ProjectSetupConflictError("The GitHub connection is not owned by this actor.");
        if (owned.connection.lifecycleState === "disconnected" || owned.connection.lifecycleState === "disconnect-pending") return owned.connection;
        const updatedAt = now().toISOString();
        const nextGeneration = owned.connection.lifecycleGeneration + 1;
        const result = db.update(githubConnections).set({ lifecycleGeneration: nextGeneration,
          lifecycleState: "disconnect-pending", cleanupState: "pending", lastAuthorityFailureCode: null,
          lastAuthorityCheckedAt: null, updatedAt, rowVersion: owned.connection.rowVersion + 1
        }).where(and(eq(githubConnections.connectionId, input.connectionId),
          eq(githubConnections.lifecycleGeneration, owned.connection.lifecycleGeneration),
          eq(githubConnections.rowVersion, owned.connection.rowVersion))).run();
        if (result.changes !== 1) throw new ProjectSetupConflictError("The GitHub connection changed concurrently.");
        const updated = db.select().from(githubConnections).where(eq(githubConnections.connectionId, input.connectionId)).get();
        if (updated === undefined) throw new ProjectSetupConflictError("The GitHub connection could not be fenced.");
        return updated;
      }).immediate();
    },
    completeGithubDisconnect(input: { actor: string; connectionId: string; lifecycleGeneration: number; cleanupState: "settled" | "pending" | "degraded" }) {
      return client.transaction(() => {
        const owned = getOwnedGithubConnection(input.actor, input.connectionId);
        if (owned === undefined) throw new ProjectSetupConflictError("The GitHub connection is not owned by this actor.");
        const result = db.update(githubConnections).set({ lifecycleState: input.cleanupState === "pending" ? "disconnect-pending" : "disconnected", cleanupState: input.cleanupState,
          status: input.cleanupState === "degraded" ? "degraded" : owned.connection.status,
          updatedAt: now().toISOString(), rowVersion: owned.connection.rowVersion + 1
        }).where(and(eq(githubConnections.connectionId, input.connectionId),
          eq(githubConnections.lifecycleGeneration, input.lifecycleGeneration), eq(githubConnections.lifecycleState, "disconnect-pending"),
          eq(githubConnections.rowVersion, owned.connection.rowVersion))).run();
        if (result.changes !== 1) throw new ProjectSetupConflictError("The GitHub disconnect changed concurrently.");
        return db.select().from(githubConnections).where(eq(githubConnections.connectionId, input.connectionId)).get()!;
      }).immediate();
    },
    recordGithubAuthorityFailure(input: { actor: string; connectionId: string; lifecycleGeneration: number; failureCode: string; lifecycleState: "installation-removed" | "installation-suspended" | "permission-required" | "repository-access-unavailable" | "transient-error" }) {
      const owned = getOwnedGithubConnection(input.actor, input.connectionId);
      if (owned === undefined) throw new ProjectSetupConflictError("The GitHub connection is not owned by this actor.");
      const result = db.update(githubConnections).set({ lifecycleState: input.lifecycleState,
        lastAuthorityFailureCode: input.failureCode, lastAuthorityCheckedAt: now().toISOString(),
        updatedAt: now().toISOString(), rowVersion: owned.connection.rowVersion + 1
      }).where(and(eq(githubConnections.connectionId, input.connectionId),
        eq(githubConnections.lifecycleGeneration, input.lifecycleGeneration), eq(githubConnections.rowVersion, owned.connection.rowVersion))).run();
      if (result.changes !== 1) throw new ProjectSetupConflictError("The GitHub authority changed concurrently.");
    },
    completeGithubAuthorityReconnect(input: { actor: string; connectionId: string; lifecycleGeneration: number; installationId: string; accountId: string; accountType: "User" | "Organization"; accountLogin: string; repositorySelection: "all" | "selected"; permissions: Record<string, "read" | "write">; status: "connected" | "degraded"; verifiedAt: string; attemptId?: string }) {
      return this.connectGithubInstallation({ ...input, lifecycleGeneration: input.lifecycleGeneration });
    },
    listOperations: () => db.select().from(operations).orderBy(operations.createdAt, operations.operationId).all(),
    listRuntimeOperations: (projectId: string, workspaceId: string) => db.select().from(operations).where(and(
      eq(operations.projectId, projectId), eq(operations.workspaceId, workspaceId)
    )).orderBy(desc(operations.createdAt), desc(operations.operationId)).all().filter((operation) =>
      operation.operationName === "workspace.start" || operation.operationName === "workspace.stop"),
    listConfigRevisions: () => db.select().from(projectConfigRevisions).orderBy(projectConfigRevisions.revisionNumber).all(),
    listWorkspaces: () => db.select().from(workspaces).orderBy(workspaces.createdAt, workspaces.id).all(),
    listRuntimeStacks: () => db.select().from(runtimeStacks).all(),
    listWorkspaceServices: () => db.select().from(workspaceServices).all(),
    listAuditEvents: () => db.select().from(auditEvents).orderBy(auditEvents.sequence).all()
  };
}

export type ProjectDatabase = ReturnType<typeof openProjectDatabase>;

let singleton: { path: string; database: ProjectDatabase } | undefined;
export function getProjectDatabase(path: string): ProjectDatabase {
  if (singleton?.path !== path) {
    singleton?.database.close();
    singleton = { path, database: openProjectDatabase(path) };
  }
  return singleton.database;
}
