import {
  aiSessionStates,
  aiInteractionRequestStates,
  aiTurnStates,
  configurationRevisionStates,
  operationStates,
  previewDesiredStates,
  previewObservedStates,
  processDesiredStates,
  processObservedStates,
  projectStates,
  runtimeStackDesiredStates,
  runtimeStackObservedStates,
  taskRunStates,
  terminalStates,
  workspaceDesiredStates,
  workspaceObservedStates,
  workspaceServiceDesiredStates,
  workspaceServiceHealthStates,
  workspaceServiceObservedStates
} from "@devspace/domain";
import { sql, type SQL } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type AnySQLiteColumn,
  type SQLiteColumn
} from "drizzle-orm/sqlite-core";

const automaticFetchPolicies = ["manual", "on-start"] as const;
const configurationRevisionSources = ["user", "detected", "imported"] as const;
const workspaceKinds = ["primary", "isolated"] as const;
const workspaceDirtyStates = ["unknown", "clean", "dirty"] as const;
const workspaceServiceKinds = ["development", "supporting"] as const;
const processKinds = ["task", "terminal", "ai", "system"] as const;
const previewProtocols = ["http"] as const;
const previewTargetKinds = ["workspace", "service"] as const;
const portLeaseStates = ["reserved", "active", "released", "stale"] as const;
const githubConnectionAttemptStates = ["pending", "claimed", "connected", "failed"] as const;
const githubConnectionStates = ["connected", "degraded", "failed"] as const;

function quotedValues(values: readonly string[]): SQL {
  return sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", "));
}

function enumCheck(name: string, column: SQLiteColumn, values: readonly string[]) {
  return check(name, sql`${column} in (${quotedValues(values)})`);
}

const lowercaseHexGlob = "[0-9a-f]";
const uuidV7Glob = `${lowercaseHexGlob.repeat(8)}-${lowercaseHexGlob.repeat(4)}`
  + `-7${lowercaseHexGlob.repeat(3)}-[89ab]${lowercaseHexGlob.repeat(3)}`
  + `-${lowercaseHexGlob.repeat(12)}`;

function uuidV7Expression(column: SQLiteColumn): SQL {
  return sql`length(${column}) = 36 and ${column} glob ${sql.raw(`'${uuidV7Glob}'`)}`;
}

function uuidV7Check(name: string, column: SQLiteColumn) {
  return check(name, uuidV7Expression(column));
}

function nullableUuidV7Check(name: string, column: SQLiteColumn) {
  return check(name, sql`${column} is null or (${uuidV7Expression(column)})`);
}

function decimalIdExpression(column: SQLiteColumn): SQL {
  return sql`length(${column}) between 1 and 32 and ${column} not glob '*[^0-9]*' and (${column} = '0' or substr(${column}, 1, 1) <> '0')`;
}

function timestampCheck(name: string, column: SQLiteColumn, nullable = false) {
  const valid = sql`
    length(${column}) = 24
    and ${column} glob
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  `;
  return check(name, nullable ? sql`${column} is null or (${valid})` : valid);
}

function hashCheck(name: string, column: SQLiteColumn, nullable = false) {
  const valid = sql`
    length(${column}) = 78
    and substr(${column}, 1, 14) = 'sha256-jcs-v1:'
    and substr(${column}, 15) not glob '*[^0-9a-f]*'
  `;
  return check(name, nullable ? sql`${column} is null or (${valid})` : valid);
}

function jsonCheck(name: string, column: SQLiteColumn, nullable = false) {
  return check(name, nullable
    ? sql`${column} is null or json_valid(${column})`
    : sql`json_valid(${column})`);
}

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique("projects_slug_unique"),
  repositoryUrl: text("repository_url").notNull(),
  repositoryStorePath: text("repository_store_path").notNull().unique("projects_repository_store_path_unique"),
  defaultBranch: text("default_branch").notNull(),
  automaticFetchPolicy: text("automatic_fetch_policy", { enum: automaticFetchPolicies })
    .notNull().default("manual"),
  state: text("state", { enum: projectStates }).notNull(),
  activeConfigRevisionId: text("active_config_revision_id").references(
    (): AnySQLiteColumn => projectConfigRevisions.id,
    { onDelete: "restrict", onUpdate: "no action" }
  ),
  primaryWorkspaceId: text("primary_workspace_id").references(
    (): AnySQLiteColumn => workspaces.id,
    { onDelete: "restrict", onUpdate: "no action" }
  ),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  archivedAt: text("archived_at"),
  rowVersion: integer("row_version").notNull().default(1)
}, (table) => [
  // These pointers are staged and cross-owner matching remains a future Web transaction invariant.
  index("projects_active_config_revision_id_idx").on(table.activeConfigRevisionId),
  index("projects_primary_workspace_id_idx").on(table.primaryWorkspaceId),
  uuidV7Check("projects_id_uuid_v7_check", table.id),
  nullableUuidV7Check("projects_active_config_revision_id_uuid_v7_check", table.activeConfigRevisionId),
  nullableUuidV7Check("projects_primary_workspace_id_uuid_v7_check", table.primaryWorkspaceId),
  enumCheck("projects_automatic_fetch_policy_check", table.automaticFetchPolicy, automaticFetchPolicies),
  enumCheck("projects_state_check", table.state, projectStates),
  timestampCheck("projects_created_at_timestamp_check", table.createdAt),
  timestampCheck("projects_updated_at_timestamp_check", table.updatedAt),
  timestampCheck("projects_archived_at_timestamp_check", table.archivedAt, true),
  check("projects_row_version_check", sql`${table.rowVersion} >= 0`)
]);

