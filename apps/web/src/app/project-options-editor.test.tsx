/**
 * @vitest-environment node
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buttonText, FakeNode, findButtons, installTerminalTestDom, settleReact, visibleText } from "./terminal-test-dom.js";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const activeRevisionId = "018f1f34-7000-7000-8000-000000000002";
const candidateRevisionId = "018f1f34-7000-7000-8000-000000000003";
const activeRevisionHash = `sha256-jcs-v1:${"a".repeat(64)}`;
const candidateRevisionHash = `sha256-jcs-v1:${"b".repeat(64)}`;
const roots: Root[] = [];

function initialOptions() {
  return {
    schemaVersion: 1,
    namedVolumes: [],
    developmentEnvironment: {
      source: { kind: "image", imageReference: "node:24-bookworm" },
      containerUser: "node",
      passwordlessSudo: false,
      workingDirectory: "/workspace",
      environment: { TZ: { kind: "literal", value: "UTC" } },
      ports: [{ name: "web", containerPort: 5173, protocol: "tcp" }],
      volumes: [],
      setupSteps: [],
      rebuildPolicy: "manual"
    },
    tasks: [{
      key: "check",
      displayName: "Check workspace",
      command: { executable: "/usr/bin/printf", args: ["configured-task-ok\\n"], workingDirectory: ".", environment: {} },
      interactive: false,
      longRunning: false,
      timeoutSeconds: 600,
      concurrencyPolicy: "allow",
      successExitCodes: [0, 7],
      logRetentionDays: 3
    }],
    services: [],
    previews: [{
      key: "web",
      displayName: "Web",
      target: { kind: "workspace" },
      containerPort: 5173,
      domainBaseId: "approved-preview",
      hostnamePattern: "{project}-{shortId}",
      protocol: "http",
      healthPath: "/healthz",
      healthStatuses: [200, 204],
      startupTimeoutSeconds: 90,
      webSocketForwarding: false
    }],
    aiProfile: null,
    resources: {
      cpuMillicores: null,
      memoryBytes: 536870912,
      pidLimit: null,
      maxNamedVolumeBytes: null,
      logRetentionDays: null,
      stoppedWorkspaceRetentionDays: null,
      automaticStopMinutes: null,
      maxConcurrentWorkspaces: null
    }
  };
}

function optionsSnapshot(options: unknown, values: {
  readonly activeId?: string;
  readonly activeNumber?: number;
  readonly activeHash?: string;
  readonly draft?: { readonly id: string; readonly number: number; readonly hash: string; readonly options: unknown } | null;
  readonly pendingApply?: unknown;
} = {}) {
  return {
    projectId,
    workspaceId: "018f1f34-7000-7000-8000-000000000010",
    activeRevision: { id: values.activeId ?? activeRevisionId, number: values.activeNumber ?? 3, hash: values.activeHash ?? activeRevisionHash, options },
    draft: values.draft ?? null,
    pendingApply: values.pendingApply ?? null,
    previews: [],
    approvedPreviewBases: [{ id: "approved-preview", domain: "preview.example.test" }]
  };
}

function visit(node: FakeNode, predicate: (candidate: FakeNode) => boolean): FakeNode[] {
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => visit(child, predicate))];
}

function findByLabel(node: FakeNode, label: string): FakeNode {
  const found = visit(node, (candidate) => candidate.getAttribute("aria-label") === label)[0];
  if (found === undefined) throw new Error(`Field ${label} was not found`);
  return found;
}

function reactProps(node: FakeNode): { onChange?: (event: { target: { value: string } }) => void; onClick?: () => void } {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (key === undefined) throw new Error("React props are not attached to the test node");
  return (node as unknown as Record<string, { onChange?: (event: { target: { value: string } }) => void; onClick?: () => void }>)[key]!;
}

function changeField(node: FakeNode, label: string, value: string) {
  const field = findByLabel(node, label);
  field.value = value;
  act(() => { reactProps(field).onChange?.({ target: { value } }); });
}

function findButton(node: FakeNode, text: string): FakeNode {
  const found = findButtons(node).find((button) => buttonText(button).trim() === text);
  if (found === undefined) throw new Error(`Button ${text} was not found`);
  return found;
}

async function press(node: FakeNode, text: string) {
  const button = findButton(node, text);
  const onClick = reactProps(button).onClick;
  if (onClick === undefined) throw new Error(`Button ${text} has no click handler`);
  act(() => { onClick(); });
  await settleReact();
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

async function mount(element: ReturnType<typeof createElement>) {
  const body = installTerminalTestDom(class {});
  const root = createRoot(body as never);
  roots.push(root);
  act(() => { root.render(element); });
  await settleReact();
  return body;
}

afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  vi.unstubAllGlobals();
});

test("loads, saves, and applies a full options document without changing unrelated fields", async () => {
  let activeOptions = initialOptions();
  let savedOptions: unknown = null;
  let didApply = false;
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ url, method, ...(body === undefined ? {} : { body }) });
    if (url === `/api/projects/${projectId}/options` && method === "GET") {
      if (didApply) return Promise.resolve(response(optionsSnapshot(activeOptions, { activeId: candidateRevisionId, activeNumber: 4, activeHash: candidateRevisionHash })));
      return Promise.resolve(response(optionsSnapshot(activeOptions, savedOptions === null ? {} : {
        activeId: candidateRevisionId,
        activeHash: candidateRevisionHash,
        draft: { id: candidateRevisionId, number: 4, hash: candidateRevisionHash, options: savedOptions }
      })));
    }
    if (url === `/api/projects/${projectId}/options` && method === "PUT") {
      savedOptions = (body as { options: unknown }).options;
      return Promise.resolve(response({ draft: { id: candidateRevisionId, number: 4, hash: candidateRevisionHash, options: savedOptions } }, 201));
    }
    if (url === `/api/projects/${projectId}/options/apply` && method === "POST") {
      activeOptions = savedOptions as ReturnType<typeof initialOptions>;
      savedOptions = null;
      didApply = true;
      return Promise.resolve(response({ state: "applied", operationId: "018f1f34-7000-7000-8000-000000000020", activeRevisionId: candidateRevisionId, runtimeState: "absent", message: "Applied." }));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onApplied = vi.fn();
  const { ProjectOptionsEditor } = await import("./project-options-editor.js");
  const body = await mount(createElement(ProjectOptionsEditor, {
    projectId, runtimeState: "stopped", active: true, onDirtyChange: () => undefined,
    onBusyChange: () => undefined, onApplyFenceChange: () => undefined, onApplied
  }));

  expect(requests[0]).toMatchObject({ url: `/api/projects/${projectId}/options`, method: "GET" });
  expect(visibleText(body)).toContain("Active configuration");
  expect(visibleText(body)).toContain("Revision 3");
  expect(findByLabel(body, "Development container image").value).toBe("node:24-bookworm");
  expect(findByLabel(body, "Task check executable").value).toBe("/usr/bin/printf");
  expect(findByLabel(body, "Preview Web container port").value).toBe("5173");

  changeField(body, "Development container image", "node:24-alpine");
  changeField(body, "Task check executable", "npm");
  changeField(body, "Task check argument 1", "test");
  changeField(body, "Task check key", "verify");
  changeField(body, "Preview Web container port", "4173");
  await press(body, "Save Draft");

  const save = requests.find((request) => request.method === "PUT");
  expect(save?.body).toMatchObject({ expectedRevision: { revisionId: activeRevisionId, revisionHash: activeRevisionHash } });
  const submitted = (save?.body as { options: ReturnType<typeof initialOptions> }).options;
  expect(submitted.developmentEnvironment.source).toEqual({ kind: "image", imageReference: "node:24-alpine" });
  expect(submitted.developmentEnvironment.environment).toEqual({ TZ: { kind: "literal", value: "UTC" } });
  expect(submitted.tasks[0]).toMatchObject({
    key: "verify", displayName: "Check workspace", interactive: false, timeoutSeconds: 600,
    concurrencyPolicy: "allow", successExitCodes: [0, 7], logRetentionDays: 3,
    command: { executable: "npm", args: ["test"], workingDirectory: ".", environment: {} }
  });
  expect(submitted.previews[0]).toMatchObject({
    key: "web", displayName: "Web", containerPort: 4173, healthPath: "/healthz",
    healthStatuses: [200, 204], startupTimeoutSeconds: 90, webSocketForwarding: false,
    hostnamePattern: "{project}-{shortId}"
  });
  expect(submitted.developmentEnvironment.ports).toEqual([{ name: "web", containerPort: 4173, protocol: "tcp" }]);
  expect(submitted.resources.memoryBytes).toBe(536870912);
  expect(requests.some((request) => request.method === "POST")).toBe(false);
  expect(visibleText(body)).toContain("Saved draft · revision 4");
  expect(visibleText(body)).toContain("Active configuration");

  await press(body, "Apply");
  expect(visibleText(body)).toContain("including for task-only changes");
  expect(visibleText(body)).toContain("writes made only to the container's disposable writable layer may be lost");
  await press(body, "Confirm Apply");

  expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  expect(requests.find((request) => request.url.endsWith("/options/apply"))?.body).toEqual({
    expectedRevision: { revisionId: activeRevisionId, revisionHash: activeRevisionHash },
    candidateRevisionId
  });
  expect(onApplied).toHaveBeenCalledOnce();
  expect(visibleText(body)).toContain("Applied");
  expect(visibleText(body)).toContain("new development container will be created on the next Start");
  expect(visibleText(body)).toContain("Revision 4");
});

test("a pending Apply loaded after reopening retries the same candidate and expected revision", async () => {
  const options = initialOptions();
  const draft = { id: candidateRevisionId, number: 4, hash: candidateRevisionHash, options };
  const requests: Array<{ method: string; body?: unknown }> = [];
  let applyAttempts = 0;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method, ...(body === undefined ? {} : { body }) });
    if (url === `/api/projects/${projectId}/options` && method === "GET") return Promise.resolve(response(optionsSnapshot(options, {
      draft, pendingApply: { operationId: "018f1f34-7000-7000-8000-000000000030", state: "running", phase: "adoption-submitted",
        expectedRevision: { revisionId: activeRevisionId, revisionHash: activeRevisionHash },
        candidateRevision: { revisionId: candidateRevisionId, revisionHash: candidateRevisionHash } }
    })));
    if (url === `/api/projects/${projectId}/options/apply` && method === "POST") {
      applyAttempts += 1;
      return applyAttempts === 1
        ? Promise.resolve(response({ state: "pending", operationId: "018f1f34-7000-7000-8000-000000000030", message: "Still applying." }, 202))
        : Promise.resolve(response({ state: "applied", operationId: "018f1f34-7000-7000-8000-000000000030", activeRevisionId: candidateRevisionId, runtimeState: "absent", message: "Applied." }));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));
  const { ProjectOptionsEditor } = await import("./project-options-editor.js");
  const body = await mount(createElement(ProjectOptionsEditor, {
    projectId, runtimeState: "applying", active: true, onDirtyChange: () => undefined,
    onBusyChange: () => undefined, onApplyFenceChange: () => undefined, onApplied: () => undefined
  }));

  expect(visibleText(body)).toContain("Apply pending");
  await press(body, "Retry/Continue Apply");
  await press(body, "Continue Apply");
  expect(visibleText(body)).toContain("Apply pending");
  await press(body, "Retry/Continue Apply");
  await press(body, "Continue Apply");

  const applyBodies = requests.filter((request) => request.method === "POST").map((request) => request.body);
  expect(applyBodies).toHaveLength(2);
  expect(applyBodies[0]).toEqual(applyBodies[1]);
  expect(applyBodies[0]).toEqual({
    expectedRevision: { revisionId: activeRevisionId, revisionHash: activeRevisionHash },
    candidateRevisionId
  });
  expect(requests.filter((request) => request.method === "PUT")).toHaveLength(0);
  expect(visibleText(body)).toContain("Applied");
});

test("field validation identifies an invalid image, task definition, preview port, and unapproved base", async () => {
  const options = initialOptions();
  const fetchMock = vi.fn(() => Promise.resolve(response(optionsSnapshot(options))));
  vi.stubGlobal("fetch", fetchMock);
  const { ProjectOptionsEditor } = await import("./project-options-editor.js");
  const body = await mount(createElement(ProjectOptionsEditor, {
    projectId, runtimeState: "stopped", active: true, onDirtyChange: () => undefined,
    onBusyChange: () => undefined, onApplyFenceChange: () => undefined, onApplied: () => undefined
  }));

  changeField(body, "Development container image", "https://bad image");
  changeField(body, "Task check executable", "   ");
  changeField(body, "Preview Web container port", "70000");
  changeField(body, "Preview Web approved domain base", "not-approved");
  await press(body, "Save Draft");

  expect(visibleText(body)).toContain("Enter a valid development container image reference.");
  expect(visibleText(body)).toContain("Enter a task executable.");
  expect(visibleText(body)).toContain("Enter a container port from 1 to 65535.");
  expect(visibleText(body)).toContain("Choose an approved preview base.");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("flags duplicate workspace preview ports on both affected fields", async () => {
  const options = initialOptions();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(optionsSnapshot(options)))));
  const { ProjectOptionsEditor } = await import("./project-options-editor.js");
  const body = await mount(createElement(ProjectOptionsEditor, {
    projectId, runtimeState: "stopped", active: true, onDirtyChange: () => undefined,
    onBusyChange: () => undefined, onApplyFenceChange: () => undefined, onApplied: () => undefined
  }));

  await press(body, "Add preview");
  changeField(body, "Preview Web 2 container port", "5173");
  await press(body, "Save Draft");

  expect(findByLabel(body, "Preview Web container port").getAttribute("aria-invalid")).toBe("true");
  expect(findByLabel(body, "Preview Web 2 container port").getAttribute("aria-invalid")).toBe("true");
  expect(visibleText(body)).toContain("Workspace preview ports must be unique.");
});

test("a running workspace explains the stop requirement and does not submit Apply", async () => {
  const options = initialOptions();
  const draft = { id: candidateRevisionId, number: 4, hash: candidateRevisionHash, options };
  const fetchMock = vi.fn(() => Promise.resolve(response(optionsSnapshot(options, { draft }))));
  vi.stubGlobal("fetch", fetchMock);
  const { ProjectOptionsEditor } = await import("./project-options-editor.js");
  const body = await mount(createElement(ProjectOptionsEditor, {
    projectId, runtimeState: "running", active: true, onDirtyChange: () => undefined,
    onBusyChange: () => undefined, onApplyFenceChange: () => undefined, onApplied: () => undefined
  }));

  expect(visibleText(body)).toContain("Stop the workspace with the normal Workbench control before Apply.");
  expect(findButton(body, "Apply").disabled).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("keeps field-specific Apply validation errors visible after refreshing saved state", async () => {
  const options = initialOptions();
  const draft = { id: candidateRevisionId, number: 4, hash: candidateRevisionHash, options };
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (url.endsWith("/options/apply") && method === "POST") {
      return Promise.resolve(response({ message: "Choose an approved preview base.", field: "previews.0.domainBaseId" }, 422));
    }
    return Promise.resolve(response(optionsSnapshot(options, { draft })));
  }));
  const { ProjectOptionsEditor } = await import("./project-options-editor.js");
  const body = await mount(createElement(ProjectOptionsEditor, {
    projectId, runtimeState: "stopped", active: true, onDirtyChange: () => undefined,
    onBusyChange: () => undefined, onApplyFenceChange: () => undefined, onApplied: () => undefined
  }));

  await press(body, "Apply");
  await press(body, "Confirm Apply");

  const domainBase = findByLabel(body, "Preview Web approved domain base");
  expect(domainBase.getAttribute("aria-invalid")).toBe("true");
  expect(visibleText(body)).toContain("Choose an approved preview base.");
});

test("adds and removes multiple tasks and previews while marking the form unsaved", async () => {
  const options = initialOptions();
  const savedOptions: { value: ReturnType<typeof initialOptions> | null } = { value: null };
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/options") && init?.method === "PUT") {
      if (typeof init.body !== "string") throw new Error("Expected JSON Project Options draft payload");
      const payload: unknown = JSON.parse(init.body);
      if (payload === null || typeof payload !== "object" || !("options" in payload)
        || payload.options === null || typeof payload.options !== "object") {
        throw new Error("Project Options draft payload is invalid");
      }
      savedOptions.value = payload.options as ReturnType<typeof initialOptions>;
      return Promise.resolve(response({ draft: { id: candidateRevisionId, number: 4, hash: candidateRevisionHash,
        options: savedOptions.value } }, 201));
    }
    return Promise.resolve(response(optionsSnapshot(options)));
  }));
  const onDirtyChange = vi.fn();
  const { ProjectOptionsEditor } = await import("./project-options-editor.js");
  const body = await mount(createElement(ProjectOptionsEditor, {
    projectId, runtimeState: "stopped", active: true, onDirtyChange,
    onBusyChange: () => undefined, onApplyFenceChange: () => undefined, onApplied: () => undefined
  }));

  await press(body, "Add task");
  await press(body, "Add preview");
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  await press(body, "Save Draft");

  expect(findByLabel(body, "Task check-2 executable").value).toBe("/usr/bin/printf");
  expect(findByLabel(body, "Preview Web 2 container port").value).toBe("3000");
  expect(savedOptions.value?.previews[1]?.hostnamePattern).toBe("{project}-{preview}-{shortId}");
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  const previewRemovals = findButtons(body).filter((button) => buttonText(button).trim() === "Remove preview");
  expect(previewRemovals).toHaveLength(2);
  const removePreview = reactProps(previewRemovals[1]!).onClick;
  if (removePreview === undefined) throw new Error("The preview remove button has no handler");
  act(() => { removePreview(); });
  await settleReact();
  expect(visibleText(body)).not.toContain("Web 2");
  expect(findByLabel(body, "Preview Web container port").value).toBe("5173");
});

test("a stale revision conflict is clearly shown and requires reloading current settings", async () => {
  const options = initialOptions();
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/options") && (init?.method ?? "GET") === "PUT") {
      return Promise.resolve(response({ message: "The active Project Options revision changed. Reload settings before saving." }, 409));
    }
    return Promise.resolve(response(optionsSnapshot(options)));
  });
  vi.stubGlobal("fetch", fetchMock);
  const { ProjectOptionsEditor } = await import("./project-options-editor.js");
  const body = await mount(createElement(ProjectOptionsEditor, {
    projectId, runtimeState: "stopped", active: true, onDirtyChange: () => undefined,
    onBusyChange: () => undefined, onApplyFenceChange: () => undefined, onApplied: () => undefined
  }));

  changeField(body, "Development container image", "node:25-bookworm");
  await press(body, "Save Draft");
  expect(visibleText(body)).toContain("active Project Options revision changed");
  expect(visibleText(body)).toContain("Revision conflict — reload required");
  expect(findButtons(body).map((button) => buttonText(button).trim())).toContain("Reload current settings");
});
