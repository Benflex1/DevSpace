import { expect, test } from "vitest";
import { disposeModelsAfterWidget } from "./monaco-model-lifecycle.js";

test("waits for widget disposal before disposing retained DevSpace-owned models", () => {
  let widgetDisposed = false;
  let modelDisposed = false;
  let disposeWidget: () => void = () => undefined;
  let subscriptionDisposed = false;
  const model = { dispose: () => { expect(widgetDisposed).toBe(true); modelDisposed = true; } };
  const widget = {
    onDidDispose: (listener: () => void) => {
      disposeWidget = listener;
      return { dispose: () => { subscriptionDisposed = true; } };
    }
  };

  disposeModelsAfterWidget(widget, [model]);
  expect(modelDisposed).toBe(false);

  widgetDisposed = true;
  disposeWidget();

  expect(modelDisposed).toBe(true);
  expect(subscriptionDisposed).toBe(true);
});
