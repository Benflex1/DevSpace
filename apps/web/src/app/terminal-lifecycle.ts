export const terminalServerStates = ["creating", "active", "disconnected", "closing", "closed", "failed", "lost"] as const;
export type TerminalServerState = (typeof terminalServerStates)[number];
export type TerminalUiState = "connecting" | "active" | TerminalServerState;

const terminalVisibleStates = new Set(["creating", "active", "disconnected"]);

export function isTerminalVisibleState(state: string): boolean {
  return terminalVisibleStates.has(state);
}

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

export type TerminalSocketCloseAction = "ignore" | "refresh" | "reconnect";

export function terminalSocketCloseAction(input: {
  readonly terminalEnded: boolean;
  readonly cancelled: boolean;
  readonly terminalState: string;
  readonly closeCode: number;
}): TerminalSocketCloseAction {
  if (input.terminalEnded) return "refresh";
  if (input.cancelled) return isTerminalAttachableState(input.terminalState) ? "refresh" : "ignore";
  if (input.closeCode === 4000) return "refresh";
  return "reconnect";
}