export const projectConfigRevisions = sqliteTable("project_config_revisions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references((): AnySQLiteColumn => projects.id, {
    onDelete: "cascade",
    onUpdate: "no action"
  }),
  revisionNumber: integer("revision_number").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  configurationJson: text("configuration_json").notNull(),
  configurationHash: text("configuration_hash").notNull(),
  compiledRuntimePlanJson: text("compiled_runtime_plan_json"),
  runtimePlanHash: text("runtime_plan_hash"),
  source: text("source", { enum: configurationRevisionSources }).notNull(),
  state: text("state", { enum: configurationRevisionStates }).notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  activatedAt: text("activated_at"),
  supersededAt: text("superseded_at")
}, (table) => [
  unique("project_config_revisions_project_revision_unique").on(table.projectId, table.revisionNumber),
  uniqueIndex("project_config_revisions_one_active_per_project")
    .on(table.projectId)
    .where(sql`${table.state} = 'active'`),
  index("project_config_revisions_project_id_idx").on(table.projectId),
  uuidV7Check("project_config_revisions_id_uuid_v7_check", table.id),
  uuidV7Check("project_config_revisions_project_id_uuid_v7_check", table.projectId),
  check("project_config_revisions_revision_number_check", sql`${table.revisionNumber} >= 1`),
  check("project_config_revisions_schema_version_check", sql`${table.schemaVersion} >= 1`),
  jsonCheck("project_config_revisions_configuration_json_check", table.configurationJson),
  hashCheck("project_config_revisions_configuration_hash_check", table.configurationHash),
  jsonCheck("project_config_revisions_compiled_runtime_plan_json_check", table.compiledRuntimePlanJson, true),
  hashCheck("project_config_revisions_runtime_plan_hash_check", table.runtimePlanHash, true),
  check("project_config_revisions_runtime_plan_pair_check", sql`
    (${table.compiledRuntimePlanJson} is null and ${table.runtimePlanHash} is null)
    or (${table.compiledRuntimePlanJson} is not null and ${table.runtimePlanHash} is not null)
  `),
  enumCheck("project_config_revisions_source_check", table.source, configurationRevisionSources),
  enumCheck("project_config_revisions_state_check", table.state, configurationRevisionStates),
  timestampCheck("project_config_revisions_created_at_timestamp_check", table.createdAt),
  timestampCheck("project_config_revisions_activated_at_timestamp_check", table.activatedAt, true),
  timestampCheck("project_config_revisions_superseded_at_timestamp_check", table.supersededAt, true)
]);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references((): AnySQLiteColumn => projects.id, {
    onDelete: "cascade",
    onUpdate: "no action"
  }),
  configRevisionId: text("config_revision_id").notNull().references(() => projectConfigRevisions.id, {
    onDelete: "restrict",
    onUpdate: "no action"
  }),
  kind: text("kind", { enum: workspaceKinds }).notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  branchName: text("branch_name").notNull(),
  baseRef: text("base_ref").notNull(),
  worktreePath: text("worktree_path").notNull().unique("workspaces_worktree_path_unique"),
  desiredState: text("desired_state", { enum: workspaceDesiredStates }).notNull(),
  observedState: text("observed_state", { enum: workspaceObservedStates }).notNull(),
  dirtyState: text("dirty_state", { enum: workspaceDirtyStates }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  archivedAt: text("archived_at"),
  removedAt: text("removed_at"),
  rowVersion: integer("row_version").notNull().default(1)
}, (table) => [
  uniqueIndex("workspaces_one_non_removed_primary_per_project")
    .on(table.projectId)
    .where(sql`${table.kind} = 'primary' and ${table.desiredState} <> 'removed'`),
  index("workspaces_project_id_idx").on(table.projectId),
  index("workspaces_config_revision_id_idx").on(table.configRevisionId),
  uuidV7Check("workspaces_id_uuid_v7_check", table.id),
  uuidV7Check("workspaces_project_id_uuid_v7_check", table.projectId),
  uuidV7Check("workspaces_config_revision_id_uuid_v7_check", table.configRevisionId),
  enumCheck("workspaces_kind_check", table.kind, workspaceKinds),
  enumCheck("workspaces_desired_state_check", table.desiredState, workspaceDesiredStates),
  enumCheck("workspaces_observed_state_check", table.observedState, workspaceObservedStates),
  enumCheck("workspaces_dirty_state_check", table.dirtyState, workspaceDirtyStates),
  timestampCheck("workspaces_created_at_timestamp_check", table.createdAt),
  timestampCheck("workspaces_updated_at_timestamp_check", table.updatedAt),
  timestampCheck("workspaces_archived_at_timestamp_check", table.archivedAt, true),
  timestampCheck("workspaces_removed_at_timestamp_check", table.removedAt, true),
  check("workspaces_row_version_check", sql`${table.rowVersion} >= 0`)
]);

