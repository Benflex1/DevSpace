import { describe, expect, test } from "vitest";
import { TRANSIENT_NOTICE_DISMISS_MS, transientNoticeDismissDelay } from "./transient-notice.js";

describe("transient notices", () => {
  test("auto-dismisses ordinary informational and success notices", () => {
    expect(transientNoticeDismissDelay("info")).toBe(TRANSIENT_NOTICE_DISMISS_MS);
    expect(transientNoticeDismissDelay("success")).toBe(TRANSIENT_NOTICE_DISMISS_MS);
  });

  test("keeps pending and error notices until replaced or cleared", () => {
    expect(transientNoticeDismissDelay("pending")).toBeNull();
    expect(transientNoticeDismissDelay("error")).toBeNull();
  });
});
