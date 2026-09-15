import {
  AI_SESSION_OUTPUT_MAX_BYTES,
  AI_TURN_ACTIVITY_HISTORY_MAX_BYTES,
  AI_TURN_ACTIVITY_HISTORY_MAX_ROWS,
  AI_TURN_OUTPUT_MAX_BYTES,
  truncateUtf8,
  utf8ByteLength
} from "../ai-bounds.js";

export { AI_SESSION_OUTPUT_MAX_BYTES, AI_TURN_OUTPUT_MAX_BYTES } from "../ai-bounds.js";

export type BrowserAiTurn = {
  id: string;
  state: string;
  content: { kind: "text"; text: string };
  outputText: string;
  outputTruncated: boolean;
  activities: string[];
  activitiesTruncated?: boolean;
  changedFiles: { files: Array<{ path: string; change: string; oldPath: string | null }>; truncated: boolean };
  createdAt: string;
};

export type BrowserAiApprovalDecision = "approve-once" | "approve-for-session" | "deny" | "cancel";
export type BrowserAiInteractionState = "pending" | "responded" | "cancelled" | "expired" | "lost";
export type BrowserAiApprovalPresentation =
  | { kind: "command"; summary: string; commandText: string; workingDirectory: string | null; risk: string; redacted: true }
  | { kind: "file-change"; summary: string; paths: string[]; truncated: boolean; redacted: true };
export type BrowserAiInputQuestion = {
  questionId: string;
  header: string;
  question: string;
  responseKind: "single-select" | "text";
  allowOther: boolean;
  secret: false;
  options: Array<{ optionId: string; label: string; description: string }>;
};
export type BrowserAiInteraction = {
  id: string;
  turnId: string;
  kind: "approval" | "input";
  state: BrowserAiInteractionState;
  request: { requestId: string; presentation: BrowserAiApprovalPresentation } | { requestId: string; questions: BrowserAiInputQuestion[] } | null;
  response: { decision: BrowserAiApprovalDecision } | { answers: unknown[] } | null;
  createdAt: string;
  updatedAt: string;
};

type BrowserAiInteractionEvent = {
  eventType: string;
  turnId: string | null;
  observedAt?: string;
  payload: Record<string, unknown>;
};