export const runtimeStacks = sqliteTable("runtime_stacks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().unique("runtime_stacks_workspace_id_unique")
    .references(() => workspaces.id, { onDelete: "cascade", onUpdate: "no action" }),
  runtimeNamespace: text("runtime_namespace").notNull().unique("runtime_stacks_runtime_namespace_unique"),
  runtimePlanHash: text("runtime_plan_hash").notNull(),
  desiredState: text("desired_state", { enum: runtimeStackDesiredStates }).notNull(),
  observedState: text("observed_state", { enum: runtimeStackObservedStates }).notNull(),
  runtimeGeneration: integer("runtime_generation").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastObservedAt: text("last_observed_at"),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message")
}, (table) => [
  uuidV7Check("runtime_stacks_id_uuid_v7_check", table.id),
  uuidV7Check("runtime_stacks_workspace_id_uuid_v7_check", table.workspaceId),
  hashCheck("runtime_stacks_runtime_plan_hash_check", table.runtimePlanHash),
  enumCheck("runtime_stacks_desired_state_check", table.desiredState, runtimeStackDesiredStates),
  enumCheck("runtime_stacks_observed_state_check", table.observedState, runtimeStackObservedStates),
  check("runtime_stacks_runtime_generation_check", sql`${table.runtimeGeneration} >= 0`),
  timestampCheck("runtime_stacks_created_at_timestamp_check", table.createdAt),
  timestampCheck("runtime_stacks_updated_at_timestamp_check", table.updatedAt),
  timestampCheck("runtime_stacks_last_observed_at_timestamp_check", table.lastObservedAt, true)
]);

export const workspaceServices = sqliteTable("workspace_services", {
  id: text("id").primaryKey(),
  runtimeStackId: text("runtime_stack_id").notNull().references(() => runtimeStacks.id, {
    onDelete: "cascade",
    onUpdate: "no action"
  }),
  serviceKey: text("service_key").notNull(),
  kind: text("kind", { enum: workspaceServiceKinds }).notNull(),
  containerId: text("container_id"),
  imageReference: text("image_reference").notNull(),
  imageDigest: text("image_digest"),
  desiredState: text("desired_state", { enum: workspaceServiceDesiredStates }).notNull(),
  observedState: text("observed_state", { enum: workspaceServiceObservedStates }).notNull(),
  healthState: text("health_state", { enum: workspaceServiceHealthStates }).notNull(),
  startedAt: text("started_at"),
  stoppedAt: text("stopped_at"),
  lastObservedAt: text("last_observed_at")
}, (table) => [
  unique("workspace_services_stack_service_key_unique").on(table.runtimeStackId, table.serviceKey),
  uuidV7Check("workspace_services_id_uuid_v7_check", table.id),
  uuidV7Check("workspace_services_runtime_stack_id_uuid_v7_check", table.runtimeStackId),
  enumCheck("workspace_services_kind_check", table.kind, workspaceServiceKinds),
  enumCheck("workspace_services_desired_state_check", table.desiredState, workspaceServiceDesiredStates),
  enumCheck("workspace_services_observed_state_check", table.observedState, workspaceServiceObservedStates),
  enumCheck("workspace_services_health_state_check", table.healthState, workspaceServiceHealthStates),
  timestampCheck("workspace_services_started_at_timestamp_check", table.startedAt, true),
  timestampCheck("workspace_services_stopped_at_timestamp_check", table.stoppedAt, true),
  timestampCheck("workspace_services_last_observed_at_timestamp_check", table.lastObservedAt, true)
]);

export const processes = sqliteTable("processes", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, {
    onDelete: "cascade",
    onUpdate: "no action"
  }),
  serviceId: text("service_id").notNull().references(() => workspaceServices.id, {
    onDelete: "restrict",
    onUpdate: "no action"
  }),
  kind: text("kind", { enum: processKinds }).notNull(),
  definitionKey: text("definition_key"),
  desiredState: text("desired_state", { enum: processDesiredStates }).notNull(),
  observedState: text("observed_state", { enum: processObservedStates }).notNull(),
  exitCode: integer("exit_code"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  lastObservedAt: text("last_observed_at")
}, (table) => [
  index("processes_workspace_id_idx").on(table.workspaceId),
  index("processes_service_id_idx").on(table.serviceId),
  uuidV7Check("processes_id_uuid_v7_check", table.id),
  uuidV7Check("processes_workspace_id_uuid_v7_check", table.workspaceId),
  uuidV7Check("processes_service_id_uuid_v7_check", table.serviceId),
  enumCheck("processes_kind_check", table.kind, processKinds),
  enumCheck("processes_desired_state_check", table.desiredState, processDesiredStates),
  enumCheck("processes_observed_state_check", table.observedState, processObservedStates),
  timestampCheck("processes_started_at_timestamp_check", table.startedAt, true),
  timestampCheck("processes_finished_at_timestamp_check", table.finishedAt, true),
  timestampCheck("processes_last_observed_at_timestamp_check", table.lastObservedAt, true)
]);

