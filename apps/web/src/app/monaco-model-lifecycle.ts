export interface MonacoDiffWidget {
  setModel(model: null): void;
  dispose(): void;
}

export interface MonacoOwnedModel {
  dispose(): void;
}

export function disposeDiffEditorResources(widget: MonacoDiffWidget, models: readonly [MonacoOwnedModel, MonacoOwnedModel]): void {
  widget.setModel(null);
  widget.dispose();
  models[0].dispose();
  models[1].dispose();
}
