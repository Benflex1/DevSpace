import { createElement } from "react";

export function AiHistoryTruncationNotice({ historyStartSequence }: { historyStartSequence: number }) {
  return createElement("p", { className: "ai-history-notice", role: "status" },
    `Earlier AI history was truncated; replay begins at sequence ${historyStartSequence}.`);
}

export function AiOutputTruncationNotice() {
  return createElement("small", { role: "status" }, "Additional assistant output was omitted at the browser limit.");
}
