import { expect, test } from "vitest";
import { selectInitialTerminal } from "./terminal-selection.js";

const terminal = (id: string, state: string) => ({ id, processId: `process-${id}`, state });

test("prefers the newest attachable terminal over an older lost terminal", () => {
  expect(selectInitialTerminal([terminal("newest-lost", "lost"), terminal("older-attachable", "disconnected")])).toEqual(
    terminal("older-attachable", "disconnected")
  );
});

test("keeps the server-selected newest terminal when every terminal is terminal", () => {
  expect(selectInitialTerminal([terminal("newest-closed", "closed"), terminal("older-lost", "lost")])).toEqual(
    terminal("newest-closed", "closed")
  );
});
