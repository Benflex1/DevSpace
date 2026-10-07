/**
 * @vitest-environment node
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { AddProjectForm } from "./project-form.js";
import { buttonText, FakeNode, findButtons, installTerminalTestDom, settleReact, visibleText } from "./terminal-test-dom.js";

const roots: Root[] = [];
const connectionId = "018f0f00-0000-7000-8000-000000000099";
const installationUrl = "https://github.com/apps/devspace/installations/new?state=fresh";

function visit(node: FakeNode, predicate: (candidate: FakeNode) => boolean): FakeNode[] {
  const matches = predicate(node) ? [node] : [];
  return [...matches, ...node.children.flatMap((child) => visit(child, predicate))];
}

function reactProps(node: FakeNode): { onChange?: () => void; onClick?: () => void } {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (key === undefined) throw new Error("React props are not attached to the test node");
  return (node as unknown as Record<string, { onChange?: () => void; onClick?: () => void }>)[key]!;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  vi.unstubAllGlobals();
});

test("reconnect-pending offers an enabled action through the existing reconnect handoff", async () => {
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (requestUrl(input) === "/api/integrations/github/connection") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "reconnect-pending", connectionId, lifecycleGeneration: 2 }) } as Response);
    }
    if (requestUrl(input) === "/api/integrations/github/reconnect") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ installationUrl }) } as Response);
    }
    throw new Error(`Unexpected request: ${requestUrl(input)} ${init?.method ?? "GET"}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const body = installTerminalTestDom(class {});
  const fakeWindow = window as unknown as { location: { origin: string; assign: (url: string) => void } };
  fakeWindow.location.origin = "http://workbench.test";
  fakeWindow.location.assign = vi.fn();
  const root = createRoot(body as never);
  roots.push(root);
  act(() => { root.render(createElement(AddProjectForm, { agentReachable: true })); });
  await settleReact();

  const githubSource = visit(body, (node) => node.nodeName === "INPUT")[1];
  if (githubSource === undefined) throw new Error("GitHub repository source option not found");
  act(() => { reactProps(githubSource).onChange?.(); });
  await settleReact();

  const reconnect = findButtons(body).find((button) => buttonText(button) === "Continue GitHub reconnect");
  expect(visibleText(body)).toContain("GitHub reconnect is pending. Complete the GitHub App installation flow to restore private read access.");
  expect(reconnect).toBeDefined();
  expect(reconnect?.getAttribute("disabled")).toBeNull();
  const onClick = reactProps(reconnect!).onClick;
  expect(onClick).toEqual(expect.any(Function));
  act(() => { onClick?.(); });
  await settleReact();

  expect(fetchMock).toHaveBeenCalledWith("/api/integrations/github/reconnect", expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ connectionId })
  }));
  expect(fakeWindow.location.assign).toHaveBeenCalledWith(installationUrl);
});
