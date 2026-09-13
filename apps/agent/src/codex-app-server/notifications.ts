export type CodexNotificationCategory =
  | "projected-and-handled"
  | "private-lifecycle"
  | "validated-and-ignored";
export type CodexNotificationClassification = CodexNotificationCategory | "unknown-non-blocking";

const projectedAndHandled = [
  "item/agentMessage/delta",
  "item/started",
  "serverRequest/resolved"
] as const;

const privateLifecycle = [
  "error",
  "turn/started",
  "turn/completed"
] as const;

const validatedAndIgnored = [
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/deleted",
  "thread/unarchived",
  "thread/closed",
  "skills/changed",
  "thread/name/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/settings/updated",
  "thread/tokenUsage/updated",
  "hook/started",
  "hook/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "item/completed",
  "item/plan/delta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "process/exited",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "app/list/updated",
  "remoteControl/status/changed",
  "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed",
  "fs/changed",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "thread/compacted",
  "model/rerouted",
  "model/verification",
  "turn/moderationMetadata",
  "model/safetyBuffering/updated",
  "warning",
  "guardianWarning",
  "deprecationNotice",
  "configWarning",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  "account/login/completed",
  // These notifications were added after the 0.145 baseline. They are
  // explicitly non-blocking and carry no semantics that the adapter projects.
  "autoApprovalReview/strictReviewRequired",
  "mcpServer/event/stream/notification",
  "modelProvider/authRecoveryCompleted",
  "modelProvider/authRecoveryStarted",
  "project/changed",
  "thread/project/updated",
  "thread/queue/changed",
  "thread/realtime/item/completed",
  "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta",
  "thread/reverted"
] as const;

function categoryEntries(methods: readonly string[], category: CodexNotificationCategory): Array<readonly [string, CodexNotificationCategory]> {
  return methods.map((method) => [method, category] as const);
}

export const CODEX_NOTIFICATION_CATEGORY_REGISTRY: Readonly<Record<string, CodexNotificationCategory>> = Object.freeze(Object.fromEntries([
  ...categoryEntries(projectedAndHandled, "projected-and-handled"),
  ...categoryEntries(privateLifecycle, "private-lifecycle"),
  ...categoryEntries(validatedAndIgnored, "validated-and-ignored")
]));

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function validateCodexNotification(notification: Readonly<Record<string, unknown>>): CodexNotificationCategory | null {
  const method = notification.method;
  if (typeof method !== "string") return null;
  const category = CODEX_NOTIFICATION_CATEGORY_REGISTRY[method];
  if (category === undefined || Object.prototype.hasOwnProperty.call(notification, "id") || objectRecord(notification.params) === null) return null;
  return category;
}

export function classifyCodexNotification(notification: Readonly<Record<string, unknown>>): CodexNotificationClassification | null {
  const method = notification.method;
  const params = notification.params;
  if (typeof method !== "string" || params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const known = validateCodexNotification(notification);
  if (known !== null) return known;
  return CODEX_NOTIFICATION_CATEGORY_REGISTRY[method] === undefined ? "unknown-non-blocking" : null;
}
