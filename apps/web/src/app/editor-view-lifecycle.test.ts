import { expect, test } from "vitest";
import { editorViewVisibility } from "./editor-view-lifecycle.js";

test("changes visibility without making Edit or Changes the widget ownership boundary", () => {
  expect(editorViewVisibility("edit")).toEqual({ editHidden: false, changesHidden: true });
  expect(editorViewVisibility("changes")).toEqual({ editHidden: true, changesHidden: false });
});
