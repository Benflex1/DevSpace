"use client";

type MonacoReactModule = typeof import("@monaco-editor/react");
type MonacoEnvironment = {
  readonly getWorker?: (workerId: string, label: string) => Worker;
  readonly [key: string]: unknown;
};

let monacoReactModule: Promise<MonacoReactModule> | null = null;
let workersConfigured = false;

function configureMonacoWorkers(): void {
  if (workersConfigured || typeof Worker === "undefined") return;
  const runtime = globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironment };
  runtime.MonacoEnvironment = {
    ...runtime.MonacoEnvironment,
    getWorker: (_workerId, label) => {
      if (label === "json") return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" });
      if (label === "css" || label === "scss" || label === "less") return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: "module" });
      if (label === "html" || label === "handlebars" || label === "razor") return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: "module" });
      if (label === "typescript" || label === "javascript") return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
      return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
    }
  };
  workersConfigured = true;
}

export function loadMonacoReact(): Promise<MonacoReactModule> {
  if (monacoReactModule === null) {
    configureMonacoWorkers();
    monacoReactModule = Promise.all([import("@monaco-editor/react"), import("monaco-editor")]).then(([react, monaco]) => {
      react.loader.config({ monaco });
      return react;
    });
  }
  return monacoReactModule;
}