export const terminalSessions = sqliteTable("terminal_sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, {
    onDelete: "cascade",
    onUpdate: "no action"
  }),
  processId: text("process_id").notNull().unique("terminal_sessions_process_id_unique")
    .references(() => processes.id, { onDelete: "restrict", onUpdate: "no action" }),
  title: text("title").notNull(),
  shellProfileKey: text("shell_profile_key").notNull(),
  state: text("state", { enum: terminalStates }).notNull(),
  createdAt: text("created_at").notNull(),
  lastActivityAt: text("last_activity_at"),
  closedAt: text("closed_at")
}, (table) => [
  index("terminal_sessions_workspace_id_idx").on(table.workspaceId),
  uuidV7Check("terminal_sessions_id_uuid_v7_check", table.id),
  uuidV7Check("terminal_sessions_workspace_id_uuid_v7_check", table.workspaceId),
  uuidV7Check("terminal_sessions_process_id_uuid_v7_check", table.processId),
  enumCheck("terminal_sessions_state_check", table.state, terminalStates),
  timestampCheck("terminal_sessions_created_at_timestamp_check", table.createdAt),
  timestampCheck("terminal_sessions_last_activity_at_timestamp_check", table.lastActivityAt, true),
  timestampCheck("terminal_sessions_closed_at_timestamp_check", table.closedAt, true)
]);

export const previews = sqliteTable("previews", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, {
    onDelete: "cascade",
    onUpdate: "no action"
  }),
  configRevisionId: text("config_revision_id").notNull().references(() => projectConfigRevisions.id, {
    onDelete: "restrict",
    onUpdate: "no action"
  }),
  serviceId: text("service_id").references(() => workspaceServices.id, {
    onDelete: "restrict",
    onUpdate: "no action"
  }),
  previewKey: text("preview_key").notNull(),
  displayName: text("display_name").notNull(),
  targetKind: text("target_kind", { enum: previewTargetKinds }).notNull(),
  targetKey: text("target_key").notNull(),
  domainBaseId: text("domain_base_id").notNull(),
  hostnamePattern: text("hostname_pattern").notNull(),
  hostname: text("hostname").notNull().unique("previews_hostname_unique"),
  containerPort: integer("container_port").notNull(),
  protocol: text("protocol", { enum: previewProtocols }).notNull(),
  healthPath: text("health_path").notNull(),
  healthStatusesJson: text("health_statuses_json").notNull(),
  startupTimeoutSeconds: integer("startup_timeout_seconds").notNull(),
  webSocketForwarding: integer("web_socket_forwarding", { mode: "boolean" }).notNull(),
  desiredState: text("desired_state", { enum: previewDesiredStates }).notNull(),
  observedState: text("observed_state", { enum: previewObservedStates }).notNull(),
  routePresent: integer("route_present", { mode: "boolean" }).notNull().default(false),
  routeRevision: integer("route_revision"),
  runtimeGeneration: integer("runtime_generation"),
  lastObservationJson: text("last_observation_json"),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  operationId: text("operation_id").references(() => operations.operationId, {
    onDelete: "set null",
    onUpdate: "no action"
  }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  activatedAt: text("activated_at"),
  deactivatedAt: text("deactivated_at")
}, (table) => [
  unique("previews_workspace_preview_key_unique").on(table.workspaceId, table.previewKey),
  index("previews_config_revision_id_idx").on(table.configRevisionId),
  index("previews_service_id_idx").on(table.serviceId),
  index("previews_operation_id_idx").on(table.operationId),
  uuidV7Check("previews_id_uuid_v7_check", table.id),
  uuidV7Check("previews_workspace_id_uuid_v7_check", table.workspaceId),
  uuidV7Check("previews_config_revision_id_uuid_v7_check", table.configRevisionId),
  nullableUuidV7Check("previews_service_id_uuid_v7_check", table.serviceId),
  nullableUuidV7Check("previews_operation_id_uuid_v7_check", table.operationId),
  enumCheck("previews_target_kind_check", table.targetKind, previewTargetKinds),
  check("previews_target_key_check", sql`length(${table.targetKey}) between 1 and 64`),
  check("previews_domain_base_id_check", sql`length(${table.domainBaseId}) between 1 and 64`),
  check("previews_hostname_pattern_check", sql`length(${table.hostnamePattern}) between 1 and 253`),
  check("previews_hostname_check", sql`
    length(${table.hostname}) between 1 and 253
    and ${table.hostname} not glob '*[^a-z0-9.-]*'
    and ${table.hostname} not like '.%'
    and ${table.hostname} not like '%.'
    and ${table.hostname} not like '%..%'
  `),
  check("previews_container_port_check", sql`${table.containerPort} between 1 and 65535`),
  enumCheck("previews_protocol_check", table.protocol, previewProtocols),
  check("previews_health_path_check", sql`length(${table.healthPath}) between 1 and 2048 and substr(${table.healthPath}, 1, 1) = '/'`),
  check("previews_health_statuses_json_check", sql`length(${table.healthStatusesJson}) between 2 and 1024 and json_valid(${table.healthStatusesJson})`),
  check("previews_startup_timeout_seconds_check", sql`${table.startupTimeoutSeconds} between 1 and 3600`),
  enumCheck("previews_desired_state_check", table.desiredState, previewDesiredStates),
  enumCheck("previews_observed_state_check", table.observedState, previewObservedStates),
  check("previews_route_present_check", sql`${table.routePresent} in (0, 1)`),
  check("previews_route_revision_check", sql`${table.routeRevision} is null or ${table.routeRevision} >= 0`),
  check("previews_runtime_generation_check", sql`${table.runtimeGeneration} is null or ${table.runtimeGeneration} >= 0`),
  jsonCheck("previews_last_observation_json_check", table.lastObservationJson, true),
  timestampCheck("previews_created_at_timestamp_check", table.createdAt),
  timestampCheck("previews_updated_at_timestamp_check", table.updatedAt),
  timestampCheck("previews_activated_at_timestamp_check", table.activatedAt, true),
  timestampCheck("previews_deactivated_at_timestamp_check", table.deactivatedAt, true)
]);

