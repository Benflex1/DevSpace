export const terminalServerStates = ["creating", "active", "disconnected", "closing", "closed", "failed", "lost"] as const;
export type TerminalServerState = (typeof terminalServerStates)[number];
export type TerminalUiState = "connecting" | "active" | TerminalServerState;

const terminalVisibleStates = new Set(["creating", "active", "disconnected", "closed", "lost"]);
const terminalDisplayNumberPattern = /^Terminal ([1-9][0-9]*)$/u;
export const LOST_TERMINAL_SIDEBAR_EXPIRY_MS = 30_000;

export function isTerminalVisibleState(state: string): boolean {
  return terminalVisibleStates.has(state);
}

export function isTerminalSidebarVisible(state: string, lostAt: number | undefined, now: number): boolean {
  if (!isTerminalVisibleState(state)) return false;
  return !["closed", "lost"].includes(state) || lostAt === undefined || now < lostAt + LOST_TERMINAL_SIDEBAR_EXPIRY_MS;
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

export function removeTerminalCollectionEntries<T extends { readonly id: string }>(
  terminals: readonly T[], terminalIds: readonly string[]
): T[] {
  const ids = new Set(terminalIds);
  return terminals.filter((terminal) => !ids.has(terminal.id));
}

export function isTerminalAttachableState(state: string): state is "active" | "disconnected" {
  return state === "active" || state === "disconnected";
}

export function isTerminalOpenableState(state: string): boolean {
  return isTerminalAttachableState(state) || state === "closed";
}

export function terminalStateMessage(state: string): string {
  if (state === "lost") {
    return "The Agent restart lost this terminal's PTY attachment. It cannot be reattached, and processes launched here may still be running inside the retained workspace runtime.";
  }
  if (state === "creating") return "This terminal is still being created.";
  return "This terminal is no longer attachable. Create a replacement from the sidebar.";
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
  if (input.terminalState === "closed") return "ignore";
  if (input.closeCode === 4000) return "refresh";
  return "reconnect";
}