const interactionStates = new Set<BrowserAiInteractionState>(["pending", "responded", "cancelled", "expired", "lost"]);
const approvalDecisions = new Set<BrowserAiApprovalDecision>(["approve-once", "approve-for-session", "deny", "cancel"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isApprovalPresentation(value: unknown): value is BrowserAiApprovalPresentation {
  if (!isRecord(value) || (value.kind !== "command" && value.kind !== "file-change") || value.redacted !== true
    || typeof value.summary !== "string") return false;
  if (value.kind === "command") {
    return typeof value.commandText === "string" && (typeof value.workingDirectory === "string" || value.workingDirectory === null)
      && typeof value.risk === "string";
  }
  return Array.isArray(value.paths) && value.paths.every((path) => typeof path === "string") && typeof value.truncated === "boolean";
}

function isInputQuestion(value: unknown): value is BrowserAiInputQuestion {
  if (!isRecord(value) || typeof value.questionId !== "string" || typeof value.header !== "string"
    || typeof value.question !== "string" || (value.responseKind !== "single-select" && value.responseKind !== "text")
    || (value.allowOther !== undefined && typeof value.allowOther !== "boolean")
    || value.secret !== false || !Array.isArray(value.options)) return false;
  return value.options.every((option) => isRecord(option) && typeof option.optionId === "string"
    && typeof option.label === "string" && typeof option.description === "string");
}

function isInteraction(value: unknown): value is BrowserAiInteraction {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.turnId !== "string"
    || (value.kind !== "approval" && value.kind !== "input") || typeof value.state !== "string"
    || !interactionStates.has(value.state as BrowserAiInteractionState) || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string") return false;
  if (value.request !== null) {
    if (!isRecord(value.request) || value.request.requestId !== value.id) return false;
    if (value.kind === "approval" && !isApprovalPresentation(value.request.presentation)) return false;
    if (value.kind === "input" && (!Array.isArray(value.request.questions) || !value.request.questions.every(isInputQuestion))) return false;
  }
  if (value.response !== null) {
    if (!isRecord(value.response)) return false;
    if (value.kind === "approval" && !approvalDecisions.has(value.response.decision as BrowserAiApprovalDecision)) return false;
    if (value.kind === "input" && !Array.isArray(value.response.answers)) return false;
  }
  return true;
}

function copyInteraction(interaction: BrowserAiInteraction): BrowserAiInteraction {
  return {
    ...interaction,
    request: interaction.request === null ? null : "presentation" in interaction.request
      ? { ...interaction.request, presentation: { ...interaction.request.presentation, ...(interaction.request.presentation.kind === "file-change" ? { paths: [...interaction.request.presentation.paths] } : {}) } }
      : { ...interaction.request, questions: interaction.request.questions.map((question) => ({ ...question,
        allowOther: question.allowOther === true, options: question.options.map((option) => ({ ...option })) })) },
    response: interaction.response === null ? null : "decision" in interaction.response
      ? { ...interaction.response } : { ...interaction.response, answers: [...interaction.response.answers] }
  };
}

export function projectAiInteractions(values: readonly unknown[]): BrowserAiInteraction[] {
  return values.filter(isInteraction).map(copyInteraction);
}

function interactionRequestFromEvent(event: BrowserAiInteractionEvent, requestId: string, kind: "approval" | "input"): BrowserAiInteraction["request"] | null {
  if (kind === "approval" && isApprovalPresentation(event.payload.presentation)) {
    return { requestId, presentation: event.payload.presentation };
  }
  if (kind === "input" && Array.isArray(event.payload.questions) && event.payload.questions.every(isInputQuestion)) {
    return { requestId, questions: event.payload.questions };
  }
  return null;
}

export function applyAiInteractionEvent(
  values: readonly BrowserAiInteraction[],
  event: BrowserAiInteractionEvent
): BrowserAiInteraction[] {
  const next = values.map(copyInteraction);
  const timestamp = event.observedAt ?? new Date().toISOString();
  const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : null;
  const requestedKind = event.eventType === "turn.approval.requested" ? "approval" : event.eventType === "turn.input.requested" ? "input" : null;
  const respondedKind = event.eventType === "turn.approval.responded" ? "approval" : event.eventType === "turn.input.responded" ? "input" : null;
  if (requestId !== null && requestedKind !== null && event.turnId !== null) {
    const request = interactionRequestFromEvent(event, requestId, requestedKind);
    if (request === null) return next;
    const index = next.findIndex((interaction) => interaction.id === requestId);
    if (index < 0) {
      next.push({ id: requestId, turnId: event.turnId, kind: requestedKind, state: "pending", request, response: null, createdAt: timestamp, updatedAt: timestamp });
    } else {
      const existing = next[index]!;
      if (existing.turnId !== event.turnId || existing.kind !== requestedKind) return next;
      if (existing.request === null) next[index] = { ...existing, request, updatedAt: existing.updatedAt };
    }
    return next;
  }
  if (requestId !== null && respondedKind !== null && event.turnId !== null) {
    const response = respondedKind === "approval" && approvalDecisions.has(event.payload.decision as BrowserAiApprovalDecision)
      ? { decision: event.payload.decision as BrowserAiApprovalDecision }
      : respondedKind === "input" && Array.isArray(event.payload.answers)
        ? { answers: [...(event.payload.answers as unknown[])] }
        : null;
    if (response === null) return next;
    const index = next.findIndex((interaction) => interaction.id === requestId);
    if (index < 0) {
      next.push({ id: requestId, turnId: event.turnId, kind: respondedKind, state: "responded", request: null, response, createdAt: timestamp, updatedAt: timestamp });
    } else {
      const existing = next[index]!;
      if (existing.turnId !== event.turnId || existing.kind !== respondedKind || existing.state !== "pending") return next;
      next[index] = { ...existing, state: "responded", response, updatedAt: timestamp };
    }
    return next;
  }
  if (event.eventType === "turn.interaction.expired" && requestId !== null && event.turnId !== null) {
    const index = next.findIndex((interaction) => interaction.id === requestId);
    if (index < 0) return next;
    const existing = next[index]!;
    if (existing.turnId !== event.turnId || existing.state !== "pending") return next;
    next[index] = { ...existing, state: "expired", updatedAt: timestamp };
    return next;
  }
  let retirement: BrowserAiInteractionState | null = null;
  if (event.eventType === "turn.interrupted" || event.eventType === "session.stopped") retirement = "cancelled";
  else if (event.eventType === "turn.quiesced") retirement = "expired";
  else if (event.eventType === "turn.failed" || event.eventType === "turn.lost" || event.eventType === "session.lost") retirement = "lost";
  if (retirement === null) return next;
  return next.map((interaction) => interaction.state === "pending"
    && (event.turnId === null || interaction.turnId === event.turnId)
    ? { ...interaction, state: retirement, updatedAt: timestamp } : interaction);
}

function boundActivities(activities: readonly string[]): { values: string[]; truncated: boolean } {
  let remaining = AI_TURN_ACTIVITY_HISTORY_MAX_BYTES;
  let truncated = activities.length > AI_TURN_ACTIVITY_HISTORY_MAX_ROWS;
  const retained: string[] = [];
  for (const activity of activities.slice(-AI_TURN_ACTIVITY_HISTORY_MAX_ROWS).reverse()) {
    const bounded = truncateUtf8(activity, remaining);
    if (bounded.truncated) truncated = true;
    if (bounded.value !== "") {
      retained.unshift(bounded.value);
      remaining -= utf8ByteLength(bounded.value);
    } else if (activity !== "") {
      truncated = true;
    }
    if (remaining === 0) truncated = true;
  }
  return { values: retained, truncated };
}

export function boundAiSessionTurns(turns: readonly BrowserAiTurn[]): BrowserAiTurn[] {
  let remaining = AI_SESSION_OUTPUT_MAX_BYTES;
  const bounded = turns.map((turn) => ({
    ...turn,
    activities: [...turn.activities],
    changedFiles: { files: [...turn.changedFiles.files], truncated: turn.changedFiles.truncated }
  }));
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const current = bounded[index]!;
    const allowed = Math.min(AI_TURN_OUTPUT_MAX_BYTES, remaining);
    const output = truncateUtf8(current.outputText, allowed);
    current.outputText = output.value;
    current.outputTruncated = current.outputTruncated || output.truncated || (remaining === 0 && current.outputText !== "");
    const activities = boundActivities(current.activities);
    current.activities = activities.values;
    current.activitiesTruncated = current.activitiesTruncated === true || activities.truncated;
    remaining -= utf8ByteLength(current.outputText);
  }
  return bounded;
}

export function appendAiTurnOutput(turns: readonly BrowserAiTurn[], turnId: string, delta: string): BrowserAiTurn[] {
  let found = false;
  const next = turns.map((turn) => {
    if (turn.id !== turnId) return {
      ...turn,
      activities: [...turn.activities],
      changedFiles: { files: [...turn.changedFiles.files], truncated: turn.changedFiles.truncated }
    };
    found = true;
    if (turn.outputTruncated) return { ...turn, activities: [...turn.activities], changedFiles: { files: [...turn.changedFiles.files], truncated: turn.changedFiles.truncated } };
    const available = Math.max(0, AI_TURN_OUTPUT_MAX_BYTES - utf8ByteLength(turn.outputText));
    const boundedDelta = truncateUtf8(delta, available);
    return {
      ...turn,
      outputText: turn.outputText + boundedDelta.value,
      outputTruncated: turn.outputTruncated || boundedDelta.truncated,
      activities: [...turn.activities],
      changedFiles: { files: [...turn.changedFiles.files], truncated: turn.changedFiles.truncated }
    };
  });
  if (!found) {
    next.push({
      id: turnId, state: "accepted", content: { kind: "text", text: "" }, outputText: truncateUtf8(delta, AI_TURN_OUTPUT_MAX_BYTES).value,
      outputTruncated: truncateUtf8(delta, AI_TURN_OUTPUT_MAX_BYTES).truncated, activities: [],
      changedFiles: { files: [], truncated: false }, createdAt: new Date().toISOString()
    });
  }
  return boundAiSessionTurns(next);
}