export const portLeases = sqliteTable("port_leases", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, {
    onDelete: "cascade",
    onUpdate: "no action"
  }),
  previewId: text("preview_id").references(() => previews.id, {
    onDelete: "set null",
    onUpdate: "no action"
  }),
  port: integer("port").notNull(),
  bindAddress: text("bind_address").notNull(),
  runtimeGeneration: integer("runtime_generation"),
  state: text("state", { enum: portLeaseStates }).notNull(),
  leaseToken: text("lease_token").notNull().unique("port_leases_lease_token_unique"),
  createdAt: text("created_at").notNull(),
  activatedAt: text("activated_at"),
  releasedAt: text("released_at"),
  expiresAt: text("expires_at").notNull()
}, (table) => [
  uniqueIndex("port_leases_one_live_address_port")
    .on(table.bindAddress, table.port)
    .where(sql`${table.state} in ('reserved', 'active')`),
  index("port_leases_workspace_id_idx").on(table.workspaceId),
  index("port_leases_preview_id_idx").on(table.previewId),
  uuidV7Check("port_leases_id_uuid_v7_check", table.id),
  uuidV7Check("port_leases_workspace_id_uuid_v7_check", table.workspaceId),
  nullableUuidV7Check("port_leases_preview_id_uuid_v7_check", table.previewId),
  check("port_leases_port_check", sql`${table.port} between 1 and 65535`),
  check("port_leases_bind_address_check", sql`${table.bindAddress} in ('127.0.0.1', '::1')`),
  check("port_leases_runtime_generation_check", sql`${table.runtimeGeneration} is null or ${table.runtimeGeneration} >= 0`),
  enumCheck("port_leases_state_check", table.state, portLeaseStates),
  timestampCheck("port_leases_created_at_timestamp_check", table.createdAt),
  timestampCheck("port_leases_activated_at_timestamp_check", table.activatedAt, true),
  timestampCheck("port_leases_released_at_timestamp_check", table.releasedAt, true),
  timestampCheck("port_leases_expires_at_timestamp_check", table.expiresAt)
]);

export const aiSessions = sqliteTable("ai_sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, {
    onDelete: "cascade",
    onUpdate: "no action"
  }),
  terminalSessionId: text("terminal_session_id").references(() => terminalSessions.id, {
    onDelete: "set null",
    onUpdate: "no action"
  }),
  processId: text("process_id").references(() => processes.id, {
    onDelete: "set null",
    onUpdate: "no action"
  }),
  providerKey: text("provider_key").notNull(),
  profileKey: text("profile_key").notNull(),
  profileRevision: text("profile_revision").notNull().default(`sha256-ai-profile-v1:${"0".repeat(64)}`),
  revisionId: text("revision_id").notNull().references(() => projectConfigRevisions.id, { onDelete: "restrict", onUpdate: "no action" }),
  runtimePlanHash: text("runtime_plan_hash").notNull(),
  runtimeGeneration: integer("runtime_generation").notNull(),
  processGeneration: integer("process_generation").notNull(),
  lastSequence: integer("last_sequence").notNull().default(0),
  historyStartSequence: integer("history_start_sequence").notNull().default(1),
  historyTruncated: integer("history_truncated", { mode: "boolean" }).notNull().default(false),
  interactionHistoryTruncated: integer("interaction_history_truncated", { mode: "boolean" }).notNull().default(false),
  failureCode: text("failure_code"),
  failureJson: text("failure_json"),
  externalSessionId: text("external_session_id"),
  title: text("title").notNull(),
  state: text("state", { enum: aiSessionStates }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastActivityAt: text("last_activity_at"),
  stoppedAt: text("stopped_at")
}, (table) => [
  index("ai_sessions_workspace_id_idx").on(table.workspaceId),
  index("ai_sessions_terminal_session_id_idx").on(table.terminalSessionId),
  index("ai_sessions_process_id_idx").on(table.processId),
  index("ai_sessions_revision_id_idx").on(table.revisionId),
  uuidV7Check("ai_sessions_id_uuid_v7_check", table.id),
  uuidV7Check("ai_sessions_workspace_id_uuid_v7_check", table.workspaceId),
  nullableUuidV7Check("ai_sessions_terminal_session_id_uuid_v7_check", table.terminalSessionId),
  nullableUuidV7Check("ai_sessions_process_id_uuid_v7_check", table.processId),
  uuidV7Check("ai_sessions_revision_id_uuid_v7_check", table.revisionId),
  check("ai_sessions_runtime_generation_check", sql`${table.runtimeGeneration} >= 1`),
  check("ai_sessions_process_generation_check", sql`${table.processGeneration} >= 1`),
  check("ai_sessions_last_sequence_check", sql`${table.lastSequence} >= 0`),
  check("ai_sessions_profile_revision_check", sql`${table.profileRevision} glob 'sha256-ai-profile-v1:*'`),
  check("ai_sessions_runtime_plan_hash_check", sql`${table.runtimePlanHash} glob 'sha256-jcs-v1:*'`),
  jsonCheck("ai_sessions_failure_json_check", table.failureJson, true),
  enumCheck("ai_sessions_state_check", table.state, aiSessionStates),
  timestampCheck("ai_sessions_created_at_timestamp_check", table.createdAt),
  timestampCheck("ai_sessions_updated_at_timestamp_check", table.updatedAt),
  timestampCheck("ai_sessions_last_activity_at_timestamp_check", table.lastActivityAt, true),
  timestampCheck("ai_sessions_stopped_at_timestamp_check", table.stoppedAt, true)
]);

