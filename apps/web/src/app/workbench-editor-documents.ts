import { markEditorConflict, updateEditorContent, type EditorDocument } from "./editor-state.js";

export type EditorLoadIntent = "initial" | "retry" | "reload";
export type EditorDocumentLoadState = "idle" | "loading" | "loaded" | "error";

export interface WorkbenchEditorDocument {
  readonly key: string;
  readonly path: string;
  readonly document: EditorDocument | null;
  readonly loadState: EditorDocumentLoadState;
  readonly loadError: string | null;
  readonly loadGeneration: number;
  readonly contentGeneration: number;
}

export interface EditorLoadRequest {
  readonly key: string;
  readonly generation: number;
  readonly intent: EditorLoadIntent;
  readonly contentGeneration: number;
}

export interface EditorLoadResult {
  readonly content: string;
  readonly revision: string;
}

type Listener = () => void;

export function editorDocumentKey(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`;
}

export class WorkbenchEditorDocuments {
  private readonly entries = new Map<string, WorkbenchEditorDocument>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private nextLoadGeneration = 0;

  get(key: string): WorkbenchEditorDocument | undefined {
    return this.entries.get(key);
  }

  hasUnsavedChanges(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.document?.dirty === true) return true;
    }
    return false;
  }

  ensure(key: string, path: string): WorkbenchEditorDocument {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.path !== path) throw new Error("EDITOR_DOCUMENT_KEY_MISMATCH");
      return existing;
    }
    const entry: WorkbenchEditorDocument = {
      key, path, document: null, loadState: "idle", loadError: null, loadGeneration: 0, contentGeneration: 0
    };
    this.entries.set(key, entry);
    this.notify(key);
    return entry;
  }

  subscribe(key: string, listener: Listener): () => void {
    let listeners = this.listeners.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(key);
    };
  }

  beginLoad(key: string, intent: EditorLoadIntent): EditorLoadRequest | null {
    const current = this.entries.get(key);
    if (current === undefined) return null;
    if (intent === "initial" && (current.loadState === "loading" || current.loadState === "loaded" || current.loadState === "error")) return null;
    const generation = ++this.nextLoadGeneration;
    const request: EditorLoadRequest = { key, generation, intent, contentGeneration: current.contentGeneration };
    this.entries.set(key, { ...current, loadState: "loading", loadError: null, loadGeneration: generation });
    this.notify(key);
    return request;
  }

  resolveLoad(request: EditorLoadRequest, result: EditorLoadResult): boolean {
    const current = this.entries.get(request.key);
    if (!this.isCurrentLoad(current, request)) return false;
    if (request.intent !== "reload" && current.contentGeneration !== request.contentGeneration) {
      if (current.document !== null) {
        this.entries.set(request.key, { ...current, loadState: "loaded", loadError: null });
        this.notify(request.key);
      }
      return false;
    }
    const document: EditorDocument = {
      path: current.path, content: result.content, savedContent: result.content, revision: result.revision, dirty: false, conflict: null
    };
    this.entries.set(request.key, { ...current, document, loadState: "loaded", loadError: null });
    this.notify(request.key);
    return true;
  }

  rejectLoad(request: EditorLoadRequest, error: string): boolean {
    const current = this.entries.get(request.key);
    if (!this.isCurrentLoad(current, request)) return false;
    this.entries.set(request.key, { ...current, loadState: "error", loadError: error });
    this.notify(request.key);
    return true;
  }

  updateContent(key: string, content: string): boolean {
    const current = this.entries.get(key);
    if (current?.document === null || current === undefined) return false;
    const document = updateEditorContent(current.document, content);
    if (document === current.document) return false;
    this.entries.set(key, { ...current, document, contentGeneration: current.contentGeneration + 1 });
    this.notify(key);
    return true;
  }

  markSaved(key: string, revision: string, savedContent?: string): boolean {
    const current = this.entries.get(key);
    if (current?.document === null || current === undefined) return false;
    const baseline = savedContent ?? current.document.content;
    const document: EditorDocument = {
      ...current.document,
      savedContent: baseline,
      revision,
      dirty: current.document.content !== baseline,
      conflict: current.document.content === baseline ? null : current.document.conflict
    };
    this.entries.set(key, { ...current, document });
    this.notify(key);
    return true;
  }

  markConflict(key: string, message: string): boolean {
    const current = this.entries.get(key);
    if (current?.document === null || current === undefined) return false;
    this.entries.set(key, { ...current, document: markEditorConflict(current.document, message) });
    this.notify(key);
    return true;
  }

  release(key: string): void {
    if (!this.entries.delete(key)) return;
    this.notify(key);
  }

  private isCurrentLoad(current: WorkbenchEditorDocument | undefined, request: EditorLoadRequest): current is WorkbenchEditorDocument {
    return current !== undefined && current.loadState === "loading" && current.loadGeneration === request.generation;
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }
}
