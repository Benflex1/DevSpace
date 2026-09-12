import { expect, test } from "vitest";
import { disposeDiffEditorResources } from "./monaco-model-lifecycle.js";

test("detaches the diff model before disposing the widget and its models", () => {
  const events: string[] = [];
  const models = [
    { dispose: () => { events.push("original.dispose"); } },
    { dispose: () => { events.push("modified.dispose"); } }
  ] as const;
  const widget = {
    setModel: (model: null) => { expect(model).toBeNull(); events.push("widget.setModel(null)"); },
    dispose: () => { events.push("widget.dispose"); }
  };

  disposeDiffEditorResources(widget, models);
  expect(events).toEqual(["widget.setModel(null)", "widget.dispose", "original.dispose", "modified.dispose"]);
});