export const aiTurns = sqliteTable("ai_turns", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => aiSessions.id, { onDelete: "cascade", onUpdate: "no action" }),
  state: text("state", { enum: aiTurnStates }).notNull(),
  contentJson: text("content_json").notNull(),
  outputText: text("output_text").notNull().default(""),
  outputTruncated: integer("output_truncated", { mode: "boolean" }).notNull().default(false),
  changedFilesJson: text("changed_files_json").notNull().default('{"files":[],"truncated":false}'),
  failureJson: text("failure_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at")
}, (table) => [
  index("ai_turns_session_id_idx").on(table.sessionId),
  uuidV7Check("ai_turns_id_uuid_v7_check", table.id),
  uuidV7Check("ai_turns_session_id_uuid_v7_check", table.sessionId),
  enumCheck("ai_turns_state_check", table.state, aiTurnStates),
  jsonCheck("ai_turns_content_json_check", table.contentJson),
  jsonCheck("ai_turns_changed_files_json_check", table.changedFilesJson),
  jsonCheck("ai_turns_failure_json_check", table.failureJson, true),
  timestampCheck("ai_turns_created_at_timestamp_check", table.createdAt),
  timestampCheck("ai_turns_updated_at_timestamp_check", table.updatedAt),
  timestampCheck("ai_turns_completed_at_timestamp_check", table.completedAt, true)
]);

export const aiEvents = sqliteTable("ai_events", {
  eventId: text("event_id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => aiSessions.id, { onDelete: "cascade", onUpdate: "no action" }),
  turnId: text("turn_id").references(() => aiTurns.id, { onDelete: "set null", onUpdate: "no action" }),
  sequence: integer("sequence").notNull(),
  eventType: text("event_type").notNull(),
  eventJson: text("event_json").notNull(),
  observedAt: text("observed_at").notNull()
}, (table) => [
  unique("ai_events_session_sequence_unique").on(table.sessionId, table.sequence),
  index("ai_events_session_sequence_idx").on(table.sessionId, table.sequence),
  uuidV7Check("ai_events_event_id_uuid_v7_check", table.eventId),
  uuidV7Check("ai_events_session_id_uuid_v7_check", table.sessionId),
  nullableUuidV7Check("ai_events_turn_id_uuid_v7_check", table.turnId),
  check("ai_events_sequence_check", sql`${table.sequence} >= 1`),
  jsonCheck("ai_events_event_json_check", table.eventJson),
  timestampCheck("ai_events_observed_at_timestamp_check", table.observedAt)
]);

export const aiInteractionRequests = sqliteTable("ai_interaction_requests", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => aiSessions.id, { onDelete: "cascade", onUpdate: "no action" }),
  turnId: text("turn_id").references(() => aiTurns.id, { onDelete: "set null", onUpdate: "no action" }),
  kind: text("kind").notNull(),
  state: text("state", { enum: aiInteractionRequestStates }).notNull(),
  requestJson: text("request_json").notNull(),
  responseJson: text("response_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  index("ai_interaction_requests_session_id_idx").on(table.sessionId),
  uuidV7Check("ai_interaction_requests_id_uuid_v7_check", table.id),
  uuidV7Check("ai_interaction_requests_session_id_uuid_v7_check", table.sessionId),
  nullableUuidV7Check("ai_interaction_requests_turn_id_uuid_v7_check", table.turnId),
  enumCheck("ai_interaction_requests_state_check", table.state, aiInteractionRequestStates),
  jsonCheck("ai_interaction_requests_request_json_check", table.requestJson),
  jsonCheck("ai_interaction_requests_response_json_check", table.responseJson, true),
  timestampCheck("ai_interaction_requests_created_at_timestamp_check", table.createdAt),
  timestampCheck("ai_interaction_requests_updated_at_timestamp_check", table.updatedAt)
]);

