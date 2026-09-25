import { act } from "react";

type Listener = (event: FakeEvent) => void;

export type FakeEvent = {
  type: string;
  target: FakeNode | FakeText | FakeDocument;
  currentTarget: FakeNode | FakeText | FakeDocument | null;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  button: number;
  preventDefault: () => void;
  stopPropagation: () => void;
};

type EventParent = FakeNode | FakeDocument;

export class FakeNode {
  nodeType = 1;
  nodeName = "DIV";
  tagName = "DIV";
  namespaceURI = "http://www.w3.org/1999/xhtml";
  ownerDocument: FakeDocument | null = null;
  parentNode: EventParent | null = null;
  nextSibling: FakeNode | FakeText | null = null;
  previousSibling: FakeNode | FakeText | null = null;
  childNodes: Array<FakeNode | FakeText> = [];
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  clientWidth = 800;
  clientHeight = 600;
  selected = false;
  get options(): FakeNode[] | undefined {
    if (this.nodeName !== "SELECT") return undefined;
    return this.children.filter((child) => child.nodeName === "OPTION");
  }
  private readonly listeners = new Map<string, Set<Listener>>();
  get children(): FakeNode[] {
    return this.childNodes.filter((node): node is FakeNode => node.nodeType === 1);
  }
  get firstChild(): FakeNode | FakeText | null {
    return this.childNodes[0] ?? null;
  }
  appendChild<T extends FakeNode | FakeText>(child: T): T {
    this.insertBefore(child, null);
    return child;
  }
  insertBefore<T extends FakeNode | FakeText>(child: T, reference: FakeNode | FakeText | null): T {
    if (child.parentNode instanceof FakeNode) child.parentNode.removeChild(child);
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    child.parentNode = this;
    this.linkSiblings();
    return child;
  }
  removeChild<T extends FakeNode | FakeText>(child: T): T {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    this.linkSiblings();
    return child;
  }
  contains(other: FakeNode | FakeText | null): boolean {
    let current = other?.parentNode ?? null;
    while (current !== null) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return other === this;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
    if (name === "value") this.value = String(value);
    if (name === "disabled") this.disabled = true;
    if (name === "hidden") this.hidden = true;
  }
  getAttribute(name: string) {
    if (name === "hidden" && this.hidden) return "";
    return this.attributes[name] ?? null;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
    if (name === "hidden") this.hidden = false;
  }
  hasAttribute(name: string) { return Object.hasOwn(this.attributes, name) || (name === "hidden" && this.hidden); }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  focus() { /* terminal focus is irrelevant here */ }
  dispatchEvent(event: FakeEvent) {
    const ancestors: EventParent[] = [];
    let parent = this.parentNode;
    while (parent !== null) {
      ancestors.push(parent);
      parent = parent.parentNode;
    }
    for (const ancestor of [...ancestors].reverse()) ancestor.emit(event);
    this.emit(event);
    for (const ancestor of ancestors) ancestor.emit(event);
    return !event.defaultPrevented;
  }
  emit(event: FakeEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener({ ...event, currentTarget: this });
  }
  private linkSiblings() {
    this.childNodes.forEach((node, index) => {
      node.previousSibling = this.childNodes[index - 1] ?? null;
      node.nextSibling = this.childNodes[index + 1] ?? null;
    });
  }
}

export class FakeText {
  nodeType = 3;
  nodeName = "#text";
  parentNode: FakeNode | null = null;
  nextSibling: FakeNode | FakeText | null = null;
  previousSibling: FakeNode | FakeText | null = null;
  constructor(public textContent: string) {}
  get nodeValue() { return this.textContent; }
  set nodeValue(value: string | null) { this.textContent = value ?? ""; }
}

export class FakeDocument {
  nodeType = 9;
  nodeName = "#document";
  ownerDocument: FakeDocument | null = null;
  parentNode: FakeDocument | null = null;
  documentElement: FakeNode;
  body: FakeNode;
  defaultView: unknown = null;
  activeElement: FakeNode | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  constructor() {
    this.ownerDocument = this;
    this.documentElement = new FakeNode();
    this.documentElement.nodeName = "HTML";
    this.documentElement.tagName = "HTML";
    this.documentElement.ownerDocument = this;
    this.body = new FakeNode();
    this.body.nodeName = "BODY";
    this.body.tagName = "BODY";
    this.body.ownerDocument = this;
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string) {
    const node = new FakeNode();
    node.nodeName = tag.toUpperCase();
    node.tagName = node.nodeName;
    node.ownerDocument = this;
    return node;
  }
  createTextNode(text: string) {
    return new FakeText(text);
  }
  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(event: FakeEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener({ ...event, currentTarget: this });
  }
}

export function visibleText(node: FakeNode | FakeText | FakeDocument): string {
  if (node instanceof FakeText) return node.textContent;
  if (node instanceof FakeDocument) return visibleText(node.body);
  if (node.hidden || node.getAttribute("hidden") !== null) return "";
  const childText = node.childNodes.map((child) => visibleText(child)).join("");
  return childText.length > 0 ? childText : node.textContent;
}

export function findButtons(node: FakeNode | FakeDocument): FakeNode[] {
  const root = node instanceof FakeDocument ? node.body : node;
  const buttons: FakeNode[] = [];
  const visit = (current: FakeNode) => {
    if (current.nodeName === "BUTTON") buttons.push(current);
    for (const child of current.children) visit(child);
  };
  visit(root);
  return buttons;
}

export function buttonText(node: FakeNode): string {
  const childText = node.childNodes.map((child) => child instanceof FakeText ? child.textContent : buttonText(child)).join("");
  return childText.length > 0 ? childText : node.textContent;
}

export function click(node: FakeNode) {
  const event: FakeEvent = {
    type: "click",
    target: node,
    currentTarget: null,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    button: 0,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() { /* tests do not cancel the bubble */ }
  };
  node.dispatchEvent(event);
}

export async function settleReact(turns = 8) {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export function installTerminalTestDom(webSocket: unknown) {
  const document = new FakeDocument();
  const windowLike = {
    document,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
    addEventListener() { /* unused */ },
    removeEventListener() { /* unused */ },
    HTMLIFrameElement: class HTMLIFrameElement {},
    Element: FakeNode,
    HTMLElement: FakeNode,
    Node: FakeNode,
    location: { protocol: "http:", host: "workbench.test" },
    ResizeObserver: class { observe() { /* unused */ } disconnect() { /* unused */ } },
    getComputedStyle: () => ({})
  };
  document.defaultView = windowLike;
  Object.assign(globalThis, {
    document,
    window: windowLike,
    WebSocket: webSocket,
    ResizeObserver: windowLike.ResizeObserver,
    Element: FakeNode,
    HTMLElement: FakeNode,
    Node: FakeNode,
    HTMLIFrameElement: windowLike.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true
  });
  return document.body;
}
