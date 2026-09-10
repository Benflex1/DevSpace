"use client";

type MonacoReactModule = typeof import("@monaco-editor/react");
type MonacoInstance = typeof import("monaco-editor");
type MonacoEnvironment = {
  readonly getWorker?: (workerId: string, label: string) => Worker;
  readonly [key: string]: unknown;
};

export interface MonacoRuntimeDiagnostic {
  readonly status: "uninitialized" | "initializing" | "ready" | "failed";
  readonly expectedRuntime: "local";
  readonly resolvedRuntime: "local" | "foreign" | null;
  readonly identityMatches: boolean;
  readonly errorMessage?: string;
  readonly getModelUris: () => string[];
}

let monacoReactModule: Promise<MonacoReactModule> | null = null;
let localMonacoModule: Promise<MonacoInstance> | null = null;
let workersConfigured = false;
let runtimeDiagnostic: MonacoRuntimeDiagnostic = {
  status: "uninitialized", expectedRuntime: "local", resolvedRuntime: null, identityMatches: false, getModelUris: () => []
};

function publishRuntimeDiagnostic(next: Partial<MonacoRuntimeDiagnostic>): void {
  runtimeDiagnostic = { ...runtimeDiagnostic, ...next };
  const runtime = globalThis as typeof globalThis & { __DEVSPACE_MONACO_RUNTIME__?: MonacoRuntimeDiagnostic };
  runtime.__DEVSPACE_MONACO_RUNTIME__ = runtimeDiagnostic;
}

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

configureMonacoWorkers();

export function assertMonacoRuntimeIdentity(expected: unknown, resolved: unknown): void {
  if (expected !== resolved) throw new Error("MONACO_RUNTIME_MISMATCH");
}

export function loadMonacoReact(): Promise<MonacoReactModule> {
  if (monacoReactModule === null) {
    configureMonacoWorkers();
    monacoReactModule = initializeMonacoReact();
  }
  return monacoReactModule;
}

export function loadMonaco(): Promise<MonacoInstance> {
  if (localMonacoModule === null) localMonacoModule = import("monaco-editor");
  return localMonacoModule;
}

async function initializeMonacoReact(): Promise<MonacoReactModule> {
  publishRuntimeDiagnostic({ status: "initializing", resolvedRuntime: null, identityMatches: false });
  let localMonaco: MonacoInstance | null = null;
  let resolvedMonaco: unknown = null;
  try {
    localMonaco = await loadMonaco();
    const react = await import("@monaco-editor/react");
    react.loader.config({ monaco: localMonaco });
    resolvedMonaco = await react.loader.init();
    assertMonacoRuntimeIdentity(localMonaco, resolvedMonaco);
    publishRuntimeDiagnostic({
      status: "ready", resolvedRuntime: "local", identityMatches: true,
      getModelUris: () => localMonaco?.editor.getModels().map((model) => model.uri.toString()) ?? []
    });
    return react;
  } catch (error) {
    publishRuntimeDiagnostic({
      status: "failed", resolvedRuntime: localMonaco !== null && resolvedMonaco !== null && resolvedMonaco !== localMonaco ? "foreign" : null,
      identityMatches: false, errorMessage: error instanceof Error ? error.message : "MONACO_RUNTIME_INITIALIZATION_FAILED"
    });
    throw error;
  }
}
