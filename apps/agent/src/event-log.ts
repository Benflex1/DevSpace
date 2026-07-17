import {
  agentEventSchema,
  formatEventCursor,
  parseEventCursor,
  uuidV7Schema,
  type AgentEvent,
  type AgentExecutionFailure,
  type AgentResourceReference,
  type GitInspectionData,
  type UuidV7
} from "@devspace/contracts";

export type ReplayFailure = "boot_mismatch" | "cursor_expired" | "history_unavailable";

export class AgentEventLog {
  readonly bootId: UuidV7;
  private sequence = 0;
  private readonly history: AgentEvent[] = [];
  private readonly subscribers = new Set<(event: AgentEvent) => void>();

  constructor(bootId: string, private readonly now: () => Date, private readonly retention = 1024) {
    this.bootId = uuidV7Schema.parse(bootId);
    if (!Number.isSafeInteger(retention) || retention < 1) throw new Error("event-retention-invalid");
  }

  get currentSequence(): number { return this.sequence; }
  get throughCursor() { return formatEventCursor(this.bootId, this.sequence); }

  private append(event: Omit<AgentEvent, "protocolVersion" | "agentBootId" | "sequence" | "cursor" | "occurredAt">): AgentEvent {
    this.sequence += 1;
    const complete = agentEventSchema.parse({
      ...event, protocolVersion: 1, agentBootId: this.bootId, sequence: this.sequence,
      cursor: formatEventCursor(this.bootId, this.sequence), occurredAt: this.now().toISOString()
    });
    this.history.push(complete);
    while (this.history.length > this.retention) this.history.shift();
    for (const subscriber of this.subscribers) subscriber(complete);
    return complete;
  }

  progressed(operationId: string, resource: AgentResourceReference | null, message: string): AgentEvent {
    return this.append({ operationId, resource, type: "operation.progressed", payload: { message } });
  }
  succeeded(operationId: string, resource: AgentResourceReference | null): AgentEvent {
    return this.append({ operationId, resource, type: "operation.succeeded", payload: {} });
  }
  failed(operationId: string, resource: AgentResourceReference | null, error: AgentExecutionFailure): AgentEvent {
    return this.append({ operationId, resource, type: "operation.failed", payload: { error } });
  }
  projectInspected(projectId: string, workspaceId: string | null, inspection: GitInspectionData): AgentEvent {
    return this.append({
      operationId: null, resource: { type: "project", projectId }, type: "project.inspected",
      payload: { scope: workspaceId === null ? { kind: "managed-store" } : { kind: "workspace", workspaceId }, inspection }
    });
  }
  workspaceCreated(operationId: string, projectId: string, workspaceId: string): AgentEvent[] {
    return [
      this.append({ operationId, resource: { type: "workspace", projectId, workspaceId }, type: "workspace.observed-state.changed", payload: { previous: null, current: "stopped" } }),
      this.append({ operationId, resource: { type: "runtime-stack", projectId, workspaceId }, type: "runtime-stack.observed-state.changed", payload: { previous: null, current: "absent" } })
    ];
  }

  replay(cursor: string): { ok: true; events: AgentEvent[] } | { ok: false; reason: ReplayFailure } {
    const parsed = parseEventCursor(cursor);
    if (!parsed.ok) throw new Error("cursor-syntax-must-be-validated-first");
    if (parsed.value.agentBootId !== this.bootId) return { ok: false, reason: "boot_mismatch" };
    const earliestBoundary = this.history.length === 0 ? this.sequence : this.history[0]!.sequence - 1;
    if (parsed.value.sequence < earliestBoundary) return { ok: false, reason: "cursor_expired" };
    if (parsed.value.sequence > this.sequence) return { ok: false, reason: "history_unavailable" };
    const events = this.history.filter((event) => event.sequence > parsed.value.sequence);
    const expectedCount = this.sequence - parsed.value.sequence;
    if (events.length !== expectedCount) return { ok: false, reason: "history_unavailable" };
    return { ok: true, events };
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
}
