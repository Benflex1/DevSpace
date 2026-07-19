export const terminalServerStates = ["creating", "active", "disconnected", "closing", "closed", "failed", "lost"] as const;
export type TerminalServerState = (typeof terminalServerStates)[number];
export type TerminalUiState = "connecting" | "active" | TerminalServerState;

export function isTerminalAttachableState(state: string): state is "active" | "disconnected" {
  return state === "active" || state === "disconnected";
}

export function terminalUiState(serverState: string): TerminalUiState {
  if (serverState === "active") return "disconnected";
  return terminalServerStates.includes(serverState as TerminalServerState)
    ? serverState as TerminalServerState
    : "failed";
}

export function reconcileTerminalState(serverState: string, localState: TerminalUiState): {
  readonly state: TerminalUiState;
  readonly closeAttachment: boolean;
} {
  if (isTerminalAttachableState(serverState)) return { state: localState, closeAttachment: false };
  return { state: terminalUiState(serverState), closeAttachment: true };
}
