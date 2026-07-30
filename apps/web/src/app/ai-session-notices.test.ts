import { Fragment, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AiHistoryTruncationNotice, AiOutputTruncationNotice } from "./ai-session-notices.js";

describe("AI browser truncation notices", () => {
  test("renders concise visible notices for history and output truncation", () => {
    const markup = renderToStaticMarkup(createElement(Fragment, null,
      createElement(AiHistoryTruncationNotice, { historyStartSequence: 42 }),
      createElement(AiOutputTruncationNotice)
    ));
    expect(markup).toContain("Earlier AI history was truncated; replay begins at sequence 42.");
    expect(markup).toContain("Additional assistant output was omitted at the browser limit.");
    expect(markup).toContain('role="status"');
  });
});
