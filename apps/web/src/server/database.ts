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
  decodeUtf8Prefix,
  parseBoundedJson,
  serializedBytes,
  truncateUtf8,
  utf8ByteLength
} from "./ai-history.js";
import {
  AI_USER_CONTENT_MAX_BYTES,
  aiChangedFilesSummarySchema,
  canonicalAiEventSchema,
  classifyAiEventAppend,
  aiTurnContentSchema,
  type AgentSnapshotData,
  type CanonicalAiEvent,
  type WorkspaceInspectionData
} from "@devspace/contracts";
import { mkdirSync } from "node:fs";
import pathModule from "node:path";
import {
  auditEvents, migrateDatabase, operations, processes, projectConfigRevisions, projects, runtimeStacks, taskRuns, terminalSessions,
  previews, workspaceServices, workspaces, aiSessions, aiTurns, aiEvents,
  type Operation, type Preview, type Project, type ProjectConfigRevision
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
}

export class DuplicateProjectSlugError extends Error {
  constructor() { super("A project with this slug already exists."); this.name = "DuplicateProjectSlugError"; }
}
export class ProjectSetupConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectSetupConflictError"; }
}

const terminalNamespaceStates = new Set(["creating", "active", "disconnected"]);
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
    const previewRows = workspace === undefined ? [] : db.select().from(previews)
      .where(eq(previews.workspaceId, workspace.id)).orderBy(previews.previewKey, previews.id).all();
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
      from ai_events where session_id = ? order by sequence desc limit ?
    `).all(AI_SESSION_EVENT_HISTORY_MAX_BYTES, session.id, AI_SESSION_EVENT_HISTORY_MAX_EVENTS + 1) as RawAiEventRow[];
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
    return { session: finalSession, turns: retainedTurns, interactions: responseInteractions, events: retainedEvents };
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
      "select id, session_id as sessionId from ai_turns where id = ? and session_id = ?"
    ).get(turnId, sessionId) as { id: string; sessionId: string } | undefined;
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
      from ai_events where session_id = ?
    `).get(sessionId) as { count: number; bytes: number; minimumSequence: number; maximumSequence: number };
    const contiguous = total.count === 0 || total.maximumSequence - total.minimumSequence + 1 === total.count;
    if (total.count <= AI_SESSION_EVENT_HISTORY_MAX_EVENTS && total.bytes <= AI_SESSION_EVENT_HISTORY_MAX_BYTES
      && contiguous && (total.count === 0 || total.minimumSequence === currentHistoryStartSequence)) {
      return { historyStartSequence: currentHistoryStartSequence, historyTruncated: alreadyTruncated };
    }
    const candidates = client.prepare(`
      select sequence, length(cast(event_json as blob)) as eventBytes
      from ai_events where session_id = ? order by sequence desc limit ?
    `).all(sessionId, AI_SESSION_EVENT_HISTORY_MAX_EVENTS) as Array<{ sequence: number; eventBytes: number }>;
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
      client.prepare("delete from ai_events where session_id = ?").run(sessionId);
    } else {
      client.prepare("delete from ai_events where session_id = ? and sequence < ?").run(sessionId, historyStartSequence);
    }
    return {
      historyStartSequence,
      historyTruncated: alreadyTruncated || total.count > retained || total.bytes > bytes
    };
  };
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
    listPreviews(projectId: string, workspaceId: string): PreviewView[] {
      const workspace = db.select({ id: workspaces.id }).from(workspaces).where(and(
        eq(workspaces.id, workspaceId), eq(workspaces.projectId, projectId)
      )).get();
      if (workspace === undefined) return [];
      return db.select().from(previews).where(eq(previews.workspaceId, workspace.id))
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
        const existing = db.select().from(previews).where(eq(previews.workspaceId, input.workspaceId)).all();
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
        return db.select().from(previews).where(eq(previews.workspaceId, input.workspaceId))
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
          db.insert(projects).values(row).run();
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
            metadataJson: JSON.stringify({ sourceKind: "remote" }),
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
    createAiSession(input: { projectId: string; workspaceId: string; profileId: string; profileRevision: string; title?: string }) {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        if (context.workspace.id !== input.workspaceId) throw new ProjectSetupConflictError("The AI session workspace is not owned by this project.");
        const existing = db.select().from(aiSessions).where(and(eq(aiSessions.workspaceId, input.workspaceId), eq(aiSessions.providerKey, "codex")))
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
    createAiTurn(input: { projectId: string; workspaceId: string; sessionId: string; turnId: string; content: unknown }) {
      return client.transaction(() => {
        const context = this.getRuntimeContext(input.projectId);
        const session = db.select().from(aiSessions).where(and(eq(aiSessions.id, input.sessionId), eq(aiSessions.workspaceId, input.workspaceId))).get();
        if (context.workspace.id !== input.workspaceId || session === undefined) throw new ProjectSetupConflictError("The AI session identity is not owned by this workspace.");
        const existing = db.select().from(aiTurns).where(and(eq(aiTurns.id, input.turnId), eq(aiTurns.sessionId, input.sessionId))).get();
        if (existing !== undefined) return existing;
        const timestamp = now().toISOString();
        const content = aiTurnContentSchema.parse(input.content);
        const turn = { id: input.turnId, sessionId: input.sessionId, state: "accepted" as const, contentJson: JSON.stringify(content), outputText: "",
          outputTruncated: false, changedFilesJson: JSON.stringify({ files: [], truncated: false }), failureJson: null,
          createdAt: timestamp, updatedAt: timestamp, completedAt: null };
        db.insert(aiTurns).values(turn).run(); return turn;
      }).immediate();
    },
    commitAiEvent(input: { projectId: string; workspaceId: string; event: CanonicalAiEvent }): "appended" | "duplicate" {
      return client.transaction(() => {
        const event = canonicalAiEventSchema.parse(input.event);
        const context = this.getRuntimeContext(input.projectId);
        const session = db.select().from(aiSessions).where(and(eq(aiSessions.id, event.sessionId), eq(aiSessions.workspaceId, input.workspaceId))).get();
        if (context.workspace.id !== input.workspaceId || session === undefined) throw new ProjectSetupConflictError("The AI event identity is not owned by this workspace.");
        const existingAtSequence = db.select().from(aiEvents).where(and(eq(aiEvents.sessionId, event.sessionId), eq(aiEvents.sequence, event.sequence))).get();
        const existingById = db.select().from(aiEvents).where(eq(aiEvents.eventId, event.eventId)).get();
        const parseExisting = (row: typeof existingAtSequence) => row === undefined ? null : canonicalAiEventSchema.parse(JSON.parse(row.eventJson));
        const decision = classifyAiEventAppend({ durableThroughSequence: session.lastSequence, existingAtSequence: parseExisting(existingAtSequence), existingByEventId: parseExisting(existingById), incoming: event });
        if (decision.kind === "exact-duplicate") return "duplicate";
        if (decision.kind !== "append") throw new ProjectSetupConflictError(decision.kind === "gap" ? "The AI event stream has a sequence gap." : "The AI event stream has a conflicting sequence.");
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
        const interactionsCompacted = compactAiInteractions(event.sessionId);
        db.insert(aiEvents).values({ eventId: event.eventId, sessionId: event.sessionId, turnId: event.turnId, sequence: event.sequence,
          eventType: event.eventType, eventJson: JSON.stringify(event), observedAt: event.observedAt }).run();
        const sessionState = event.eventType === "session.stopped" ? "stopped" : event.eventType === "session.lost" ? "lost"
          : event.eventType === "session.stopping" ? "active" : "active";
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
            if (event.eventType === "turn.interrupted") { state = "interrupted"; completedAt = timestamp; }
            if (event.eventType === "turn.quiesced") { state = event.payload.outcome === "completed" ? "completed" : event.payload.outcome === "interrupted" ? "interrupted" : "failed"; completedAt = timestamp; }
            db.update(aiTurns).set({ state, ...(outputText === undefined ? {} : { outputText }), outputTruncated: outputWasTruncated, changedFilesJson, failureJson,
              completedAt, updatedAt: timestamp }).where(and(eq(aiTurns.id, turn.id), eq(aiTurns.sessionId, event.sessionId))).run();
          }
        }
        const compacted = compactAiEvents(event.sessionId, event.sequence, session.historyStartSequence,
          session.historyTruncated || deletedTurns || outputTruncated);
        db.update(aiSessions).set({ state: sessionState, lastSequence: event.sequence, historyStartSequence: compacted.historyStartSequence,
          historyTruncated: compacted.historyTruncated, interactionHistoryTruncated: session.interactionHistoryTruncated || interactionsCompacted,
          updatedAt: timestamp, lastActivityAt: timestamp,
          stoppedAt: event.eventType === "session.stopped" ? timestamp : session.stoppedAt }).where(eq(aiSessions.id, event.sessionId)).run();
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
          if (local === undefined || !["task.start", "process.stop", "terminal.create", "terminal.close", "preview.activate", "preview.deactivate"].includes(local.operationName)) continue;
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
              db.update(terminalSessions).set({ state: "failed", closedAt: timestamp }).where(eq(terminalSessions.id, local.resourceId)).run();
              db.update(processes).set({ observedState: "failed", finishedAt: timestamp, lastObservedAt: timestamp })
                .where(eq(processes.id, local.resourceId)).run();
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
      return terminal !== undefined && ["active", "disconnected"].includes(terminal.state);
    },
    finalizePrimaryWorkspace(input: {
      projectId: string; revisionId: string; workspaceId: string; branchName: string; baseRef: string; actor: string;
      dirtyState: "clean" | "dirty";
    }): ManagedProjectView {
      client.transaction(() => {
        const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
        if (project === undefined) throw new ProjectSetupConflictError("The project no longer exists.");
        if (project.state === "ready") return;
        const required = ["configuration-revision.register", "configuration-runtime-plan.register", "project.managed-store.create", "project.fetch", "workspace.create"];
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
