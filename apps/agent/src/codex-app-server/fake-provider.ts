import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterCallbacks,
  AiInteractionDecision,
  AiStructuredInputAnswer,
  ProviderAdapter,
  ProviderFinalizationResult
} from "./provider.js";
import {
  encodeCodexApprovalResponse,
  encodeCodexInputResponse,
  parseCodexServerInteractionRequest,
  projectCodexApprovalRequest,
  projectCodexFileChangeItem,
  projectCodexInputRequest,
  type CodexInteractionProjection,
  type CodexServerInteractionRequest
} from "./interactions.js";

export type FakeProviderNativeResponse = Readonly<{
  readonly kind: "approval" | "input";
  readonly payload: unknown;
}>;

export type FakeProviderTestHooks = Readonly<{
  readonly onStart?: () => void;
  readonly onSend?: () => void;
  readonly onStop?: () => void;
  readonly onNativeResponse?: (response: FakeProviderNativeResponse) => void;
  readonly closeAfterTurn?: boolean;
}>;

type PendingFakeInteraction = {
  readonly projection: CodexInteractionProjection;
  readonly request: CodexServerInteractionRequest;
  decision?: AiInteractionDecision;
  answers?: readonly AiStructuredInputAnswer[];
};

export class FakeProvider implements ProviderAdapter {
  private interrupted = false;
  private stopped = false;
  private releaseLongTurn: (() => void) | null = null;
  private longTurnTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingInteractions = new Map<string, PendingFakeInteraction>();
  private releaseInteraction: (() => void) | null = null;

  constructor(
    private readonly callbacks: AdapterCallbacks,
    private readonly worktreePath: string | null,
    private readonly testHooks: FakeProviderTestHooks | undefined,
    private readonly createId: () => string
  ) {}

  async start(): Promise<void> { this.testHooks?.onStart?.(); }

  async sendTurn(turnId: string, text: string): Promise<void> {
    this.testHooks?.onSend?.();
    this.interrupted = false;
    this.stopped = false;
    if (text.includes("devspace-ai-beta-check.txt") && this.worktreePath !== null) {
      await writeFile(path.join(this.worktreePath, "devspace-ai-beta-check.txt"), "DevSpace AI beta check", { mode: 0o600 });
    }
    if (text.includes("approval") || text.includes("file approval")) {
      const request = this.createApprovalRequest(text);
      const fileChangeItems = text.includes("file approval")
        ? new Map([[
            "fake-file-item",
            projectCodexFileChangeItem({
              id: "fake-file-item", type: "fileChange",
              changes: [{ path: "/workspace/devspace-ai-beta-check.txt", kind: { type: "add" }, diff: "private fake diff" }]
            }, "fake-thread", "fake-turn")!
          ]])
        : new Map();
      const projection = projectCodexApprovalRequest(request, turnId, this.createId, fileChangeItems);
      if (projection === null) throw new Error("fake-approval-projection-failed");
      this.pendingInteractions.set(projection.requestId, { projection, request });
      await this.callbacks.interactionRequested(projection);
      await this.waitForInteraction();
      const result = this.pendingInteractions.get(projection.requestId);
      if (this.interrupted || this.stopped) return await this.callbacks.completed("interrupted");
      this.pendingInteractions.delete(projection.requestId);
      await this.callbacks.outputDelta(result?.decision === "deny" ? "The command was denied." : "The approved command completed.");
      await this.callbacks.completed("completed");
      return;
    }
    if (text.includes("question") || text.includes("structured input")) {
      const request = this.createInputRequest();
      const projection = projectCodexInputRequest(request, turnId, this.createId);
      if (projection === null) throw new Error("fake-input-projection-failed");
      this.pendingInteractions.set(projection.requestId, { projection, request });
      await this.callbacks.interactionRequested(projection);
      await this.waitForInteraction();
      const result = this.pendingInteractions.get(projection.requestId);
      if (this.interrupted || this.stopped) return await this.callbacks.completed("interrupted");
      this.pendingInteractions.delete(projection.requestId);
      await this.callbacks.outputDelta(result?.answers?.some((answer) => answer.kind === "other") === true
        ? "Thanks, I will continue with the Other answer."
        : result?.answers === undefined
          ? "The answer was not received."
          : "Thanks, I will continue with the selected options.");
      await this.callbacks.completed("completed");
      return;
    }
    if (text === "long") {
      await this.callbacks.activity("Deterministic provider is inspecting the workspace.");
      await this.callbacks.outputDelta("I am still working on it.");
      await new Promise<void>((resolve) => {
        this.releaseLongTurn = resolve;
        this.longTurnTimer = setTimeout(resolve, 30_000);
        if (this.interrupted || this.stopped) resolve();
      });
      if (this.longTurnTimer !== null) clearTimeout(this.longTurnTimer);
      this.longTurnTimer = null;
      this.releaseLongTurn = null;
      await this.callbacks.completed(this.interrupted || this.stopped ? "interrupted" : "completed");
      if (this.testHooks?.closeAfterTurn === true) await this.callbacks.providerClosed();
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.interrupted || this.stopped) return await this.callbacks.completed("interrupted");
    await this.callbacks.outputDelta("Hello from the deterministic provider.");
    await this.callbacks.completed("completed");
    if (this.testHooks?.closeAfterTurn === true) await this.callbacks.providerClosed();
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.releaseLongTurn?.();
    this.releaseInteraction?.();
  }