export const aiProviderResumeMetadata = sqliteTable("ai_provider_resume_metadata", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => aiSessions.id, { onDelete: "cascade", onUpdate: "no action" }),
  profileRevision: text("profile_revision").notNull(),
  runtimeGeneration: integer("runtime_generation").notNull(),
  processGeneration: integer("process_generation").notNull(),
  stateJson: text("state_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  uniqueIndex("ai_provider_resume_metadata_session_unique").on(table.sessionId),
  uuidV7Check("ai_provider_resume_metadata_id_uuid_v7_check", table.id),
  uuidV7Check("ai_provider_resume_metadata_session_id_uuid_v7_check", table.sessionId),
  check("ai_provider_resume_metadata_runtime_generation_check", sql`${table.runtimeGeneration} >= 1`),
  check("ai_provider_resume_metadata_process_generation_check", sql`${table.processGeneration} >= 1`),
  check("ai_provider_resume_metadata_profile_revision_check", sql`${table.profileRevision} glob 'sha256-ai-profile-v1:*'`),
  jsonCheck("ai_provider_resume_metadata_state_json_check", table.stateJson),
  timestampCheck("ai_provider_resume_metadata_created_at_timestamp_check", table.createdAt),
  timestampCheck("ai_provider_resume_metadata_updated_at_timestamp_check", table.updatedAt)
]);

export const taskRuns = sqliteTable("task_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, {
    onDelete: "cascade",
    onUpdate: "no action"
  }),
  taskKey: text("task_key").notNull(),
  processId: text("process_id").references(() => processes.id, {
    onDelete: "set null",
    onUpdate: "no action"
  }),
  configRevisionId: text("config_revision_id").notNull().references(() => projectConfigRevisions.id, {
    onDelete: "restrict",
    onUpdate: "no action"
  }),
  state: text("state", { enum: taskRunStates }).notNull(),
  exitCode: integer("exit_code"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  summaryJson: text("summary_json")
}, (table) => [
  index("task_runs_workspace_id_idx").on(table.workspaceId),
  index("task_runs_process_id_idx").on(table.processId),
  index("task_runs_config_revision_id_idx").on(table.configRevisionId),
  uuidV7Check("task_runs_id_uuid_v7_check", table.id),
  uuidV7Check("task_runs_workspace_id_uuid_v7_check", table.workspaceId),
  nullableUuidV7Check("task_runs_process_id_uuid_v7_check", table.processId),
  uuidV7Check("task_runs_config_revision_id_uuid_v7_check", table.configRevisionId),
  enumCheck("task_runs_state_check", table.state, taskRunStates),
  timestampCheck("task_runs_started_at_timestamp_check", table.startedAt, true),
  timestampCheck("task_runs_finished_at_timestamp_check", table.finishedAt, true),
  jsonCheck("task_runs_summary_json_check", table.summaryJson, true)
]);

export const operations = sqliteTable("operations", {
  operationId: text("operation_id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, {
    onDelete: "cascade",
    onUpdate: "no action"
  }),
  workspaceId: text("workspace_id").references(() => workspaces.id, {
    onDelete: "set null",
    onUpdate: "no action"
  }),
  actor: text("actor").notNull(),
  operationName: text("operation_name").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  state: text("state", { enum: operationStates }).notNull(),
  progressJson: text("progress_json"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at")
}, (table) => [
  index("operations_project_id_idx").on(table.projectId),
  index("operations_workspace_id_idx").on(table.workspaceId),
  uuidV7Check("operations_operation_id_uuid_v7_check", table.operationId),
  uuidV7Check("operations_project_id_uuid_v7_check", table.projectId),
  nullableUuidV7Check("operations_workspace_id_uuid_v7_check", table.workspaceId),
  uuidV7Check("operations_resource_id_uuid_v7_check", table.resourceId),
  enumCheck("operations_state_check", table.state, operationStates),
  jsonCheck("operations_progress_json_check", table.progressJson, true),
  timestampCheck("operations_created_at_timestamp_check", table.createdAt),
  timestampCheck("operations_started_at_timestamp_check", table.startedAt, true),
  timestampCheck("operations_finished_at_timestamp_check", table.finishedAt, true)
]);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  sequence: integer("sequence").notNull().unique("audit_events_sequence_unique"),
  actor: text("actor").notNull(),
  eventType: text("event_type").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  operationId: text("operation_id").references(() => operations.operationId, {
    onDelete: "set null",
    onUpdate: "no action"
  }),
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("audit_events_operation_id_idx").on(table.operationId),
  uuidV7Check("audit_events_id_uuid_v7_check", table.id),
  uuidV7Check("audit_events_resource_id_uuid_v7_check", table.resourceId),
  nullableUuidV7Check("audit_events_operation_id_uuid_v7_check", table.operationId),
  check("audit_events_sequence_check", sql`${table.sequence} >= 0`),
  jsonCheck("audit_events_metadata_json_check", table.metadataJson),
  timestampCheck("audit_events_created_at_timestamp_check", table.createdAt)
]);

