export type AiSessionStreamAdmissionReason =
  | "allowed"
  | "inactive"
  | "session-not-live"
  | "workspace-runtime-unavailable"
  | "provider-unavailable";

export type AiSessionStreamAdmissionInput = Readonly<{
  active: boolean;
  sessionState: string | null;
  runtimeState: string;
  runtimeAvailable: boolean;
  activeAction: "start" | "stop" | null;
  providerAvailable: boolean;
}>;

export type AiSessionStreamAdmission = Readonly<{
  allowed: boolean;
  reason: AiSessionStreamAdmissionReason;
}>;

const liveSessionStates = new Set(["creating", "active", "waiting_for_input", "interrupted"]);

/**
 * Stream admission stops at the prerequisites for a live attachment. A
 * creating session is deliberately allowed: its stream carries session.ready.
 */
export function aiSessionStreamAdmission(input: AiSessionStreamAdmissionInput): AiSessionStreamAdmission {
  if (!input.active) return { allowed: false, reason: "inactive" };
  if (input.sessionState === null || !liveSessionStates.has(input.sessionState)) {
    return { allowed: false, reason: "session-not-live" };
  }
  if (!input.runtimeAvailable || input.runtimeState !== "running" || input.activeAction !== null) {
    return { allowed: false, reason: "workspace-runtime-unavailable" };
  }
  if (!input.providerAvailable) return { allowed: false, reason: "provider-unavailable" };
  return { allowed: true, reason: "allowed" };
}