  async respondToApproval(requestId: string, decision: AiInteractionDecision): Promise<void> {
    const pending = this.pendingInteractions.get(requestId);
    if (pending?.projection.kind !== "approval") throw new Error("ai-interaction-not-pending");
    const payload = encodeCodexApprovalResponse(pending.request, decision);
    this.testHooks?.onNativeResponse?.({ kind: "approval", payload });
    pending.decision = decision;
    this.releaseInteraction?.();
  }

  async respondToStructuredInput(requestId: string, answers: readonly AiStructuredInputAnswer[]): Promise<void> {
    const pending = this.pendingInteractions.get(requestId);
    if (pending?.projection.kind !== "input") throw new Error("ai-interaction-not-pending");
    const payload = encodeCodexInputResponse(pending.projection.mapping, answers);
    this.testHooks?.onNativeResponse?.({ kind: "input", payload });
    pending.answers = answers;
    this.releaseInteraction?.();
  }

  pendingInteractionIds(): readonly string[] { return [...this.pendingInteractions.keys()]; }

  retireInteractions(turnId: string): void {
    for (const [requestId, pending] of this.pendingInteractions.entries()) {
      if (pending.projection.turnId === turnId) this.pendingInteractions.delete(requestId);
    }
    this.releaseInteraction?.();
  }

  async stop(): Promise<ProviderFinalizationResult> {
    this.testHooks?.onStop?.();
    this.stopped = true;
    this.releaseLongTurn?.();
    this.releaseInteraction?.();
    return { state: "finalized", synchronization: "unchanged-valid" };
  }

  private createApprovalRequest(text: string): CodexServerInteractionRequest {
    const method = text.includes("file approval") ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    const params = method === "item/fileChange/requestApproval"
      ? { itemId: "fake-file-item", startedAtMs: 1, threadId: "fake-thread", turnId: "fake-turn", grantRoot: "/workspace", reason: "Codex wants to update the beta check file." }
      : { itemId: "fake-item", startedAtMs: 1, threadId: "fake-thread", turnId: "fake-turn", command: "printf 'DevSpace approval'", cwd: "/workspace", reason: "Codex wants to run the bounded approval test command." };
    const request = parseCodexServerInteractionRequest({ id: "fake-native-approval", method, params });
    if (request === null) throw new Error("fake-approval-request-invalid");
    return request;
  }

  private createInputRequest(): CodexServerInteractionRequest {
    const request = parseCodexServerInteractionRequest({
      id: "fake-native-input",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "fake-item", threadId: "fake-thread", turnId: "fake-turn",
        questions: [
          { id: "question-1", header: "Mode", question: "Choose a safe mode.", isOther: true,
            options: [{ label: "Safe", description: "Use the bounded safe mode." }, { label: "Explain", description: "Explain before continuing." }] },
          { id: "question-2", header: "Reason", question: "Why should Codex continue?", isOther: true,
            options: [{ label: "Continue", description: "Continue with the bounded task." }] }
        ]
      }
    });
    if (request === null) throw new Error("fake-input-request-invalid");
    return request;
  }

  private async waitForInteraction(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.releaseInteraction = resolve;
      if (this.interrupted || this.stopped) resolve();
    });
    this.releaseInteraction = null;
  }
}