export const githubConnectionAttempts = sqliteTable("github_connection_attempts", {
  connectionId: text("connection_id").primaryKey(),
  stateHash: text("state_hash").notNull().unique("github_connection_attempts_state_hash_unique"),
  status: text("status", { enum: githubConnectionAttemptStates }).notNull(),
  expiresAt: text("expires_at").notNull(),
  claimedInstallationId: text("claimed_installation_id"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  failureClassification: text("failure_classification"),
  rowVersion: integer("row_version").notNull().default(1)
}, (table) => [
  uuidV7Check("github_connection_attempts_connection_id_uuid_v7_check", table.connectionId),
  check("github_connection_attempts_state_hash_check", sql`length(${table.stateHash}) = 64 and ${table.stateHash} not glob '*[^0-9a-f]*'`),
  enumCheck("github_connection_attempts_status_check", table.status, githubConnectionAttemptStates),
  timestampCheck("github_connection_attempts_expires_at_timestamp_check", table.expiresAt),
  timestampCheck("github_connection_attempts_created_at_timestamp_check", table.createdAt),
  timestampCheck("github_connection_attempts_updated_at_timestamp_check", table.updatedAt),
  check("github_connection_attempts_claimed_installation_id_check", sql`${table.claimedInstallationId} is null or (${decimalIdExpression(table.claimedInstallationId)})`),
  check("github_connection_attempts_row_version_check", sql`${table.rowVersion} >= 1`)
]);

export const githubConnections = sqliteTable("github_connections", {
  connectionId: text("connection_id").primaryKey(),
  installationId: text("installation_id").notNull(),
  accountId: text("account_id").notNull(),
  accountType: text("account_type", { enum: ["User", "Organization"] }).notNull(),
  accountLogin: text("account_login").notNull(),
  repositorySelection: text("repository_selection", { enum: ["all", "selected"] }).notNull(),
  permissionsJson: text("permissions_json").notNull(),
  status: text("status", { enum: githubConnectionStates }).notNull(),
  verifiedAt: text("verified_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  rowVersion: integer("row_version").notNull().default(1)
}, (table) => [
  uuidV7Check("github_connections_connection_id_uuid_v7_check", table.connectionId),
  unique("github_connections_installation_id_unique").on(table.installationId),
  check("github_connections_installation_id_check", decimalIdExpression(table.installationId)),
  check("github_connections_account_id_check", decimalIdExpression(table.accountId)),
  enumCheck("github_connections_account_type_check", table.accountType, ["User", "Organization"]),
  enumCheck("github_connections_repository_selection_check", table.repositorySelection, ["all", "selected"]),
  jsonCheck("github_connections_permissions_json_check", table.permissionsJson),
  enumCheck("github_connections_status_check", table.status, githubConnectionStates),
  timestampCheck("github_connections_verified_at_timestamp_check", table.verifiedAt),
  timestampCheck("github_connections_created_at_timestamp_check", table.createdAt),
  timestampCheck("github_connections_updated_at_timestamp_check", table.updatedAt),
  check("github_connections_row_version_check", sql`${table.rowVersion} >= 1`)
]);

export const schema = {
  projects,
  projectConfigRevisions,
  workspaces,
  runtimeStacks,
  workspaceServices,
  processes,
  terminalSessions,
  previews,
  portLeases,
  aiSessions,
  aiTurns,
  aiEvents,
  aiInteractionRequests,
  aiProviderResumeMetadata,
  taskRuns,
  operations,
  auditEvents,
  githubConnectionAttempts,
  githubConnections
} as const;

export const applicationTableNames = [
  "projects",
  "project_config_revisions",
  "workspaces",
  "runtime_stacks",
  "workspace_services",
  "processes",
  "terminal_sessions",
  "previews",
  "port_leases",
  "ai_sessions",
  "ai_turns",
  "ai_events",
  "ai_interaction_requests",
  "ai_provider_resume_metadata",
  "task_runs",
  "operations",
  "audit_events",
  "github_connection_attempts",
  "github_connections"
] as const;

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectConfigRevision = typeof projectConfigRevisions.$inferSelect;
export type NewProjectConfigRevision = typeof projectConfigRevisions.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type RuntimeStack = typeof runtimeStacks.$inferSelect;
export type NewRuntimeStack = typeof runtimeStacks.$inferInsert;
export type WorkspaceService = typeof workspaceServices.$inferSelect;
export type NewWorkspaceService = typeof workspaceServices.$inferInsert;
export type Process = typeof processes.$inferSelect;
export type NewProcess = typeof processes.$inferInsert;
export type TerminalSession = typeof terminalSessions.$inferSelect;
export type NewTerminalSession = typeof terminalSessions.$inferInsert;
export type Preview = typeof previews.$inferSelect;
export type NewPreview = typeof previews.$inferInsert;
export type PortLease = typeof portLeases.$inferSelect;
export type NewPortLease = typeof portLeases.$inferInsert;
export type AiSession = typeof aiSessions.$inferSelect;
export type NewAiSession = typeof aiSessions.$inferInsert;
export type AiTurn = typeof aiTurns.$inferSelect;
export type NewAiTurn = typeof aiTurns.$inferInsert;
export type AiEvent = typeof aiEvents.$inferSelect;
export type NewAiEvent = typeof aiEvents.$inferInsert;
export type AiInteractionRequest = typeof aiInteractionRequests.$inferSelect;
export type NewAiInteractionRequest = typeof aiInteractionRequests.$inferInsert;
export type TaskRun = typeof taskRuns.$inferSelect;
export type NewTaskRun = typeof taskRuns.$inferInsert;
export type Operation = typeof operations.$inferSelect;
export type NewOperation = typeof operations.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type GithubConnectionAttempt = typeof githubConnectionAttempts.$inferSelect;
export type GithubConnection = typeof githubConnections.$inferSelect;
