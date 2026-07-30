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
