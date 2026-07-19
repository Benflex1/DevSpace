export const terminalServerStates = ["creating", "active", "disconnected", "closing", "closed", "failed", "lost"] as const;
export type TerminalServerState = (typeof terminalServerStates)[number];
export type TerminalUiState = "connecting" | "active" | TerminalServerState;

const terminalVisibleStates = new Set(["creating", "active", "disconnected"]);
const terminalDisplayNumberPattern = /^Terminal ([1-9][0-9]*)$/u;

export function isTerminalVisibleState(state: string): boolean {
  return terminalVisibleStates.has(state);
}

export function terminalDisplayNumber(title: string): number | undefined {
  const match = terminalDisplayNumberPattern.exec(title);
  return match === null ? undefined : Number(match[1]);
}

export function sortTerminalViewsByTitle<T extends { readonly id: string; readonly title: string }>(terminals: readonly T[]): T[] {
  return [...terminals].sort((left, right) => {
    const leftNumber = terminalDisplayNumber(left.title);
    const rightNumber = terminalDisplayNumber(right.title);
    if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) return leftNumber - rightNumber;
    if (leftNumber !== undefined && rightNumber === undefined) return -1;
    if (leftNumber === undefined && rightNumber !== undefined) return 1;
    if (left.title !== right.title) return left.title < right.title ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function updateTerminalCollectionState<T extends { readonly id: string; readonly state: string }>(
  terminals: readonly T[], terminalId: string, state: string
): readonly T[] {
  const terminal = terminals.find((candidate) => candidate.id === terminalId);
  if (terminal === undefined || terminal.state === state) return terminals;
  return terminals.map((candidate) => candidate.id === terminalId ? { ...candidate, state } : candidate);
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
