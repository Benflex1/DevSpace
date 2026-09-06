export type SuggestedFieldState = {
  readonly value: string;
  readonly source: "auto" | "user";
};

export function updateSuggestedField(current: SuggestedFieldState, suggestion: string): SuggestedFieldState {
  return current.source === "auto" ? { value: suggestion, source: "auto" } : current;
}
