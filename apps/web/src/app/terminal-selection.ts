export type TerminalSelectionView = { readonly id: string; readonly processId: string; readonly state: string };

const attachableTerminalStates = ["active", "creating", "disconnected"] as const;

export function isAttachableTerminal(terminal: TerminalSelectionView): boolean {
  return (attachableTerminalStates as readonly string[]).includes(terminal.state);
}

/** The server orders terminals newest-first; preserve that order within each state class. */
export function selectInitialTerminal(terminals: readonly TerminalSelectionView[]): TerminalSelectionView | undefined {
  return terminals.find(isAttachableTerminal) ?? terminals[0];
}
